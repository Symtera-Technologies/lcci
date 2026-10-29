import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import type { Queryable } from "@/db/client";
import type { CalendarConfidence } from "@/db/schema";
import { requirePermission, type ActorContext } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { nthWorkingDayAfter } from "@/membership/sla";
import { TIER_WORKING_DAYS } from "@/membership/workflow";

/**
 * The working-day calendar, as editable reference data.
 *
 * Pakistani public holidays cannot be computed, and this module exists because
 * of that one fact. Eid, Ashura and Eid Milad-un-Nabi are lunar and officially
 * notified days in advance; Eid routinely shifts on the moon sighting; bank
 * holidays matter in their own right because a pay order cannot be issued or
 * realised on one; and Lahore adds closures for security and smog that nobody
 * could derive from anything. A computed calendar would look authoritative and
 * miss paid deadlines, which is the worst of both.
 *
 * So the seed is Monday to Friday, every row marked `provisional`, and the
 * holidays arrive here as the secretariat is told about them. `0010_seed_calendar.sql`
 * says so in its header and names this screen as where they go.
 *
 * Two consequences the rest of the module is shaped by.
 *
 * **An edit moves deadlines that have already been quoted.** A holiday
 * notified in the middle of a running forty-day window makes the fortieth
 * working day later than the date the applicant was told. That is correct —
 * the promise was in working days — but it must never happen silently, so
 * every edit flags the clocks it touches and the recompute writes one audit
 * event per deadline it moves.
 *
 * **A calendar that stops is a tier that cannot be promised.** `nthWorkingDayAfter`
 * throws `CalendarExhaustedError` rather than falling back to calendar days,
 * which is right, but it surfaces as a failure at the moment an applicant
 * presses submit. `calendarReach` exists so the chamber sees it coming.
 */

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface CalendarDay {
  readonly date: string;
  readonly isWorkingDay: boolean;
  readonly label: string | null;
  readonly confidence: CalendarConfidence;
  readonly source: string | null;
  readonly notifiedOn: string | null;
  /** 1 = Sunday … 7 = Saturday, as MySQL's `DAYOFWEEK` reports it. */
  readonly weekday: number;
}

export interface CalendarReach {
  readonly firstDate: string | null;
  readonly lastDate: string | null;
  /** Working days left in the calendar after today. */
  readonly workingDaysAhead: number;
  /**
   * The latest date on which each tier could still be promised, or null where
   * the calendar no longer reaches far enough to promise it at all.
   */
  readonly tierHorizon: Readonly<Record<string, string | null>>;
  /** Years the calendar covers, for the year picker. */
  readonly years: readonly number[];
}

const DEVIATION_SQL = sql<boolean>`
  (is_working_day = 1 AND DAYOFWEEK(cal_date) IN (1, 7))
  OR (is_working_day = 0 AND DAYOFWEEK(cal_date) NOT IN (1, 7))
`;

/**
 * The days somebody decided about, rather than all 365 of them.
 *
 * A year of rows is a year of rows, and almost every one of them says only
 * "this was a Tuesday". What a secretariat needs to read back is the set of
 * deviations from the Monday-to-Friday assumption: the notified holidays, and
 * any weekend the chamber worked. Everything else is the assumption, which is
 * stated once at the top of the screen rather than 260 times down it.
 */
export async function listDeviations(
  actor: ActorContext,
  year: number,
  db: Queryable = getDb(),
): Promise<readonly CalendarDay[]> {
  requirePermission(actor, "calendar.manage");

  const result = await sql<{
    cal_date: string;
    is_working_day: number;
    label_en: string | null;
    confidence: CalendarConfidence;
    source: string | null;
    notified_on: string | null;
    weekday: number;
  }>`
    SELECT cal_date, is_working_day, label_en, confidence, source, notified_on,
           DAYOFWEEK(cal_date) AS weekday
      FROM working_day_calendar
     WHERE YEAR(cal_date) = ${year}
       AND (${DEVIATION_SQL})
     ORDER BY cal_date ASC
  `.execute(db);

  return result.rows.map(toDay);
}

/** One day, for the edit form to show what it is about to change. */
export async function getCalendarDay(
  actor: ActorContext,
  date: string,
  db: Queryable = getDb(),
): Promise<CalendarDay | null> {
  requirePermission(actor, "calendar.manage");

  const result = await sql<{
    cal_date: string;
    is_working_day: number;
    label_en: string | null;
    confidence: CalendarConfidence;
    source: string | null;
    notified_on: string | null;
    weekday: number;
  }>`
    SELECT cal_date, is_working_day, label_en, confidence, source, notified_on,
           DAYOFWEEK(cal_date) AS weekday
      FROM working_day_calendar
     WHERE cal_date = ${date}
  `.execute(db);

  const row = result.rows[0];
  return row ? toDay(row) : null;
}

/**
 * How far the calendar reaches, and what can still be promised against it.
 *
 * The horizon per tier is the question that actually matters, and it is not
 * "when does the calendar end". An Executive application promises three
 * working days: it can be accepted until three working days before the last
 * row. A Regular one promises forty. So the calendar running out hits the
 * cheapest tier first and the chamber's most expensive promise last, which is
 * precisely backwards from how anyone would notice it by eye.
 */
export async function calendarReach(
  actor: ActorContext,
  db: Queryable = getDb(),
): Promise<CalendarReach> {
  requirePermission(actor, "calendar.manage");

  const bounds = await sql<{ first_date: string | null; last_date: string | null }>`
    SELECT MIN(cal_date) AS first_date, MAX(cal_date) AS last_date
      FROM working_day_calendar
  `.execute(db);

  const firstDate = bounds.rows[0]?.first_date ?? null;
  const lastDate = bounds.rows[0]?.last_date ?? null;

  const today = new Date().toISOString().slice(0, 10);

  const ahead = await sql<{ n: number }>`
    SELECT COUNT(*) AS n
      FROM working_day_calendar
     WHERE is_working_day = 1
       AND cal_date > ${today}
  `.execute(db);

  const workingDaysAhead = Number(ahead.rows[0]?.n ?? 0);

  /**
   * Counted backwards from the end rather than forwards from today.
   *
   * "The latest day an Executive promise can be made" is the working day with
   * exactly three working days after it, which is a row offset from the tail
   * of the calendar. Reading it this way means the answer does not change
   * when somebody opens the screen on a different date, and it degrades
   * honestly: a tier the calendar cannot cover at all returns null instead of
   * a date in the past.
   */
  const tierHorizon: Record<string, string | null> = {};
  for (const [tier, workingDays] of Object.entries(TIER_WORKING_DAYS)) {
    const row = await sql<{ cal_date: string }>`
      SELECT cal_date
        FROM working_day_calendar
       WHERE is_working_day = 1
       ORDER BY cal_date DESC
       LIMIT 1 OFFSET ${sql.raw(String(workingDays))}
    `.execute(db);

    const horizon = row.rows[0]?.cal_date ?? null;
    tierHorizon[tier] = horizon !== null && horizon >= today ? horizon : null;
  }

  const years = await sql<{ y: number }>`
    SELECT DISTINCT YEAR(cal_date) AS y
      FROM working_day_calendar
     ORDER BY y ASC
  `.execute(db);

  return {
    firstDate,
    lastDate,
    workingDaysAhead,
    tierHorizon,
    years: years.rows.map((row) => Number(row.y)),
  };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface SetDayInput {
  readonly date: string;
  readonly isWorkingDay: boolean;
  readonly label: string | null;
  readonly confidence: CalendarConfidence;
  readonly source: string | null;
  readonly notifiedOn: string | null;
}

export interface SetDayResult {
  readonly changed: boolean;
  /** Running and paused clocks whose window spans this date. */
  readonly clocksFlagged: number;
}

/**
 * Record one day, and flag every deadline it may have moved.
 *
 * An upsert rather than an update, so a date outside the seeded range can be
 * entered — a holiday notified for a year nobody has extended into yet is
 * still worth recording, and the extend action will not overwrite it.
 *
 * The flagging is the part that matters. Changing a Thursday in March to a
 * closure makes every running fortieth-working-day fall one day later, and
 * those dates are already in applicants' inboxes. Setting `needs_recompute`
 * here and recomputing in the job keeps the edit cheap — a secretary entering
 * five Eid days should not wait on five full recomputes — while making it
 * impossible for the edit to land without the deadlines following it.
 */
export async function setCalendarDay(
  actor: ActorContext,
  input: SetDayInput,
): Promise<SetDayResult> {
  requirePermission(actor, "calendar.manage");

  return transaction(async (tx) => {
    const before = await sql<{
      is_working_day: number;
      label_en: string | null;
      confidence: CalendarConfidence;
      source: string | null;
      notified_on: string | null;
    }>`
      SELECT is_working_day, label_en, confidence, source, notified_on
        FROM working_day_calendar
       WHERE cal_date = ${input.date}
       FOR UPDATE
    `.execute(tx);

    const previous = before.rows[0] ?? null;
    const wasWorking = previous === null ? null : previous.is_working_day === 1;

    await sql`
      INSERT INTO working_day_calendar
        (cal_date, is_working_day, label_en, confidence, source, notified_on, updated_at)
      VALUES
        (${input.date}, ${input.isWorkingDay ? 1 : 0}, ${input.label},
         ${input.confidence}, ${input.source}, ${input.notifiedOn}, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        is_working_day = VALUES(is_working_day),
        label_en       = VALUES(label_en),
        confidence     = VALUES(confidence),
        source         = VALUES(source),
        notified_on    = VALUES(notified_on),
        updated_at     = CURRENT_TIMESTAMP(3)
    `.execute(tx);

    /**
     * Only a change to whether the day is worked moves a deadline.
     *
     * Renaming "Eid holiday" to "Eid-ul-Fitr (second day)", or promoting a
     * provisional date to confirmed once the notification lands, changes no
     * arithmetic at all. Flagging clocks for those would put a recompute and
     * an audit event behind every typo correction, and an audit log that
     * records nothing in particular is one nobody reads.
     */
    const movesDeadlines = wasWorking !== input.isWorkingDay;
    const clocksFlagged = movesDeadlines
      ? await flagClocksSpanning(tx, input.date)
      : 0;

    await writeAudit(
      actor,
      {
        entityType: "calendar",
        entityId: input.date,
        action: previous === null ? "calendar.day_added" : "calendar.day_changed",
        summary: input.isWorkingDay
          ? `${input.date} recorded as a working day${input.label ? ` (${input.label})` : ""}`
          : `${input.date} recorded as closed${input.label ? ` — ${input.label}` : ""}`,
        before: previous,
        after: {
          is_working_day: input.isWorkingDay ? 1 : 0,
          label_en: input.label,
          confidence: input.confidence,
          source: input.source,
          notified_on: input.notifiedOn,
        },
        context: { clocksFlagged, movesDeadlines },
      },
      tx,
    );

    return { changed: movesDeadlines, clocksFlagged };
  });
}

/**
 * Flag every live clock whose window contains this date.
 *
 * `started_at <= date <= due_date` — a date before the application arrived
 * cannot affect it, and one after the current deadline cannot either, because
 * the deadline is the last day the window reaches. A stopped clock is left
 * alone deliberately: `stopSlaClock` froze its outcome on the day it decided,
 * and a holiday notified afterwards must not reach back and turn a breach into
 * a success.
 */
async function flagClocksSpanning(tx: Queryable, date: string): Promise<number> {
  const result = await sql<{ n: number }>`
    UPDATE sla_clocks
       SET needs_recompute = 1
     WHERE state <> 'stopped'
       AND DATE(started_at) <= ${date}
       AND due_date >= ${date}
  `.execute(tx);

  return Number(result.numAffectedRows ?? 0);
}

export interface ExtendResult {
  readonly added: number;
  readonly through: string;
}

/**
 * Fill the calendar forward to the end of a year.
 *
 * It fills from the first gap rather than from the last row, and that is not
 * a refinement — it is the whole correctness of the thing. `MAX(cal_date)`
 * looked like the right place to start until a test entered next March's bank
 * holiday before anyone had extended into that year: the extend then began the
 * day after *that*, and January and February were never written. A calendar
 * with a hole in it does not fail. `nthWorkingDayAfter` counts rows, so every
 * deadline crossing the hole comes back short, and an applicant is promised a
 * date the chamber has no intention of meeting. The first missing successor is
 * found with a self-join rather than a window function, because this host
 * ships MariaDB at least as often as MySQL.
 *
 * `INSERT IGNORE`, so the holiday that caused the problem survives being
 * extended over. A chamber told in October about next March's closure should
 * be able to record it at once, and an extend that silently reopened it would
 * delete the one piece of real information in the range.
 *
 * Every row is written `provisional` and says why in `source`. The
 * secretariat's working week is open question 8 — many Pakistani chambers work
 * a six-day week — so Monday to Friday is an assumption this app makes, not a
 * fact it was given, and the rows are marked rather than left to look
 * authoritative.
 */
export async function extendCalendar(
  actor: ActorContext,
  throughYear: number,
): Promise<ExtendResult> {
  requirePermission(actor, "calendar.manage");

  if (!Number.isInteger(throughYear)) {
    throw new Error(`throughYear must be a whole year, got ${throughYear}`);
  }

  return transaction(async (tx) => {
    const gap = await sql<{ gap_end: string | null }>`
      SELECT MIN(c.cal_date) AS gap_end
        FROM working_day_calendar c
        LEFT JOIN working_day_calendar n
               ON n.cal_date = c.cal_date + INTERVAL 1 DAY
       WHERE n.cal_date IS NULL
    `.execute(tx);

    const gapEnd = gap.rows[0]?.gap_end ?? null;
    const through = `${throughYear}-12-31`;
    const start = gapEnd === null ? `${throughYear}-01-01` : nextDay(gapEnd);

    if (start > through) return { added: 0, through: gapEnd ?? through };

    const rows: { date: string; working: number }[] = [];
    for (let date = start; date <= through; date = nextDay(date)) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      rows.push({ date, working: weekday >= 1 && weekday <= 5 ? 1 : 0 });

      /**
       * Four years at most in one press.
       *
       * Beyond that the request is long enough to be killed on a shared plan,
       * and a half-written calendar is worse than none: the arithmetic would
       * answer from it rather than refusing. The result names the date it
       * actually reached, and pressing again continues from there — which the
       * gap-finding start makes safe to do.
       */
      if (rows.length >= 1500) break;
    }

    const source =
      "Monday to Friday assumed; the secretariat's working week is not yet confirmed";

    // Batched, because one statement per day is 1,500 round trips inside a
    // transaction holding a connection from a pool of three.
    for (let at = 0; at < rows.length; at += 200) {
      const batch = rows.slice(at, at + 200);
      const values = batch.map(
        (row) =>
          sql`(${row.date}, ${row.working}, NULL, 'provisional', ${source}, CURRENT_TIMESTAMP(3))`,
      );

      await sql`
        INSERT IGNORE INTO working_day_calendar
          (cal_date, is_working_day, label_en, confidence, source, updated_at)
        VALUES ${sql.join(values)}
      `.execute(tx);
    }

    const reached = rows[rows.length - 1]?.date ?? start;
    const added = rows.length;

    await writeAudit(
      actor,
      {
        entityType: "calendar",
        entityId: `${start}..${reached}`,
        action: "calendar.extended",
        summary: `Calendar filled from ${start} to ${reached} (${added} days)`,
        after: { from: start, to: reached, added },
      },
      tx,
    );

    return { added, through: reached };
  });
}

/* -------------------------------------------------------------------------- */
/* Recompute                                                                  */
/* -------------------------------------------------------------------------- */

export interface RecomputeResult {
  readonly examined: number;
  readonly moved: number;
  readonly more: boolean;
}

/**
 * Recompute the deadlines a calendar edit flagged, and record every move.
 *
 * Rebuilt from first principles rather than nudged: the deadline is the
 * `(promised + paused)`th working day after the application arrived. That
 * identity holds because `resumeSlaClock` extends the deadline by the working
 * days a pause cost, and the cth working day after the Nth working day after a
 * date *is* the (N+c)th — so one query reproduces whatever sequence of pauses
 * the file has been through. Nudging the stored date by the difference the
 * edit made would need to know which edits had already been applied, which is
 * state nobody is keeping.
 *
 * One audit event per deadline that actually moves, and none for the clocks
 * that were flagged and turned out unaffected — a holiday on a Sunday changes
 * nothing. The plan calls a deadline quietly becoming later the audit failure
 * to avoid, and it is: the date is in the applicant's inbox and in the breach
 * report, and the two must be able to explain each other.
 *
 * Bounded, because it runs in a cron tick on a host that kills long requests.
 */
export async function recomputeFlaggedClocks(
  actor: ActorContext,
  limit = 50,
  db: Queryable = getDb(),
): Promise<RecomputeResult> {
  const flagged = await db
    .selectFrom("sla_clocks")
    .select([
      "id",
      "application_id",
      "started_at",
      "due_date",
      "working_days",
      "paused_working_days",
    ])
    .where("needs_recompute", "=", 1)
    .where("state", "!=", "stopped")
    .orderBy("id", "asc")
    .limit(limit + 1)
    .execute();

  const batch = flagged.slice(0, limit);
  let moved = 0;

  for (const clock of batch) {
    const startDate = new Date(clock.started_at).toISOString().slice(0, 10);
    const total = Number(clock.working_days) + Number(clock.paused_working_days);
    const recomputed = await nthWorkingDayAfter(db, startDate, total);

    if (recomputed === clock.due_date) {
      // Flagged and unmoved. The flag still has to be cleared or the job
      // re-reads the same rows on every tick for ever.
      await db
        .updateTable("sla_clocks")
        .set({ needs_recompute: 0 })
        .where("id", "=", clock.id)
        .execute();
      continue;
    }

    await transaction(async (tx) => {
      await tx
        .updateTable("sla_clocks")
        .set({ due_date: recomputed, needs_recompute: 0 })
        .where("id", "=", clock.id)
        .execute();

      await writeAudit(
        actor,
        {
          entityType: "application",
          entityId: Number(clock.application_id),
          action: "sla.deadline_recomputed",
          summary:
            `Promised date moved from ${clock.due_date} to ${recomputed} ` +
            `after a change to the working-day calendar`,
          before: { due_date: clock.due_date },
          after: { due_date: recomputed },
          context: {
            workingDays: Number(clock.working_days),
            pausedWorkingDays: Number(clock.paused_working_days),
          },
        },
        tx,
      );
    });

    moved += 1;
  }

  return { examined: batch.length, moved, more: flagged.length > limit };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toDay(row: {
  cal_date: string;
  is_working_day: number;
  label_en: string | null;
  confidence: CalendarConfidence;
  source: string | null;
  notified_on: string | null;
  weekday: number;
}): CalendarDay {
  return {
    date: row.cal_date,
    isWorkingDay: row.is_working_day === 1,
    label: row.label_en,
    confidence: row.confidence,
    source: row.source,
    notifiedOn: row.notified_on,
    weekday: Number(row.weekday),
  };
}

/**
 * The next civil date, by arithmetic on the UTC instant.
 *
 * Deliberately not `new Date(y, m, d + 1)`, which is local-time and so skips
 * or repeats a day across a DST boundary. Pakistan does not observe DST today,
 * but the machine generating a migration might be anywhere, and a calendar
 * with a missing Tuesday is an off-by-one in every deadline after it.
 */
function nextDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
