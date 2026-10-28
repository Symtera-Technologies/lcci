import "server-only";

import { getDb, withAdvisoryLock } from "@/db/client";
import { newUlid } from "@/server/crypto";
import { log, logError } from "@/server/log";
import { jobDefinition, type JobResult } from "@/server/jobs/registry";
import type { JobName } from "@/server/jobs/schedule";

/**
 * Run one job, exactly once, within a budget.
 *
 * Mutual exclusion is `GET_LOCK` on its own connection, not a row in a table.
 * The reason is crash safety and it is the whole argument: MySQL releases a
 * named lock when the connection holding it drops, so a worker killed by the
 * shared plan's CPU limiter releases its lock as a side effect of dying. A
 * lock *row* would still say `running` with nobody running, and the symptom
 * would be "cron silently stopped working" with nothing in any log.
 *
 * `job_runs` therefore records rather than guards. One consequence worth
 * stating, because the plan describes the claim as conditional on heartbeat
 * staleness: the claim here is unconditional. A row left `running` by a killed
 * worker must not be able to block the next run — if it could, one CPU-limiter
 * kill would stop that job permanently. The orphan is logged and reported by
 * the `health` job instead, which is where a human will see it.
 */

const DEFAULT_BUDGET_MS = 45_000;

/** 15 minutes. A heartbeat older than this means the run died. */
const STALE_AFTER_MS = 15 * 60_000;

export type JobOutcome =
  | { status: "ran"; runId: string; durationMs: number; result: JobResult }
  | { status: "skipped"; reason: "locked" }
  | { status: "failed"; runId: string; durationMs: number };

export async function runJob(name: JobName): Promise<JobOutcome> {
  const definition = jobDefinition(name);
  const runId = newUlid();

  // Zero timeout: if another tick holds the lock, this one returns at once. A
  // queued wait would hold a connection from a three-connection pool for the
  // duration of someone else's job, which is how a cron overlap becomes a site
  // outage.
  const locked = await withAdvisoryLock(`lcci:job:${name}`, 0, async () => {
    const startedAt = Date.now();
    const previous = await claim(name, runId);

    if (previous?.orphaned) {
      log.warn("previous job run never finished", {
        job: name,
        runId: previous.runId ?? null,
      });
    }

    try {
      const result = await definition.run({
        runId,
        deadline: startedAt + (definition.budgetMs ?? DEFAULT_BUDGET_MS),
        lastSummary: previous?.summary ?? null,
        heartbeat: () => beat(name, runId),
      });

      const durationMs = Date.now() - startedAt;
      await finish(name, runId, "idle", result.detail ?? null);

      // Only logged when something happened. An hourly job that logs "0
      // processed" produces 8,760 lines a year that nobody reads and that bury
      // the one line that mattered.
      if (result.processed > 0 || result.more) {
        log.info("job ran", {
          job: name,
          runId,
          processed: result.processed,
          more: result.more,
          durationMs,
        });
      }

      return { status: "ran" as const, runId, durationMs, result };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      logError("job failed", error, { job: name, runId, durationMs });
      await finish(name, runId, "failed", { error: true });
      return { status: "failed" as const, runId, durationMs };
    }
  });

  if (!locked.acquired) {
    log.info("job skipped, already running", { job: name });
    return { status: "skipped", reason: "locked" };
  }

  return locked.value;
}

interface PreviousRun {
  runId: string | null;
  summary: Record<string, unknown> | null;
  /** True when the row was still `running` with a cold or absent heartbeat. */
  orphaned: boolean;
}

/**
 * Mark the job running and return what the previous run left behind.
 *
 * The read happens before the write so the handler can have its cursor. Safe
 * without a transaction because the advisory lock is already held — this is
 * the one place in the system where read-then-write is not a race, and the
 * lock is the reason.
 */
async function claim(name: JobName, runId: string): Promise<PreviousRun | null> {
  const existing = await getDb()
    .selectFrom("job_runs")
    .select(["run_id", "state", "heartbeat_at", "last_summary"])
    .where("job", "=", name)
    .executeTakeFirst();

  const now = new Date();

  if (!existing) {
    await getDb()
      .insertInto("job_runs")
      .values({
        job: name,
        state: "running",
        run_id: runId,
        started_at: now,
        heartbeat_at: now,
      })
      .execute();
    return null;
  }

  await getDb()
    .updateTable("job_runs")
    .set({
      state: "running",
      run_id: runId,
      started_at: now,
      heartbeat_at: now,
      finished_at: null,
    })
    .where("job", "=", name)
    .execute();

  const heartbeat = existing.heartbeat_at;
  const cold = !heartbeat || now.getTime() - heartbeat.getTime() > STALE_AFTER_MS;

  return {
    runId: existing.run_id,
    summary: asRecord(existing.last_summary),
    orphaned: existing.state === "running" && cold,
  };
}

/**
 * Refresh the heartbeat, but only for this run.
 *
 * The `run_id` guard matters: if this run was declared orphaned and a later
 * tick took the job over, this run must not quietly keep the row looking
 * healthy on the new run's behalf.
 */
async function beat(name: JobName, runId: string): Promise<void> {
  await getDb()
    .updateTable("job_runs")
    .set({ heartbeat_at: new Date() })
    .where("job", "=", name)
    .where("run_id", "=", runId)
    .execute();
}

async function finish(
  name: JobName,
  runId: string,
  state: "idle" | "failed",
  detail: Record<string, unknown> | null,
): Promise<void> {
  try {
    await getDb()
      .updateTable("job_runs")
      .set({
        state,
        finished_at: new Date(),
        last_summary: detail === null ? null : JSON.stringify(detail),
      })
      .where("job", "=", name)
      .where("run_id", "=", runId)
      .execute();
  } catch (error) {
    // The job itself may well have succeeded. Failing to record that is worth
    // a log line and nothing more — throwing here would turn a bookkeeping
    // problem into a failed run and a retry of work already done.
    logError("could not record job completion", error, { job: name, runId });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
