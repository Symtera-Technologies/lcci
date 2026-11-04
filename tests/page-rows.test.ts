import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pageSlug } from "@/content/page-slug";

/**
 * Every public route has a `page` row, and every `page` row has a route.
 *
 * This is the one invariant in the content layer that fails *silently* in both
 * directions, which is why it is worth a test rather than a convention.
 *
 * A route whose slug has no row renders a page that looks finished: correct
 * heading, correct breadcrumb, correct canonical, and a panel saying the page
 * is being prepared. `getPage` returns null for "no row" and null for "not
 * written yet", so nothing throws and nothing logs — and the editor who was
 * asked to write that page cannot find it in the admin, because the admin
 * lists rows.
 *
 * A row whose slug no route reads is the same failure mirrored: it appears in
 * the admin, an editor writes into it, presses publish, and the text appears
 * nowhere. `/membership/register` was exactly that case for one commit — it is
 * in the navigation, so the seed generator created a row for it, but it is a
 * form the portal owns and has no editable prose at all.
 *
 * Both sides are read from the repository rather than from a database, so this
 * runs in the hermetic suite: the routes from the filesystem, the rows from the
 * `INSERT` statements in `migrations/`. That also makes the failure arrive at
 * the right moment — when the route or the migration is added, not when
 * somebody runs the migrations against a server.
 */

const SITE = join("src", "app", "(site)");
const MIGRATIONS = "migrations";

/**
 * The slug each public interior route reads its prose from.
 *
 * Skips the homepage, which is not a `page`, and any route with a dynamic
 * segment: `/about/committees/[slug]` renders one `committee` row per URL and
 * has no prose of its own.
 */
function routeSlugs(dir = SITE, prefix = ""): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("[")) continue;

    const path = `${prefix}/${entry.name}`;
    const child = join(dir, entry.name);

    if (readdirSync(child).includes("page.tsx")) {
      found.push(pageSlug(path as `/${string}`));
    }
    found.push(...routeSlugs(child, path));
  }

  return found;
}

/**
 * Every slug the migrations create a `page` row at.
 *
 * Matched on the literal tuple the seed generator emits rather than parsed as
 * SQL, which is enough here and keeps the test from needing a parser: a seed
 * row always begins `('page', '<slug>', `. A migration that created a page row
 * some other way would be missed, and would then show up as a row with no
 * route the moment it was regenerated.
 */
function seededSlugs(): string[] {
  const slugs: string[] = [];

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of sql.matchAll(/\(\s*'page',\s*'([a-z0-9-]+)'/g)) {
      if (match[1]) slugs.push(match[1]);
    }
  }

  return slugs;
}

describe("page rows and public routes", () => {
  const routes = [...new Set(routeSlugs())].sort();
  const seeded = [...new Set(seededSlugs())].sort();

  it("finds the routes and the rows at all", () => {
    // Guards the two tests below against passing vacuously: a glob that
    // matched nothing, or a regex that stopped matching the generator's
    // output, would otherwise make both comparisons trivially true.
    expect(routes.length).toBeGreaterThan(50);
    expect(seeded.length).toBeGreaterThan(50);
  });

  it("creates a row for every public route", () => {
    const missing = routes.filter((slug) => !seeded.includes(slug));
    expect(
      missing,
      "these routes have no `page` row, so the page they render can never be " +
        "written: it is not in the admin's list. Add them to a section in " +
        "scripts/generate-page-seed.ts and regenerate that section's seed.",
    ).toEqual([]);
  });

  it("creates no row that no route reads", () => {
    const orphans = seeded.filter((slug) => !routes.includes(slug));
    expect(
      orphans,
      "these `page` rows have no route reading them, so anything an editor " +
        "writes into them appears nowhere. Either add the route under " +
        "src/app/(site)/, or stop seeding the row.",
    ).toEqual([]);
  });
});
