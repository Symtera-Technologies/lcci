import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sitePaths } from "@/components/site/nav-data";
import {
  buildRobots,
  buildSitemap,
  disallowedPaths,
  isIndexableHost,
  type SitemapData,
} from "@/content/crawling";
import { POLICY_REQUIRED_PREFIXES } from "@/server/auth/policy";

/**
 * What crawlers are told, and whether it is true.
 *
 * Three things here cannot be caught by looking at the generated files, which
 * is why they are tested. **A route missing from the sitemap** looks like
 * nothing at all — the file is still valid XML and the page still works, so
 * the only symptom is a page that never ranks. **A URL that is both listed and
 * disallowed** is reported by Search Console as an error per URL, long after
 * whichever of the two files was edited alone. And **`Disallow: /` reaching
 * production** would deindex the chamber's entire site, silently, with the
 * site itself looking perfectly healthy.
 */

const SITE = join("src", "app", "(site)");

/** Every public route with a `page.tsx`, from the filesystem. */
function routesOnDisk(dir = SITE, prefix = ""): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Dynamic segments render one row per URL and have no fixed address of
    // their own; the sitemap enumerates those from the database instead.
    if (!entry.isDirectory() || entry.name.startsWith("[")) continue;

    const path = `${prefix}/${entry.name}`;
    const child = join(dir, entry.name);

    if (readdirSync(child).includes("page.tsx")) found.push(path);
    found.push(...routesOnDisk(child, path));
  }

  return found;
}

const DATA: SitemapData = {
  origin: "https://lcci.com.pk",
  pages: [
    { slug: "about-history", updatedAt: new Date("2026-03-01T00:00:00Z") },
    { slug: "services-training", updatedAt: new Date("2026-04-02T00:00:00Z") },
  ],
  pressReleases: [
    { slug: "budget-proposals-submitted", updatedAt: new Date("2026-05-03T00:00:00Z") },
  ],
  committees: [{ slug: "energy", updatedAt: new Date("2026-02-04T00:00:00Z") }],
  pressReleasesPerPage: 24,
};

function urls(data: SitemapData = DATA): string[] {
  return buildSitemap(data).map((entry) => entry.url);
}

describe("the site's own routes", () => {
  it("lists exactly the routes that exist on disk", () => {
    // Both directions. A route added without a navigation entry already fails
    // `navEntry` at build time; this is the other half — a route the IA knows
    // about that nobody built, which would put a 404 in the sitemap.
    const declared = sitePaths().filter((path) => path !== "/");
    expect([...declared].sort()).toEqual(routesOnDisk().sort());
  });

  it("includes the homepage, which is in no menu", () => {
    expect(sitePaths()).toContain("/");
  });

  it("leaves the off-site membership portal out", () => {
    expect(sitePaths().every((path) => path.startsWith("/"))).toBe(true);
    expect(sitePaths().some((path) => path.includes("membership.lcci"))).toBe(false);
  });
});

describe("the sitemap", () => {
  it("carries every public route", () => {
    const listed = new Set(urls());
    for (const path of sitePaths()) {
      const expected = path === "/" ? "https://lcci.com.pk" : `https://lcci.com.pk${path}`;
      expect(listed.has(expected), `${path} is missing from the sitemap`).toBe(true);
    }
  });

  it("gives the homepage no trailing slash", () => {
    // `https://lcci.com.pk/` and `https://lcci.com.pk` are the same page and
    // two URLs. The canonical link says the second, so this must too.
    expect(urls()).toContain("https://lcci.com.pk");
    expect(urls()).not.toContain("https://lcci.com.pk/");
  });

  it("survives an origin with a trailing slash", () => {
    const listed = urls({ ...DATA, origin: "https://lcci.com.pk/" });
    expect(listed).toContain("https://lcci.com.pk/about/history");
    expect(listed.some((url) => url.includes("pk//"))).toBe(false);
  });

  it("dates a page from its row", () => {
    const entry = buildSitemap(DATA).find((e) => e.url.endsWith("/about/history"));
    expect(entry?.lastModified).toEqual(new Date("2026-03-01T00:00:00Z"));
  });

  it("gives no date to a page nobody has written", () => {
    // The 28 empty pages. A fabricated `lastmod` — today's date, say — tells a
    // crawler every one of them changed this morning, which is both false and
    // the way a crawler learns to ignore the field.
    const entry = buildSitemap(DATA).find((e) => e.url.endsWith("/about/careers"));
    expect(entry).toBeDefined();
    expect(entry?.lastModified).toBeUndefined();
  });

  it("gives the homepage no date, having no row to take one from", () => {
    const entry = buildSitemap(DATA).find((e) => e.url === "https://lcci.com.pk");
    expect(entry?.lastModified).toBeUndefined();
  });

  it("lists each press release and each committee", () => {
    expect(urls()).toContain(
      "https://lcci.com.pk/news/press-releases/budget-proposals-submitted",
    );
    expect(urls()).toContain("https://lcci.com.pk/about/committees/energy");
  });

  it("omits the archive's page 2 while one page holds everything", () => {
    expect(urls().some((url) => url.includes("/press-releases/page/"))).toBe(false);
  });

  it("lists the archive's later pages once there are any", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      slug: `release-${i}`,
      updatedAt: new Date("2026-06-05T00:00:00Z"),
    }));
    const listed = urls({ ...DATA, pressReleases: many });

    // 50 releases at 24 a page is three pages; page 1 is the index route.
    expect(listed).toContain("https://lcci.com.pk/news/press-releases/page/2");
    expect(listed).toContain("https://lcci.com.pk/news/press-releases/page/3");
    expect(listed).not.toContain("https://lcci.com.pk/news/press-releases/page/1");
    expect(listed).not.toContain("https://lcci.com.pk/news/press-releases/page/4");
  });

  it("repeats no URL", () => {
    const listed = urls();
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("advertises nothing robots.txt forbids", () => {
    // The invariant the two files exist to keep. Prefix matching, because that
    // is how a crawler reads `Disallow`.
    const forbidden = disallowedPaths();
    for (const url of urls()) {
      const path = url.replace("https://lcci.com.pk", "") || "/";
      const hit = forbidden.find((prefix) => path.startsWith(prefix));
      expect(hit, `${path} is in the sitemap and disallowed by ${hit}`).toBeUndefined();
    }
  });
});

describe("robots.txt", () => {
  it("disallows every prefix the auth policy protects", () => {
    const forbidden = disallowedPaths();
    for (const prefix of POLICY_REQUIRED_PREFIXES) {
      expect(forbidden, `${prefix} is reachable by crawlers`).toContain(`${prefix}/`);
    }
  });

  it("disallows the second design variant", () => {
    // `/v2` serves the homepage's content at a second address. Crawlable, it
    // competes with `/` for the chamber's own name.
    expect(disallowedPaths()).toContain("/v2");
  });

  it("points at the sitemap on a production host", () => {
    const robots = buildRobots("https://lcci.com.pk", "lcci.com.pk");
    expect(robots.sitemap).toBe("https://lcci.com.pk/sitemap.xml");
    expect(robots.rules).toMatchObject({ userAgent: "*", allow: "/" });
  });

  it("shuts a staging copy out entirely", () => {
    for (const host of [
      "staging.lcci.com.pk",
      "dev.lcci.com.pk",
      "test-lcci.com.pk",
      "preview.lcci.com.pk",
      "localhost:9000",
      "127.0.0.1:3000",
    ]) {
      const robots = buildRobots("https://lcci.com.pk", host);
      expect(robots.rules, host).toEqual({ userAgent: "*", disallow: "/" });
      // No sitemap line either: handing over the list of URLs a crawler was
      // just told not to fetch is an invitation some of them accept.
      expect(robots.sitemap, host).toBeUndefined();
    }
  });

  it("treats an unrecognised host as production", () => {
    // The asymmetry that matters. Behind Passenger the `Host` header may be
    // an internal name, and a strict match against the canonical origin would
    // then serve `Disallow: /` on the live site — a worse failure, and a
    // quieter one, than a staging copy being indexed.
    for (const host of [null, "", "lcci.com.pk", "www.lcci.com.pk", "10.0.0.4:8080"]) {
      expect(isIndexableHost(host), String(host)).toBe(true);
    }
  });

  it("is not fooled by a production host that merely contains a keyword", () => {
    // `development.lcci.com.pk` is staging; `devonshire.example` is not, and
    // neither is a chamber page about development.
    expect(isIndexableHost("devonshire.example")).toBe(true);
    expect(isIndexableHost("lcci-dev.com.pk")).toBe(true);
    expect(isIndexableHost("development.lcci.com.pk")).toBe(false);
  });
});
