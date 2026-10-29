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
 * Staff authentication: a password, and an authenticator app if the account
 * holder has turned one on.
 *
 * **Two-factor is off by default and each staff member manages their own**,
 * from `/admin/security`. That is a deliberate reversal of the original
 * design, which made enrolment a gate nobody could pass without an
 * authenticator, and the cost of the reversal should be stated rather than
 * discovered: these accounts approve memberships, receipt money and can read
 * every identity document in the system, and an account with two-factor off
 * is one stolen password away from all of it. The mitigations that remain are
 * the escalating lockout in `throttle.ts`, the audit event on every accepted
 * and refused password, and `role_version` killing every session the moment a
 * password changes. None of them is a second factor.
 *
 * What makes it manageable rather than merely optional is that turning it on
 * and off is the account holder's own, audited, password-confirmed act — so a
 * super administrator can ask for it, see who has it, and see when someone
 * dropped it, which a hard gate never showed because everyone was behind it.
 *
 * **This diverges from the spec and the divergence is a launch gate, not a
 * detail.** §9 of `docs/LCCI-Website-Rebuild-Developer-Spec.md` requires "OTP
 * or 2FA for portal login and admin accounts"; a staff account with
 * two-factor off has neither. Members are unaffected — an emailed code is
 * their only credential and there is no way to switch it off. Closing the gap
 * for staff means either LCCI amending that line in writing, or requiring
 * two-factor for the roles that touch money and identity documents
 * (`cashier`, `membership_approver`, `super_admin`), which belongs in the
 * role grants and the sign-in path rather than as a second switch here.
 *
 * When two-factor **is** on, the flow is unchanged: two factors in two steps,
 * with a session in between that is real but not yet trusted —
 * `sessions.mfa_satisfied_at` is NULL until the second factor lands, and
 * `requireStaff` refuses everything except the route needed to finish signing
 * in. The alternative (a short-lived cookie carrying a pending user id) would
 * be a second, weaker session mechanism with its own expiry and revocation to
 * get right.
 *
 * Two columns say whether it is on, and both must agree: `mfa_mode = 'totp'`
 * is the holder's decision, `totp_secret_enc IS NOT NULL` is the means of
 * checking it. A row where only one is set is treated as **off**, because the
 * opposite reading would demand a code at the door that nothing can verify
 * and lock the holder out of their own account.
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
  /**
   * True when this account has turned two-factor on and a secret exists to
   * check it against. The caller uses it to decide whether the session it
   * creates is already trusted or still owes a code.
   */
  readonly twoFactorEnabled: boolean;
  /**
   * True when an administrator has required two-factor on this account.
   *
   * With `twoFactorEnabled` false, this is the state the gate acts on: the
   * session is created untrusted and the holder reaches enrolment and nothing
   * else. It is also what stops them turning it back off.
   */
  readonly twoFactorRequired: boolean;
}

/** Both halves must agree, or two-factor is off. See the module header. */
function twoFactorOn(row: {
  mfa_mode: string;
  totp_secret_enc: Buffer | null;
}): boolean {
  return row.mfa_mode === "totp" && row.totp_secret_enc !== null;
}

/** mysql2 returns TINYINT(1) as 0 or 1, never a boolean. */
function isRequired(row: { mfa_required: number }): boolean {
  return row.mfa_required === 1;
}

/**
 * Stamp the moment sign-in actually completed.
 *
 * Written where the credential is *finished*, not where the password is
 * accepted: a password accepted and a code never produced is not a sign-in,
 * and recording it as one would make "last signed in" read as reassurance
 * about an account somebody is currently failing to break into.
 *
 * `otp.ts` already did this for members. Staff did not, and it went unnoticed
 * until the staff list had a column for it and every row read "Never".
 */
async function recordSignIn(userId: number): Promise<void> {
  await getDb()
    .updateTable("users")
    .set({ last_login_at: new Date(), failed_logins: 0, locked_until: null })
    .where("id", "=", userId)
    .execute();
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
    departmentScopes: [],
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
      "mfa_mode",
      "mfa_required",
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

  const twoFactor = twoFactorOn(row);
  const required = isRequired(row);
  // The password finishes the job only when nothing else is owed — no
  // authenticator to present, and nobody insisting one be set up.
  const complete = !twoFactor && !required;

  // Cleared only where the password was the *whole* credential. With anything
  // still to come, clearing here would let an attacker who has the password
  // reset the lockout at will while grinding what follows.
  if (complete) {
    await clearFailures(subjects);
    await recordSignIn(row.id);
  }

  await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
    entityType: "user",
    entityId: row.id,
    action: complete ? "staff.signed_in" : "staff.password_accepted",
    summary: complete
      ? "A staff member signed in with a password alone; two-factor is off for this account."
      : twoFactor
        ? "A staff password was accepted; the second factor is still outstanding."
        : "A staff password was accepted; two-factor is required on this account and not yet set up.",
    context: {
      twoFactor,
      required,
      method: complete ? "password_only" : null,
    },
  });

  return {
    ok: true,
    user: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      roleVersion: row.role_version,
      twoFactorEnabled: twoFactor,
      twoFactorRequired: required,
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
    .select(["id", "email", "totp_secret_enc", "mfa_mode"])
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

  // `not-enrolled` is now a genuinely odd state rather than the common one: a
  // session only ever owes a code because two-factor was on when the password
  // was accepted, so reaching here means the holder turned it off from another
  // device in between. The caller sends them back to the start, where the
  // password alone will now be enough.
  const secret = twoFactorOn(row) ? openTotpSecret(row.id, row.totp_secret_enc) : null;
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
    await recordSignIn(row.id);
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
  await recordSignIn(row.id);
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
 * Replacing a working authenticator revokes every session of that user; first
 * enrolment does not. The asymmetry is the point. Turning two-factor **on**
 * strictly narrows what a stolen cookie is worth, so throwing the holder out
 * at the moment they improve their own security would only teach them not to
 * bother. Swapping an authenticator that already worked is the case where a
 * forced re-sign-in matters: if it was not the account holder who swapped it,
 * every session they had is now gone.
 */
export async function enrolTotp(input: EnrolInput): Promise<EnrolResult> {
  const requestId = input.requestId ?? newUlid();
  const db = getDb();

  const row = await db
    .selectFrom("users")
    .select(["id", "totp_secret_enc", "mfa_mode"])
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

  // Replacing a *working* authenticator, not merely one whose secret is still
  // in the column. An account that turned two-factor off has no working
  // authenticator to replace, so turning it back on is a first enrolment and
  // must not revoke the session doing it.
  const reEnrolment = twoFactorOn(row);
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

/* -------------------------------------------------------------------------- */
/* Turning it off again                                                       */
/* -------------------------------------------------------------------------- */

export interface DisableInput {
  readonly userId: number;
  /** The account's own password, re-entered to confirm. */
  readonly password: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

export type DisableResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "wrong-password" | "not-enabled" | "locked" | "required";
    };

/**
 * Turn two-factor off for one's own account.
 *
 * **The password is re-entered, and that is not a formality.** Everything else
 * on these screens is reversible or visible; this one weakens the account
 * permanently and silently, and the realistic attacker is not a stranger with
 * a stolen password — it is whoever walks past an unlocked secretariat machine
 * with a signed-in session on it. A session cookie alone must not be enough to
 * remove a factor, so the holder proves they are the holder.
 *
 * The secret and every unused recovery code go together, in one transaction.
 * Leaving the secret behind would mean a "disabled" account whose old
 * authenticator still generates codes this system would accept the moment
 * `mfa_mode` flipped back — so turning it on again issues a fresh secret and a
 * fresh set of ten codes, and the old phone is inert.
 *
 * Sessions are deliberately **not** revoked. The holder is signed in, has just
 * proved it with their password, and ejecting them from the screen they used
 * would read as a fault. The audit event is what makes this safe to leave
 * quiet: it names who, when and from where, so a super administrator reviewing
 * the log can see a factor being dropped.
 */
export async function disableTotp(input: DisableInput): Promise<DisableResult> {
  const requestId = input.requestId ?? newUlid();
  const db = getDb();

  const row = await db
    .selectFrom("users")
    .select([
      "id",
      "email",
      "password_hash",
      "totp_secret_enc",
      "mfa_mode",
      "mfa_required",
    ])
    .where("id", "=", input.userId)
    .where("user_type", "=", "staff")
    .where("status", "=", "active")
    .executeTakeFirst();

  if (!row) return { ok: false, reason: "not-enabled" };
  if (!twoFactorOn(row)) return { ok: false, reason: "not-enabled" };

  // Checked here and not only in the UI. The screen hides the control when
  // two-factor is required, but a server action is a publicly addressable
  // endpoint — the hidden button is not the control, this is. Refused before
  // the password is even looked at, so an account that cannot do this learns
  // that rather than being told its own password is wrong.
  if (isRequired(row)) return { ok: false, reason: "required" };

  const subjects = { identifier: `staff:${row.email}`, ip: input.ip };
  const lock = await isLocked(subjects);
  if (lock.locked) return { ok: false, reason: "locked" };

  // The same throttle as the sign-in form, on the same subject pair. Without
  // it this becomes an unthrottled password oracle for anyone holding a
  // borrowed session — the one place where confirming a password could be
  // guessed at instead of known.
  if (!verifyPassword(input.password, row.password_hash ?? DUMMY_HASH)) {
    await recordFailure(subjects);
    await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
      entityType: "user",
      entityId: row.id,
      action: "staff.totp_disable_refused",
      summary: "Two-factor sign-in was not turned off: the confirming password was wrong.",
    });
    return { ok: false, reason: "wrong-password" };
  }

  await clearFailures(subjects);

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("users")
      .set({ totp_secret_enc: null, mfa_mode: "none" })
      .where("id", "=", row.id)
      .execute();

    await tx
      .deleteFrom("staff_recovery_codes")
      .where("user_id", "=", row.id)
      .where("used_at", "is", null)
      .execute();
  });

  await writeAudit(actorFor(requestId, input.ip, input.userAgent, row.id, true), {
    entityType: "user",
    entityId: row.id,
    action: "staff.totp_disabled",
    summary:
      "A staff member turned two-factor sign-in off; this account is now a password alone.",
    context: { confirmedWith: "password" },
  });

  return { ok: true };
}

export interface TwoFactorStatus {
  readonly enabled: boolean;
  readonly required: boolean;
  /** Who required it, for the screen that has to name them. */
  readonly requiredBy: string | null;
  readonly requiredAt: Date | null;
  readonly recoveryRemaining: number;
}

/**
 * Two-factor as it stands for one account, for its own settings screen.
 *
 * `requiredBy` is a left join rather than a second query, and it is a name
 * rather than an id because the screen has to say who: "an administrator"
 * leaves the holder with nobody to ask, and the audit log that does carry the
 * answer is a page they cannot open.
 */
export async function twoFactorStatus(userId: number): Promise<TwoFactorStatus> {
  const row = await getDb()
    .selectFrom("users")
    .leftJoin(
      (eb) => eb.selectFrom("users").select(["id", "full_name"]).as("requirer"),
      (join) => join.onRef("requirer.id", "=", "users.mfa_required_by"),
    )
    .select([
      "users.totp_secret_enc",
      "users.mfa_mode",
      "users.mfa_required",
      "users.mfa_required_at",
      "requirer.full_name as required_by_name",
    ])
    .where("users.id", "=", userId)
    .executeTakeFirst();

  if (!row) {
    return {
      enabled: false,
      required: false,
      requiredBy: null,
      requiredAt: null,
      recoveryRemaining: 0,
    };
  }

  const enabled = twoFactorOn(row);
  return {
    enabled,
    required: isRequired(row),
    requiredBy: row.required_by_name ?? null,
    requiredAt: row.mfa_required_at,
    recoveryRemaining: enabled ? await countRecoveryCodes(userId) : 0,
  };
}

export { countRecoveryCodes };
