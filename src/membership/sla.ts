import "server-only";

import { sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import type { ProcessingTier, SlaPauseReason } from "@/db/schema";

/**
 * Working-day arithmetic, in SQL.
 *
 * The nth working day is one indexed query against `working_day_calendar`, and
 * it is done here rather than in TypeScript for a reason that is about
 * correctness and not performance: the admin queue, the applicant's tracker,
 * the breach report and the nudge email all have to agree about when an
 * application is due. Two implementations of "the 40th working day" is two
 * answers, and the one the applicant is shown would be the one nobody checks.
 *
 * `due_date` is then materialised onto `sla_clocks` and recomputed only on
 * pause, resume, or a calendar edit landing inside a running window. Breach is
 * evaluated on read — `due_date < CURDATE()` — exactly as the public site
 * already evaluates notice expiry, so nothing here needs a timer. Which is
 * just as well: this host cannot run one.
 */

/** Raised when the calendar does not reach far enough to answer. */
export class CalendarExhaustedError extends Error {
  constructor(from: string, workingDays: number) {
    super(
      `The working-day calendar does not extend far enough to find ` +
        `${workingDays} working days after ${from}. Extend it in the admin ` +
        `calendar before this tier can be promised.`,
    );
    this.name = "CalendarExhaustedError";
  }
}

/**
 * The nth working day strictly after `from`.
 *
 * Strictly after, not including: an application submitted on a Tuesday has not
 * used up Tuesday. The offset is `n - 1` because the first matching row *is*
 * the first working day.
 *
 * Throws rather than returning null when the calendar runs out. A null would
 * have to be handled by every caller and the tempting handling — fall back to
 * calendar days — would silently turn a 40-working-day promise into a
 * 40-day one. An error surfaces as a 503 the chamber can act on by extending
 * the calendar.
 */
export async function nthWorkingDayAfter(
  db: Queryable,
  from: string,
  workingDays: number,
): Promise<string> {
  if (!Number.isInteger(workingDays) || workingDays < 1) {
    throw new Error(`workingDays must be a positive integer, got ${workingDays}`);
  }

  const result = await sql<{ cal_date: string }>`
    SELECT cal_date
      FROM working_day_calendar
     WHERE is_working_day = 1
       AND cal_date > ${from}
     ORDER BY cal_date ASC
     LIMIT 1 OFFSET ${sql.raw(String(workingDays - 1))}
  `.execute(db);

  const row = result.rows[0];
  if (!row) throw new CalendarExhaustedError(from, workingDays);
  return row.cal_date;
}

/**
 * How many working days lie in `(from, to]`.
 *
 * Used to price a pause: the SLA report has to be able to say "32 working days
 * elapsed, 11 of them waiting on the applicant", which is the number that
 * matters when a member complains about a missed Executive promise.
 */
export async function workingDaysBetween(
  db: Queryable,
  from: string,
  to: string,
): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT COUNT(*) AS n
      FROM working_day_calendar
     WHERE is_working_day = 1
       AND cal_date > ${from}
       AND cal_date <= ${to}
  `.execute(db);

  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Start the clock for a submitted application.
 *
 * `working_days` is read from the fee row rather than from the tier constant,
 * because the fee schedule is what the applicant paid against and the chamber
 * can change it without a deploy. The constant in `workflow.ts` exists for the
 * UI and is checked against this by a test.
 */
export async function startSlaClock(
  db: Queryable,
  params: {
    readonly applicationId: number;
    readonly processingTier: ProcessingTier;
    readonly workingDays: number;
    readonly startedAt: Date;
  },
): Promise<{ dueDate: string }> {
  // The civil date the clock starts from, in UTC. The session is UTC, so this
  // and `CURDATE()` agree — which they would not if the pool left the session
  // in the server's own zone.
  const startDate = params.startedAt.toISOString().slice(0, 10);
  const dueDate = await nthWorkingDayAfter(db, startDate, params.workingDays);

  await db
    .insertInto("sla_clocks")
    .values({
      application_id: params.applicationId,
      processing_tier: params.processingTier,
      working_days: params.workingDays,
      started_at: params.startedAt,
      due_date: dueDate,
      state: "running",
    })
    .execute();

  return { dueDate };
}

/* -------------------------------------------------------------------------- */
/* Pausing and resuming                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Stop the clock, and say why.
 *
 * Guarded on `state = 'running'` and decided by the affected-row count, not by
 * reading the clock and then writing it: two officers raising a deficiency on
 * the same application in the same second would both read "running" and both
 * open a pause, and the second would be a stretch of time that never happened.
 *
 * Returns null when the clock was not running — already paused, already
 * stopped, or absent because the application was never submitted. The caller
 * decides whether that is a failure; for a deficiency it is not, because an
 * application can legitimately be returned twice without the clock restarting
 * in between.
 */
export async function pauseSlaClock(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    readonly reason: SlaPauseReason;
    readonly note?: string | null;
    readonly at: Date;
  },
): Promise<number | null> {
  const clock = await tx
    .selectFrom("sla_clocks")
    .select(["id"])
    .where("application_id", "=", params.applicationId)
    .executeTakeFirst();

  if (!clock) return null;

  const paused = await tx
    .updateTable("sla_clocks")
    .set({ state: "paused" })
    .where("id", "=", clock.id)
    .where("state", "=", "running")
    .executeTakeFirst();

  if (Number(paused.numUpdatedRows) !== 1) return null;

  const inserted = await tx
    .insertInto("sla_pauses")
    .values({
      sla_clock_id: clock.id,
      reason: params.reason,
      note: params.note ?? null,
      paused_at: params.at,
    })
    .executeTakeFirst();

  return Number(inserted.insertId);
}

/**
 * Start the clock again, and move the deadline out by what the pause cost.
 *
 * The promise is N working days *of the chamber's time*. An application
 * returned to the applicant for eleven working days has not consumed eleven
 * days of the chamber's forty, so `due_date` moves out by exactly the working
 * days the pause spanned — which is why the cost is measured here and stored
 * on the pause row rather than inferred later from two timestamps.
 *
 * `paused_working_days` accumulates alongside, because the report has to be
 * able to say "thirty-two working days elapsed, eleven of them waiting on the
 * applicant". That sentence is what matters when a member complains about a
 * missed Executive promise, and a single elapsed figure cannot produce it.
 *
 * A pause opened and closed inside one working day costs nothing and moves
 * nothing: there is no deadline to extend, and `nthWorkingDayAfter` refuses a
 * zero offset rather than quietly treating it as one.
 */
export async function resumeSlaClock(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    /** The stretch to close. Named, not "the latest", so two overlapping
     *  reasons cannot close each other's. */
    readonly pauseId: number | null;
    readonly at: Date;
  },
): Promise<{ resumed: boolean; costWorkingDays: number; dueDate: string | null }> {
  const clock = await tx
    .selectFrom("sla_clocks")
    .select(["id", "due_date", "paused_working_days"])
    .where("application_id", "=", params.applicationId)
    .executeTakeFirst();

  if (!clock) return { resumed: false, costWorkingDays: 0, dueDate: null };

  const pause = params.pauseId === null
    ? await tx
        .selectFrom("sla_pauses")
        .select(["id", "paused_at"])
        .where("sla_clock_id", "=", clock.id)
        .where("resumed_at", "is", null)
        .orderBy("paused_at", "desc")
        .executeTakeFirst()
    : await tx
        .selectFrom("sla_pauses")
        .select(["id", "paused_at"])
        .where("id", "=", params.pauseId)
        .where("resumed_at", "is", null)
        .executeTakeFirst();

  const resumedClock = await tx
    .updateTable("sla_clocks")
    .set({ state: "running" })
    .where("id", "=", clock.id)
    .where("state", "=", "paused")
    .executeTakeFirst();

  if (Number(resumedClock.numUpdatedRows) !== 1) {
    return { resumed: false, costWorkingDays: 0, dueDate: clock.due_date };
  }

  if (!pause) return { resumed: true, costWorkingDays: 0, dueDate: clock.due_date };

  const from = new Date(pause.paused_at).toISOString().slice(0, 10);
  const to = params.at.toISOString().slice(0, 10);
  const cost = await workingDaysBetween(tx, from, to);

  await tx
    .updateTable("sla_pauses")
    .set({ resumed_at: params.at, working_days_cost: cost })
    .where("id", "=", pause.id)
    .where("resumed_at", "is", null)
    .execute();

  if (cost === 0) {
    return { resumed: true, costWorkingDays: 0, dueDate: clock.due_date };
  }

  const dueDate = await nthWorkingDayAfter(tx, clock.due_date, cost);

  await tx
    .updateTable("sla_clocks")
    .set({
      due_date: dueDate,
      paused_working_days: Number(clock.paused_working_days) + cost,
    })
    .where("id", "=", clock.id)
    .execute();

  return { resumed: true, costWorkingDays: cost, dueDate };
}

/** True when a running clock has passed its promised date. */
export function isBreached(clock: {
  state: string;
  due_date: string;
  outcome: string | null;
}): boolean {
  if (clock.outcome !== null) return clock.outcome === "breached";
  if (clock.state === "stopped") return false;
  return clock.due_date < new Date().toISOString().slice(0, 10);
}
