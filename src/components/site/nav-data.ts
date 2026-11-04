/**
 * The site's information architecture, straight from spec §4.1.
 *
 * Rule enforced here: no entry may be "#" or point back at "/". The legacy site
 * had seven placeholder links and six footer links that looped home; keeping the
 * IA as typed data means a dead link is a type error, not a thing QA finds later.
 */

import { LEGACY_PORTAL } from "@/membership/portal";

/**
 * `href` allows an absolute `https://` target as well as a path, for the one
 * case that needs it: the membership portal is not part of this site. Joining
 * and signing in happen on `membership.lcci.org.pk`, so the navigation has to
 * be able to point off-site without the entry becoming a lie. See
 * `src/membership/portal.ts`.
 *
 * Only `https://`, never a bare `string` — the rule this file exists to
 * enforce is that every entry goes somewhere real, and `string` would let `#`
 * back in through the side door.
 */
export interface NavLink {
  label: string;
  href: `/${string}` | `https://${string}`;
  description?: string;
}

/**
 * Whether a navigation target is a route on this site.
 *
 * Exists because most things that consume the IA — the breadcrumb, the page
 * slug, the CMS row generator, `navEntry` itself — are only meaningful for
 * our own routes, and since the membership portal moved off-site the menu
 * holds an entry that is none of their business. A shared guard means each of
 * them skips it the same way rather than four hand-rolled `startsWith` calls
 * drifting apart.
 */
export function isSitePath(href: NavLink["href"]): href is `/${string}` {
  return href.startsWith("/");
}

export interface NavSection {
  label: string;
  href: `/${string}`;
  children: NavLink[];
}

export const PRIMARY_NAV: NavSection[] = [
  {
    label: "About",
    href: "/about",
    children: [
      { label: "History & mission", href: "/about/history", description: "The chamber since 1923" },
      { label: "Leadership", href: "/about/leadership", description: "President, SVP, VP and the Executive Committee" },
      { label: "Committees", href: "/about/committees", description: "Standing and advisory committees" },
      {
        label: "Past leadership",
        href: "/about/past-leadership",
        description: "Former presidents and vice presidents",
      },
      // Not in spec §4.1, added because the content is on the old site and has
      // nowhere else to go: `about.php?id=135` is an index of the Executive
      // Committee's meeting minutes, 39 PDFs deep. Dropping it would lose the
      // only public record of what the committee decided.
      {
        label: "Minutes of meetings",
        href: "/about/minutes",
        description: "What the Executive Committee decided",
      },
      { label: "Secretariat", href: "/about/secretariat", description: "Departments and who to contact" },
      { label: "Careers", href: "/about/careers", description: "Working at the chamber" },
      {
        label: "Contact",
        href: "/about/contact",
        description: "Address, switchboard and who to write to",
      },
    ],
  },
  {
    label: "Membership",
    href: "/membership",
    children: [
      { label: "Why join", href: "/membership/why-join", description: "What membership gets you" },
      { label: "Categories & dues", href: "/membership/categories" },
      // Off-site, to the Chamber's own membership portal. This site runs no
      // registration of its own — see `src/membership/portal.ts` — and the
      // label and target are the ones lcci.com.pk uses today, so a member
      // who knows the old site arrives where they expect. The description
      // says where it goes, because a navigation item that silently leaves
      // the site is the kind of thing people report as a bug.
      {
        label: "New membership",
        href: LEGACY_PORTAL.register,
        description: "Apply on the Chamber's membership portal",
      },
      { label: "Renew", href: "/membership/renew" },
      { label: "Member directory", href: "/membership/directory", description: "Search 20,000+ businesses by sector" },
      { label: "FAQs", href: "/membership/faqs" },
    ],
  },
  {
    label: "Services",
    href: "/services",
    children: [
      { label: "Certificates of origin", href: "/services/certificates-of-origin" },
      { label: "Attestation", href: "/services/attestation" },
      { label: "Visa recommendation", href: "/services/visa-recommendation" },
      { label: "Women entrepreneurs", href: "/services/women-entrepreneurs", description: "The standing committee and what it does" },
      { label: "Training", href: "/services/training", description: "Seminars and workshops, and what they cost" },
      { label: "Library & research centres", href: "/services/library", description: "Internet Library, EDRC, WTO Reference Centre" },
      { label: "Forms & downloads", href: "/services/forms", description: "Visa, invitation and membership forms to download" },
    ],
  },
  {
    label: "Advocacy",
    href: "/advocacy",
    children: [
      { label: "Policy positions", href: "/advocacy/positions", description: "What the chamber is asking for, and where it stands" },
      { label: "Budget proposals", href: "/advocacy/budget-proposals" },
      { label: "Economy", href: "/advocacy/economy", description: "Indicators, updated monthly" },
      { label: "Research & publications", href: "/advocacy/research", description: "Lahore Chamber News and the chamber's other publications" },
      { label: "Business confidence", href: "/advocacy/business-confidence" },
    ],
  },
  {
    label: "Trade & Events",
    href: "/trade",
    children: [
      { label: "Events calendar", href: "/trade/events", description: "What the chamber has on" },
      { label: "Delegations", href: "/trade/delegations" },
      { label: "Exhibitions & fairs", href: "/trade/exhibitions", description: "Fairs and trade shows the chamber is promoting" },
      { label: "Trade inquiries", href: "/trade/inquiries", description: "Buy, sell and partner leads" },
      { label: "Investment opportunities", href: "/trade/investment", description: "Opportunities notified to the chamber" },
      { label: "Humanitarian appeals", href: "/trade/humanitarian-appeals", description: "Appeals the chamber has circulated to members" },
    ],
  },
  /**
   * The chamber's reference lists — the old site's "Useful Links" menu.
   *
   * A seventh top-level section, which spec §4.1 does not have, added because
   * the content does: seventeen pages and ~19,000 characters of embassy
   * addresses, helpline numbers, government department directories and
   * hospital lists, all reachable from lcci.com.pk today. They are not filler
   * — they are the kind of page a member actually opens — and the spec's IA
   * simply predates knowing they were there.
   *
   * One route each rather than one long page, so every legacy URL 301s to the
   * list it was pointing at instead of to a fragment.
   *
   * **Several of these lists are visibly out of date** and some carry telephone
   * numbers; a stale embassy number is worse than no number. They are migrated
   * as published because that is what the chamber publishes now, and the
   * stale-content report (`review_by`) is where they should resurface for a
   * check.
   */
  {
    label: "Resources",
    href: "/resources",
    children: [
      { label: "Embassies & high commissions in Pakistan", href: "/resources/embassies-in-pakistan", description: "Foreign missions in Pakistan, with their websites" },
      { label: "Pakistan's missions abroad", href: "/resources/pakistan-embassies-abroad", description: "Where to find a Pakistani mission overseas" },
      { label: "Government authorities & ministries", href: "/resources/government-authorities", description: "Ministries and federal regulators, with their websites" },
      { label: "Federal government departments", href: "/resources/federal-departments", description: "Addresses and telephone numbers, department by department" },
      { label: "Helpline numbers", href: "/resources/helpline-numbers", description: "Lahore" },
      { label: "Hospitals in Lahore", href: "/resources/hospitals-lahore", description: "Addresses, telephones and websites" },
      { label: "Hospitals in Pakistan", href: "/resources/hospitals-pakistan", description: "The major hospitals, city by city" },
      { label: "Banks in Pakistan", href: "/resources/banks", description: "Pakistani banks, with their websites" },
      { label: "Chambers of commerce in Pakistan", href: "/resources/chambers-pakistan", description: "Chambers of commerce across the country" },
      { label: "International chambers", href: "/resources/chambers-international", description: "Chambers of commerce overseas" },
      { label: "Pakistani newspapers", href: "/resources/newspapers-pakistan", description: "The national press, online" },
      { label: "International newspapers", href: "/resources/newspapers-international", description: "The international press, online" },
      { label: "Airlines in Pakistan", href: "/resources/airlines", description: "International carriers serving Pakistan" },
      { label: "International links", href: "/resources/international-links", description: "Trade bodies and development agencies abroad" },
      { label: "Places to visit in Pakistan", href: "/resources/places-to-visit", description: "Travel guides to Pakistan" },
      { label: "Member websites", href: "/resources/member-websites", description: "Businesses in membership, with their own sites" },
    ],
  },
  {
    label: "Newsroom",
    href: "/news",
    children: [
      { label: "Press releases", href: "/news/press-releases", description: "The chamber's statements, newest first" },
      { label: "Circulars & SROs", href: "/news/circulars", description: "Notices circulated to members" },
      { label: "Galleries", href: "/news/galleries", description: "Photographs from the chamber's events" },
      { label: "Videos", href: "/news/videos", description: "Recordings from the chamber's events" },
      { label: "Media contacts", href: "/news/media-contacts" },
    ],
  },
];

/** Footer quick tasks — spec §4.3. */
export const FOOTER_TASKS: NavLink[] = [
  { label: "Renew membership", href: "/membership/renew" },
  { label: "Certificates of origin", href: "/services/certificates-of-origin" },
  { label: "Circulars & SROs", href: "/news/circulars" },
  { label: "Member directory", href: "/membership/directory" },
  { label: "Forms & downloads", href: "/services/forms" },
];

/**
 * `NavCrumb`, not `NavLink`: these three are pages of ours and `navEntry` has
 * to resolve them, so the type says they can never be given an off-site
 * target.
 */
export const FOOTER_LEGAL: NavCrumb[] = [
  { label: "Privacy policy", href: "/privacy" },
  { label: "Terms of use", href: "/terms" },
  { label: "Accessibility", href: "/accessibility" },
];

/*
 * `DEPARTMENTS` used to live here: four departmental email addresses
 * (`membership@`, `certificates@`, `research@`, `media@`) rendered in the
 * footer and on the contact page. None of them appears anywhere on
 * lcci.com.pk. They were invented, and a made-up contact address is the worst
 * kind of error to publish on a chamber's site, because a member writes to it
 * and never hears back.
 *
 * The addresses the chamber does publish are its office bearers', and they
 * live in `src/content/chamber.ts` with their extensions. If LCCI runs
 * departmental inboxes, they belong here — this file is still the right home
 * for "which departments is a visitor offered", which is an IA question — and
 * the footer block can be restored around them.
 */

/**
 * The chamber's own accounts, taken from the links in lcci.com.pk's header.
 *
 * Every one of these was wrong here until it was checked against the live
 * site: the handles had been guessed from the chamber's name, and three of the
 * four guesses pointed at accounts that are not LCCI's. They are worth more
 * care than an ordinary link, because the homepage's `Organization` JSON-LD
 * publishes them as `sameAs` -- which is how a search engine decides which
 * social accounts speak for the chamber, so a wrong one hands that authority
 * to somebody else.
 *
 * `twitter.com` rather than `x.com`, and a channel id rather than a handle,
 * because those are the URLs the chamber actually links to. Neither is
 * modernised here: a redirect we can see working is better than a prettier URL
 * nobody has verified.
 */
export const SOCIAL: { label: string; href: string }[] = [
  { label: "Facebook", href: "https://www.facebook.com/lcci.official" },
  { label: "X", href: "https://twitter.com/LahoreChamber" },
  { label: "Instagram", href: "https://www.instagram.com/lcciofficial" },
  {
    label: "YouTube",
    href: "https://www.youtube.com/channel/UCQAyoZiYNsntsRWwFbvUr5Q",
  },
];

/* -------------------------------------------------------------------------- */
/* Deriving a route's own place from the IA                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a route needs to render its own heading and breadcrumb.
 *
 * Derived from `PRIMARY_NAV` rather than typed again in the route file,
 * because the header, the footer sitemap, the section landing pages and the
 * page's own `<h1>` must all call a page the same thing. A page renamed in the
 * navigation is renamed everywhere in one edit.
 */
/**
 * A breadcrumb step: always a path on this site, never an off-site link.
 *
 * Narrower than `NavLink` on purpose. A trail is a chain of ancestors within
 * this site, and `NavLink.href` is wide enough to hold the membership
 * portal's `https://` address — which can be a leaf in the menu but can never
 * be something a page sits *underneath*.
 */
export interface NavCrumb {
  label: string;
  href: `/${string}`;
}

export interface NavEntry {
  /** The page's own title. */
  title: string;
  /** Its one-line description, where the IA gives one. */
  description?: string;
  /** Its ancestors, nearest last. The page itself is not in it. */
  trail: readonly NavCrumb[];
}

/**
 * Look a route up in the IA.
 *
 * **Throws on an unknown href**, which is the whole value of it. These are
 * statically prerendered pages, so a route whose path does not appear in the
 * navigation fails the build rather than shipping a page with an empty
 * heading — and "I added the route and forgot the nav entry" is precisely the
 * mistake that left the legacy site with seven placeholder links.
 */
export function navEntry(href: `/${string}`): NavEntry {
  for (const section of PRIMARY_NAV) {
    // A section landing page: its title is the section's own label and its
    // trail is empty, since `Breadcrumb` prepends Home for every page.
    if (section.href === href) {
      return { title: section.label, trail: [] };
    }

    const child = section.children.find((c) => c.href === href);
    if (child) {
      return {
        title: child.label,
        ...(child.description ? { description: child.description } : {}),
        trail: [{ label: section.label, href: section.href }],
      };
    }
  }

  // The three legal pages are reachable from the footer and from nowhere
  // else, deliberately: a privacy policy does not belong in a chamber's main
  // menu. They still have to resolve here, because they are public routes and
  // the rule below is what keeps a public route from shipping with no heading.
  const legal = FOOTER_LEGAL.find((l) => l.href === href);
  if (legal) {
    return { title: legal.label, trail: [] };
  }

  throw new Error(
    `${href} is not in the navigation. Every public route must appear in it — ` +
      "add it to PRIMARY_NAV or FOOTER_LEGAL in " +
      "src/components/site/nav-data.ts, or the page renders with no heading " +
      "and nothing links to it.",
  );
}
