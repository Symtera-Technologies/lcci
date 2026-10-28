import "server-only";

import { getDb } from "@/db/client";
import type { ActorContext } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { hashIp, hashUserAgent, newUlid, verifyPassword } from "@/server/crypto";
import type { PermissionCode } from "@/server/permissions";
import { consume } from "@/server/rate-limit";
import { clearFailures, isLocked, recordFailure } from "@/server/auth/throttle";
import {
  base32Decode,
  claimStep,
  consumeRecoveryCode,
  countRecoveryCodes,
  issueRecoveryCodes,
  matchingStep,
  openTotpSecret,
  sealTotpSecret,
} from "@/server/auth/totp";
import { invalidateUserSessions } from "@/server/auth/session";

/**
 * Staff authentication: a password, then an authenticator app.
 *
 * Two factors in two steps, with a session in between that is real but not yet
 * trusted — `sessions.mfa_satisfied_at` is NULL until the second factor lands,
 * and `requireStaff` refuses everything except the two routes needed to finish
 * signing in. The schema was built for this; the alternative (a short-lived
 * cookie carrying a pending user id) would be a second, weaker session
 * mechanism with its own expiry and revocation to get right.
 *
 * Enrolment is a **gate, not an option**. An account with no TOTP secret can
 * reach `/admin/setup-2fa` and nothing else. A chamber that lets staff defer
 * two-factor enrolment has staff who never enrol, and the accounts that
 * approve memberships and read every CNIC are the ones it matters for.
 */

/**
 * A well-formed digest that no password matches, verified against when the
 * address is unknown.
 *
 * The parameters must be the production ones — `N=32768, r=8, p=1`, a 64-byte
 * key — because the whole point is that the work done is identical. A cheaper
 * dummy would make an unknown address measurably faster than a wrong password,
 * which is the enumeration this is here to prevent. The salt and digest are
 * fixed base64url filler; nothing derives from them.
 */
const DUMMY_HASH = [
  "scrypt",
  32768,
  8,
  1,
  "A".repeat(22),
  "A".repeat(86),
].join("$");

export interface StaffUser {
  readonly id: number;
  readonly email: string;
  readonly fullName: string;
  readonly roleVersion: number;
  /** False until an authenticator app has been enrolled. */
  readonly hasTotp: boolean;
}

export type PasswordFailure = "invalid" | "locked";

export type PasswordResult =
  | { readonly ok: true; readonly user: StaffUser }
  | {
      readonly ok: false;
      readonly reason: PasswordFailure;
      readonly retryAfterSeconds: number;
    };

function actorFor(
  requestId: string,
  ip: string | null,
  userAgent: string | null,
  userId: number | null,
  staff: boolean,
): ActorContext {
  return {
    userId,
    userType: staff ? "staff" : "system",
    roleCode: null,
    roleCodes: [],
    permissions: new Set<PermissionCode>(),
    requestId,
    ipHash: hashIp(ip),
    userAgentHash: hashUserAgent(userAgent),
    onBehalfOfUserId: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Step one: the password                                                     */
/* -------------------------------------------------------------------------- */

export interface PasswordInput {
  readonly email: string;
  readonly password: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

/**
 * Check a staff password.
 *
 * Unlike member sign-in, this does **not** hide whether the account exists,
 * and that is a considered difference rather than an oversight. Staff
 * addresses are not guessable in bulk the way sequential membership numbers
 * are, there are about fifteen of them, and they are already public on the
 * chamber's own contact pages. What matters here instead is that a wrong
 * password and a wrong address take the same time — hence the dummy verify —
 * so the form cannot be used to discover which of two plausible addresses a
 * colleague actually uses.
 *
 * The lockout *is* reported, because a staff member who is locked out needs to
 * know that rather than to keep trying, and they can phone the secretariat.
 */
export async function signInWithPassword(input: PasswordInput): Promise<PasswordResult> {
  const requestId = input.requestId ?? newUlid();
  const email = input.email.trim().toLowerCase();
  const subjects = { identifier: `staff:${email}`, ip: input.ip };

  const lock = await isLocked(subjects);
  if (lock.locked) {
    return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };
  }

  const limit = await consume("staffPasswordAccount", email);
  if (!limit.allowed) {
    return { ok: false, reason: "locked", retryAfterSeconds: limit.retryAfterSeconds };
  }

  const row = await getDb()
    .selectFrom("users")
    .select([
      "id",
      "email",
      "full_name",
      "password_hash",
      "role_version",
      "totp_secret_enc",
    ])
    .where("email", "=", email)
    .where("user_type", "=", "staff")
    .where("status", "=", "active")
    .executeTakeFirst();

  // Always a verify, even with no row and even with a NULL hash. scrypt at
  // N=2^15 is around a tenth of a second, which is precisely the interval a
  // skipped verify would hand an attacker as "that address does not exist".
  const stored = row?.password_hash ?? DUMMY_HASH;
  const correct = verifyPassword(input.password, stored) && row !== undefined;

  if (!correct) {
    await recordFailure(subjects);
    await writeAudit(actorFor(requestId, input.ip, input.userAgent, row?.id ?? null, false), {
      entityType: "user",
      entityId: row?.id ?? `staff:${email}`,
      action: "staff.password_failed",
      summary: "A staff sign-in was attempted with an incorrect password or unknown address.",
      context: { known: row !== undefined },
    });

    const after = await isLocked(subjects);
    return {
      ok: false,
      reason: after.locked ? "locked" : "invalid",
      retryAfterSeconds: after.retryAfterSeconds,
    };
  }

  // Not cleared yet. The password is only the first factor, and clearing the
  // counters here would let an attacker who has the password reset the lockout
  // at will while grinding the second factor.
  await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
    entityType: "user",
    entityId: row.id,
    action: "staff.password_accepted",
    summary: "A staff password was accepted; the second factor is still outstanding.",
    context: { hasTotp: row.totp_secret_enc !== null },
  });

  return {
    ok: true,
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      roleVersion: row.role_version,
      hasTotp: row.totp_secret_enc !== null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Step two: the authenticator                                                */
/* -------------------------------------------------------------------------- */

export type SecondFactorFailure =
  | "invalid"
  /** Correct digits, but this step has already been spent. */
  | "replayed"
  | "not-enrolled"
  | "locked";

export type SecondFactorResult =
  | {
      readonly ok: true;
      /** Set when a recovery code was spent, so the UI can say how many are left. */
      readonly recoveryRemaining: number | null;
    }
  | {
      readonly ok: false;
      readonly reason: SecondFactorFailure;
      readonly retryAfterSeconds: number;
    };

export interface SecondFactorInput {
  readonly userId: number;
  readonly code: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

/**
 * Check a six-digit authenticator code, or a recovery code.
 *
 * Which one is decided by shape rather than by a radio button the user has to
 * get right: six digits is a TOTP code, anything else is tried as a recovery
 * code. Both paths record a failure on the throttle, so grinding the second
 * factor with a stolen password runs into the same escalating lock.
 */
export async function verifySecondFactor(
  input: SecondFactorInput,
): Promise<SecondFactorResult> {
  const requestId = input.requestId ?? newUlid();
  const db = getDb();

  const row = await db
    .selectFrom("users")
    .select(["id", "email", "totp_secret_enc"])
    .where("id", "=", input.userId)
    .where("user_type", "=", "staff")
    .where("status", "=", "active")
    .executeTakeFirst();

  if (!row) return { ok: false, reason: "invalid", retryAfterSeconds: 0 };

  const subjects = { identifier: `staff:${row.email}`, ip: input.ip };
  const lock = await isLocked(subjects);
  if (lock.locked) {
    return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };
  }

  const secret = openTotpSecret(row.id, row.totp_secret_enc);
  if (!secret) return { ok: false, reason: "not-enrolled", retryAfterSeconds: 0 };

  const digits = input.code.replace(/\D/g, "");
  const looksLikeTotp = digits.length === 6 && input.code.replace(/[\s-]/g, "").length === 6;

  const fail = async (
    reason: SecondFactorFailure,
    summary: string,
  ): Promise<SecondFactorResult> => {
    await recordFailure(subjects);
    await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
      entityType: "user",
      entityId: row.id,
      action: "staff.second_factor_failed",
      summary,
      context: { reason },
    });
    const after = await isLocked(subjects);
    return {
      ok: false,
      reason: after.locked ? "locked" : reason,
      retryAfterSeconds: after.retryAfterSeconds,
    };
  };

  if (looksLikeTotp) {
    const step = matchingStep(secret, digits);
    if (step === null) {
      return fail("invalid", "An incorrect authenticator code was submitted.");
    }

    // A code is valid for its whole 30-second window, so without this the same
    // six digits work twice — and on a different Passenger worker the second
    // time, which is why the record is in the database.
    if (!(await claimStep(row.id, step))) {
      return fail(
        "replayed",
        "A correct authenticator code was submitted a second time inside its own window.",
      );
    }

    await clearFailures(subjects);
    await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
      entityType: "user",
      entityId: row.id,
      action: "staff.signed_in",
      summary: "A staff member completed sign-in with an authenticator code.",
      context: { method: "totp" },
    });

    return { ok: true, recoveryRemaining: null };
  }

  const recovery = await consumeRecoveryCode(row.id, input.code, hashIp(input.ip));
  if (!recovery.consumed) {
    return fail("invalid", "An incorrect recovery code was submitted.");
  }

  await clearFailures(subjects);
  await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
    entityType: "user",
    entityId: row.id,
    action: "staff.signed_in",
    summary: `A staff member completed sign-in with recovery code ${recovery.ordinal} of ten.`,
    // The count is the operationally interesting part: an account running low
    // is an account whose authenticator is not working, and somebody should
    // notice before it reaches zero.
    context: { method: "recovery_code", ordinal: recovery.ordinal, remaining: recovery.remaining },
  });

  return { ok: true, recoveryRemaining: recovery.remaining };
}

/* -------------------------------------------------------------------------- */
/* Enrolment                                                                  */
/* -------------------------------------------------------------------------- */

export interface EnrolInput {
  readonly userId: number;
  /** The base32 secret the page displayed, returned with the confirming code. */
  readonly secretBase32: string;
  readonly code: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

export type EnrolResult =
  | { readonly ok: true; readonly recoveryCodes: readonly string[] }
  | { readonly ok: false; readonly reason: "invalid" | "already-enrolled" };

/**
 * Confirm and store an authenticator secret.
 *
 * The secret travels from the setup page back in a hidden field. That is the
 * standard shape for this flow and worth stating plainly rather than hiding:
 * it is already on the screen as a QR code or a transcribable key, the page is
 * served `no-store` to an authenticated staff member, and the secret is inert
 * until a code generated from it is confirmed here. The alternative — a
 * pending-secret column — adds a half-enrolled state to the user row that
 * every other query then has to know about.
 *
 * Re-enrolment bumps `role_version`, which kills every session of that user.
 * First enrolment does not, because the person is in the middle of signing in
 * and throwing them out at the moment they succeed teaches them that the
 * system is broken. Changing an already-working authenticator is the case
 * where a forced re-sign-in is the point: if it was not the account holder who
 * changed it, every session they had is now gone.
 */
export async function enrolTotp(input: EnrolInput): Promise<EnrolResult> {
  const requestId = input.requestId ?? newUlid();
  const db = getDb();

  const row = await db
    .selectFrom("users")
    .select(["id", "totp_secret_enc"])
    .where("id", "=", input.userId)
    .where("user_type", "=", "staff")
    .where("status", "=", "active")
    .executeTakeFirst();

  if (!row) return { ok: false, reason: "invalid" };

  let secret: Buffer;
  try {
    secret = base32Decode(input.secretBase32);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (secret.length < 10) return { ok: false, reason: "invalid" };

  const step = matchingStep(secret, input.code);
  if (step === null) return { ok: false, reason: "invalid" };

  const reEnrolment = row.totp_secret_enc !== null;
  let codes: readonly string[] = [];

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("users")
      .set({
        totp_secret_enc: sealTotpSecret(row.id, secret),
        mfa_mode: "totp",
      })
      .where("id", "=", row.id)
      .execute();

    codes = await issueRecoveryCodes(row.id, tx);

    // Spend the confirming step too, so the code just typed into the setup
    // form cannot immediately be replayed at the sign-in form.
    await claimStep(row.id, step, tx);
  });

  await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
    entityType: "user",
    entityId: row.id,
    action: reEnrolment ? "staff.totp_replaced" : "staff.totp_enrolled",
    summary: reEnrolment
      ? "A staff member replaced their authenticator; every session was revoked."
      : "A staff member enrolled an authenticator app.",
    context: { recoveryCodesIssued: codes.length },
  });

  if (reEnrolment) await invalidateUserSessions(row.id);

  return { ok: true, recoveryCodes: codes };
}

export { countRecoveryCodes };
