import { headers } from "next/headers";
import type { MetadataRoute } from "next";
import { buildRobots } from "@/content/crawling";
import { siteOrigin } from "@/lib/site-url";

/**
 * `/robots.txt`, generated per request.
 *
 * **Dynamic for one reason that earns it**: the host. Reading the request's
 * host is what lets a staging or preview copy of this site serve
 * `Disallow: /` while production serves the real policy — from one build, with
 * no environment variable anybody has to remember to set on the copy. The
 * mistake it prevents is a duplicate of the chamber's site being indexed under
 * someone else's domain, which is slow to notice and slower to undo.
 *
 * The rest of the file is derived rather than typed out: the disallow list
 * comes from the auth policy's own prefixes, so a new protected area is
 * excluded from crawling the moment it is declared. See
 * `src/content/crawling.ts`.
 *
 * `headers()` is a request-time API, so this route would be dynamic without
 * the export below; it is stated anyway, because "dynamic because of a call
 * three lines down" is a property somebody deletes by accident.
 */
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const headerList = await headers();

  // `x-forwarded-host` first: behind Passenger and behind Cloudflare, `host`
  // can be the internal name the proxy dialled rather than the one the
  // visitor typed. Taken as a hint only — `isIndexableHost` is deliberately
  // written so that an unrecognised value leaves the site indexable.
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");

  return buildRobots(siteOrigin(), host);
}
