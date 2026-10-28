import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import type { Queryable } from "@/db/client";
import type { ThrottleAxis } from "@/db/schema";
import { hmacHex } from "@/server/crypto";

/**
 * Login lockout, on two axes at once.
 *
 * Time-based on **both** the identifier and the address, because each alone
 * fails in a different direction. Lock only by address and one NAT'd office —
 * which is how a Pakistani chamber's members mostly reach the internet — locks
 * itself out the moment any one person fumbles a code. Lock only by
 * identifier and an attacker sprays a thousand membership numbers from one
 * machine without ever tripping anything.
 *
 * Separate from `rate-limit.ts` on purpose. That module caps *volume* and
 * forgets; this one escalates and is about a specific credential being
 * attacked. A failed sign-in should get slower each time; a request for a
 * press release should not.
 *
 * Buckets are peppered HMACs, never the address or the email itself, so this
 * table is not a log of who tried to sign in from where. It is in every
 * backup and is read by whoever is debugging a lockout, and neither of those
 * should disclose a member's address.
 */

/**
 * Escalating lock durations, in minutes.
 *
 * Four failures earn fifteen minutes, then an hour, then four hours, then a
 * day. Capped rather than unbounded: a permanent lock reached by failing is a
 * denial-of-service against a member whose own mistakes caused it, and the
 * person who has to undo it is the secretariat.
 */
const LOCK_MINUTES = [15, 60, 240, 1440] as const;

/** Failures tolerated inside one window before a lock is applied. */
const FAILURES_BEFORE_LOCK = 5;

/**
 * How long a quiet period clears the slate.
 *
 * A member who failed twice this morning and returns in the evening starts
 * fresh. Without this, counters accumulate across months and the first failure
 * of the year locks an account.
 */
const FORGET_AFTER_MINUTES = 60;

export interface LockState {
  readonly locked: boolean;
  /** Seconds until the lock lifts. Zero when not locked. */
  readonly retryAfterSeconds: number;
}

function bucketFor(axis: ThrottleAxis, subject: string): string {
  return `${axis}:${hmacHex(subject.trim().toLowerCase())}`;
}

/**
 * Is either axis locked?
 *
 * Checked before any work is done, and — importantly — the caller must behave
 * identically whether the answer is "locked" or "that identifier does not
 * exist". A locked account that says so is an account that has been confirmed
 * to exist.
 */
export async function isLocked(
  subjects: { readonly identifier: string; readonly ip: string | null },
  db: Queryable = getDb(),
): Promise<LockState> {
  const buckets = [bucketFor("identifier", subjects.identifier)];
  if (subjects.ip) buckets.push(bucketFor("ip", subjects.ip));

  const rows = await db
    .selectFrom("login_throttle")
    .select(["locked_until"])
    .where("bucket", "in", buckets)
    .where("locked_until", "is not", null)
    .execute();

  const now = Date.now();
  let until = 0;

  for (const row of rows) {
    const at = row.locked_until ? row.locked_until.getTime() : 0;
    if (at > until) until = at;
  }

  if (until <= now) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: Math.ceil((until - now) / 1000) };
}

/**
 * Record a failed attempt on both axes.
 *
 * One statement per bucket, `INSERT … ON DUPLICATE KEY UPDATE`, so two
 * concurrent failures cannot both read a count of two and both write three.
 * The escalation step is computed in SQL for the same reason: read-then-write
 * across two statements is how a brute-force run stays one failure below the
 * threshold forever.
 */
export async function recordFailure(subjects: {
  readonly identifier: string;
  readonly ip: string | null;
}): Promise<void> {
  const entries: { bucket: string; axis: ThrottleAxis }[] = [
    { bucket: bucketFor("identifier", subjects.identifier), axis: "identifier" },
  ];
  if (subjects.ip) {
    entries.push({ bucket: bucketFor("ip", subjects.ip), axis: "ip" });
  }

  await transaction(async (tx) => {
    for (const entry of entries) {
      await sql`
        INSERT INTO login_throttle
          (bucket, axis, failures, escalation, first_failure_at, last_failure_at)
        VALUES
          (${entry.bucket}, ${entry.axis}, 1, 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          -- A quiet hour forgets the earlier failures, so an honest member who
          -- mistyped a code last week does not start today one away from a lock.
          failures = IF(
            last_failure_at < UTC_TIMESTAMP(3) - INTERVAL ${sql.lit(FORGET_AFTER_MINUTES)} MINUTE,
            1,
            failures + 1
          ),
          last_failure_at = UTC_TIMESTAMP(3)
      `.execute(tx);

      // The lock itself is a second statement against the row just updated,
      // because the duration depends on the new count and MySQL will not let
      // an ON DUPLICATE KEY UPDATE read its own result.
      await sql`
        UPDATE login_throttle
           SET escalation = LEAST(escalation + 1, ${sql.lit(LOCK_MINUTES.length - 1)}),
               locked_until = UTC_TIMESTAMP(3) + INTERVAL ELT(
                 LEAST(escalation + 1, ${sql.lit(LOCK_MINUTES.length)}),
                 ${sql.lit(LOCK_MINUTES[0])},
                 ${sql.lit(LOCK_MINUTES[1])},
                 ${sql.lit(LOCK_MINUTES[2])},
                 ${sql.lit(LOCK_MINUTES[3])}
               ) MINUTE,
               failures = 0
         WHERE bucket = ${entry.bucket}
           AND failures >= ${sql.lit(FAILURES_BEFORE_LOCK)}
      `.execute(tx);
    }
  });
}

/**
 * Clear both axes after a success.
 *
 * The identifier always; the address only because the person at it has just
 * proved they hold a real credential. Leaving the address counter standing
 * after a successful sign-in would mean one member's typos slowly lock out
 * their colleagues on the same office connection.
 */
export async function clearFailures(subjects: {
  readonly identifier: string;
  readonly ip: string | null;
}): Promise<void> {
  const buckets = [bucketFor("identifier", subjects.identifier)];
  if (subjects.ip) buckets.push(bucketFor("ip", subjects.ip));

  await getDb().deleteFrom("login_throttle").where("bucket", "in", buckets).execute();
}

/** Drop rows nothing is counting any more. Called by the nightly sweep. */
export async function purgeThrottle(olderThanDays = 7): Promise<number> {
  const result = await sql`
    DELETE FROM login_throttle
     WHERE last_failure_at < UTC_TIMESTAMP(3) - INTERVAL ${sql.lit(olderThanDays)} DAY
       AND (locked_until IS NULL OR locked_until < UTC_TIMESTAMP(3))
  `.execute(getDb());

  return Number(result.numAffectedRows ?? 0);
}
