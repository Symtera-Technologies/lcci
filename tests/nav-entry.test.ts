import { describe, expect, it } from "vitest";
import {
  FOOTER_LEGAL,
  PRIMARY_NAV,
  isSitePath,
  navEntry,
} from "@/components/site/nav-data";

/**
 * The IA lookup every interior route builds its heading and breadcrumb from.
 *
 * It exists so that a page's title lives in exactly one place — the navigation
 * data — rather than being typed again in the route file, in the header, in
 * the footer sitemap and in the section landing page. The test that earns its
 * keep is the last one: `navEntry` **throws** on an href that is not in the
 * navigation, and because these pages are statically prerendered, that throw
 * is a failed build rather than a page that ships with an empty `<h1>`.
 *
 * That is the mechanical version of the rule `nav-data.ts` states in prose:
 * the legacy site had seven placeholder links, and "added the route, forgot
 * the nav entry" is how the eighth would happen here.
 */

describe("navEntry", () => {
  it("resolves a section landing page to its own label and an empty trail", () => {
    const entry = navEntry("/about");

    expect(entry.title).toBe("About");
    // Empty, not `[{ label: "Home" }]` — `Breadcrumb` prepends Home itself, so
    // a trail containing it would render Home twice.
    expect(entry.trail).toEqual([]);
  });

  it("resolves a child to its label and its parent", () => {
    const entry = navEntry("/about/history");

    expect(entry.title).toBe("History & mission");
    expect(entry.description).toBe("The chamber since 1923");
    expect(entry.trail).toEqual([{ label: "About", href: "/about" }]);
  });

  it("omits the description where the IA gives none", () => {
    // `CmsPage` falls back on `undefined` and renders no standfirst at all; an
    // empty string would satisfy `??` and leave a blank line under the
    // heading.
    //
    // Most entries carry one — a section index card without a line under its
    // heading reads as unfinished beside ones that have it — so this names a
    // route that still does not, and the assertion is about the absence, not
    // about this particular page.
    expect(navEntry("/membership/categories").description).toBeUndefined();
  });

  it("resolves a child of a section other than About", () => {
    const entry = navEntry("/news/press-releases");

    expect(entry.title).toBe("Press releases");
    expect(entry.trail).toEqual([{ label: "Newsroom", href: "/news" }]);
  });

  it("covers every route in the navigation", () => {
    // Walks the whole IA rather than sampling it, so a section added without a
    // label, or a child duplicated under two sections, is caught here.
    for (const section of PRIMARY_NAV) {
      expect(navEntry(section.href).title, section.href).toBe(section.label);

      for (const child of section.children) {
        // Off-site entries are not routes of ours, so `navEntry` neither can
        // nor should answer for them. The assertion below keeps that honest:
        // an internal route silently turned external would stop being checked
        // here, so it is checked that it is external on purpose.
        if (!isSitePath(child.href)) {
          expect(child.href, child.label).toMatch(/^https:\/\//);
          continue;
        }

        const entry = navEntry(child.href);
        expect(entry.title, child.href).toBe(child.label);
        expect(entry.trail, child.href).toEqual([
          { label: section.label, href: section.href },
        ]);
      }
    }
  });

  it("throws on a route the navigation does not know about", () => {
    expect(() => navEntry("/about/invented")).toThrowError(/not in the navigation/);
  });

  it("resolves the footer's legal pages, which are in no section", () => {
    // They are reachable from the footer and nowhere else -- a privacy policy
    // does not belong in a chamber's main menu -- but they are public routes,
    // so navEntry has to answer for them or the rule above would force them
    // into PRIMARY_NAV to get a heading.
    for (const legal of FOOTER_LEGAL) {
      const entry = navEntry(legal.href);
      expect(entry.title, legal.href).toBe(legal.label);
      expect(entry.trail, legal.href).toEqual([]);
    }
  });

  it("does not resolve a route by prefix", () => {
    // `/about/history/1923` is not `/about/history`. A prefix match would give
    // a nested route the wrong heading and a breadcrumb missing a level.
    expect(() => navEntry("/about/history/1923")).toThrowError(/not in the navigation/);
  });
});
