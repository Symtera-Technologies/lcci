import type { MetadataRoute } from "next";
import { PRESS_RELEASES_PER_PAGE } from "@/components/site/press-release-list";
import { buildSitemap } from "@/content/crawling";
import { getSlugIndex } from "@/content/repository";
import { siteOrigin } from "@/lib/site-url";

/**
 * `/sitemap.xml`, generated from the CMS on every request.
 *
 * **Dynamic, not prerendered**, which is the point of it. Next caches
 * `sitemap.ts` at build time by default, and a build-time sitemap on this
 * deployment would be wrong within a day: the site is content-driven, the
 * admin publishes rows without a deploy, and the press archive is 686 rows
 * waiting only on dates. A crawler would be told about whatever had been
 * published the last time somebody ran `next build` — which is the kind of
 * stale that nobody notices, because the file is still there and still valid.
 *
 * The cost of `force-dynamic` is three indexed two-column queries per fetch,
 * on a pool of three connections. That is affordable because of who fetches
 * it: crawlers, a few times a day, never a visitor. It is also why
 * `getSlugIndex` exists instead of calling `getPressReleases` with a large
 * limit — see its own note.
 *
 * What goes in it, and the three judgements behind that, is in
 * `src/content/crawling.ts`. This file is the I/O.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // One clock for all three reads, so a row published in the millisecond
  // between two of them cannot appear in one list and not another.
  const now = new Date();

  const [pages, pressReleases, committees] = await Promise.all([
    getSlugIndex("page", now),
    getSlugIndex("press_release", now),
    getSlugIndex("committee", now),
  ]);

  return buildSitemap({
    origin: siteOrigin(),
    pages,
    pressReleases,
    committees,
    pressReleasesPerPage: PRESS_RELEASES_PER_PAGE,
  });
}
