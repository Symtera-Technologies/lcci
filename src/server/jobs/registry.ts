import "server-only";

import { sql, getDb } from "@/db/client";
import { envIsValid, envProblems } from "@/server/env";
import { drain, prunePayloads } from "@/server/mail/outbox";
import { sweep } from "@/server/rate-limit";
import { verifyAuditChain } from "@/server/audit";
import { systemActor } from "@/server/actor";
import { recomputeFlaggedClocks } from "@/membership/calendar";
import { revalidatePath } from "next/cache";
import { jobSchedule, type JobName, type JobSchedule } from "@/server/jobs/schedule";

/**
 * What each scheduled job actually does.
 *
 * The schedules live in `./schedule.ts`, which has no server-only guard and no
 * database import so the crontab generator and the admin panel can read it.
 * This module is the half that touches things, and `satisfies Record<JobName,
 * JobHandler>` is what keeps the two in step: a schedule with no handler here,
 * or a handler for something that is not scheduled, is a type error.
 *
 * Three properties every handler must have, all of them forced by the host
 * rather than chosen:
 *
 * **Idempotent.** A unit of work is claimed by a conditional `UPDATE` whose
 * `WHERE` names the current state, and the affected-row count decides
 * ownership. cPanel cron has no overlap protection, so two ticks will overlap
 * eventually; read-decide-write across two statements does the work twice.
 *
 * **Bounded and resumable.** A handler gets a wall-clock budget and returns
 * `more` when work remains. No job's duration may depend on its backlog,
 * because the shared plan kills long requests — a renewal run that must send
 * twenty thousand reminders cannot be one request, and must not lose its place
 * when that request is killed.
 *
 * **Observable.** The returned `detail` is written to `job_runs.last_summary`
 * and handed back to the next run as `ctx.lastSummary`. On a host with no
 * monitoring stack, that column read by the admin panel *is* the monitoring,
 * and it is also how a paged job keeps its cursor without a table of its own.
 */

export interface JobContext {
  /** This run's ULID. Also the `request_id` on any audit event the job writes. */
  readonly runId: string;
  /** `Date.now()` past which the handler must stop and return `more: true`. */
  readonly deadline: number;
  /** What the previous run returned as `detail`, or null. A job's cursor. */
  readonly lastSummary: Record<string, unknown> | null;
  /** Refresh `heartbeat_at`. Call inside any loop that may run for a while. */
  heartbeat(): Promise<void>;
}

export interface JobResult {
  /** Units of work handled. Reported, and used to decide whether to log. */
  processed: number;
  /** True when work remains; the next tick continues from here. */
  more: boolean;
  /**
   * Anything worth keeping. Becomes `last_summary`, so keep it small and keep
   * it free of personal data — this column is read by whoever opens the admin
   * panel, and by anyone with cPanel access.
   */
  detail?: Record<string, string | number | boolean | null>;
}

export type JobHandler = (ctx: JobContext) => Promise<JobResult>;

export const JOB_HANDLERS = {
  /** Send what the request path could not. */
  "email-outbox": async (ctx) => {
    let processed = 0;
    let more = true;

    while (more && Date.now() < ctx.deadline) {
      const result = await drain(20, ctx.runId);
      processed += result.sent + result.failed;
      more = result.more;
      // Nothing claimed means nothing is due, whatever the backlog count says
      // — without this the loop spins until the budget expires.
      if (result.claimed === 0) break;
      await ctx.heartbeat();
    }

    return { processed, more, detail: { pending: more } };
  },

  /**
   * Drop rendered payloads from old sent mail.
   *
   * The queue is the one place in this system where message contents
   * accumulate outside the tables that own them, and some of those contents
   * name people. Send metadata is kept; the payload is not.
   */
  "outbox-prune": async () => {
    const pruned = await prunePayloads(30);
    return { processed: pruned, more: pruned >= 500 };
  },

  /**
   * Rebuild the public pages when a scheduled instant has come due.
   *
   * The job does not change a single row, and that is the design rather than
   * an omission. Whether an item is public is `status = 'published' AND
   * published_at <= now AND (scheduled_unpublish_at IS NULL OR
   * scheduled_unpublish_at > now)`, asked in SQL on every read — so the
   * database is already right the moment the instant passes, with or without
   * this tick. What is stale is the prerendered HTML.
   *
   * So all this has to decide is "did anything cross a boundary since I last
   * looked", and the window comes from `lastSummary` rather than from a column
   * on the rows. A cursor in the job keeps the content tables free of
   * scheduling bookkeeping that would then need its own backfill, its own
   * index and its own answer to "what if two workers tick at once".
   *
   * A missed tick is self-healing: the cursor is only advanced by a run that
   * finished, so the next one covers both windows. The first run ever, and any
   * run after the cursor is lost, looks back an hour — six intervals, enough
   * to cover a restart without revalidating the whole site for no reason.
   *
   * **`revalidatePath` marks rather than rebuilds**, which is what makes a
   * ten-minute interval affordable. Called from a route handler it flags the
   * path, and the rebuild happens on the next visit — so a tick during the
   * night costs nothing, and the promise to LCCI is "live within ten minutes
   * of the scheduled time", not "regenerated on the dot".
   *
   * **This is the one job `npm run dev:job` cannot run.** `revalidatePath`
   * needs a request context and throws `Invariant: static generation store
   * missing` without one; the real caller is `POST /api/cron/[job]`, which has
   * one. Verified, not assumed — so if you came here because that script
   * failed, nothing is broken.
   */
  "content-revalidate": async (ctx) => {
    const now = new Date();
    const since = instantOrNull(ctx.lastSummary?.checkedThrough)
      ?? new Date(now.getTime() - 60 * 60 * 1000);

    const crossed = await getDb()
      .selectFrom("content_items")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("status", "=", "published")
      .where((eb) =>
        eb.or([
          eb.and([
            eb("published_at", ">", since),
            eb("published_at", "<=", now),
          ]),
          eb.and([
            eb("scheduled_unpublish_at", ">", since),
            eb("scheduled_unpublish_at", "<=", now),
          ]),
        ]),
      )
      .executeTakeFirst();

    const due = Number(crossed?.count ?? 0);

    // Broad on purpose, exactly as the editor's own save path is: the homepage
    // renders ten of the twelve content types, so a map from type to path
    // would be more code than this and wrong the first time a band moves.
    if (due > 0) revalidatePath("/", "layout");

    return {
      processed: due,
      more: false,
      detail: {
        checkedThrough: now.toISOString(),
        revalidated: due > 0,
        windowFrom: since.toISOString(),
      },
    };
  },

  "rate-limit-sweep": async () => {
    const result = await sweep(5000);
    const processed = result.counters + result.events;
    return {
      processed,
      more: processed >= 5000,
      detail: { counters: result.counters, events: result.events },
    };
  },

  /**
   * Walk the audit hash chain and report the first break.
   *
   * Paged across runs through `lastSummary.cursor`. Reaching the end resets
   * the cursor, so the chain is re-verified from the beginning rather than
   * only ever checking what is new — verifying the tail alone would miss
   * exactly the edit someone made to an old row, which is the case the chain
   * exists for.
   *
   * A break does not prove tampering: a partially applied restore looks
   * identical. It does prove the table is no longer a record anyone can rely
   * on, which is the fact worth surfacing.
   */
  "audit-verify": async (ctx) => {
    const page = 2000;
    const cursor = nonNegativeInt(ctx.lastSummary?.cursor);
    const result = await verifyAuditChain(cursor, page);

    if (result.brokenAtId !== null) {
      // Deliberately not written as an audit event. Writing into the table
      // whose integrity is in question is not how to report that it is in
      // question. This goes to the operational log and to `last_summary`.
      return {
        processed: result.checked,
        more: false,
        detail: { broken: true, brokenAtId: result.brokenAtId, cursor },
      };
    }

    const reachedEnd = result.checked < page;

    // Same keys either way, so the admin panel reads one shape.
    return {
      processed: result.checked,
      more: !reachedEnd,
      detail: {
        broken: false,
        brokenAtId: null,
        cursor: reachedEnd ? 0 : cursor + result.checked,
      },
    };
  },

  /**
   * Move the deadlines a calendar edit flagged, and audit every move.
   *
   * Separated from the edit itself on purpose. A secretary entering five days
   * of Eid should not wait on five full recomputes, and more importantly the
   * edit must not fail because the recompute did — the notified holiday is a
   * fact and belongs in the table whether or not the arithmetic behind it has
   * caught up. The flag is what makes that safe: an edit that lands without
   * its recompute leaves `needs_recompute` set, and this job finds it on the
   * next tick rather than the deadlines quietly staying wrong.
   *
   * The system actor holds no permissions, which is why `recomputeFlaggedClocks`
   * does not ask for one. It changes no decision and grants nothing; it
   * restates a date the calendar already determined.
   */
  "sla-recompute": async (ctx) => {
    const result = await recomputeFlaggedClocks(systemActor(ctx.runId), 50);
    return {
      processed: result.examined,
      more: result.more,
      detail: { moved: result.moved },
    };
  },

  /**
   * The monitoring.
   *
   * There is no monitoring stack on this plan, so this job is it: one cheap
   * query per thing that can be wrong, written to `last_summary` where the
   * admin panel reads it. It reports rather than repairs — a job that silently
   * fixes a symptom is how the cause stays hidden.
   *
   * Everything it checks is something with no other way of being noticed. A
   * dead outbox row means somebody was never told their application was
   * approved. A job stuck `running` with a cold heartbeat means a worker was
   * killed mid-run and that job has not actually executed since.
   */
  health: async () => {
    const dbOk = await pingDatabase();

    return {
      processed: 1,
      more: false,
      detail: {
        dbOk,
        envOk: envIsValid,
        envProblems: envIsValid ? 0 : envProblems.length,
        deadMail: dbOk ? await countDeadMail() : -1,
        stalledJobs: dbOk ? await countStalledJobs() : -1,
      },
    };
  },
} satisfies Record<JobName, JobHandler>;

/** Schedule and handler together, for the runner. */
/**
 * An instant off `last_summary`, or null if it is not one.
 *
 * The column is JSON written by a previous release of this code, so it is
 * read as untrusted: a cursor that has become a string like "null", or a
 * timestamp from a job that was renamed, must fall back to the default window
 * rather than produce an `Invalid Date` that silently matches nothing.
 */
function instantOrNull(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function jobDefinition(name: JobName): JobSchedule & { run: JobHandler } {
  return { ...jobSchedule(name), run: JOB_HANDLERS[name] };
}

/* -------------------------------------------------------------------------- */
/* Health probes                                                              */
/* -------------------------------------------------------------------------- */

async function pingDatabase(): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(getDb());
    return true;
  } catch {
    return false;
  }
}

async function countDeadMail(): Promise<number> {
  const row = await getDb()
    .selectFrom("email_outbox")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where("state", "=", "dead")
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** `running` with a heartbeat older than 15 minutes means killed mid-run. */
async function countStalledJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  const row = await getDb()
    .selectFrom("job_runs")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where("state", "=", "running")
    .where((eb) =>
      eb.or([eb("heartbeat_at", "is", null), eb("heartbeat_at", "<", cutoff)]),
    )
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

function nonNegativeInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}
