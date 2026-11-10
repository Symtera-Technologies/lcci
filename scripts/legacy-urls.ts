import { createHash } from "node:crypto";
import { slugify } from "@/content/fields";

/**
 * How a legacy URL is identified, and how the press archive was addressed.
 *
 * Three functions, moved here out of `generate-page-seed.ts` and
 * `generate-press-seed.ts` without a line changed, because a third script now
 * needs them: `generate-redirect-map.ts`. The comment that sat above
 * `legacyRouteMap` said deriving the link rewriting and the launch's 301 table
 * from one place was the point — this file is that place.
 *
 * Nothing here may change casually. `assignSlugs` decides the public address
 * of 691 press releases, and migration 0037 has already been applied with its
 * output; a different answer from the same input would silently point every
 * redirect at a slug that does not exist. `tests/legacy-redirects.test.ts`
 * holds it to 0037 by comparing every slug it produces against the migration's
 * own `INSERT` list.
 */

/** The fields of an imported page that matter for addressing it. */
export interface LegacySource {
  source: string;
}

/** The fields of an imported press release that matter for addressing it. */
export interface LegacyRelease {
  legacyId: number;
  headline: string;
  body: string | null;
}

/**
 * An href's legacy identity, or null if it does not have one.
 *
 * The old site writes the same page four ways — `about.php?id=101`,
 * `/about.php?id=101`, `http://lcci.com.pk/about.php?id=101` and the `www.`
 * form — and all four appear in the markup, sometimes on one page. They are
 * normalised to the bare path-and-query so one map entry covers all of them.
 *
 * Returns null for a fragment, a `mailto:`/`tel:`, or a link to another host:
 * those are left exactly as they are.
 */
export function legacyKey(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  if (/^(mailto|tel|javascript|data):/i.test(trimmed)) return null;

  const onThisHost = /^https?:\/\/(?:www\.)?lcci\.com\.pk(?:\/|$)(.*)$/i.exec(trimmed);
  if (onThisHost) return (onThisHost[1] ?? "").replace(/^\/+/, "");

  // Any other absolute or protocol-relative URL is somebody else's site.
  if (/^(?:https?:)?\/\//i.test(trimmed)) return null;

  return trimmed.replace(/^\/+/, "");
}

/**
 * Group releases that are the same release under more than one legacy id.
 *
 * Keyed on headline plus body, so a page the old site serves at two ids
 * collapses to one row — and the lower id wins, because it is the one more
 * likely to be linked from elsewhere. The discarded ids are returned as
 * `aliases` rather than dropped: they are live URLs today and each one needs a
 * redirect to the kept release.
 */
export function dedupe<T extends LegacyRelease>(
  items: T[],
): { kept: T; aliases: number[] }[] {
  const groups = new Map<string, T[]>();

  for (const item of items) {
    const key = createHash("sha256")
      .update(`${item.headline}\u0000${item.body ?? ""}`)
      .digest("hex");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => a.legacyId - b.legacyId);
      return {
        kept: sorted[0] as T,
        aliases: sorted.slice(1).map((i) => i.legacyId),
      };
    })
    .sort((a, b) => a.kept.legacyId - b.kept.legacyId);
}

/**
 * One slug per release, unique within the archive.
 *
 * `slugify` is the application's own — the same suggestion the admin's editor
 * would make from the headline — so these addresses are the ones an editor
 * would have chosen. Two releases can share a headline (the chamber reissues
 * one, or a page was duplicated), and the slug is the public address, so a
 * collision inside the archive is disambiguated with the legacy id rather than
 * silently dropping a release.
 *
 * **Order-dependent, and the order is the caller's job.** Which of two
 * colliding headlines keeps the bare slug depends on which is seen first, so
 * every caller sorts by `legacyId` before calling this — the same order
 * migration 0037 was generated in.
 */
export function assignSlugs(items: readonly LegacyRelease[]): Map<number, string> {
  const taken = new Set<string>();
  const slugs = new Map<number, string>();

  for (const item of items) {
    const base = slugify(item.headline) || `press-${item.legacyId}`;
    let slug = base;

    if (taken.has(slug)) {
      const suffix = `-${item.legacyId}`;
      slug = `${base.slice(0, 160 - suffix.length)}${suffix}`;
    }

    taken.add(slug);
    slugs.set(item.legacyId, slug);
  }

  return slugs;
}
