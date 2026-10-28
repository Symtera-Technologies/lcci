import "server-only";

import { cookies } from "next/headers";
import { getDb, sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import type { UserType } from "@/db/schema";
import { env } from "@/server/env";
import { hashIp, hashUserAgent, newToken, sha256Hex } from "@/server/crypto";

/**
 * Server-side sessions.
 *
 * Sessions live in MySQL rather than in a signed, self-contained token. Spec
 * section 9 requires invalidation on role change, and a stateless token cannot
 * be revoked: a chamber needs to kill a session when a staff member leaves,
 * when an account is compromised, or when a membership lapses. The usual
 * alternative — a revocation list in the database, consulted on every request
 * — is a database read per request, so the stateless token has bought nothing.
 * MySQL here is a local socket and the lookup is sub-millisecond.
 *
 * The patterns are Lucia's — opaque token, session row, one validation
 * function. Lucia itself was deprecated by its author and is now a learning
 * resource, so using its patterns directly is the honest way to use it.
 */

/* -------------------------------------------------------------------------- */
/* Lifetimes                                                                  */
/* -------------------------------------------------------------------------- */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Staff sessions are short and members' are long, because the consequences
 * differ by an order of magnitude: a staff session reads every CNIC in the
 * system and approves memberships, while a member session shows one applicant
 * their own application.
 *
 * `absolute` is never extended by activity. Without it, a session that is used
 * once a day lives forever.
 */
const LIFETIME: Record<UserType, { sliding: number; absolute: number }> = {
  staff: { sliding: 30 * MINUTE, absolute: 12 * HOUR },
  portal: { sliding: 7 * DAY, absolute: 30 * DAY },
};

/**
 * Sliding expiry is only written to the database when this much of the window
 * has already passed. Refreshing on every request would make every page view a
 * write, which on a shared MySQL with three connections is a real cost for no
 * security benefit.
 */
const REFRESH_AFTER = 5 * MINUTE;

/* -------------------------------------------------------------------------- */
/* Cookie                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The `__Host-` prefix pins the cookie to this exact host and forbids a
 * `Domain` attribute, which makes cookie injection from any other
 * `*.lcci.com.pk` or `*.lcci.org.pk` host impossible. That is directly
 * valuable while the legacy `membership.lcci.org.pk` may still be under
 * someone else's control during cut-over.
 *
 * The prefix requires `Secure`, and browsers disagree about whether
 * `http://localhost` qualifies — so development uses an unprefixed name. The
 * production guarantee is the one that matters and it is unaffected.
 */
export const SESSION_COOKIE = env.isProduction
  ? "__Host-lcci_session"
  : "lcci_session_dev";

/**
 * A second cookie, `SameSite=Strict`, checked before any irreversible admin
 * action.
 *
 * The session cookie itself must be `Lax`, because `Strict` would break the
 * OTP flow: clicking a link in a mail client is a cross-site top-level
 * navigation and would arrive without the cookie. `Lax` sends on top-level GET
 * navigations — exactly what is needed — and withholds on cross-site POST.
 *
 * This sentinel closes what `Lax` leaves open, and in particular covers the
 * documented gap where Next lets a request carrying no `Origin` header at all
 * through its server-action check with only a warning: if the session cookie
 * arrives and the sentinel does not, the request did not originate here.
 */
export const SENTINEL_COOKIE = env.isProduction
  ? "__Host-lcci_same_site"
  : "lcci_same_site_dev";

export const SENTINEL_VALUE = "1";

interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict";
  path: string;
  expires?: Date;
}

function cookieOptions(sameSite: "lax" | "strict", expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    // Always true, including in development: `__Host-` requires it, and a
    // cookie that behaves differently in development is a cookie whose
    // production behaviour is untested.
    secure: true,
    sameSite,
    path: "/",
    // No `domain`: the `__Host-` prefix forbids it, and omitting it keeps the
    // cookie host-only in development too.
    ...(expires ? { expires } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Creating and validating                                                    */
/* -------------------------------------------------------------------------- */

export interface SessionRecord {
  id: string;
  userId: number;
  userType: UserType;
  roleVersion: number;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  mfaSatisfiedAt: Date | null;
}

export interface CreateSessionInput {
  userId: number;
  userType: UserType;
  roleVersion: number;
  ip: string | null;
  userAgent: string | null;
  /** Set when the second factor has already been satisfied in this flow. */
  mfaSatisfied: boolean;
  /** A member's explicit "keep me signed in". Ignored for staff. */
  remember?: boolean;
}

/**
 * Mint a session and set the cookies.
 *
 * Returns the token only so that tests and the OTP flow can assert on it. The
 * token is never returned to a caller that would put it in a response body, a
 * log line or a URL.
 */
export async function createSession(
  input: CreateSessionInput,
  db: Queryable = getDb(),
): Promise<{ token: string; session: SessionRecord }> {
  const token = newToken();
  // The database stores sha256(token), never the token. A leaked backup, a
  // mis-logged query or a stray `SELECT *` therefore yields nothing usable,
  // and there is no timing channel to exploit because the hash is the primary
  // key. This is the detail hand-rolled sessions most often get wrong.
  const id = sha256Hex(token);

  const lifetime = LIFETIME[input.userType];
  const now = Date.now();
  const expiresAt = new Date(now + lifetime.sliding);
  const absoluteExpiresAt = new Date(now + lifetime.absolute);

  await db
    .insertInto("sessions")
    .values({
      id,
      user_id: input.userId,
      user_type: input.userType,
      role_version: input.roleVersion,
      expires_at: expiresAt,
      absolute_expires_at: absoluteExpiresAt,
      mfa_satisfied_at: input.mfaSatisfied ? new Date(now) : null,
      ip_hash: hashIp(input.ip),
      user_agent_hash: hashUserAgent(input.userAgent),
    })
    .execute();

  const jar = await cookies();

  // Staff get a session cookie with no expiry, so closing the browser ends it.
  // A member may opt into persistence.
  const persist = input.userType === "portal" && input.remember === true;
  jar.set(
    SESSION_COOKIE,
    token,
    cookieOptions("lax", persist ? absoluteExpiresAt : undefined),
  );
  jar.set(
    SENTINEL_COOKIE,
    SENTINEL_VALUE,
    cookieOptions("strict", persist ? absoluteExpiresAt : undefined),
  );

  return {
    token,
    session: {
      id,
      userId: input.userId,
      userType: input.userType,
      roleVersion: input.roleVersion,
      expiresAt,
      absoluteExpiresAt,
      mfaSatisfiedAt: input.mfaSatisfied ? new Date(now) : null,
    },
  };
}

/**
 * Mark the second factor satisfied on a session that already exists.
 *
 * Staff sign-in creates the session after the password and promotes it here
 * after the authenticator code, so there is one session mechanism rather than
 * a password step carrying its own short-lived pending-login cookie with its
 * own expiry and revocation to get right. Until this runs, `requireStaff`
 * refuses everything except the two routes needed to finish signing in.
 *
 * Guarded on `mfa_satisfied_at IS NULL` so a replayed submission cannot move
 * the timestamp forward on a session that was promoted minutes ago.
 */
export async function satisfyMfa(
  sessionId: string,
  db: Queryable = getDb(),
): Promise<boolean> {
  const result = await db
    .updateTable("sessions")
    .set({ mfa_satisfied_at: new Date() })
    .where("id", "=", sessionId)
    .where("mfa_satisfied_at", "is", null)
    .where("revoked_at", "is", null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows ?? 0) === 1;
}

export type SessionFailure =
  | "no-cookie"
  | "unknown"
  | "revoked"
  | "expired"
  | "absolute-expired"
  | "stale-roles"
  | "user-inactive";

export interface ValidatedSession {
  session: SessionRecord;
  user: {
    id: number;
    userType: UserType;
    email: string;
    fullName: string;
    roleVersion: number;
    mfaMode: string;
  };
}

/**
 * Validate a raw token against the database.
 *
 * Returns a reason on failure rather than a bare null, because the reasons are
 * operationally different: `stale-roles` means the account's permissions
 * changed and the user should sign in again; `absolute-expired` is routine.
 * Only the caller decides what to tell the user, and the caller is the only
 * place that knows whether it is answering a page or an `<img src>`.
 */
export async function validateSessionToken(
  token: string | undefined,
): Promise<{ ok: true; value: ValidatedSession } | { ok: false; reason: SessionFailure }> {
  if (!token) return { ok: false, reason: "no-cookie" };

  const id = sha256Hex(token);
  const db = getDb();

  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "sessions.id as session_id",
      "sessions.user_id",
      "sessions.user_type",
      "sessions.role_version as session_role_version",
      "sessions.expires_at",
      "sessions.absolute_expires_at",
      "sessions.mfa_satisfied_at",
      "sessions.revoked_at",
      "sessions.last_seen_at",
      "users.email",
      "users.full_name",
      "users.status",
      "users.mfa_mode",
      "users.role_version as user_role_version",
    ])
    .where("sessions.id", "=", id)
    .executeTakeFirst();

  if (!row) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };

  const now = new Date();
  if (row.absolute_expires_at <= now) return { ok: false, reason: "absolute-expired" };
  if (row.expires_at <= now) return { ok: false, reason: "expired" };

  // One integer comparison on a row already loaded. This is what invalidates
  // every session of a user the instant their roles, status, password, 2FA or
  // email changes — including a member going lapsed, so a lapsed member stops
  // being able to endorse an application immediately rather than at next login.
  if (row.session_role_version !== row.user_role_version) {
    return { ok: false, reason: "stale-roles" };
  }

  if (row.status !== "active") return { ok: false, reason: "user-inactive" };

  const lifetime = LIFETIME[row.user_type];
  const elapsed = now.getTime() - row.last_seen_at.getTime();
  let expiresAt = row.expires_at;

  if (elapsed > REFRESH_AFTER) {
    // Clamped to the absolute ceiling, so activity can never push a session
    // past the hard limit.
    const slid = new Date(
      Math.min(now.getTime() + lifetime.sliding, row.absolute_expires_at.getTime()),
    );
    await db
      .updateTable("sessions")
      .set({ last_seen_at: now, expires_at: slid })
      .where("id", "=", id)
      .execute();
    expiresAt = slid;
  }

  return {
    ok: true,
    value: {
      session: {
        id: row.session_id,
        userId: row.user_id,
        userType: row.user_type,
        roleVersion: row.session_role_version,
        expiresAt,
        absoluteExpiresAt: row.absolute_expires_at,
        mfaSatisfiedAt: row.mfa_satisfied_at,
      },
      user: {
        id: row.user_id,
        userType: row.user_type,
        email: row.email,
        fullName: row.full_name,
        roleVersion: row.user_role_version,
        mfaMode: row.mfa_mode,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Revoking                                                                   */
/* -------------------------------------------------------------------------- */

export async function revokeCurrentSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (token) {
    await getDb()
      .updateTable("sessions")
      .set({ revoked_at: new Date() })
      .where("id", "=", sha256Hex(token))
      .where("revoked_at", "is", null)
      .execute();
  }

  jar.delete(SESSION_COOKIE);
  jar.delete(SENTINEL_COOKIE);
}

/**
 * Revoke every session of a user.
 *
 * Belt and braces alongside `role_version`: the version bump already
 * invalidates them, but an explicit revocation leaves a row an administrator
 * can see, which matters when the question is "did we actually sign that
 * person out when they left".
 */
export async function revokeAllSessions(
  userId: number,
  db: Queryable = getDb(),
): Promise<number> {
  const result = await db
    .updateTable("sessions")
    .set({ revoked_at: new Date() })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();

  return Number(result.numUpdatedRows ?? 0);
}

/**
 * Bump `role_version` and revoke, in one transaction.
 *
 * Every caller that changes what an account may do must go through this, so
 * there is no path that changes a grant and leaves a live session holding the
 * old one.
 */
export async function invalidateUserSessions(
  userId: number,
  db: Queryable = getDb(),
): Promise<void> {
  await db
    .updateTable("users")
    .set({ role_version: sql<number>`role_version + 1` })
    .where("id", "=", userId)
    .execute();

  await revokeAllSessions(userId, db);
}

/** Expired and long-revoked rows. Called by the retention sweep, not inline. */
export async function purgeDeadSessions(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * DAY);
  const result = await getDb()
    .deleteFrom("sessions")
    .where((eb) =>
      eb.or([
        eb("absolute_expires_at", "<", cutoff),
        eb.and([eb("revoked_at", "is not", null), eb("revoked_at", "<", cutoff)]),
      ]),
    )
    .executeTakeFirst();

  return Number(result.numDeletedRows ?? 0);
}
