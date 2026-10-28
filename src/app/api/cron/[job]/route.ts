import { timingSafeEqual } from "node:crypto";
import { env, requireEnv } from "@/server/env";
import { sha256Hex } from "@/server/crypto";
import { log, logError } from "@/server/log";
import { isJobName } from "@/server/jobs/schedule";
import { runJob } from "@/server/jobs/runner";

/**
 * The cron entry point.
 *
 * One route for every job, with the job name as a path segment, so the set of
 * reachable jobs is exactly the set in `src/server/jobs/registry.ts` and a test
 * can assert that. A route per job would let one drift out of the registry and
 * become unfindable.
 *
 * Authenticated by a bearer secret rather than a session, because the caller is
 * cPanel's cron daemon and it has none. Three properties of that check, each
 * closing a specific hole:
 *
 * **`timingSafeEqual`, on hashes of equal length.** A plain `===` on a secret
 * leaks its prefix to anyone who can measure a few thousand requests — and
 * this endpoint is reachable from the internet by definition.
 *
 * **404 on failure, never 401.** A 401 confirms the endpoint exists and that
 * it wants a token, which is an invitation. A 404 is indistinguishable from a
 * typo'd URL.
 *
 * **POST only, and no query-string token.** A secret in a query string lands
 * in Apache's access log, in cPanel's own analytics, and in the `Referer`
 * header of anything the response links to.
 *
 * Excluded from the proxy matcher. A proxy file buffers every matched request
 * body in memory and silently truncates past 10 MB; nothing here needs that,
 * and a cron tick must not be able to be slowed down by it.
 */

export const dynamic = "force-dynamic";

/** cPanel's cron and most shared plans give up well before this. */
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ job: string }> },
): Promise<Response> {
  const headerList = request.headers;

  if (!authorised(headerList.get("authorization"))) {
    // Deliberately no log line naming the path. An unauthenticated endpoint
    // that logs every probe is a way to fill the account's disk quota from
    // outside, and the quota is shared with the documents.
    return notFound();
  }

  const { job } = await params;

  if (!isJobName(job)) {
    log.warn("cron called for an unknown job", { job: safe(job) });
    return notFound();
  }

  try {
    // Checked after authorisation, so a misconfigured host does not advertise
    // its own misconfiguration to an unauthenticated caller.
    requireEnv();
  } catch (error) {
    logError("cron rejected: environment is not usable", error, { job });
    return json({ ok: false, error: "environment" }, 503);
  }

  try {
    const outcome = await runJob(job);

    if (outcome.status === "skipped") {
      // 200, not an error: an overlapping tick is the normal behaviour of a
      // lock working, and a non-2xx here would have cron mailing the
      // administrator about a system that is functioning correctly.
      return json({ ok: true, job, status: "skipped" }, 200);
    }

    if (outcome.status === "failed") {
      return json({ ok: false, job, status: "failed", runId: outcome.runId }, 500);
    }

    return json({
      ok: true,
      job,
      status: "ran",
      runId: outcome.runId,
      durationMs: outcome.durationMs,
      processed: outcome.result.processed,
      // The caller — a shell script or the admin panel's "run now" — uses this
      // to decide whether to tick again immediately rather than waiting for
      // the schedule.
      more: outcome.result.more,
    });
  } catch (error) {
    logError("cron route failed outside the job", error, { job });
    return json({ ok: false, job, error: "internal" }, 500);
  }
}

/**
 * Compare the presented bearer token against the configured secret.
 *
 * Both sides are hashed to a fixed width before comparison, because
 * `timingSafeEqual` throws on a length mismatch and the length of the real
 * secret is itself something not to leak.
 */
function authorised(header: string | null): boolean {
  if (!header) return false;

  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return false;

  const presented = Buffer.from(sha256Hex(match[1]), "hex");
  const expected = Buffer.from(sha256Hex(env.cronSecret), "hex");

  return timingSafeEqual(presented, expected);
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Job names reach a log line; an attacker-supplied path segment does not. */
function safe(value: string): string {
  return /^[a-z0-9-]{1,40}$/.test(value) ? value : "<invalid>";
}
