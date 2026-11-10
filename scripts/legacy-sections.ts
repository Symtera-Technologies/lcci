/**
 * Which legacy page belongs at which route.
 *
 * The mapping table, on its own, because two scripts read it:
 * `generate-page-seed.ts` turns it into seed SQL, and
 * `verify-migrated-text.ts` uses it to check the built site against the pages
 * it was built from. A second copy of the pairings would eventually disagree
 * with the first, and the disagreement would show up as "that page verifies
 * clean" for a page nothing had actually seeded.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PRIMARY_NAV, type NavLink } from "@/components/site/nav-data";

export interface Source {
  /** Basename of the JSON file in the import directory. */
  file: string;
  /**
   * Other legacy URLs that serve this same page.
   *
   * The old site has duplicates — `about.php?id=95` and `services.php?id=95`
   * are one page under two addresses, as are `about.php?id=85` and
   * `members.php?id=85`. Listing them here does two things: both get rewritten
   * when another page links to them, and both are on record as needing a 301
   * to the same new route.
   */
  aliases?: string[];
  /**
   * Drop `<table>` elements from this page's body.
   *
   * One page needs it. `contact.php`'s body is mostly a contact *form* laid
   * out as a table — "Your Name:", "Your Email:", empty cells where the inputs
   * were. A form is a control and not content: the inputs cannot survive the
   * sanitiser, so migrating the table would publish a table of labels with
   * nothing to type into. The rebuilt contact page carries the same
   * information the live one does — address, switchboard, fax and the four
   * published addresses — as structured blocks the route renders.
   */
  dropTables?: boolean;
}

export interface Mapping {
  /**
   * The route this content belongs at.
   *
   * The slug and the title are derived from it, by the same `pageSlug` and
   * `navEntry` the route file itself calls. That is the point of taking a path
   * here rather than a slug: a seed and a route that disagree about either
   * would produce a page that renders perfectly and is permanently empty, and
   * nothing would report it.
   */
  path: `/${string}`;
  /** Legacy pages whose content belongs at that route, in reading order. */
  sources: Source[];
  /**
   * Add this content to the end of a body that is already there, instead of
   * filling an empty one.
   *
   * Needed because an applied migration cannot be edited. `/about/secretariat`
   * was seeded with the Information and the Research & Development
   * departments; `services.php?id=76` is a third department on the same page,
   * found later. The ordinary `body_en IS NULL` guard would skip that row
   * forever, so this emits a `CONCAT` guarded on the heading not already being
   * in the body -- idempotent, and it destroys nothing an editor has written,
   * because their text is kept and the new section lands after it.
   */
  append?: boolean;
}

export interface Section {
  /**
   * The section's landing route. Its child routes are read from `PRIMARY_NAV`,
   * so a row is created for every page in the section — including the ones no
   * legacy page maps onto, which are exactly the ones an editor has to write
   * and so exactly the ones that must already be listed in the admin.
   *
   * Exactly one of `path` and `routes` is given.
   */
  path?: `/${string}`;
  /**
   * The routes to create rows for, listed rather than derived.
   *
   * For the pages that are in no navigation section: the privacy policy, the
   * terms and the accessibility statement hang off the footer and nothing
   * else, so there is no section to read them from — but they are public
   * routes with editable prose and need their rows like any other page.
   */
  routes?: readonly `/${string}`[];
  /** `departments.code` for rows this migration creates. */
  department: string;
  /**
   * `review_by` for rows this migration creates, where the content is the kind
   * that goes stale on nobody's schedule. Omitted leaves it NULL.
   */
  reviewBy?: string;
  mappings: Mapping[];
}

/**
 * Which legacy page belongs at which route.
 *
 * Written out rather than inferred, because there is no rule to infer it
 * from — `about.php?id=75` is titled "Vision & Mission" and belongs under a
 * route the IA calls "History & mission", and three separate legacy pages make
 * up the one roll of past office bearers. Each line is a judgement, so each
 * line is visible and reviewable.
 *
 * A route with no entry here still gets a row — `createRows` reads the section
 * from `PRIMARY_NAV`, not from this table — it simply gets an empty one. Three
 * About routes are in that position, for two different reasons: `/about` is a
 * section landing page the legacy site has no equivalent of, and
 * `/about/committees` and `/about/careers` are `href="#"` on the old menu, so
 * the old site links to them and serves nothing.
 *
 * One route is deliberately incomplete: `/about/leadership` takes the
 * President's message, but the thirteen other Executive Committee members on
 * `excomm.php` are structured records — name, designation, firm, telephone,
 * email, portrait — rendered outside the content container. They need a
 * content type, not a paragraph.
 */
export const SECTIONS: Record<string, Section> = {
  about: {
    path: "/about",
    department: "info",
    mappings: [
      { path: "/about/history", sources: [{ file: "about.php-id-75.json" }] },
      { path: "/about/leadership", sources: [{ file: "about.php-id-5.json" }] },
      {
        path: "/about/past-leadership",
        sources: [
          { file: "presidents.php.json" },
          { file: "about.php-id-6.json" },
          { file: "about.php-id-7.json" },
        ],
      },
      {
        path: "/about/secretariat",
        sources: [
          { file: "services.php-id-9.json" },
          { file: "about.php-id-95.json", aliases: ["services.php?id=95"] },
        ],
      },
      {
        path: "/about/contact",
        sources: [{ file: "contact.php.json", dropTables: true }],
      },
    ],
  },

  /**
   * The old site's "Useful Links" menu, one route per list.
   *
   * `about.php?id=96` is that menu's own index page and lands on the section
   * landing route, where its paragraph of introduction sits above the index of
   * the sixteen lists.
   *
   * `review_by` is set on every row, which is unusual for seeded content.
   * These lists carry embassy telephone numbers, hospital addresses and
   * helpline numbers, several of them visibly years old. They are published
   * because they are what the chamber publishes today, and dated for review
   * because a wrong emergency number is worse than no number — B4's
   * stale-content report is the only mechanism that will ever raise them
   * again.
   */
  resources: {
    path: "/resources",
    department: "info",
    reviewBy: "2027-04-01",
    mappings: [
      { path: "/resources", sources: [{ file: "about.php-id-96.json" }] },
      {
        path: "/resources/embassies-in-pakistan",
        sources: [{ file: "about.php-id-106.json" }],
      },
      {
        path: "/resources/pakistan-embassies-abroad",
        sources: [{ file: "about.php-id-107.json" }],
      },
      {
        path: "/resources/government-authorities",
        sources: [{ file: "about.php-id-120.json" }],
      },
      {
        path: "/resources/federal-departments",
        sources: [{ file: "about.php-id-129.json" }],
      },
      {
        path: "/resources/helpline-numbers",
        sources: [{ file: "about.php-id-146.json" }],
      },
      {
        path: "/resources/hospitals-lahore",
        sources: [{ file: "about.php-id-128.json" }],
      },
      {
        path: "/resources/hospitals-pakistan",
        sources: [{ file: "business.php-id-130.json" }],
      },
      { path: "/resources/banks", sources: [{ file: "about.php-id-100.json" }] },
      {
        path: "/resources/chambers-pakistan",
        sources: [{ file: "about.php-id-103.json" }],
      },
      {
        path: "/resources/chambers-international",
        sources: [{ file: "about.php-id-101.json" }],
      },
      {
        path: "/resources/newspapers-pakistan",
        sources: [{ file: "about.php-id-104.json" }],
      },
      {
        path: "/resources/newspapers-international",
        sources: [{ file: "about.php-id-102.json" }],
      },
      { path: "/resources/airlines", sources: [{ file: "about.php-id-145.json" }] },
      {
        path: "/resources/international-links",
        sources: [{ file: "about.php-id-144.json" }],
      },
      {
        path: "/resources/places-to-visit",
        sources: [{ file: "about.php-id-109.json" }],
      },
      {
        path: "/resources/member-websites",
        sources: [{ file: "about.php-id-85.json", aliases: ["members.php?id=85"] }],
      },
    ],
  },

  /**
   * One page added to About after 0025 and 0026 had already run.
   *
   * A second entry rather than an edit to `about` above, because an applied
   * migration is immutable: 0026 is on the server and its checksum is in
   * `schema_migrations`, so the only way to add a page to a seeded section is
   * a new file. The row insert is `INSERT IGNORE` and the body update is
   * guarded on `body_en IS NULL`, so running this over the eight rows 0025
   * created touches none of them.
   */
  "about-minutes": {
    path: "/about",
    department: "info",
    mappings: [
      { path: "/about/minutes", sources: [{ file: "about.php-id-135.json" }] },
      // The Computer & Internet Department, a third department on a page 0026
      // already seeded with two. See `Mapping.append`.
      {
        path: "/about/secretariat",
        sources: [{ file: "services.php-id-76.json" }],
        append: true,
      },
    ],
  },

  /**
   * What membership is and what it costs.
   *
   * Two of the six routes have a legacy page behind it. The others are
   * genuinely not on lcci.com.pk: the dues are published as a PDF rather than
   * as a page, renewal is described nowhere, the directory is a database and
   * "FAQs" is an `href="#"` on the old menu. Those are rows an editor types
   * into, which is why the rows are created regardless.
   *
   * **`membership.php` was missed on the first pass.** It is the target of the
   * legacy site's own *Membership* menu item and it was never imported — the
   * crawler saw it (`LEGACY-MIGRATION.md` cites it in the broken-links table)
   * and no mapping claimed it, so 1,316 characters the chamber publishes today
   * were absent from the rebuild and the client spreadsheet was asking LCCI to
   * write content they already own.
   *
   * It maps to `/membership`, the section landing, because that is the same
   * position in the IA that the legacy menu item occupied — one page, one
   * destination, no words moved between routes.
   *
   * It does **not** close `/membership/categories`. The legacy page says only
   * "There shall be two classes of memberships" and never names them, so what
   * the two classes are, and what each costs, is still outstanding and still
   * LCCI's to supply.
   */
  membership: {
    path: "/membership",
    department: "secretariat",
    mappings: [
      { path: "/membership", sources: [{ file: "membership.php.json" }] },
      { path: "/membership/why-join", sources: [{ file: "members.php-id-83.json" }] },
    ],
  },

  /**
   * The chamber's services.
   *
   * `/services/certificates-of-origin`, `/services/attestation` and
   * `/services/visa-recommendation` are absent, and their absence is the
   * finding: the chamber's three most-used services are not described on its
   * own website today. What exists is the forms behind `services.php?id=97`
   * and the fee schedule in `dues.pdf`, and seeding prose out of a form's
   * instructions is writing, not migrating -- so those three pages wait for
   * LCCI.
   *
   * `services.php?id=79` "Online Services" is skipped: it is a heading with no
   * body on the live site, and seeding a heading alone would publish an empty
   * page over a route that currently says, accurately, that it is being
   * prepared.
   */
  services: {
    path: "/services",
    department: "secretariat",
    mappings: [
      {
        path: "/services/women-entrepreneurs",
        sources: [{ file: "services.php-id-77.json" }],
      },
      { path: "/services/training", sources: [{ file: "business.php-id-134.json" }] },
      { path: "/services/library", sources: [{ file: "services.php-id-98.json" }] },
      { path: "/services/forms", sources: [{ file: "services.php-id-97.json" }] },
    ],
  },

  /**
   * Policy and research.
   *
   * `budgetproposals/` is an Apache directory index of PDFs rather than a
   * page, so `/advocacy/budget-proposals` has nothing to migrate and needs the
   * documents moved instead. `/advocacy/positions`, `/advocacy/economy` and
   * `/advocacy/business-confidence` have no legacy source at all -- the
   * footer's "Economic Indicator", "Economic Out Look" and "Analysis Business
   * Confidence" are `#` or a 2015 PDF.
   */
  advocacy: {
    path: "/advocacy",
    department: "research",
    mappings: [
      { path: "/advocacy/research", sources: [{ file: "about.php-id-113.json" }] },
    ],
  },

  /**
   * Trade promotion and events.
   *
   * `/trade/exhibitions` takes three legacy pages: the old site splits
   * "Fairs & Exhibitions" into an introduction, a local list and an
   * international list, and the rebuilt IA has one page for all three. Each
   * keeps its own heading, demoted to `h2`.
   *
   * `business.php?id=92` "LCCI Delegations" is skipped for the same reason
   * `services.php?id=79` is: on the live site it is a heading with no body.
   */
  trade: {
    path: "/trade",
    department: "research",
    mappings: [
      {
        path: "/trade/exhibitions",
        sources: [
          { file: "business.php-id-126.json" },
          { file: "business.php-id-131.json" },
          { file: "business.php-id-133.json" },
        ],
      },
      { path: "/trade/investment", sources: [{ file: "business.php-id-87.json" }] },
      { path: "/trade/inquiries", sources: [{ file: "business.php-id-90.json" }] },
      {
        path: "/trade/humanitarian-appeals",
        sources: [{ file: "business.php-id-94.json" }],
      },
    ],
  },

  /**
   * The newsroom.
   *
   * Only the circulars page is a `page`. The rest of this section is other
   * content types and wants its own pass: ~895 press releases behind
   * `press.php?id=N`, two photograph galleries that hold no text at all
   * (`gallery_album`), and one video (`video`).
   */
  news: {
    path: "/news",
    department: "info",
    mappings: [
      { path: "/news/circulars", sources: [{ file: "business.php-id-88.json" }] },
    ],
  },

  /**
   * The footer's three legal pages, which belong to no section.
   *
   * No legacy source and none expected: lcci.com.pk publishes no privacy
   * policy, no terms of use and no accessibility statement. The rows exist so
   * the three are in the admin's list waiting to be written, because a privacy
   * policy that nobody can find the field for is a privacy policy that never
   * gets written — and spec §9 requires one before launch.
   */
  legal: {
    routes: ["/privacy", "/terms", "/accessibility"],
    department: "secretariat",
    mappings: [],
  },
};

/**
 * Every route in a section, landing page first, in the order the navigation
 * lists them.
 *
 * Read from `PRIMARY_NAV` and not from `MAPPINGS`, so the rows this migration
 * creates cover the whole section. A page with no legacy source still needs
 * its row: those are the pages somebody has to write, and a page an editor
 * cannot find in the admin is a page that never gets written.
 */
export function sectionRoutes(sectionPath: string): `/${string}`[] {
  const section = PRIMARY_NAV.find((s) => s.href === sectionPath);
  if (!section) {
    throw new Error(
      `${sectionPath} is not a section in PRIMARY_NAV. Add it to the IA first — ` +
        "seeding rows for a section the navigation does not have would create " +
        "content at addresses nothing renders.",
    );
  }

  const routes = [section.href, ...section.children.map((c) => c.href)];

  // Only the routes the public `(site)` group serves. The navigation also
  // points at pages the member portal owns -- "Apply" is
  // `/membership/register`, a form behind a session -- and those have no
  // editable prose. A `page` row for one of them would sit in the admin's
  // list looking editable, and an editor who typed into it would watch their
  // text appear nowhere.
  return routes.filter(servedByTheSiteGroup);
}

/**
 * Only the routes the public `(site)` group serves.
 *
 * Takes the full `NavLink["href"]`, which since the membership portal moved
 * off-site can also be an `https://` address. Those are not routes of ours at
 * all, so they are rejected before the path check rather than being turned
 * into a nonsense filesystem lookup.
 */
function servedByTheSiteGroup(href: NavLink["href"]): href is `/${string}` {
  if (!href.startsWith("/")) return false;
  return existsSync(join("src", "app", "(site)", href.replace(/^\//, ""), "page.tsx"));
}

/** The routes a section's rows cover, however the section names them. */
export function routesOf(section: Section): `/${string}`[] {
  if (section.routes) return section.routes.filter(servedByTheSiteGroup);
  if (section.path) return sectionRoutes(section.path);
  throw new Error("a section needs either a `path` or a `routes` list");
}
