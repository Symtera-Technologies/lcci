import "server-only";

import { getDb, sql, wonRace } from "@/db/client";
import type { UserType } from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import { writeAudit } from "@/server/audit";
import {
  hashOtpCode,
  hashIp,
  hashUserAgent,
  hmacHex,
  newOtpCode,
  newSalt,
  newUlid,
  timingSafeEqualHex,
} from "@/server/crypto";
import { env } from "@/server/env";
import { getMailer } from "@/server/mail/mailer";
import { sendNow } from "@/server/mail/outbox";
import { consume } from "@/server/rate-limit";
import { clearFailures, isLocked, recordFailure } from "@/server/auth/throttle";

/**
 * Member sign-in: a six-digit code to the registered address, no password.
 *
 * Members have `users.password_hash IS NULL` by design. Three reasons, in
 * order of weight. It removes the password-reset flow, which is the most
 * attacked part of any membership site and the one a secretariat has to staff.
 * It makes the legacy import of ~20,000 members tractable — email plus
 * membership number is enough, with no temporary credentials sitting in
 * mailboxes. And the credential a member cannot reuse from another site cannot
 * arrive here already breached.
 *
 * Staff are the opposite case and get password + TOTP (`totp.ts`), because an
 * emailed code would make the inbox the root credential for the accounts that
 * approve memberships and read every CNIC in the system.
 *
 * Two properties carry most of the security here, and both are easy to lose in
 * a refactor:
 *
 * - **Consumption is one guarded statement.** `UPDATE … WHERE id = ? AND
 *   code_hash = ? AND consumed_at IS NULL`, and the affected-row count decides
 *   who won. Passenger runs several workers, so a `SELECT` followed by an
 *   `UPDATE` is a live race whose prize is "the same code used twice".
 * - **Both paths do the same work.** An unregistered identifier still costs a
 *   code generation, a hash and an audit write, and returns the same message
 *   after the same floor delay. Membership numbers are sequential and
 *   guessable, so this is the one place in the application where enumeration
 *   resistance is load-bearing rather than hygiene.
 */

/** Ten minutes, and `auth.signIn.sent` says so in words. Change both or neither. */
export const OTP_LIFETIME_MINUTES = 10;

/**
 * The floor every sign-in request is held to, in milliseconds.
 *
 * A registered address costs an INSERT and a synchronous provider call; an
 * unregistered one costs neither. Without a floor the difference is hundreds
 * of milliseconds and the login form is an existence oracle.
 *
 * Stated plainly, because a comment claiming constant time would be false:
 * this equalises the common case and **does not** eliminate the channel. When
 * the provider is slower than the floor, a registered address is still the
 * slower response. The control that actually stops enumeration is the request
 * limit — three per identifier per hour and ten per address per hour makes
 * walking a membership-number range take years. The floor removes the cheap
 * signal; the limiter removes the attack.
 */
const TIMING_FLOOR_MS = 900;

/* -------------------------------------------------------------------------- */
/* Identifiers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the member typed, reduced to one canonical form.
 *
 * Lowercased because the bucket keys, the throttle axis and the
 * `identifier_hash` must all agree: `Owais@Example.com` and
 * `owais@example.com` are one account, and if they hash differently then three
 * requests become six and the rate limit has been halved by capitalisation.
 */
function normaliseIdentifier(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "");
}

function looksLikeEmail(identifier: string): boolean {
  return identifier.includes("@");
}

interface SignInUser {
  readonly id: number;
  readonly email: string;
  readonly userType: UserType;
  readonly roleVersion: number;
}

/**
 * Resolve an identifier to a member account, or to nothing.
 *
 * **Only email resolves today.** Sign-in by membership number needs the
 * `memberships` table, which arrives with approval and numbering (plan item
 * A7); until then no number exists in this system to sign in with. The
 * identifier is still accepted, hashed and rate-limited exactly as an address
 * would be, so the membership-number branch is a lookup to add here rather
 * than a flow to build — and so the generic response is already truthful.
 *
 * Staff are excluded deliberately. An emailed code must not be a second way
 * into an account whose first way is password + TOTP, and silently declining
 * is better than a message that confirms which addresses belong to staff.
 */
async function resolveIdentifier(identifier: string): Promise<SignInUser | null> {
  if (!looksLikeEmail(identifier)) return null;

  const row = await getDb()
    .selectFrom("users")
    .select(["id", "email", "user_type", "role_version"])
    .where("email", "=", identifier)
    .where("user_type", "=", "portal")
    .where("status", "=", "active")
    .executeTakeFirst();

  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    userType: row.user_type,
    roleVersion: row.role_version,
  };
}

/**
 * The actor for an event written before anyone is authenticated.
 *
 * The system is what wrote the row; the request's address and user agent are
 * context. Attributing a failed sign-in to the account whose address was typed
 * would put "this user did X" in the log for something a stranger did.
 */
function anonymousActor(
  requestId: string,
  ip: string | null,
  userAgent: string | null,
  user?: SignInUser,
): ActorContext {
  return {
    userId: user?.id ?? null,
    userType: user ? user.userType : "system",
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

async function floorDelay(startedAt: number): Promise<void> {
  const remaining = TIMING_FLOOR_MS - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

/* -------------------------------------------------------------------------- */
/* Issuing                                                                   */
/* -------------------------------------------------------------------------- */

export interface IssueInput {
  readonly identifier: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

export interface IssueResult {
  /**
   * False only when the request itself was refused — too many requests, or
   * asked again too soon. Never false because the identifier is unknown: the
   * caller must not be able to tell those apart, and this is the type that
   * stops it from accidentally doing so.
   */
  readonly accepted: boolean;
  readonly retryAfterSeconds: number;
  /** Refused for spacing rather than volume, so the copy can say "wait a moment". */
  readonly tooSoon: boolean;
  /**
   * The code itself, in development only, so the flow can be exercised with no
   * mail provider configured.
   *
   * Two conditions, both required: not production, **and** the active mailer is
   * the console one — so a staging box with real Postmark credentials never
   * echoes a code even if someone leaves `NODE_ENV` unset. `ConsoleMailer`
   * deliberately does not log message bodies (a code in a scrollback buffer is
   * still a code), which is precisely why it has to surface here instead.
   */
  readonly devCode?: string;
}

/** See `IssueResult.devCode`. Both conditions, never one. */
function mayEchoCode(): boolean {
  return !env.isProduction && getMailer().name === "console";
}

/**
 * Issue a sign-in code, or convincingly appear to.
 *
 * The lockout in `throttle.ts` is deliberately **not** consulted here. A lock
 * is earned by failed verifications, and verification is only reachable once a
 * code has been issued — so "this identifier is locked" would imply "this
 * identifier exists", said by the one endpoint that must never imply it. The
 * limits that apply at this step are existence-independent by construction.
 */
export async function issueSignInCode(input: IssueInput): Promise<IssueResult> {
  const startedAt = Date.now();
  const requestId = input.requestId ?? newUlid();
  const identifier = normaliseIdentifier(input.identifier);

  // An empty box is still charged against the limits. Otherwise the cheapest
  // way to probe is to submit nothing and watch what changes.
  const identifierHash = hmacHex(`otp:login:${identifier}`);

  const perIdentifier = await consume("otpRequestIdentifier", identifier);
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

  const user = identifier === "" ? null : await resolveIdentifier(identifier);

  // Generated on both paths. The cost is a few microseconds and it keeps the
  // two branches structurally identical, which is what stops a later edit from
  // reintroducing an early return that skips the work.
  const code = newOtpCode();
  const salt = newSalt();
  const codeHash = hashOtpCode(code, salt);

  if (!user) {
    await writeAudit(
      anonymousActor(requestId, input.ip, input.userAgent),
      {
        entityType: "user",
        // The hash, not the identifier. This event exists to make a sweep
        // across many identifiers visible, which needs them distinguishable,
        // not readable — and an audit log is not the place to accumulate the
        // addresses of people who do not have accounts.
        entityId: identifierHash,
        action: "user.sign_in_code_unknown_identifier",
        summary: "A sign-in code was requested for an identifier with no member account.",
        context: { looksLikeEmail: looksLikeEmail(identifier) },
      },
    );
    await floorDelay(startedAt);
    return { accepted: true, retryAfterSeconds: 0, tooSoon: false };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_LIFETIME_MINUTES * 60_000);

  // Issuing invalidates every prior unconsumed code for this identifier, in
  // one statement. Without it, asking for a second code because the first was
  // slow to arrive leaves two live codes and doubles the attempt budget.
  await getDb()
    .updateTable("otp_challenges")
    .set({ consumed_at: now })
    .where("identifier_hash", "=", identifierHash)
    .where("purpose", "=", "login")
    .where("consumed_at", "is", null)
    .execute();

  const inserted = await getDb()
    .insertInto("otp_challenges")
    .values({
      user_id: user.id,
      purpose: "login",
      identifier_hash: identifierHash,
      destination: user.email.slice(0, 190),
      code_hash: codeHash,
      salt,
      // Not bound to the requesting browser, and that is the right call for
      // this flow specifically: the code is read on a phone and typed on a
      // laptop more often than not, so a nonce check would reject the most
      // common honest use. `auth.code.wrongBrowser` is reserved for the
      // endorsement link, where the recipient and the browser are the same
      // person in the same sitting and the binding costs nothing.
      browser_nonce_hash: null,
      expires_at: expiresAt,
      created_ip_hash: hashIp(input.ip),
    })
    .executeTakeFirst();

  const challengeId = Number(inserted.insertId ?? 0);

  // Awaited, not queued. The page must not say "a code is on its way" when the
  // provider rejected the message — that sends a member to an inbox that will
  // never have anything in it, and the only recovery is to ask again and wait
  // again. This is the one message in the system sent synchronously.
  const { sent } = await sendNow({
    to: user.email,
    template: "sign-in-code",
    payload: { code },
    entityType: "user",
    entityId: user.id,
  });

  await writeAudit(anonymousActor(requestId, input.ip, input.userAgent, user), {
    entityType: "user",
    entityId: user.id,
    action: "user.sign_in_code_issued",
    summary: sent
      ? "A sign-in code was issued and sent."
      : "A sign-in code was issued but the provider refused the message.",
    // Never the code, and never the address — the address is already on the
    // user row this event points at, and repeating it here would put it in a
    // table that is append-only and kept for seven years.
    context: { challengeId, delivered: sent },
  });

  await floorDelay(startedAt);

  // Deliberately `accepted: true` even when the provider refused. The member
  // is told the same thing either way; the failure is in the audit log and the
  // outbox row, where someone can act on it. Surfacing "we could not send it"
  // here would confirm the address exists.
  return {
    accepted: true,
    retryAfterSeconds: 0,
    tooSoon: false,
    ...(mayEchoCode() ? { devCode: code } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Verifying                                                                 */
/* -------------------------------------------------------------------------- */

export type VerifyFailure =
  /** Wrong, expired, already used, or never issued. One reason on purpose. */
  | "invalid"
  /** The attempt budget for this code, or the verify limit, is spent. */
  | "too-many"
  /** Escalating lockout on the identifier or the address. */
  | "locked";

export interface VerifyInput {
  readonly identifier: string;
  readonly code: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId?: string;
}

export type VerifyResult =
  | { readonly ok: true; readonly user: SignInUser; readonly challengeId: number }
  | {
      readonly ok: false;
      readonly reason: VerifyFailure;
      readonly retryAfterSeconds: number;
    };

/**
 * Check a code and consume it.
 *
 * Failures are recorded on the throttle axes **whether or not the identifier
 * exists**, which is what keeps the lockout from becoming the oracle that
 * issuing refuses to be: a lock can be earned against an identifier that was
 * never registered, so its presence says nothing.
 */
export async function verifySignInCode(input: VerifyInput): Promise<VerifyResult> {
  const requestId = input.requestId ?? newUlid();
  const identifier = normaliseIdentifier(input.identifier);
  const identifierHash = hmacHex(`otp:login:${identifier}`);
  const code = input.code.replace(/\D/g, "");
  const subjects = { identifier, ip: input.ip };

  const lock = await isLocked(subjects);
  if (lock.locked) {
    return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };
  }

  const limit = await consume("otpVerifyIdentifier", identifier);
  if (!limit.allowed) {
    return { ok: false, reason: "too-many", retryAfterSeconds: limit.retryAfterSeconds };
  }

  const db = getDb();
  const now = new Date();

  // Several rows only if something went wrong with invalidation, but the query
  // is written to tolerate it rather than to assume. `id desc` so the newest
  // code is the one whose attempt counter moves.
  const candidates = await db
    .selectFrom("otp_challenges")
    .select(["id", "user_id", "code_hash", "salt", "attempts", "max_attempts"])
    .where("identifier_hash", "=", identifierHash)
    .where("purpose", "=", "login")
    .where("consumed_at", "is", null)
    .where("expires_at", ">", now)
    .orderBy("id", "desc")
    .limit(5)
    .execute();

  const failGenerically = async (
    reason: VerifyFailure,
    detail: string,
    userId: number | null,
  ): Promise<VerifyResult> => {
    await recordFailure(subjects);
    await writeAudit(anonymousActor(requestId, input.ip, input.userAgent), {
      entityType: "user",
      entityId: userId ?? identifierHash,
      action: "user.sign_in_failed",
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
      "A sign-in code was submitted with no live challenge for that identifier.",
      null,
    );
  }

  // Constant-time over the candidates, and over the digits of the hash rather
  // than of the code. Comparing hashes means a near-miss code leaks nothing
  // about how near it was.
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
        ? "A sign-in code reached its attempt limit and is now dead."
        : "An incorrect sign-in code was submitted.",
      newest.user_id,
    );
  }

  if (match.attempts >= match.max_attempts) {
    return failGenerically(
      "too-many",
      "The correct sign-in code was submitted after its attempt budget was spent.",
      match.user_id,
    );
  }

  // The consumption. Everything above is lookup; this is the statement that
  // decides, and it decides by affected-row count. Two workers racing the same
  // code both reach here and exactly one sees a row.
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
    // The code was right and someone else consumed it first. No throttle
    // failure is recorded: the usual cause is a double-submitted form, and
    // charging an honest member towards a lockout for clicking twice is worse
    // than the replay this would otherwise deter — which the dead code already
    // deters by being dead.
    await writeAudit(anonymousActor(requestId, input.ip, input.userAgent), {
      entityType: "user",
      entityId: match.user_id ?? identifierHash,
      action: "user.sign_in_code_replayed",
      summary: "A correct sign-in code was submitted after it had already been consumed.",
      context: { challengeId: match.id },
    });
    return { ok: false, reason: "invalid", retryAfterSeconds: 0 };
  }

  // Re-read rather than trusting the challenge's `user_id`: the account may
  // have been suspended, or a member may have lapsed, in the ten minutes since
  // the code was issued. The code proves possession of the inbox, not that the
  // account is still allowed in.
  const user = match.user_id
    ? await db
        .selectFrom("users")
        .select(["id", "email", "user_type", "role_version"])
        .where("id", "=", match.user_id)
        .where("user_type", "=", "portal")
        .where("status", "=", "active")
        .executeTakeFirst()
    : undefined;

  if (!user) {
    return failGenerically(
      "invalid",
      "A correct sign-in code was submitted for an account that is no longer active.",
      match.user_id,
    );
  }

  const signInUser: SignInUser = {
    id: user.id,
    email: user.email,
    userType: user.user_type,
    roleVersion: user.role_version,
  };

  await clearFailures(subjects);

  await db
    .updateTable("users")
    .set({ last_login_at: now, failed_logins: 0, locked_until: null })
    .where("id", "=", user.id)
    .execute();

  await writeAudit(anonymousActor(requestId, input.ip, input.userAgent, signInUser), {
    entityType: "user",
    entityId: user.id,
    action: "user.signed_in",
    summary: "A member signed in with an emailed code.",
    context: { challengeId: match.id, method: "otp" },
  });

  return { ok: true, user: signInUser, challengeId: match.id };
}

/* -------------------------------------------------------------------------- */
/* Housekeeping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Drop challenges nothing can use.
 *
 * Called by the retention sweep. Consumed and expired rows are not just clutter
 * — `destination` holds an email address, so a row that can no longer
 * authenticate anything is pure retained PII.
 */
export async function purgeOtpChallenges(olderThanDays = 2): Promise<number> {
  const result = await sql`
    DELETE FROM otp_challenges
     WHERE expires_at < UTC_TIMESTAMP(3) - INTERVAL ${sql.lit(olderThanDays)} DAY
     LIMIT 5000
  `.execute(getDb());

  return Number(result.numAffectedRows ?? 0);
}
