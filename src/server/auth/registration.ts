import "server-only";

import { getDb, sql, wonRace } from "@/db/client";
import { writeAudit } from "@/server/audit";
import {
  hashIp,
  hashOtpCode,
  hmacHex,
  newOtpCode,
  newSalt,
  newUlid,
  timingSafeEqualHex,
} from "@/server/crypto";
import { sendNow } from "@/server/mail/outbox";
import { consume } from "@/server/rate-limit";
import { clearFailures, isLocked, recordFailure } from "@/server/auth/throttle";
import {
  anonymousActor,
  floorDelay,
  mayEchoCode,
  normaliseIdentifier,
  OTP_LIFETIME_MINUTES,
  type SignInUser,
} from "@/server/auth/otp";

/**
 * Opening an account, which is the front door the system did not have.
 *
 * Everything downstream of this file was already built — the wizard, the
 * officer's queue, verification, receipting, approval, the membership number —
 * and none of it was reachable by a firm that had never dealt with the Chamber
 * before. `issueSignInCode` resolves an address to an existing `portal` user
 * and silently does nothing when there is none, so the only accounts in
 * existence were the ones a developer script had made. A prospective member
 * had no way in at all.
 *
 * This is deliberately *not* a second authentication mechanism. It is the same
 * one, pointed at an account that does not exist yet: a six-digit code to the
 * address the applicant typed, no password ever, and the code is what proves
 * the inbox is theirs. Members have `password_hash IS NULL` by design and that
 * does not change here — see the header of `otp.ts` for why, and note that a
 * registration form with a password field would have quietly reintroduced the
 * reset flow that decision exists to avoid.
 *
 * Four properties carry this file. Each is easy to lose and expensive to lose.
 *
 * **Registering an address that already has an account signs that account
 * in.** Not "an account already exists with that email" — that sentence is an
 * existence oracle on a public form, and the address is the one thing an
 * attacker starts with. So both paths look identical from outside: a code goes
 * to the address, and entering it lands you in the member area, whether the
 * account was made a minute ago or last year. The returning member who
 * forgot they had an account gets in rather than getting an error, which is
 * the same behaviour for a better reason.
 *
 * **The account is created unverified and cannot sign in.** The row is written
 * at `status = 'invited'`, and `resolveIdentifier` in `otp.ts` requires
 * `status = 'active'` — so an account nobody has proved an inbox for is inert
 * everywhere else in the system. Verification is the transition, and it is the
 * only one.
 *
 * **The limits are the sign-in limits, not new ones.** `otpRequestIdentifier`
 * and `otpRequestIp` are consumed here with the same keys, so three codes an
 * hour means three in total and not three per endpoint. Separate buckets would
 * have doubled every published figure the moment this file landed.
 *
 * **Nothing here tells a staff address apart from a stranger's.** A staff
 * account must never acquire an emailed-code path — it has a password and an
 * authenticator precisely because it approves memberships and reads CNICs —
 * and refusing it in words would also confirm which addresses belong to
 * officers. It does the same work, sends nothing, and answers the same.
 */

/* -------------------------------------------------------------------------- */
/* The challenge namespace                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Registration codes live under `email_verify`, sign-in codes under `login`,
 * and the `identifier_hash` prefix differs with them.
 *
 * The separation is the thing that stops a code issued for one purpose from
 * satisfying the other: a code mailed to confirm an address cannot be replayed
 * into the sign-in form, and a sign-in code cannot activate a dormant invited
 * account. Both lookups are by `(identifier_hash, purpose)`, so the two
 * namespaces cannot meet even by accident.
 */
const PURPOSE = "email_verify" as const;

function challengeKey(email: string): string {
  return hmacHex(`otp:${PURPOSE}:${email}`);
}

/* -------------------------------------------------------------------------- */
/* Starting                                                                   */
/* -------------------------------------------------------------------------- */

export interface StartRegistrationInput {
  /** The person, not the firm. The firm is named in the wizard. */
  readonly fullName: string;
  readonly email: string;
  /** Already E.164, or null. `toE164` in `src/lib/phone.ts` decides. */
  readonly mobile: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

export interface StartRegistrationResult {
  /**
   * False only when the request itself was refused — too many, or too soon.
   * Never false because of anything about the address: that is the whole
   * point, and this is the type that stops a later edit from leaking it.
   */
  readonly accepted: boolean;
  readonly retryAfterSeconds: number;
  readonly tooSoon: boolean;
  /** Development only, and only with no mail provider. See `mayEchoCode`. */
  readonly devCode?: string;
}

/**
 * Take a registration, and send a code — or convincingly appear to.
 *
 * The order is the same as `issueSignInCode` and for the same reasons: limits
 * before any lookup, the code generated on every path, one floor delay on the
 * way out of all of them.
 */
export async function startRegistration(
  input: StartRegistrationInput,
): Promise<StartRegistrationResult> {
  const startedAt = Date.now();
  const requestId = input.requestId ?? newUlid();
  const email = normaliseIdentifier(input.email);
  const identifierHash = challengeKey(email);

  const perIdentifier = await consume("otpRequestIdentifier", email);
  if (!perIdentifier.allowed) {
    await floorDelay(startedAt);
    return {
      accepted: false,
      retryAfterSeconds: perIdentifier.retryAfterSeconds,
      tooSoon: perIdentifier.tooSoon === true,
    };
  }

  const perIp = await consume("otpRequestIp", input.ip ?? "unknown");
  if (!perIp.allowed) {
    await floorDelay(startedAt);
    return {
      accepted: false,
      retryAfterSeconds: perIp.retryAfterSeconds,
      tooSoon: perIp.tooSoon === true,
    };
  }

  // Generated before the branch, like sign-in's, so the two paths stay
  // structurally identical and a later edit cannot reintroduce an early return
  // that skips the work.
  const code = newOtpCode();
  const salt = newSalt();
  const codeHash = hashOtpCode(code, salt);

  const account = email === "" ? null : await openAccount(email, input, requestId);

  if (!account) {
    await floorDelay(startedAt);
    return { accepted: true, retryAfterSeconds: 0, tooSoon: false };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MINUTES * 60_000);
  const db = getDb();

  // One statement, and it kills every live code for this address. Without it,
  // asking for a second code because the first was slow leaves two live codes
  // and doubles the attempt budget against them.
  await db
    .updateTable("otp_challenges")
    .set({ consumed_at: now })
    .where("identifier_hash", "=", identifierHash)
    .where("purpose", "=", PURPOSE)
    .where("consumed_at", "is", null)
    .execute();

  const inserted = await db
    .insertInto("otp_challenges")
    .values({
      user_id: account.id,
      purpose: PURPOSE,
      identifier_hash: identifierHash,
      destination: account.email.slice(0, 190),
      code_hash: codeHash,
      salt,
      // Not bound to the requesting browser, for the reason sign-in gives: the
      // code is read on a phone and typed on a laptop more often than not, and
      // a nonce check would refuse the commonest honest use.
      browser_nonce_hash: null,
      expires_at: expiresAt,
      created_ip_hash: hashIp(input.ip),
    })
    .executeTakeFirst();

  const challengeId = Number(inserted.insertId ?? 0);

  // Awaited, not queued — the one place this flow copies sign-in exactly. The
  // page must not say "a code is on its way" when the provider rejected the
  // message: that sends a new applicant to an inbox that will never have
  // anything in it, and their only recovery is to ask again and wait again.
  const { sent } = await sendNow({
    to: account.email,
    template: "email-verification",
    payload: { code },
    entityType: "user",
    entityId: account.id,
  });

  await writeAudit(anonymousActor(requestId, input.ip, input.userAgent), {
    entityType: "user",
    entityId: account.id,
    action: "user.registration_code_issued",
    summary: sent
      ? "A confirmation code was issued and sent for a membership account."
      : "A confirmation code was issued but the provider refused the message.",
    // Never the code, and never the address — the address is on the user row
    // this event already points at, and the audit log is kept for seven years.
    // `created` is here because it is the one fact that distinguishes a new
    // firm from a returning one, and the secretariat cannot read it anywhere
    // else: the applicant-facing answer is deliberately the same either way.
    context: { challengeId, delivered: sent, created: account.created },
  });

  await floorDelay(startedAt);

  return {
    accepted: true,
    retryAfterSeconds: 0,
    tooSoon: false,
    ...(mayEchoCode() ? { devCode: code } : {}),
  };
}

interface OpenedAccount {
  readonly id: number;
  readonly email: string;
  /** True only when this request wrote the row. For the audit log, not the UI. */
  readonly created: boolean;
}

/**
 * Find the account this registration belongs to, or make one — or decline, in
 * silence.
 *
 * Returning null means "send nothing and say the usual thing". It happens for
 * a staff address and for a member the Chamber has suspended, and in both
 * cases the event is written so the refusal is findable by somebody who can
 * act on it.
 */
async function openAccount(
  email: string,
  input: StartRegistrationInput,
  requestId: string,
): Promise<OpenedAccount | null> {
  const db = getDb();

  const existing = await db
    .selectFrom("users")
    .select(["id", "email", "user_type", "status"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (existing) {
    const declined = async (action: string, summary: string): Promise<null> => {
      await writeAudit(anonymousActor(requestId, input.ip, input.userAgent), {
        entityType: "user",
        entityId: existing.id,
        action,
        summary,
        context: { userType: existing.user_type, status: existing.status },
      });
      return null;
    };

    if (existing.user_type === "staff") {
      // An emailed code must not become a second way into an account whose
      // first way is a password and an authenticator.
      return declined(
        "user.registration_refused_staff_address",
        "Registration was attempted with an address that belongs to a staff account.",
      );
    }

    if (existing.status === "suspended" || existing.status === "disabled") {
      // Re-registering must not be a way to walk back a suspension. The
      // applicant is told what everybody is told; the Chamber decided this
      // account's status and only the Chamber can change it.
      return declined(
        "user.registration_refused_account_closed",
        "Registration was attempted for a member account that is suspended or disabled.",
      );
    }

    if (existing.status === "invited") {
      // Nobody has ever authenticated as this row — it was created by an
      // earlier registration that was never confirmed — so the name and mobile
      // from this attempt replace what is on it. Whoever confirms the inbox is
      // overwhelmingly the person who just filled the form in, and their own
      // name is the right one to have on the account. The window in which this
      // could carry somebody else's name is one code lifetime, and an officer
      // can correct a name; an account permanently stuck with the name of the
      // first person to type the address could not be corrected by the owner
      // at all.
      await db
        .updateTable("users")
        .set({ full_name: input.fullName, mobile_e164: input.mobile })
        .where("id", "=", existing.id)
        .where("status", "=", "invited")
        .execute();
    }

    // Active: this registration is a sign-in, and is answered as one.
    return { id: existing.id, email: existing.email, created: false };
  }

  try {
    const inserted = await db
      .insertInto("users")
      .values({
        user_type: "portal",
        email,
        full_name: input.fullName,
        mobile_e164: input.mobile,
        // Explicit, although it is also the column default: a member's second
        // factor *is* the emailed code, and a row that said anything else here
        // would describe an account this system cannot sign in.
        mfa_mode: "otp_email",
        // The whole safety of creating a row for an unproven address. Nothing
        // in the system will authenticate it until the code comes back.
        status: "invited",
      })
      .executeTakeFirst();

    return { id: Number(inserted.insertId ?? 0), email, created: true };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;

    // Two registrations for one new address, at once. `uq_users_email` picked
    // a winner; this request adopts it rather than failing in front of an
    // applicant who did nothing wrong. Re-read rather than assume it is a
    // portal row: the collision could equally be with a staff account created
    // in the same moment.
    const won = await db
      .selectFrom("users")
      .select(["id", "email", "user_type", "status"])
      .where("email", "=", email)
      .executeTakeFirst();

    if (!won || won.user_type !== "portal") return null;
    if (won.status === "suspended" || won.status === "disabled") return null;
    return { id: won.id, email: won.email, created: false };
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}

/* -------------------------------------------------------------------------- */
/* Completing                                                                 */
/* -------------------------------------------------------------------------- */

export type CompleteRegistrationFailure =
  /** Wrong, expired, already used, or never issued. One reason on purpose. */
  | "invalid"
  /** The attempt budget for this code, or the verify limit, is spent. */
  | "too-many"
  /** Escalating lockout on the address or the requesting network. */
  | "locked";

export interface CompleteRegistrationInput {
  readonly email: string;
  readonly code: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

export type CompleteRegistrationResult =
  | {
      readonly ok: true;
      readonly user: SignInUser;
      /** True when this call activated the account. For copy, not for access. */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: CompleteRegistrationFailure;
      readonly retryAfterSeconds: number;
    };

/**
 * Check the code, activate the account, and report who to sign in.
 *
 * Deliberately a near-copy of `verifySignInCode` rather than a call into it:
 * the lookup is on a different purpose, the account it accepts may be
 * `invited` rather than `active`, and the activation is a write sign-in must
 * never make. Sharing the body would mean a parameter deciding whether a dead
 * account can be woken up, which is the kind of flag that eventually gets
 * passed from the wrong place. What is shared is everything that must not
 * diverge — normalisation, the throttle axes, the limit, the floor.
 *
 * The consumption is the one statement that decides, and it decides by
 * affected-row count, because Passenger runs several workers and a `SELECT`
 * followed by an `UPDATE` is a live race whose prize is one code used twice.
 */
export async function completeRegistration(
  input: CompleteRegistrationInput,
): Promise<CompleteRegistrationResult> {
  const requestId = input.requestId ?? newUlid();
  const email = normaliseIdentifier(input.email);
  const identifierHash = challengeKey(email);
  const code = input.code.replace(/\D/g, "");
  const subjects = { identifier: email, ip: input.ip };

  const lock = await isLocked(subjects);
  if (lock.locked) {
    return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };
  }

  const limit = await consume("otpVerifyIdentifier", email);
  if (!limit.allowed) {
    return { ok: false, reason: "too-many", retryAfterSeconds: limit.retryAfterSeconds };
  }

  const db = getDb();
  const now = new Date();

  const candidates = await db
    .selectFrom("otp_challenges")
    .select(["id", "user_id", "code_hash", "salt", "attempts", "max_attempts"])
    .where("identifier_hash", "=", identifierHash)
    .where("purpose", "=", PURPOSE)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", now)
    .orderBy("id", "desc")
    .limit(5)
    .execute();

  const failGenerically = async (
    reason: CompleteRegistrationFailure,
    detail: string,
    userId: number | null,
  ): Promise<CompleteRegistrationResult> => {
    await recordFailure(subjects);
    await writeAudit(anonymousActor(requestId, input.ip, input.userAgent), {
      entityType: "user",
      // The hash where there is no account: an audit log kept for seven years
      // should not accumulate the addresses of people who have none.
      entityId: userId ?? identifierHash,
      action: "user.registration_failed",
      summary: detail,
      context: { reason },
    });
    const after = await isLocked(subjects);
    return {
      ok: false,
      reason: after.locked ? "locked" : reason,
      retryAfterSeconds: after.retryAfterSeconds,
    };
  };

  if (candidates.length === 0) {
    return failGenerically(
      "invalid",
      "A confirmation code was submitted with no live challenge for that address.",
      null,
    );
  }

  // Over the hashes, not the codes: a near-miss then leaks nothing about how
  // near it was.
  const match = candidates.find((row) =>
    timingSafeEqualHex(row.code_hash, hashOtpCode(code, row.salt)),
  );

  if (!match) {
    const newest = candidates[0];
    await db
      .updateTable("otp_challenges")
      .set({ attempts: sql<number>`attempts + 1` })
      .where("id", "=", newest.id)
      .where("consumed_at", "is", null)
      .execute();

    const spent = newest.attempts + 1 >= newest.max_attempts;
    return failGenerically(
      spent ? "too-many" : "invalid",
      spent
        ? "A confirmation code reached its attempt limit and is now dead."
        : "An incorrect confirmation code was submitted.",
      newest.user_id,
    );
  }

  if (match.attempts >= match.max_attempts) {
    return failGenerically(
      "too-many",
      "The correct confirmation code was submitted after its attempt budget was spent.",
      match.user_id,
    );
  }

  const consumed = await db
    .updateTable("otp_challenges")
    .set({ consumed_at: now })
    .where("id", "=", match.id)
    .where("code_hash", "=", match.code_hash)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", now)
    .where(sql<boolean>`attempts < max_attempts`)
    .executeTakeFirst();

  if (!wonRace(consumed)) {
    // Right code, somebody else consumed it first — nearly always a
    // double-submitted form. No throttle failure is recorded: charging an
    // honest applicant towards a lockout for clicking twice is worse than the
    // replay this would deter, which the dead code already deters by being
    // dead.
    await writeAudit(anonymousActor(requestId, input.ip, input.userAgent), {
      entityType: "user",
      entityId: match.user_id ?? identifierHash,
      action: "user.registration_code_replayed",
      summary: "A correct confirmation code was submitted after it had been consumed.",
      context: { challengeId: match.id },
    });
    return { ok: false, reason: "invalid", retryAfterSeconds: 0 };
  }

  // Re-read rather than trusting the challenge's `user_id`. Ten minutes is
  // long enough for an officer to suspend an account, and the code proves
  // possession of an inbox — not that the account is allowed in.
  const user = match.user_id
    ? await db
        .selectFrom("users")
        .select(["id", "email", "user_type", "status", "role_version", "email_verified_at"])
        .where("id", "=", match.user_id)
        .where("user_type", "=", "portal")
        .executeTakeFirst()
    : undefined;

  if (!user || (user.status !== "invited" && user.status !== "active")) {
    return failGenerically(
      "invalid",
      "A correct confirmation code was submitted for an account that cannot be signed in.",
      match.user_id,
    );
  }

  const activating = user.status === "invited";

  if (activating) {
    // Guarded on the status it is leaving, so two requests racing the same
    // activation produce one of them. `role_version` moves because the row's
    // status moved: the invariant in `0001_identity.sql` is that any change to
    // status, roles or permissions invalidates every session minted before it.
    // There are none to invalidate for an account that has never signed in,
    // and an invariant honoured only when it is observable is an invariant
    // somebody will be surprised by later.
    await db
      .updateTable("users")
      .set({
        status: "active",
        email_verified_at: now,
        role_version: sql<number>`role_version + 1`,
        last_login_at: now,
        failed_logins: 0,
        locked_until: null,
      })
      .where("id", "=", user.id)
      .where("status", "=", "invited")
      .execute();
  } else {
    await db
      .updateTable("users")
      .set({
        // Only if it was never set. An address confirmed in 2026 was not
        // confirmed again today, and overwriting the date would lose the one
        // fact the column records.
        email_verified_at: user.email_verified_at ?? now,
        last_login_at: now,
        failed_logins: 0,
        locked_until: null,
      })
      .where("id", "=", user.id)
      .execute();
  }

  // Read back, never computed. The session is minted with this number and dies
  // the moment it changes, so a value this function guessed at — `+ 1` in
  // TypeScript against a `+ 1` in SQL — would be a session that is invalid the
  // instant it is issued, on the one path where the member has no older
  // session to fall back to.
  const fresh = await db
    .selectFrom("users")
    .select(["role_version", "status"])
    .where("id", "=", user.id)
    .executeTakeFirstOrThrow();

  if (fresh.status !== "active") {
    return failGenerically(
      "invalid",
      "A confirmation code was accepted but the account did not become active.",
      user.id,
    );
  }

  await clearFailures(subjects);

  await writeAudit(
    anonymousActor(requestId, input.ip, input.userAgent, {
      id: user.id,
      email: user.email,
      userType: "portal",
      roleVersion: fresh.role_version,
    }),
    {
      entityType: "user",
      entityId: user.id,
      // Two actions rather than one with a flag, because these are two
      // different things to find in the log: the day an account came into
      // existence, and a sign-in. The second is spelled exactly as the sign-in
      // form spells it, so "how did this member get in" has one answer to
      // search for however they got to the form.
      action: activating ? "user.registered" : "user.signed_in",
      summary: activating
        ? "A membership account was created and its email address confirmed."
        : "A member signed in with a confirmation code from the registration form.",
      context: { challengeId: match.id, method: PURPOSE },
    },
  );

  return {
    ok: true,
    created: activating,
    user: {
      id: user.id,
      email: user.email,
      userType: "portal",
      roleVersion: fresh.role_version,
    },
  };
}
