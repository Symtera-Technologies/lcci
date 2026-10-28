import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb, sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import {
  hashPassword,
  packSealed,
  seal,
  unpackSealed,
  unseal,
  verifyPassword,
} from "@/server/crypto";

/**
 * Time-based one-time passwords, RFC 6238, for staff accounts.
 *
 * Staff get password + authenticator app; members get an emailed code and no
 * password at all. The asymmetry is deliberate and is about what the account
 * can reach: a staff session approves memberships, receipts money and reads
 * every CNIC in the system, so making the inbox the root credential for it
 * would be the single worst decision available. A member session shows one
 * applicant their own form.
 *
 * Hand-rolled rather than a dependency, because the whole of RFC 6238 is an
 * HMAC, a truncation and a division — about forty lines below — and the build
 * has to run off-box onto a shared cPanel account, where every avoidable
 * package is one more thing that can fail to install. `node:crypto` is already
 * doing the work either way.
 *
 * Three properties that are easy to leave out and expensive to leave out:
 *
 * - **Replay is blocked in the database.** A code is valid for its whole
 *   30-second step, so without a spent-step record the same six digits work
 *   twice. Passenger runs several worker processes, so an in-process set would
 *   let the replay simply land on a different worker.
 * - **The secret is sealed, not stored.** AES-256-GCM with the AAD bound to
 *   `users:<id>:totp_secret_enc`, so a ciphertext lifted from a backup cannot
 *   be pasted onto another row.
 * - **Comparison is constant-time.** Over the generated digits, not the
 *   secret, but an early-exit compare on a six-digit code is a real oracle
 *   when an attacker can try it thousands of times.
 */

/* -------------------------------------------------------------------------- */
/* Base32, because that is what authenticator apps speak                      */
/* -------------------------------------------------------------------------- */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * RFC 4648 base32, without padding.
 *
 * Authenticator apps take the secret as base32 — that is what the `secret`
 * parameter of an `otpauth://` URI contains and what "enter a key manually"
 * expects. Padding is omitted because Google Authenticator and several others
 * reject `=` characters outright.
 */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("Not base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/* -------------------------------------------------------------------------- */
/* The algorithm                                                              */
/* -------------------------------------------------------------------------- */

/** 30 seconds, SHA-1, 6 digits: the defaults every authenticator app assumes. */
export const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * How many steps either side of the current one are accepted.
 *
 * One, so a code is usable for ninety seconds in total. Zero would reject
 * anyone whose phone clock is a few seconds out — which on an Android handset
 * that has not synced is common — and the complaint arrives as "the app is
 * broken". More than one starts to matter: each extra step is another window
 * in which a shoulder-surfed code still works.
 */
const DRIFT_STEPS = 1;

export function currentStep(at: number = Date.now()): number {
  return Math.floor(at / 1000 / STEP_SECONDS);
}

/**
 * The code for one secret at one step.
 *
 * RFC 6238 dynamic truncation: HMAC-SHA1 the big-endian step counter, take the
 * low nibble of the last byte as an offset, read four bytes from there, clear
 * the sign bit, and take the last six decimal digits.
 */
export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Which step a code is valid for, or null.
 *
 * Returns the step rather than a boolean because the caller has to record it
 * as spent, and recomputing which window matched would be a second place for
 * the drift tolerance to be written down differently.
 */
export function matchingStep(
  secret: Buffer,
  code: string,
  at: number = Date.now(),
): number | null {
  const presented = code.replace(/\D/g, "");
  if (presented.length !== DIGITS) return null;

  const now = currentStep(at);
  const presentedBytes = Buffer.from(presented, "utf8");

  let found: number | null = null;
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    const step = now + drift;
    const expected = Buffer.from(totpCode(secret, step), "utf8");
    // No early `break`: every window is compared whether or not an earlier one
    // matched, so the time taken does not say which window was right. Cheap
    // here — three HMACs — and the kind of thing that is never added later.
    if (expected.length === presentedBytes.length && timingSafeEqual(expected, presentedBytes)) {
      found = step;
    }
  }

  return found;
}

/** The URI an authenticator app consumes, by QR code or by hand. */
export function otpauthUri(options: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = `${options.issuer}:${options.accountName}`;
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/* -------------------------------------------------------------------------- */
/* The secret, at rest                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 20 bytes, which is the SHA-1 block size and what RFC 4226 recommends.
 *
 * Longer is not better here: the secret is transcribed by a human or scanned
 * from a QR code, and 160 bits is already far beyond what the six-digit output
 * can express.
 */
const SECRET_BYTES = 20;

function aadFor(userId: number): string {
  return `users:${userId}:totp_secret_enc`;
}

export function newTotpSecret(): { secret: Buffer; base32: string } {
  const secret = randomBytes(SECRET_BYTES);
  return { secret, base32: base32Encode(secret) };
}

export function sealTotpSecret(userId: number, secret: Buffer): Buffer {
  return packSealed(seal(secret.toString("base64"), aadFor(userId)));
}

export function openTotpSecret(userId: number, packed: Buffer | null): Buffer | null {
  if (!packed || packed.length === 0) return null;
  return Buffer.from(unseal(unpackSealed(packed), aadFor(userId)), "base64");
}

/* -------------------------------------------------------------------------- */
/* Replay                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Claim a step for a user, once.
 *
 * `INSERT` against a `(user_id, step)` primary key, and a duplicate-key error
 * is the answer, not an exception to log: it means this code has already been
 * used inside its own window. Checking with a `SELECT` first would be the
 * race this is here to prevent.
 */
export async function claimStep(
  userId: number,
  step: number,
  db: Queryable = getDb(),
): Promise<boolean> {
  const result = await sql`
    INSERT IGNORE INTO staff_totp_used (user_id, step) VALUES (${userId}, ${step})
  `.execute(db);

  return Number(result.numAffectedRows ?? 0) === 1;
}

/** Steps nobody can replay any more. Called by the retention sweep. */
export async function purgeSpentSteps(olderThanHours = 24): Promise<number> {
  const result = await sql`
    DELETE FROM staff_totp_used
     WHERE used_at < UTC_TIMESTAMP(3) - INTERVAL ${sql.lit(olderThanHours)} HOUR
     LIMIT 5000
  `.execute(getDb());

  return Number(result.numAffectedRows ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Recovery codes                                                             */
/* -------------------------------------------------------------------------- */

export const RECOVERY_CODE_COUNT = 10;

/**
 * Ten codes, shown once.
 *
 * Crockford-ish base32 without the characters people confuse when copying off
 * a screen onto paper — no I, L, O, U, 0 or 1 — because these are read aloud
 * over the phone to the secretariat more often than anyone designing them
 * expects. Grouped in two blocks of five for the same reason.
 */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newRecoveryCode(): string {
  const bytes = randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
    if (i === 4) out += "-";
  }
  return out;
}

export function normaliseRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/**
 * Replace a user's whole recovery set.
 *
 * All ten at once, inside one transaction, because a half-replaced set is a
 * set where some of the codes the staff member is looking at do not work and
 * nobody can tell which. Any unused codes from a previous enrolment are
 * deleted: re-enrolling 2FA invalidates the old authenticator, and codes that
 * bypass it must go with it.
 */
export async function issueRecoveryCodes(
  userId: number,
  db: Queryable = getDb(),
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);

  await db.deleteFrom("staff_recovery_codes").where("user_id", "=", userId).execute();

  await db
    .insertInto("staff_recovery_codes")
    .values(
      codes.map((code, index) => ({
        user_id: userId,
        // scrypt, like the password. These are low-entropy enough to be worth
        // brute-forcing if the table leaks, which rules out a bare hash.
        code_hash: hashPassword(normaliseRecoveryCode(code)),
        ordinal: index + 1,
      })),
    )
    .execute();

  return codes;
}

/**
 * Spend a recovery code.
 *
 * Every unused code is verified, and the loop does not stop at the first
 * match. Ten scrypt verifications is roughly a second of CPU, which is the
 * cost of not leaking — through timing — how far down the set the presented
 * code sat. The code is marked used by a guarded `UPDATE` whose
 * `used_at IS NULL` is checked by affected rows, so two simultaneous
 * presentations of the same code cannot both succeed.
 */
export async function consumeRecoveryCode(
  userId: number,
  presented: string,
  ipHash: string | null,
): Promise<{ consumed: boolean; ordinal: number | null; remaining: number }> {
  const normalised = normaliseRecoveryCode(presented);
  const db = getDb();

  const rows = await db
    .selectFrom("staff_recovery_codes")
    .select(["id", "code_hash", "ordinal"])
    .where("user_id", "=", userId)
    .where("used_at", "is", null)
    .orderBy("ordinal", "asc")
    .execute();

  let match: { id: number; ordinal: number } | null = null;
  for (const row of rows) {
    if (verifyPassword(normalised, row.code_hash)) {
      match = { id: row.id, ordinal: row.ordinal };
    }
  }

  if (!match) {
    return { consumed: false, ordinal: null, remaining: rows.length };
  }

  const claimed = await db
    .updateTable("staff_recovery_codes")
    .set({ used_at: new Date(), used_ip_hash: ipHash })
    .where("id", "=", match.id)
    .where("used_at", "is", null)
    .executeTakeFirst();

  if (Number(claimed.numUpdatedRows ?? 0) !== 1) {
    return { consumed: false, ordinal: null, remaining: rows.length };
  }

  return { consumed: true, ordinal: match.ordinal, remaining: rows.length - 1 };
}

export async function countRecoveryCodes(userId: number): Promise<number> {
  const row = await getDb()
    .selectFrom("staff_recovery_codes")
    .select((eb) => eb.fn.countAll<number>().as("remaining"))
    .where("user_id", "=", userId)
    .where("used_at", "is", null)
    .executeTakeFirst();

  return Number(row?.remaining ?? 0);
}
