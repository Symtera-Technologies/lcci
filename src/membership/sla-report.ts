import "server-only";

import { getDb, sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import type { ApplicationState, ProcessingTier, SlaOutcome } from "@/db/schema";
import { requirePermission, type ActorContext } from "@/server/actor";
import { TIER_WORKING_DAYS } from "@/membership/workflow";

/**
 * What the chamber promised, and whether it kept its word.
 *
 * The three processing tiers are not labels. Rs 20,000 buys an Executive
 * answer in three working days and Rs 10,650 buys a Regular one in forty, so
 * a missed tier is an undelivered thing somebody paid for. This module is the
 * report that makes that visible before a member has to point it out.
 *
 * Two numbers, and the second is the one that settles arguments.
 *
 * **Elapsed working days** is derived on read, never stored. `sla_clocks` has
 * an `elapsed_working_days` column that nothing maintains, and that is the
 * right state for it to be in: a stored figure is wrong every day after it is
 * written, and the queue, the applicant's tracker and this report have to
 * agree. One definition, counted from the calendar, in the same SQL the
 * deadline itself came from.
 *
 * **Paused working days** is stored, because it is not derivable. It is the
 * sum of what each pause actually cost at the time it closed, and recomputing
 * it later from two timestamps would silently reprice old pauses against a
 * calendar that has since been edited. Together the two produce the sentence
 * this report exists for: "thirty-two working days elapsed, eleven of them
 * waiting on the applicant". That sentence is the answer when a member
 * complains about a missed Executive promise, and neither number alone is.
 *
 * Breach on an open file is `due_date < CURDATE()`, a comparison rather than a
 * calculation, so nothing here needs a timer. Breach on a decided file is read
 * from `outcome`, frozen on the day of the decision — whether the chamber kept
 * its word is a fact about that day, and a holiday notified afterwards must
 * not rewrite it.
 */

export interface OpenPromise {
  readonly applicationId: number;
  readonly publicRef: string | null;
  readonly firmName: string | null;
  readonly state: ApplicationState;
  readonly tier: ProcessingTier;
  readonly promisedWorkingDays: number;
  readonly startedAt: Date;
  readonly dueDate: string;
  readonly clockState: string;
  readonly breached: boolean;
  /** Working days from the start to today, the chamber's and the applicant's together. */
  readonly elapsedWorkingDays: number;
  /** Of those, the ones the file spent with the applicant. */
  readonly pausedWorkingDays: number;
  /** Working days to the promised date; negative once it has passed. */
  readonly workingDaysToDue: number;
  readonly needsRecompute: boolean;
}

export interface DecidedPromise {
  readonly applicationId: number;
  readonly publicRef: string | null;
  readonly firmName: string | null;
  readonly tier: ProcessingTier;
  readonly dueDate: string;
  readonly stoppedAt: Date | null;
  readonly outcome: SlaOutcome;
  readonly elapsedWorkingDays: number;
  readonly pausedWorkingDays: number;
}

export interface TierOutcome {
  readonly tier: ProcessingTier;
  readonly promisedWorkingDays: number;
  readonly met: number;
  readonly breached: number;
  readonly open: number;
  readonly openBreached: number;
}

export interface SlaReport {
  readonly open: readonly OpenPromise[];
  readonly breaches: readonly DecidedPromise[];
  readonly byTier: readonly TierOutcome[];
  /** Decisions on or after this date are counted in `byTier`. */
  readonly since: string;
  /** Deadlines flagged by a calendar edit and not yet recomputed. */
  readonly awaitingRecompute: number;
}

/**
 * Working days in `(from, to]`, as a correlated count.
 *
 * Inlined rather than calling `workingDaysBetween` per row, because the report
 * reads tens of rows and a query each would be tens of round trips to serve
 * one page. Same `WHERE` as the function, against the same index.
 */
const ELAPSED = sql<number>`
  (SELECT COUNT(*)
     FROM working_day_calendar wc
    WHERE wc.is_working_day = 1
      AND wc.cal_date > DATE(sc.started_at)
      AND wc.cal_date <= COALESCE(DATE(sc.stopped_at), CURDATE()))
`;

/** The distance to the deadline, unsigned; the caller applies the sign. */
const TO_DUE = sql<number>`
  (SELECT COUNT(*)
     FROM working_day_calendar wc
    WHERE wc.is_working_day = 1
      AND wc.cal_date > LEAST(CURDATE(), sc.due_date)
      AND wc.cal_date <= GREATEST(CURDATE(), sc.due_date))
`;

export interface ReportFilters {
  /** Count decisions from this civil date onwards. Defaults to a year back. */
  readonly since?: string;
  readonly tier?: ProcessingTier;
}

export async function slaReport(
  actor: ActorContext,
  filters: ReportFilters = {},
  db: Queryable = getDb(),
): Promise<SlaReport> {
  requirePermission(actor, "application.read");

  const since = filters.since ?? oneYearAgo();
  const tier = filters.tier ?? null;
  const today = new Date().toISOString().slice(0, 10);

  const openRows = await sql<{
    application_id: number;
    public_ref: string | null;
    firm_name: string | null;
    state: ApplicationState;
    processing_tier: ProcessingTier;
    working_days: number;
    started_at: Date;
    due_date: string;
    clock_state: string;
    paused_working_days: number;
    needs_recompute: number;
    elapsed: number;
    to_due: number;
  }>`
    SELECT sc.application_id,
           a.public_ref,
           ac.firm_name,
           a.state,
           sc.processing_tier,
           sc.working_days,
           sc.started_at,
           sc.due_date,
           sc.state AS clock_state,
           sc.paused_working_days,
           sc.needs_recompute,
           ${ELAPSED} AS elapsed,
           ${TO_DUE} AS to_due
      FROM sla_clocks sc
      JOIN applications a ON a.id = sc.application_id
      LEFT JOIN application_company ac ON ac.application_id = sc.application_id
     WHERE sc.state <> 'stopped'
       AND (${tier} IS NULL OR sc.processing_tier = ${tier})
     ORDER BY (sc.due_date < CURDATE()) DESC, sc.due_date ASC, sc.application_id ASC
  `.execute(db);

  const open: OpenPromise[] = openRows.rows.map((row) => {
    const late = row.due_date < today;
    return {
      applicationId: Number(row.application_id),
      publicRef: row.public_ref,
      firmName: row.firm_name,
      state: row.state,
      tier: row.processing_tier,
      promisedWorkingDays: Number(row.working_days),
      startedAt: new Date(row.started_at),
      dueDate: row.due_date,
      clockState: row.clock_state,
      breached: late,
      elapsedWorkingDays: Number(row.elapsed),
      pausedWorkingDays: Number(row.paused_working_days),
      workingDaysToDue: late ? -Number(row.to_due) : Number(row.to_due),
      needsRecompute: Number(row.needs_recompute) === 1,
    };
  });

  const breachRows = await sql<{
    application_id: number;
    public_ref: string | null;
    firm_name: string | null;
    processing_tier: ProcessingTier;
    due_date: string;
    stopped_at: Date | null;
    outcome: SlaOutcome;
    paused_working_days: number;
    elapsed: number;
  }>`
    SELECT sc.application_id,
           a.public_ref,
           ac.firm_name,
           sc.processing_tier,
           sc.due_date,
           sc.stopped_at,
           sc.outcome,
           sc.paused_working_days,
           ${ELAPSED} AS elapsed
      FROM sla_clocks sc
      JOIN applications a ON a.id = sc.application_id
      LEFT JOIN application_company ac ON ac.application_id = sc.application_id
     WHERE sc.state = 'stopped'
       AND sc.outcome = 'breached'
       AND DATE(sc.stopped_at) >= ${since}
       AND (${tier} IS NULL OR sc.processing_tier = ${tier})
     ORDER BY sc.stopped_at DESC
     LIMIT 50
  `.execute(db);

  const breaches: DecidedPromise[] = breachRows.rows.map((row) => ({
    applicationId: Number(row.application_id),
    publicRef: row.public_ref,
    firmName: row.firm_name,
    tier: row.processing_tier,
    dueDate: row.due_date,
    stoppedAt: row.stopped_at === null ? null : new Date(row.stopped_at),
    outcome: row.outcome,
    elapsedWorkingDays: Number(row.elapsed),
    pausedWorkingDays: Number(row.paused_working_days),
  }));

  /**
   * One grouped query rather than three counts per tier.
   *
   * Open files are counted here too, and separately from decided ones, because
   * a tier with no breaches and eleven applications already past their date is
   * not a tier that is being met — it is one whose bad news has not been
   * written down yet. A report that showed only closed outcomes would read
   * best exactly when things were worst.
   */
  const tallyRows = await sql<{
    processing_tier: ProcessingTier;
    met: number;
    breached: number;
    open_count: number;
    open_breached: number;
  }>`
    SELECT sc.processing_tier,
           SUM(sc.state = 'stopped' AND sc.outcome = 'met'
               AND DATE(sc.stopped_at) >= ${since}) AS met,
           SUM(sc.state = 'stopped' AND sc.outcome = 'breached'
               AND DATE(sc.stopped_at) >= ${since}) AS breached,
           SUM(sc.state <> 'stopped') AS open_count,
           SUM(sc.state <> 'stopped' AND sc.due_date < CURDATE()) AS open_breached
      FROM sla_clocks sc
     WHERE (${tier} IS NULL OR sc.processing_tier = ${tier})
     GROUP BY sc.processing_tier
  `.execute(db);

  const byTally = new Map(
    tallyRows.rows.map((row) => [row.processing_tier, row]),
  );

  // Every tier, including the ones with nothing in them. A tier missing from
  // the table reads as "no data" where the truth is "nobody has bought this",
  // and the Executive tier being empty is itself worth seeing.
  const byTier: TierOutcome[] = (
    Object.keys(TIER_WORKING_DAYS) as ProcessingTier[]
  )
    .filter((code) => tier === null || code === tier)
    .map((code) => {
      const row = byTally.get(code);
      return {
        tier: code,
        promisedWorkingDays: TIER_WORKING_DAYS[code],
        met: Number(row?.met ?? 0),
        breached: Number(row?.breached ?? 0),
        open: Number(row?.open_count ?? 0),
        openBreached: Number(row?.open_breached ?? 0),
      };
    });

  const pending = await sql<{ n: number }>`
    SELECT COUNT(*) AS n
      FROM sla_clocks
     WHERE needs_recompute = 1
       AND state <> 'stopped'
  `.execute(db);

  return {
    open,
    breaches,
    byTier,
    since,
    awaitingRecompute: Number(pending.rows[0]?.n ?? 0),
  };
}

function oneYearAgo(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}
