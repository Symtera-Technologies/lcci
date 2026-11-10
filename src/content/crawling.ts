import type { MetadataRoute } from "next";
import { sitePaths } from "@/components/site/nav-data";
import { POLICY_REQUIRED_PREFIXES } from "@/server/auth/policy";
import type { SlugIndexEntry } from "./repository";

/**
 * What a crawler is told about this site: the sitemap's contents, and the
 * rules in robots.txt.
 *
 * Both are built here as pure functions over data the route handlers fetch,
 * for the same reason the workflow machine is a pure function: these two files
 * have to agree with each other, and the agreement is only checkable if it can
 * be asserted without a database. A sitemap that advertises a URL robots.txt
 * forbids is not a small inconsistency — Search Console reports it as an error
 * against every affected URL — and the usual way it happens is that one of the
 * two files was edited and the other was not.
 *
 * `tests/crawling.test.ts` holds three invariants over what is below: every
 * route in the sitemap is a route on disk, no URL in the sitemap is disallowed
 * by robots.txt, and every prefix the auth policy protects is disallowed.
 */

/* -------------------------------------------------------------------------- */
/* robots.txt                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Paths no crawler should follow, as robots.txt directives.
 *
 * Derived from `POLICY_REQUIRED_PREFIXES` rather than written out, so the list
 * cannot drift from the one the route-inventory test enforces: a new protected
 * area is disallowed the moment it is declared, with nobody having to remember
 * this file exists. The trailing slash is deliberate — `Disallow: /admin`
 * would also match a hypothetical public `/administration`, and robots.txt
 * matching is prefix-based with no segment awareness at all.
 *
 * `/v2` is the one entry that is not protected: it is the second design
 * variant, a live route on purpose so the two can be compared, and it serves
 * the homepage's content at a second address. Left crawlable it is duplicate
 * content competing with `/` for the chamber's own name.
 */
export function disallowedPaths(): string[] {
  return [...POLICY_REQUIRED_PREFIXES.map((prefix) => `${prefix}/`), "/v2"].sort();
}

/**
 * Host shapes that must never be indexed, whatever they are serving.
 *
 * The question this answers is not "is this production" but "is this
 * recognisably *not* production", and the asymmetry is the whole design. A
 * staging copy of the chamber's site getting into Google is bad; a production
 * site accidentally serving `Disallow: /` is far worse, and that is the
 * mistake made by comparing the request's host against a canonical one and
 * disallowing everything on a mismatch. Behind Passenger on shared hosting the
 * `Host` header is not reliably the public domain, so a mismatch is weak
 * evidence of staging and strong evidence of nothing.
 *
 * So the test is positive and narrow: loopback, and a first label that names
 * an environment. Anything unrecognised is treated as production and stays
 * indexable.
 */
const NON_PRODUCTION_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|(staging|stage|dev|development|test|qa|uat|preview|beta|demo)[.-])/i;

export function isIndexableHost(host: string | null): boolean {
  if (!host) return true;
  return !NON_PRODUCTION_HOST.test(host.trim().toLowerCase());
}

/**
 * robots.txt, for one request.
 *
 * `origin` is the canonical site origin, which is where the sitemap lives;
 * `host` is the host the request actually arrived on, and the only thing it
 * decides is whether this copy of the site may be indexed at all.
 *
 * On a non-production host the sitemap line is omitted as well as everything
 * being disallowed. Leaving it in would hand a crawler a direct list of the
 * URLs it has just been told not to fetch, which some of them fetch anyway.
 */
export function buildRobots(origin: string, host: string | null): MetadataRoute.Robots {
  if (!isIndexableHost(host)) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: { userAgent: "*", allow: "/", disallow: disallowedPaths() },
    sitemap: `${origin}/sitemap.xml`,
  };
}

/* -------------------------------------------------------------------------- */
/* sitemap.xml                                                                */
/* -------------------------------------------------------------------------- */

/** Everything the sitemap is built from, fetched by the route handler. */
export interface SitemapData {
  /** The canonical origin every `loc` is resolved against. */
  origin: string;
  /** Live `page` rows — the modification dates for the standing pages. */
  pages: readonly SlugIndexEntry[];
  /** Live press releases, one URL each. */
  pressReleases: readonly SlugIndexEntry[];
  /** Live committees, one URL each. */
  committees: readonly SlugIndexEntry[];
  /** How many press releases fit on one index page. */
  pressReleasesPerPage: number;
}

/**
 * The sitemap.
 *
 * Three groups, and one judgement in each.
 *
 * **The standing pages come from the IA**, not from the published `page` rows,
 * and that is the decision most worth defending. Twenty-eight of the sixty-two
 * have no prose yet — LCCI has not supplied it — and listing a page whose body
 * is empty does invite "crawled, currently not indexed". But every one of them
 * renders a real page with its own heading, breadcrumb and navigation; every
 * one is linked from the menu and so will be crawled with or without this
 * file; and making the sitemap a second, quieter opinion about what the site
 * publishes is how the two opinions start to disagree. The lever for "do not
 * index this yet" is `robots: { index: false }` on the page itself, where a
 * visitor-facing fact belongs. It is not this file's to pull.
 *
 * **`lastModified` is omitted where there is no honest date.** A page with no
 * published row has never been modified, and `new Date()` would tell a crawler
 * that every unwritten page changed on the day it last fetched the sitemap —
 * which is false, and is the exact signal that makes a crawler stop trusting
 * the field.
 *
 * **No `priority` and no `changeFrequency`.** Google ignores both and has said
 * so; they would be two more columns to keep plausible on a file whose only
 * load-bearing hint is `lastmod`.
 */
export function buildSitemap(data: SitemapData): MetadataRoute.Sitemap {
  const { origin } = data;
  const dateBySlug = new Map(data.pages.map((page) => [page.slug, page.updatedAt]));

  const entries: MetadataRoute.Sitemap = sitePaths().map((path) => {
    // `/` is not a `page` row — the homepage's content is the `hero` type and
    // its section types — so it has no date here, and deriving one from the
    // most recently touched band would be a guess dressed as a fact.
    const updatedAt = path === "/" ? undefined : dateBySlug.get(slugFor(path));
    return {
      url: absolute(origin, path),
      ...(updatedAt ? { lastModified: updatedAt } : {}),
    };
  });

  for (const release of data.pressReleases) {
    entries.push({
      url: absolute(origin, `/news/press-releases/${release.slug}`),
      lastModified: release.updatedAt,
    });
  }

  // The archive's own pages. Page 1 is `/news/press-releases`, already listed
  // above as a standing page, so this starts at 2 and produces nothing until
  // there are more releases than fit on one page.
  const pageCount = Math.ceil(data.pressReleases.length / data.pressReleasesPerPage);
  for (let n = 2; n <= pageCount; n += 1) {
    entries.push({ url: absolute(origin, `/news/press-releases/page/${n}`) });
  }

  for (const committee of data.committees) {
    entries.push({
      url: absolute(origin, `/about/committees/${committee.slug}`),
      lastModified: committee.updatedAt,
    });
  }

  return entries;
}

/**
 * A route's `page` slug.
 *
 * `pageSlug` is not imported for this: it throws on `/`, which the caller has
 * already handled above, and importing it would make this module capable of
 * failing for a reason that has nothing to do with crawling. The rule is the
 * same one, and `tests/page-slug.test.ts` owns it.
 */
function slugFor(path: string): string {
  return path.replace(/^\/+|\/+$/g, "").replace(/\//g, "-");
}

/** `origin` and a path joined without the double slash a naive concat makes. */
function absolute(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, "");
  return path === "/" ? base : `${base}${path}`;
}
