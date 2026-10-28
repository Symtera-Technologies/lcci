import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { env } from "@/server/env";

/**
 * Cryptographic primitives, all from `node:crypto`.
 *
 * Zero dependencies is the point, not an accident. This project builds off-box
 * for a cPanel host whose libc and architecture differ from the build machine,
 * so every native module is a deploy that boots on the developer's laptop and
 * fails on the server. `node:crypto` covers hashing, HMAC, random generation,
 * password hashing, TOTP and AES-GCM with nothing to compile.
 */

/* -------------------------------------------------------------------------- */
/* Hashing                                                                    */
/* -------------------------------------------------------------------------- */

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Keyed hash, for values that must be matchable but never readable.
 *
 * A plain hash of a CNIC is reversible by anyone willing to enumerate thirteen
 * digits, which is a few minutes of work. The pepper makes the digest useless
 * without a secret the database does not contain.
 */
export function hmacHex(input: string, pepper: string = env.ipPepper): string {
  return createHmac("sha256", pepper).update(input).digest("hex");
}

/**
 * Hash an IP address before it becomes a log entry or a rate-limit key.
 *
 * The rate limiter needs to count requests per address and the audit log needs
 * to show that two actions came from the same place. Neither needs to know the
 * address. Peppered rather than plain, because the IPv4 space is small enough
 * to enumerate against an unkeyed hash.
 *
 * `null` in, `null` out: an unknown address is recorded as unknown rather than
 * as the hash of an empty string, which would make every unknown look alike.
 */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return hmacHex(`ip:${ip}`);
}

export function hashUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  return hmacHex(`ua:${ua.slice(0, 512)}`);
}

/**
 * Constant-time comparison of two hex strings.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself leak the
 * length, so the lengths are compared first and a mismatch returns false
 * without touching the buffers.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Identifiers and tokens                                                     */
/* -------------------------------------------------------------------------- */

export function newUuid(): string {
  return randomUUID();
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID: 26 Crockford-base32 characters, lexicographically sortable by time.
 *
 * Used as the request id that correlates every audit event, log line and
 * document access within one HTTP request. Sortable matters because the audit
 * log is read chronologically, and a UUIDv4 request id would mean every
 * correlated read needs a timestamp join.
 *
 * Hand-rolled rather than a dependency: it is twenty lines and the alternative
 * is another package in the server bundle.
 */
export function newUlid(now: number = Date.now()): string {
  let timePart = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[remaining % 32] + timePart;
    remaining = Math.floor(remaining / 32);
  }

  const random = randomBytes(16);
  let randomPart = "";
  for (let i = 0; i < 16; i += 1) {
    randomPart += CROCKFORD[random[i] % 32];
  }

  return timePart + randomPart;
}

/** A 32-byte session or endorsement token, base64url. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A six-digit one-time code.
 *
 * `randomInt` and not `Math.random()`: `Math.random` is not a CSPRNG, and a
 * predictable login code is a login bypass. Six digits rather than four
 * because, with five attempts and a ten-minute life, the per-code guess
 * probability is 5 in a million; four digits would make it 1 in 2000.
 */
export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

/** sha256(code + salt). The code itself is never stored or logged. */
export function hashOtpCode(code: string, salt: string): string {
  return sha256Hex(`${code}${salt}`);
}

/* -------------------------------------------------------------------------- */
/* Passwords                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * scrypt parameters.
 *
 * N=2^15 with r=8 is about 64 MB and roughly 100ms on modest hardware —
 * defensible for 2026, and affordable because the surface is tiny: only staff
 * have passwords, roughly fifteen accounts, and members authenticate by OTP.
 * If login latency on the real host is painful, drop to 2^14 after measuring
 * there rather than guessing here.
 *
 * `maxmem` must be raised explicitly: Node's default is 32 MB and scrypt
 * throws rather than silently weakening the parameters, which is the correct
 * failure but needs accommodating.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

/**
 * Hash a staff password. Format: `scrypt$N$r$p$salt$hash`, so the parameters
 * travel with the digest and can be raised later without invalidating every
 * existing password.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");

  try {
    const derived = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT.maxmem,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* AES-256-GCM for encrypted columns                                          */
/* -------------------------------------------------------------------------- */

function masterKey(): Buffer {
  const key = Buffer.from(env.encryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must be 32 bytes base64-encoded; got ${key.length} bytes.`,
    );
  }
  return key;
}

export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/**
 * Encrypt a short value — a CNIC, a passport number, a TOTP secret.
 *
 * `aad` binds the ciphertext to its context, so a CNIC column value cannot be
 * moved to a different row or a different column and still authenticate. Pass
 * something stable and specific, like `users.totp_secret:42`.
 *
 * What this protects against is filesystem and backup exposure, not
 * application compromise: the app can obviously decrypt what it encrypts. On
 * shared cPanel there is no disk encryption at all, so this is the difference
 * between a stray backup download being a breach and being noise.
 */
export function seal(plaintext: string, aad: string): SealedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function unseal(sealed: SealedValue, aad: string): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), sealed.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([
    decipher.update(sealed.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/** A fresh 32-byte data key, for envelope-encrypting a document's bytes. */
export function newDataKey(): Buffer {
  return randomBytes(32);
}

/** Wrap a document's data key with the master key, for storage beside the row. */
export function wrapDataKey(dataKey: Buffer, aad: string): SealedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function unwrapDataKey(sealed: SealedValue, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), sealed.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/**
 * One column, not three.
 *
 * A sealed value is an IV, a tag and a ciphertext, and storing them in three
 * columns means three chances for them to be updated out of step. Packed into
 * one `VARBINARY` they move together or not at all, which for an
 * authenticated-encryption value is the only correct behaviour — two-thirds of
 * a sealed value is not a value.
 *
 * Fixed-width prefixes, so there is no length field to get wrong: 12 bytes of
 * IV (GCM's standard size, which `seal` and `wrapDataKey` both use), then the
 * 16-byte tag, then the rest.
 */
export function packSealed(sealed: SealedValue): Buffer {
  return Buffer.concat([sealed.iv, sealed.tag, sealed.ciphertext]);
}

export function unpackSealed(packed: Buffer): SealedValue {
  if (packed.length < 12 + 16) {
    throw new Error("Sealed value is too short to contain an IV and a tag");
  }
  return {
    iv: packed.subarray(0, 12),
    tag: packed.subarray(12, 28),
    ciphertext: packed.subarray(28),
  };
}
