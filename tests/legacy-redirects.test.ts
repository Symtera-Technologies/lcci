import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sitePaths } from "@/components/site/nav-data";
import { LEGACY_REDIRECTS } from "@/content/legacy-redirects";
import { archiveSlugCount, isUnpublishedArchiveSlug } from "@/content/press-archive";
import { legacyRedirect } from "@/proxy";

/**
 * The launch 301 table, and whether it points anywhere real.
 *
 * A redirect is uniquely bad at reporting its own failure. One pointing at a
 * slug that does not exist answers 308 and then 404 — so it looks like it
 * works from the server's side, it looks like it works in a redirect checker
 * that only follows one hop, and the visitor still ends up nowhere. Multiply
 * that by 699 press releases generated from a reproduced slug pipeline and the
 * only way to know is to check every target against the migration that created
 * the rows.
 *
 * That is this file's main job: **every slug the map redirects to must be a
 * slug some migration actually inserted.** It is also the check that holds
 * `scripts/legacy-urls.ts` still: if `assignSlugs` ever answers differently
 * from the way migration 0037 was generated, hundreds of these fail at once.
 */

const MIGRATIONS = "migrations";

/** Every `content_items` slug any migration inserts, by content type. */
function seededSlugs(type: string): Set<string> {
  const slugs = new Set<string>();
  const pattern = new RegExp(`\\(\\s*'${type}'\\s*,\\s*'((?:[^']|'')*)'`, "g");

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(pattern)) {
      if (match[1]) slugs.add(match[1].replace(/''/g, "'"));
    }
  }

  return slugs;
}

const PRESS_PREFIX = "/news/press-releases/";

describe("the 301 table's destinations", () => {
  it("sends every press URL to a release that exists", () => {
    const seeded = seededSlugs("press_release");
    expect(seeded.size).toBeGreaterThan(600);

    const missing: string[] = [];
    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      if (!to.startsWith(PRESS_PREFIX)) continue;
      const slug = to.slice(PRESS_PREFIX.length);
      if (!seeded.has(slug)) missing.push(`${from} -> ${to}`);
    }

    // Named rather than counted: a failure here means the slug pipeline in
    // scripts/legacy-urls.ts has drifted from migration 0037, and the first
    // few examples are what identifies which way.
    expect(missing.slice(0, 5)).toEqual([]);
    expect(missing).toHaveLength(0);
  });

  it("sends every other URL to a route that exists", () => {
    const routes = new Set<string>(sitePaths());
    const committees = seededSlugs("committee");

    for (const [from, to] of Object.entries(LEGACY_REDIRECTS)) {
      if (to.startsWith(PRESS_PREFIX)) continue;

      const known =
        routes.has(to) ||
        (to.startsWith("/about/committees/") &&
          committees.has(to.slice("/about/committees/".length)));

      expect(known, `${from} redirects to ${to}, which is not a route`).toBe(true);
    }
  });

  it("never redirects to another legacy URL", () => {
    // A chain costs a hop, and more than five hops is where crawlers give up.
    for (const to of Object.values(LEGACY_REDIRECTS)) {
      expect(to).not.toMatch(/\.php/);
      expect(to.startsWith("/")).toBe(true);
    }
  });

  it("covers the whole crawled press archive", () => {
    const ids = Object.keys(LEGACY_REDIRECTS).filter((k) => k.startsWith("press.php?id="));
    // 699 legacy ids were crawled; 8 of them are duplicates of another id and
    // were folded into the release they duplicate — but all 699 are live URLs
    // today, so all 699 need a destination.
    expect(ids).toHaveLength(699);
  });

  it("covers every interior page the import mapped", () => {
    // Loose sanity bound rather than an exact count: the number moves when a
    // legacy page is placed, and the test should not have to be edited for an
    // improvement.
    const pages = Object.keys(LEGACY_REDIRECTS).filter(
      (k) => !k.startsWith("press.php?id="),
    );
    expect(pages.length).toBeGreaterThanOrEqual(50);
  });

  it("leaves no imported page without a destination", () => {
    // The check that would have caught the eleven pages that were imported,
    // mapped to no route, and therefore absent from the table entirely.
    const sources: string[] = [];
    for (const file of readdirSync("legacy-import").filter((f) => f.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(join("legacy-import", file), "utf8")) as {
        source?: string;
      };
      if (data.source) sources.push(data.source);
    }

    expect(sources.length).toBeGreaterThan(40);

    const unrouted = sources.filter((url) => {
      const key = url.replace(/^https?:\/\/(?:www\.)?lcci\.com\.pk\/?/i, "");
      return !LEGACY_REDIRECTS[key];
    });

    expect(unrouted).toEqual([]);
  });
});

describe("resolving a request", () => {
  function resolve(url: string): string | null {
    const parsed = new URL(url, "https://lcci.com.pk");
    return legacyRedirect(parsed.pathname, parsed.searchParams);
  }

  it("moves a legacy interior page", () => {
    expect(resolve("/about.php?id=100")).toBe("/resources/banks");
  });

  it("moves the old front door", () => {
    expect(resolve("/index.php")).toBe("/");
  });

  it("ignores a query parameter that is not the id", () => {
    // The old site's own links sometimes carry a tracking or session
    // parameter. The page is the same page.
    expect(resolve("/about.php?id=100&utm_source=newsletter")).toBe("/resources/banks");
  });

  it("sends an emptied press id to the archive rather than a 404", () => {
    // ~196 of the ~895 legacy press ids were already empty when the archive
    // was crawled. They still have inbound links, and a visitor who clicked a
    // press link should land on press releases.
    expect(resolve("/press.php?id=999999")).toBe("/news/press-releases");
    expect(resolve("/press.php")).toBe("/news/press-releases");
  });

  it("does not redirect anything that is not a legacy address", () => {
    for (const url of [
      "/about/history",
      "/",
      "/news/press-releases",
      "/admin",
      "/api/cron/email-outbox",
    ]) {
      expect(resolve(url), url).toBeNull();
    }
  });

  it("leaves an unknown legacy script to 404", () => {
    // Deliberately not a blanket redirect home: a soft 404 is treated worse
    // by search engines than the real thing, and tells the visitor nothing.
    expect(resolve("/wp-login.php")).toBeNull();
    expect(resolve("/about.php?id=999999")).toBeNull();
  });
});

describe("the press route can actually serve a redirect", () => {
  const ROUTE = "src/app/(site)/news/press-releases/[slug]/page.tsx";

  it("does not refuse an unprerendered slug at the route level", () => {
    // The bug this exists for: the route had `dynamicParams = false`, which
    // makes Next answer 404 for any slug absent from `generateStaticParams`
    // *before* the component runs. Every one of the 686 draft archive slugs is
    // absent from that list, so the `isUnpublishedArchiveSlug` branch in the
    // component — the whole point of src/content/press-archive.ts — was
    // unreachable, and `press.php?id=1` answered 308 and then 404 exactly as
    // if the fallback had never been written.
    //
    // Asserted against the source rather than by importing the module, because
    // the module pulls in the repository and a real database connection; this
    // check needs to hold in a unit run with neither.
    const source = readFileSync(ROUTE, "utf8");
    const declared = /export\s+const\s+dynamicParams\s*=\s*(true|false)/.exec(source);

    expect(
      declared?.[1] ?? "true",
      "dynamicParams = false makes the unpublished-archive redirect unreachable",
    ).toBe("true");
  });

  it("still sends a slug nobody imported to Not Found", () => {
    // The other half: render-on-demand must not become a soft 404 for
    // everything. `notFound()` has to stay on the path a random slug takes.
    const source = readFileSync(ROUTE, "utf8");
    expect(source).toContain("notFound()");
    expect(source).toContain("isUnpublishedArchiveSlug(slug)");
  });
});

describe("a press redirect's destination", () => {
  it("knows every slug the archive was imported under", () => {
    // Derived from the table's own destinations, so this is really a check
    // that the derivation found them rather than a count worth defending.
    expect(archiveSlugCount()).toBeGreaterThan(600);
  });

  it("recognises an imported slug and nothing else", () => {
    const anyArchiveSlug = Object.values(LEGACY_REDIRECTS)
      .filter((to) => to.startsWith(PRESS_PREFIX))
      .map((to) => to.slice(PRESS_PREFIX.length))[0] as string;

    expect(isUnpublishedArchiveSlug(anyArchiveSlug)).toBe(true);
    expect(isUnpublishedArchiveSlug("a-release-nobody-imported")).toBe(false);
    expect(isUnpublishedArchiveSlug("")).toBe(false);
  });
});
