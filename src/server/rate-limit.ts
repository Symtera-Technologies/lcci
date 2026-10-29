import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import { hmacHex } from "@/server/crypto";
import { log } from "@/server/log";

/**
 * Rate limiting, in MySQL.
 *
 * Not in process memory, and the reason is structural rather than a
 * preference: Passenger spawns several worker processes and respawns them
 * whenever `tmp/restart.txt` is touched. An in-memory counter is therefore
 * per-worker and resets on deploy, so "five attempts" becomes "five attempts
 * per worker, until the next release" — which is not a limit. MySQL is the
 * only state shared between workers on this host.
 *
 * Two strategies, because the right one differs by bucket:
 *
 * - **Fixed window** (`rate_limit_counters`) for high-volume, low-value
 *   buckets. One atomic statement per check.
 * - **Sliding window** (`rate_limit_events`) for the few small, high-value
 *   buckets — login, OTP request, OTP verify. A fixed window permits a 2x
 *   burst across the boundary, and the login form is precisely where that
 *   matters.
 *
 * The honest limitation, which belongs in writing to the chamber rather than
 * buried here: this protects *correctness*, not *availability*. Every check is
 * a database round trip, and a real flood still consumes a Passenger worker
 * and a connection per request before this code runs at all. We can stop
 * credential stuffing and form spam. We cannot absorb a denial-of-service
 * attack — that needs something in front of the origin.
 */

export interface LimitRule {
  /** Identifies the bucket family, e.g. `otp:request:identifier`. */
  scope: string;
  /** Maximum events allowed in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Sliding is more accurate and costs a row per event; fixed is one upsert.
   * Use sliding where a boundary burst would matter.
   */
  strategy: "fixed" | "sliding";
  /** Minimum seconds between two events. Enforced for sliding buckets only. */
  minIntervalSeconds?: number;
}

/**
 * The limits.
 *
 * Numbers chosen to be survivable by a real user on a slow connection and
 * unhelpful to an attacker. The OTP ones are the pair that matters: the
 * per-code attempt counter stops brute-forcing one code, and the per-identifier
 * request limit stops cycling codes to buy more attempts. Either alone is
 * close to useless.
 */
export const LIMITS = {
  /** A member or applicant asking for a sign-in code. */
  otpRequestIdentifier: {
    scope: "otp:request:identifier",
    limit: 3,
    windowSeconds: 3600,
    strategy: "sliding",
    minIntervalSeconds: 60,
  },
  otpRequestIp: {
    scope: "otp:request:ip",
    limit: 10,
    windowSeconds: 3600,
    strategy: "sliding",
  },
  /**
   * Deliberately absent from the CAPTCHA list and present here: the user is
   * already mid-flow, and the per-code attempt counter already covers
   * brute force. Friction at this step costs completions and buys nothing.
   */
  otpVerifyIdentifier: {
    scope: "otp:verify:identifier",
    limit: 10,
    windowSeconds: 900,
    strategy: "sliding",
  },
  /** A staff password attempt. Lockout escalation lives in `login_throttle`. */
  staffPasswordAccount: {
    scope: "login:password:account",
    limit: 5,
    windowSeconds: 900,
    strategy: "sliding",
  },
  /**
   * A staff member confirming their own password to change a security
   * setting — today, to turn two-factor off.
   *
   * Tighter than the sign-in limit, and sliding, because the attacker this
   * guards against is not at the front door: they are holding a session
   * borrowed from an unlocked machine and guessing at the password that
   * protects the one control that would make the theft permanent. Five
   * attempts an hour is more than a person who knows their own password
   * needs. `login_throttle` escalates on top of this, on the same subject
   * pair as the sign-in form, so grinding here locks the account there too.
   */
  staffReauth: {
    scope: "login:reauth:account",
    limit: 5,
    windowSeconds: 3600,
    strategy: "sliding",
  },
  /** Public forms: newsletter, trade enquiry, contact. */
  publicFormIp: {
    scope: "form:public:ip",
    limit: 5,
    windowSeconds: 3600,
    strategy: "fixed",
  },
  /** Document upload, per session. */
  uploadSession: {
    scope: "upload:session",
    limit: 30,
    windowSeconds: 3600,
    strategy: "fixed",
  },
  /**
   * Document fetch, per session. A range flood is a cheap way to pin a
   * shared-plan worker on disk I/O, so even an authorised reader is capped.
   */
  documentFetchSession: {
    scope: "document:fetch:session",
    limit: 300,
    windowSeconds: 3600,
    strategy: "fixed",
  },
  /** An endorsement token being presented. */
  endorsementToken: {
    scope: "endorsement:verify:token",
    limit: 10,
    windowSeconds: 86_400,
    strategy: "fixed",
  },
  /**
   * The wizard's autosave, per signed-in applicant.
   *
   * Set high on purpose. This is someone filling in a sixty-field form over
   * several sittings, and every debounced keystroke burst is a hit; a limit
   * tight enough to be interesting would start refusing to save a genuine
   * applicant's work, which is the one failure this form cannot afford. It is
   * here to cap a scripted write loop against the database, not to police
   * typing.
   */
  wizardAutosave: {
    scope: "membership:autosave:actor",
    limit: 600,
    windowSeconds: 3600,
    strategy: "fixed",
  },
  /**
   * Submission, per applicant.
   *
   * Sliding rather than fixed: the thing being guarded against is a burst of
   * identical submit clicks, and a fixed window lets a burst through at the
   * boundary. The transition itself is already race-safe, so this is about not
   * spending ten transactions on one impatient click.
   */
  applicationSubmit: {
    scope: "membership:submit:actor",
    limit: 10,
    windowSeconds: 3600,
    strategy: "sliding",
    minIntervalSeconds: 5,
  },
  /**
   * A content save, per staff account.
   *
   * Generous, for the same reason the autosave limit is: this is an editor
   * working, and a limit tight enough to be interesting would start refusing
   * somebody's copy. It is here because each save is a transaction plus an
   * audit insert plus a revalidation of every public page, so a scripted loop
   * is expensive in a way an ordinary read is not.
   */
  contentSave: {
    scope: "content:save:actor",
    limit: 300,
    windowSeconds: 3600,
    strategy: "fixed",
  },
  /** CSP violation reports, per address. Browsers can be enthusiastic. */
  cspReportIp: {
    scope: "csp:report:ip",
    limit: 30,
    windowSeconds: 600,
    strategy: "fixed",
  },
} as const satisfies Record<string, LimitRule>;

export type LimitName = keyof typeof LIMITS;

export interface LimitResult {
  allowed: boolean;
  /** How many of the window's allowance remain. */
  remaining: number;
  /** Seconds until the caller may retry. Zero when allowed. */
  retryAfterSeconds: number;
  /** True when refused for spacing rather than for volume. */
  tooSoon?: boolean;
}

/**
 * Build a bucket key.
 *
 * The subject is always hashed with the pepper before it becomes a key, so
 * this table is not a log of who did what from where. That matters because the
 * rate-limit tables are in every backup and are read by anyone debugging a
 * lockout, which is a much wider audience than the audit log's.
 */
function bucketKey(scope: string, subject: string, windowStart?: Date): string {
  return windowStart
    ? `${bucketPrefix(scope, subject)}${Math.floor(windowStart.getTime() / 1000)}`
    : `${scope}:${hmacHex(`${scope}:${subject}`).slice(0, 32)}`;
}

/**
 * Everything in a fixed-window key except the window itself, trailing colon
 * included — the stable part that identifies one subject across every window
 * it has touched. `reset` matches on it.
 */
function bucketPrefix(scope: string, subject: string): string {
  return `${scope}:${hmacHex(`${scope}:${subject}`).slice(0, 32)}:`;
}

/**
 * The `LIKE` escape character, and the escaping to match.
 *
 * Deliberately `!` rather than the conventional backslash. A backslash has to
 * survive two escaping layers that do not agree — the TypeScript template
 * literal and MySQL's own string parser — so writing the clause as
 * `ESCAPE '\\'` in source emits `ESCAPE '\'` to the server, where the
 * backslash escapes the closing quote and the statement dies on an
 * unterminated string. Four backslashes would work and would be wrong to
 * leave for the next reader. `!` needs no escaping in either layer.
 *
 * The scopes in this file contain no wildcards today, which is exactly the
 * kind of fact that stops being true the week someone adds one with an
 * underscore — and `_` matches any single character, so an unescaped reset
 * would delete other subjects' rows.
 */
const LIKE_ESCAPE_CHARACTER = "!";

function likeEscape(value: string): string {
  return value.replace(/[!%_]/g, (character) => `${LIKE_ESCAPE_CHARACTER}${character}`);
}

/**
 * Check and consume one unit of allowance.
 *
 * Fails **open** on a database error, and that is a deliberate trade worth
 * naming: a limiter that fails closed turns a transient database blip into a
 * site-wide sign-in outage. The thing behind every limited route is itself
 * authenticated and audited, so a brief window of unlimited attempts is a
 * smaller harm than locking every member out. The error is logged so the blip
 * is visible.
 */
export async function consume(
  name: LimitName,
  subject: string,
): Promise<LimitResult> {
  const rule: LimitRule = LIMITS[name];

  try {
    return rule.strategy === "sliding"
      ? await consumeSliding(rule, subject)
      : await consumeFixed(rule, subject);
  } catch (error) {
    log.warn("rate limit check failed; allowing", {
      bucket: rule.scope,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

async function consumeFixed(rule: LimitRule, subject: string): Promise<LimitResult> {
  const now = Date.now();
  const windowMs = rule.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs);
  const bucket = bucketKey(rule.scope, subject, windowStart);

  /**
   * Increment and read back *this caller's own* count, atomically.
   *
   * The obvious shape — `INSERT ... ON DUPLICATE KEY UPDATE hits = hits + 1`
   * followed by a `SELECT hits` — is atomic in neither the useful sense nor
   * the obvious one. The increment is atomic, but the read is a second
   * statement, and under concurrency every caller's read happens after every
   * caller's write: twelve simultaneous requests all increment to twelve and
   * then all read twelve, so all twelve are refused and a limit of five
   * rejects the five it was supposed to admit. The failure only appears under
   * exactly the load the limiter exists for, which is the worst place for it
   * to hide.
   *
   * `LAST_INSERT_ID(expr)` is MySQL's answer: it sets a *session*-scoped value
   * as a side effect of the write, so each connection reads back the number
   * its own statement produced. It is given explicitly on the insert path too,
   * because this table is keyed on `bucket` and has no AUTO_INCREMENT column
   * for it to pick up from.
   *
   * Both statements must run on one connection for a session variable to mean
   * anything, and Kysely takes a fresh connection per statement — hence the
   * transaction, which pins one for the pair.
   */
  const hits = await transaction(async (tx) => {
    await sql`
      INSERT INTO rate_limit_counters (bucket, hits, window_started_at, expires_at)
      VALUES (${bucket}, LAST_INSERT_ID(1), ${windowStart}, ${expiresAt})
      ON DUPLICATE KEY UPDATE hits = LAST_INSERT_ID(hits + 1)
    `.execute(tx);

    const counted = await sql<{ hits: number }>`
      SELECT LAST_INSERT_ID() AS hits
    `.execute(tx);

    return Number(counted.rows[0]?.hits ?? 1);
  });

  const allowed = hits <= rule.limit;

  return {
    allowed,
    remaining: Math.max(0, rule.limit - hits),
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((expiresAt.getTime() - now) / 1000)),
  };
}

async function consumeSliding(rule: LimitRule, subject: string): Promise<LimitResult> {
  const db = getDb();
  const bucket = bucketKey(rule.scope, subject);
  const now = new Date();
  const windowStart = new Date(now.getTime() - rule.windowSeconds * 1000);

  const existing = await db
    .selectFrom("rate_limit_events")
    .select(({ fn }) => [
      fn.count<number>("id").as("hits"),
      fn.max("at").as("latest"),
    ])
    .where("bucket", "=", bucket)
    .where("at", ">=", windowStart)
    .executeTakeFirst();

  const hits = Number(existing?.hits ?? 0);
  const latest = existing?.latest ? new Date(existing.latest) : null;

  // Spacing is checked before volume, and a refusal here does NOT record an
  // event. Otherwise an impatient user double-clicking "send me a code" would
  // spend their hourly allowance on requests that were never honoured.
  if (rule.minIntervalSeconds && latest) {
    const sinceSeconds = (now.getTime() - latest.getTime()) / 1000;
    if (sinceSeconds < rule.minIntervalSeconds) {
      return {
        allowed: false,
        remaining: Math.max(0, rule.limit - hits),
        retryAfterSeconds: Math.ceil(rule.minIntervalSeconds - sinceSeconds),
        tooSoon: true,
      };
    }
  }

  if (hits >= rule.limit) {
    // The window slides, so the earliest event in it is what frees a slot.
    const oldest = await db
      .selectFrom("rate_limit_events")
      .select("at")
      .where("bucket", "=", bucket)
      .where("at", ">=", windowStart)
      .orderBy("at", "asc")
      .limit(1)
      .executeTakeFirst();

    const freesAt = oldest
      ? oldest.at.getTime() + rule.windowSeconds * 1000
      : now.getTime() + rule.windowSeconds * 1000;

    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)),
    };
  }

  await db.insertInto("rate_limit_events").values({ bucket, at: now }).execute();

  return {
    allowed: true,
    remaining: Math.max(0, rule.limit - hits - 1),
    retryAfterSeconds: 0,
  };
}

/**
 * Clear a subject's sliding events — on a successful sign-in, for example.
 *
 * Without this, a member who mistypes their code four times and then succeeds
 * still carries four failures for the rest of the hour, and the next genuine
 * attempt is refused for no reason they can see.
 */
export async function reset(name: LimitName, subject: string): Promise<void> {
  const rule: LimitRule = LIMITS[name];

  try {
    if (rule.strategy === "sliding") {
      await getDb()
        .deleteFrom("rate_limit_events")
        .where("bucket", "=", bucketKey(rule.scope, subject))
        .execute();
      return;
    }

    /**
     * Fixed-window buckets carry the window start in the key, so there is no
     * single row to delete — a subject has one row per window it touched, and
     * the caller knows the subject rather than the windows. Matching on the
     * stable `scope:digest:` prefix clears them all, and the prefix is a
     * leftmost match on the primary key, so it is an index range rather than a
     * scan.
     *
     * An earlier version returned early here instead, which made `reset` a
     * function that silently did nothing for most of the limits defined in
     * this file. A successful no-op is worse than an error: the caller that
     * resets a limit after, say, a successful sign-in had no way to find out
     * the allowance was never actually cleared.
     */
    const pattern = `${likeEscape(bucketPrefix(rule.scope, subject))}%`;
    await sql`
      DELETE FROM rate_limit_counters
       WHERE bucket LIKE ${pattern} ESCAPE ${sql.lit(LIKE_ESCAPE_CHARACTER)}
    `.execute(getDb());
  } catch (error) {
    log.warn("rate limit reset failed", {
      bucket: rule.scope,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Delete expired rows. Called by the retention sweep, in bounded batches.
 *
 * Never on the request path: a DELETE that scans a growing table is exactly
 * the kind of work that turns a sign-in into a timeout under load.
 */
export async function sweep(batch = 5000): Promise<{ counters: number; events: number }> {
  const db = getDb();
  const now = new Date();

  const counters = await sql`
    DELETE FROM rate_limit_counters WHERE expires_at < ${now} LIMIT ${sql.lit(batch)}
  `.execute(db);

  // The longest sliding window is 24 hours; two days of history is generous
  // and keeps the table small enough to stay in memory.
  const cutoff = new Date(now.getTime() - 2 * 86_400_000);
  const events = await sql`
    DELETE FROM rate_limit_events WHERE at < ${cutoff} LIMIT ${sql.lit(batch)}
  `.execute(db);

  return {
    counters: Number(counters.numAffectedRows ?? 0),
    events: Number(events.numAffectedRows ?? 0),
  };
}
