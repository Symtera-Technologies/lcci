import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { clientIp } from "@/server/auth/dal";
import { consume } from "@/server/rate-limit";
import { logError } from "@/server/log";

/**
 * CSP violation reports.
 *
 * Unauthenticated by necessity: the browser posts these with no credentials
 * and no cookies, and there is no way to ask it to. So everything here treats
 * the body as hostile — it is rate-limited by address, capped in size,
 * truncated field by field, and stored without being interpreted.
 *
 * This route exists so the policy can ship as `Report-Only` first. An
 * enforcing CSP shipped blind to a site with third-party embeds and a CMS
 * breaks something on day one, and the breakage is invisible to whoever
 * shipped it — a blocked script just does not run. Collecting violations for a
 * couple of weeks and reading them is the only honest way to turn enforcement
 * on. See `src/server/csp.ts`.
 *
 * Always returns 204, even on failure. A browser has nothing useful to do with
 * an error here, and a 500 would make a transient database problem look like a
 * security event in someone's console.
 */

export const dynamic = "force-dynamic";

/** Reports arrive as a small JSON object; anything larger is not one. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  try {
    const headerList = await headers();
    const ip = clientIp(headerList);

    const limit = await consume("cspReportIp", ip ? `ip:${ip}` : "ip:unknown");
    if (!limit.allowed) return new Response(null, { status: 204 });

    // `Content-Length` is attacker-supplied, so the body is read and measured
    // rather than trusted. Reading a bounded amount is safe because this route
    // is excluded from nothing — the proxy's own 10 MB buffer applies above it
    // — and a report that size is not a report.
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 204 });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return new Response(null, { status: 204 });
    }

    // Two formats in the wild: the legacy `report-uri` shape, which wraps the
    // detail in `csp-report`, and the Reporting API's `body`. Both are handled
    // because `report-uri` is what has broad support and `report-to` is what
    // newer browsers prefer, and a site in the middle of a CSP rollout will
    // receive both.
    const report = unwrap(parsed);

    await getDb()
      .insertInto("csp_reports")
      .values({
        document_uri: str(report, "document-uri", "documentURL", 500),
        violated_directive: str(
          report,
          "violated-directive",
          "effectiveDirective",
          190,
        ),
        blocked_uri: str(report, "blocked-uri", "blockedURL", 500),
        disposition: str(report, "disposition", "disposition", 20),
        // Stored as-is for the parts the columns do not cover: the raw JSON is
        // what tells you which inline script a browser objected to. Re-encoded
        // from the parsed value rather than stored verbatim, so a body that is
        // valid JSON but not an object cannot smuggle anything into the column.
        raw_json: JSON.stringify(report).slice(0, 60_000),
      })
      .execute();

    return new Response(null, { status: 204 });
  } catch (error) {
    logError("csp report could not be stored", error, { route: "/api/csp-report" });
    return new Response(null, { status: 204 });
  }
}

function unwrap(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object") return {};

  const asRecord = parsed as Record<string, unknown>;

  // Legacy report-uri: { "csp-report": { ... } }
  const legacy = asRecord["csp-report"];
  if (legacy && typeof legacy === "object") return legacy as Record<string, unknown>;

  // Reporting API sends an array of { type, body }.
  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (first && typeof first === "object" && "body" in first) {
      const body = (first as { body: unknown }).body;
      if (body && typeof body === "object") return body as Record<string, unknown>;
    }
    return {};
  }

  const body = asRecord.body;
  if (body && typeof body === "object") return body as Record<string, unknown>;

  return asRecord;
}

/** Read whichever of the two field names is present, truncated to the column. */
function str(
  report: Record<string, unknown>,
  legacyKey: string,
  modernKey: string,
  maxLength: number,
): string | null {
  const value = report[legacyKey] ?? report[modernKey];
  if (typeof value !== "string" || value === "") return null;
  return value.slice(0, maxLength);
}
