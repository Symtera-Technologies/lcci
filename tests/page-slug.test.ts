import { describe, expect, it } from "vitest";
import { PRIMARY_NAV, isSitePath } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";

/**
 * Where a page's prose is published, derived from the route that serves it.
 *
 * The reason this is tested rather than trusted is that its failure is silent.
 * A route whose slug does not match the row an editor created renders a page
 * that looks finished — correct heading, correct breadcrumb, correct canonical
 * — and is permanently blank, because `getPage` returns null, which is also
 * exactly what "nobody has written this yet" returns. Nothing throws, nothing
 * logs, and the only person who can see the problem is the editor who is
 * certain they published it.
 *
 * The collision test is the one that will eventually fire. Flattening `/` to
 * `-` is not injective, so the day someone adds a nested route whose flattened
 * path already belongs to another page, this suite says so instead of two
 * pages quietly sharing one row.
 */

describe("pageSlug", () => {
  it("flattens a section landing page to a single word", () => {
    expect(pageSlug("/about")).toBe("about");
  });

  it("joins a child's segments with a dash", () => {
    expect(pageSlug("/about/history")).toBe("about-history");
  });

  it("leaves dashes inside a segment alone", () => {
    expect(pageSlug("/about/past-leadership")).toBe("about-past-leadership");
  });

  it("flattens a route nested more than two deep", () => {
    expect(pageSlug("/services/library/wto-reference-centre")).toBe(
      "services-library-wto-reference-centre",
    );
  });

  it("tolerates a trailing slash", () => {
    // Not how a route file writes it, but `pageSlug` is handed a path and a
    // trailing slash must not produce `about-history-`, which would match no
    // row and read, in the admin's list, as a typo nobody made.
    expect(pageSlug("/about/history/")).toBe("about-history");
  });

  it("refuses the homepage, which is not a page", () => {
    expect(() => pageSlug("/")).toThrowError(/not a `page`/);
  });

  /* ---------------------------------------------------------------------- */

  it("fits inside the slug column", () => {
    // `content_items.slug` is VARCHAR(160). Every route in the IA has to fit,
    // because the insert is what would fail — at the moment an editor presses
    // save, in the admin, with no indication that the route is the problem.
    for (const section of PRIMARY_NAV) {
      for (const href of [
        section.href,
        ...section.children.map((c) => c.href).filter(isSitePath),
      ]) {
        expect(pageSlug(href).length, href).toBeLessThanOrEqual(160);
      }
    }
  });

  it("gives every route in the navigation its own slug", () => {
    const seen = new Map<string, string>();

    for (const section of PRIMARY_NAV) {
      for (const href of [
        section.href,
        ...section.children.map((c) => c.href).filter(isSitePath),
      ]) {
        const slug = pageSlug(href);
        const clash = seen.get(slug);

        expect(
          clash,
          `${href} and ${clash} both flatten to "${slug}" — rename one of the ` +
            "segments; do not change the rule, which would orphan every row " +
            "already published under it",
        ).toBeUndefined();

        seen.set(slug, href);
      }
    }

    // A sanity check on the walk itself: if `PRIMARY_NAV` were ever emptied,
    // every assertion above would pass vacuously.
    expect(seen.size).toBeGreaterThan(40);
  });

  it("produces slugs the admin's own validation would accept", () => {
    // The admin's slug field is a `slug` kind, and a hand-typed slug has to
    // look like these. A derived slug that the editor could not have typed
    // would be a row they cannot create or correct by hand.
    for (const section of PRIMARY_NAV) {
      for (const href of [
        section.href,
        ...section.children.map((c) => c.href).filter(isSitePath),
      ]) {
        expect(pageSlug(href), href).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    }
  });
});
