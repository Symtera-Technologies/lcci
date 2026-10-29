/**
 * Run one scheduled job now, on a development machine.
 *
 *   npm run dev:job -- sla-recompute
 *   npm run dev:job              (lists the jobs)
 *
 * Every job is reachable in production only through `POST /api/cron/[job]`
 * carrying the bearer secret, which is the correct shape there and useless
 * here: the secret lives in a file on the server and a developer who wants to
 * see a recompute happen should not have to hold a production credential to do
 * it. So this calls the handler straight out of the registry — the same
 * function the route calls, not a copy of it, which is the only version worth
 * exercising.
 *
 * What it deliberately does *not* do is take the `GET_LOCK` single-flight or
 * write a `job_runs` row. Those belong to the route, and faking them here would
 * mean a developer could watch a job "work" through machinery the real caller
 * never used. The consequence is that this must not be pointed at a database
 * that cron is also driving, which is the same reason it refuses in production.
 */

import process from "node:process";
import { closePool } from "@/db/pool";
import { env } from "@/server/env";
import { newUlid } from "@/server/crypto";
import {
  JOB_HANDLERS,
  type JobContext,
  type JobHandler,
} from "@/server/jobs/registry";
import { JOB_NAMES, type JobName } from "@/server/jobs/schedule";

async function main(): Promise<number> {
  if (env.isProduction) {
    console.error(
      "Refusing to run: NODE_ENV is production. There the jobs are cron's, " +
        "and running one beside it loses the single-flight lock.",
    );
    return 1;
  }

  const name = process.argv[2];
  if (!name || !(JOB_NAMES as readonly string[]).includes(name)) {
    console.error(
      name
        ? `Unknown job: ${name}\n`
        : "Pass a job name, for example: npm run dev:job -- sla-recompute\n",
    );
    console.error(`Jobs: ${JOB_NAMES.join(", ")}`);
    return 1;
  }

  const runId = newUlid();
  const ctx: JobContext = {
    runId,
    // The route gives a handler a wall-clock budget short enough to return
    // before the host kills the request. Here nothing is going to kill it, so
    // the budget is generous — but it is still finite, because a handler that
    // ignores its deadline is a bug worth seeing on a laptop first.
    deadline: Date.now() + 120_000,
    lastSummary: null,
    heartbeat: async () => {},
  };

  // Through `JobHandler` rather than the inferred signature: `JOB_HANDLERS` is
  // written with `satisfies`, so indexing it by a union of names gives a union
  // of each handler's own return type, and `detail` is optional in only some of
  // them. The declared contract is the one a caller is entitled to.
  const started = Date.now();
  const run: JobHandler = JOB_HANDLERS[name as JobName];
  const result = await run(ctx);
  const elapsed = Date.now() - started;

  console.log(
    `${name}: ${result.processed} processed, ${
      result.more ? "more to do" : "nothing left"
    }, ${elapsed} ms (run ${runId}).`,
  );
  if (result.detail) {
    console.log(JSON.stringify(result.detail, null, 2));
  }

  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
