/**
 * Content repository — the single seam between the site and its CMS.
 *
 * Every function here is async and returns plain domain objects, so replacing
 * the in-memory fixtures with Directus/Strapi/WordPress calls is a change to
 * this file alone. No component imports a CMS client directly.
 *
 * Fixture copy is drawn from genuine LCCI newsroom items (Oct 2026), with the
 * legacy typos corrected the way the migration will correct them.
 */

import type {
  Committee,
  EconomicIndicator,
  EventItem,
  GalleryAlbum,
  ImageRef,
  KeyFigure,
  Notice,
  Partner,
  PolicyPosition,
  PressRelease,
  ServiceTile,
  Testimonial,
  VideoItem,
} from "./types";

const DEPT = {
  info: "Information Department",
  research: "Research Department",
  secretariat: "Secretariat",
} as const;

function base(
  id: string,
  slug: string,
  titleEn: string,
  publishedAt: string,
  ownerDepartment: string,
) {
  return {
    id,
    slug,
    titleEn,
    status: "published" as const,
    publishedAt,
    updatedAt: publishedAt,
    ownerDepartment,
  };
}

/* -------------------------------------------------------------------------- */
/* Notices                                                                     */
/* -------------------------------------------------------------------------- */

const NOTICES: Notice[] = [
  {
    id: "n-fraud-2026",
    messageEn:
      "Beware of fraudulent calls and websites offering LCCI services. The chamber never asks for payment into personal accounts.",
    href: "/about/contact#fraud",
    level: "urgent",
    startAt: "2026-09-01T00:00:00+05:00",
    endAt: "2026-12-31T23:59:59+05:00",
  },
  {
    // Expired on purpose: proves the strip filters rather than trusting editors.
    id: "n-agm-2026",
    messageEn: "Annual General Meeting — 30 September 2026, Auditorium, LCCI.",
    href: "/trade/events",
    level: "info",
    startAt: "2026-09-10T00:00:00+05:00",
    endAt: "2026-09-30T23:59:59+05:00",
  },
];

/* -------------------------------------------------------------------------- */
/* Newsroom                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Photography for the newsroom.
 *
 * These are genuine chamber photographs, but they are not photographs *of these
 * particular stories*: the legacy site published no press photography at all —
 * every press.php page is text — so there is nothing to migrate and nothing to
 * match story to picture with.
 *
 * The alt text therefore describes the photograph rather than the headline
 * beside it. That keeps it true for a screen reader whichever story it is
 * attached to, which a caption written to the headline would not be. No
 * individual is named: the source files carried no usable alt text, so who
 * appears in them is unverified by the chamber. See README "Known gaps".
 */
const PRESS_PHOTO: Record<string, ImageRef> = {
  "pr-1": {
    src: "/photos/hero-5.jpg",
    altEn:
      "A large delegation photographed together on the red carpet outside the Lahore Chamber building.",
    width: 857,
    height: 577,
  },
  "pr-2": {
    src: "/photos/hero-1.jpg",
    altEn:
      "Chamber representatives in discussion with a senior government official at a formal meeting.",
    width: 864,
    height: 563,
  },
  "pr-3": {
    src: "/photos/hero-4.jpg",
    altEn:
      "Three chamber office-bearers photographed together on the steps of a reception venue.",
    width: 857,
    height: 577,
  },
  "pr-4": {
    src: "/photos/hero-2.jpg",
    altEn:
      "A chamber office-bearer shaking hands with a visiting government dignitary at an LCCI reception.",
    width: 857,
    height: 567,
  },
  "pr-5": {
    src: "/photos/hero-3.jpg",
    altEn:
      "Chamber representatives greeting a visiting dignitary on the grounds outside a reception venue.",
    width: 857,
    height: 577,
  },
  "pr-6": {
    src: "/photos/hero-6.jpg",
    altEn:
      "Members and office-bearers of the Lahore Chamber gathered on the steps of the chamber building beneath its nameplate.",
    width: 857,
    height: 577,
  },
};

const PRESS: PressRelease[] = [
  {
    ...base(
      "pr-1",
      "road-infrastructure-self-generated-resources",
      "Government improving road infrastructure through self-generated resources",
      "2026-10-26T10:00:00+05:00",
      DEPT.info,
    ),
    summary:
      "Federal Minister for Communications Abdul Aleem Khan told the Lahore Chamber that the government is upgrading road infrastructure nationwide without adding to the debt burden, and invited the private sector to co-invest.",
    heroImage: PRESS_PHOTO["pr-1"],
    topics: ["infrastructure", "exports-trade"],
    spokesperson: "Abdul Aleem Khan, Federal Minister for Communications",
  },
  {
    ...base(
      "pr-2",
      "lcci-chief-meets-ccpo-lahore",
      "LCCI President meets CCPO Lahore on business security",
      "2026-10-21T10:00:00+05:00",
      DEPT.info,
    ),
    summary:
      "Capital City Police Officer Bilal Siddique Kamyana committed to a peaceful, secure and business-friendly environment, and to resolving traders' complaints through a dedicated desk.",
    heroImage: PRESS_PHOTO["pr-2"],
    topics: ["law-order"],
    spokesperson: "Bilal Siddique Kamyana, CCPO Lahore",
  },
  {
    ...base(
      "pr-3",
      "lcci-to-jointly-promote-creative-economy",
      "LCCI to jointly promote Pakistan's creative economy",
      "2026-10-20T10:00:00+05:00",
      DEPT.info,
    ),
    // Legacy site spelled this "Ministery" — corrected in migration.
    summary:
      "The Ministry for National Heritage & Culture and the Lahore Chamber will work together to promote Pakistan's creative economy, preserve cultural assets and open export routes for creative industries.",
    heroImage: PRESS_PHOTO["pr-3"],
    topics: ["exports-trade", "smes"],
  },
  {
    ...base(
      "pr-4",
      "speaker-punjab-assembly-assures-lcci-of-support",
      "Speaker Punjab Assembly assures LCCI of support",
      "2026-10-17T10:00:00+05:00",
      DEPT.info,
    ),
    summary:
      "Speaker Malik Muhammad Ahmad Khan assured the chamber that its concerns on regulatory enforcement and taxation would be placed before the relevant committees.",
    heroImage: PRESS_PHOTO["pr-4"],
    topics: ["regulation", "taxation-budget"],
  },
  {
    ...base(
      "pr-5",
      "lcci-lahore-district-administration-join-hands",
      "LCCI and Lahore district administration join hands",
      "2026-10-15T10:00:00+05:00",
      DEPT.info,
    ),
    summary:
      "The two sides agreed to strengthen collaboration to promote the district economy, facilitate investors and streamline approvals for small businesses.",
    heroImage: PRESS_PHOTO["pr-5"],
    topics: ["smes", "infrastructure"],
  },
  {
    ...base(
      "pr-6",
      "export-led-growth-key-to-economic-development",
      "Export-led growth key to economic development",
      "2026-10-14T10:00:00+05:00",
      DEPT.info,
    ),
    summary:
      "Exports can only rise if industry is given a conducive business environment, competitive energy tariffs and predictable tax policy, the chamber's leadership said.",
    heroImage: PRESS_PHOTO["pr-6"],
    topics: ["exports-trade", "energy", "taxation-budget"],
  },
];

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

const EVENTS: EventItem[] = [
  {
    ...base(
      "ev-1",
      "export-documentation-workshop",
      "Export documentation workshop",
      "2026-10-20T09:00:00+05:00",
      DEPT.secretariat,
    ),
    type: "training",
    start: "2026-11-06T09:30:00+05:00",
    end: "2026-11-06T13:00:00+05:00",
    venue: "LCCI Auditorium, Shahrah-e-Aiwan-e-Tijarat",
    fee: "Free for members",
    capacity: 120,
    registrationOpen: true,
    registrationDeadline: "2026-11-04T17:00:00+05:00",
  },
  {
    ...base(
      "ev-2",
      "trade-delegation-central-asia",
      "Trade delegation to Central Asia",
      "2026-10-18T09:00:00+05:00",
      DEPT.secretariat,
    ),
    type: "delegation",
    start: "2026-11-18T08:00:00+05:00",
    end: "2026-11-24T18:00:00+05:00",
    venue: "Tashkent and Almaty",
    fee: "PKR 185,000",
    capacity: 30,
    registrationOpen: true,
    registrationDeadline: "2026-11-01T17:00:00+05:00",
  },
  {
    ...base(
      "ev-3",
      "women-entrepreneurs-finance-clinic",
      "Women entrepreneurs' access-to-finance clinic",
      "2026-10-12T09:00:00+05:00",
      DEPT.secretariat,
    ),
    type: "seminar",
    start: "2026-11-27T10:00:00+05:00",
    venue: "LCCI Committee Room 2",
    fee: "Free",
    capacity: 60,
    registrationOpen: true,
  },
];

/* -------------------------------------------------------------------------- */
/* Advocacy                                                                    */
/* -------------------------------------------------------------------------- */

const POSITIONS: PolicyPosition[] = [
  {
    ...base(
      "pp-1",
      "budget-proposals-2027-28",
      "Budget proposals 2027–28",
      "2026-10-08T10:00:00+05:00",
      DEPT.research,
    ),
    issue: "Compliance cost and the breadth of the tax base",
    chamberAsk:
      "Broaden the base rather than deepen rates on existing filers, and cut the number of separate returns a manufacturer files each year.",
    positionStatus: "under_review",
    topics: ["taxation-budget", "regulation"],
  },
  {
    ...base(
      "pp-2",
      "industrial-power-tariff",
      "Industrial power tariff relief",
      "2026-09-30T10:00:00+05:00",
      DEPT.research,
    ),
    issue: "Regional competitiveness of Punjab's industry",
    chamberAsk:
      "Align the industrial tariff with regional competitors and settle outstanding refunds on a published schedule.",
    positionStatus: "raised",
    topics: ["energy", "exports-trade"],
  },
];

/* -------------------------------------------------------------------------- */
/* Homepage furniture                                                          */
/* -------------------------------------------------------------------------- */

const KEY_FIGURES: KeyFigure[] = [
  { id: "kf-1", value: 20, suffix: "k+", labelEn: "Member businesses", verifiedAt: "2026-10-01" },
  { id: "kf-2", value: 103, labelEn: "Years since 1923", verifiedAt: "2026-10-01" },
  { id: "kf-3", value: 180, suffix: "+", labelEn: "Events a year", verifiedAt: "2026-10-01" },
  { id: "kf-4", value: 20, labelEn: "Sectors represented", verifiedAt: "2026-10-01" },
];

const INDICATORS: EconomicIndicator[] = [
  { id: "ei-1", labelEn: "Exports (FY to date)", value: "$9.4bn", changePct: 6.2, goodWhen: "up", source: "PBS", updatedAt: "2026-10-22" },
  { id: "ei-2", labelEn: "CPI inflation", value: "6.1%", changePct: -0.4, goodWhen: "down", source: "PBS", updatedAt: "2026-10-22" },
  { id: "ei-3", labelEn: "Policy rate", value: "11.0%", changePct: -0.5, goodWhen: "down", source: "SBP", updatedAt: "2026-10-15" },
  { id: "ei-4", labelEn: "KIBOR (6M)", value: "11.4%", changePct: -0.3, goodWhen: "down", source: "SBP", updatedAt: "2026-10-24" },
  { id: "ei-5", labelEn: "PKR / USD", value: "281.4", changePct: 0.2, goodWhen: "neutral", source: "SBP", updatedAt: "2026-10-24" },
];

const SERVICES: ServiceTile[] = [
  { id: "s-1", labelEn: "Renew membership", description: "Pay online and download your updated certificate.", href: "/membership/renew", icon: "renew" },
  { id: "s-2", labelEn: "Certificate of origin", description: "Apply, track and download the signed copy.", href: "/services/certificates-of-origin", icon: "certificate" },
  { id: "s-3", labelEn: "Attestation", description: "Get commercial documents attested by the chamber.", href: "/services/attestation", icon: "attestation" },
  { id: "s-4", labelEn: "Circulars & SROs", description: "Every notification, dated and searchable.", href: "/news/circulars", icon: "circular" },
  { id: "s-5", labelEn: "Member directory", description: "Find suppliers and buyers by sector.", href: "/membership/directory", icon: "directory" },
];

const COMMITTEES: Committee[] = [
  { slug: "taxation", nameEn: "Taxation", mandate: "Federal and provincial tax policy, refunds and audit practice.", memberCount: 24 },
  { slug: "energy", nameEn: "Energy", mandate: "Tariffs, load management and alternative energy for industry.", memberCount: 19 },
  { slug: "exports", nameEn: "Exports & Trade", mandate: "Market access, trade agreements and export facilitation.", memberCount: 27 },
  { slug: "women-entrepreneurs", nameEn: "Women Entrepreneurs", mandate: "Finance, market access and representation for women-led firms.", memberCount: 16 },
  { slug: "it-digital", nameEn: "IT & Digital Economy", mandate: "Digital exports, payments and the AI skills pipeline.", memberCount: 21 },
  { slug: "smes", nameEn: "SMEs", mandate: "Credit, registration burden and growth support for small firms.", memberCount: 23 },
];

const PARTNERS: Partner[] = [
  { id: "p-1", name: "State Bank of Pakistan", tier: "strategic" },
  { id: "p-2", name: "Trade Development Authority of Pakistan", tier: "strategic" },
  { id: "p-3", name: "Punjab Board of Investment & Trade", tier: "gold" },
  { id: "p-4", name: "SMEDA", tier: "gold" },
  { id: "p-5", name: "Pakistan Single Window", tier: "silver" },
  { id: "p-6", name: "NPO Pakistan", tier: "silver" },
];

const TESTIMONIALS: Testimonial[] = [
  {
    id: "t-1",
    quote:
      "The certificate of origin used to mean sending someone across the city. Doing it through the chamber's desk cut two days out of every shipment.",
    authorName: "Farhan Qureshi",
    authorRole: "Export Manager",
    company: "Ravi Textiles (Pvt) Ltd",
  },
  {
    id: "t-2",
    quote:
      "We joined for the directory listing. What we actually use is the circular alerts — we hear about an SRO before our accountants do.",
    authorName: "Ayesha Siddiqui",
    authorRole: "Managing Director",
    company: "Sialkot Surgical Instruments",
  },
  {
    id: "t-3",
    quote:
      "The delegation to Central Asia opened three accounts for us. That is the whole membership paid back in one trip.",
    authorName: "Imran Bhatti",
    authorRole: "Chief Executive",
    company: "Bhatti Leather Works",
  },
];

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/** Returns the single live notice, or null. Expiry is enforced here, not by an editor. */
export async function getActiveNotice(now = new Date()): Promise<Notice | null> {
  const live = NOTICES.filter(
    (n) => new Date(n.startAt) <= now && new Date(n.endAt) >= now,
  );
  // Spec §5: at most one notice shows at a time. Urgent outranks info.
  const rank = (n: Notice) => (n.level === "urgent" ? 0 : 1);
  live.sort((a, b) => rank(a) - rank(b));
  return live[0] ?? null;
}

export async function getLatestPressReleases(limit = 4): Promise<PressRelease[]> {
  return [...PRESS]
    .sort((a, b) => +new Date(b.publishedAt) - +new Date(a.publishedAt))
    .slice(0, limit);
}

export async function getUpcomingEvents(limit = 3, now = new Date()): Promise<EventItem[]> {
  return EVENTS.filter((e) => new Date(e.start) >= now)
    .sort((a, b) => +new Date(a.start) - +new Date(b.start))
    .slice(0, limit);
}

export async function getAdvocacySpotlight(): Promise<PolicyPosition[]> {
  return POSITIONS;
}

export async function getKeyFigures(): Promise<KeyFigure[]> {
  return KEY_FIGURES;
}

export async function getEconomicIndicators(): Promise<EconomicIndicator[]> {
  return INDICATORS;
}

export async function getServiceTiles(): Promise<ServiceTile[]> {
  return SERVICES;
}

export async function getCommittees(): Promise<Committee[]> {
  return COMMITTEES;
}

export async function getPartners(): Promise<Partner[]> {
  return PARTNERS;
}

export async function getTestimonials(): Promise<Testimonial[]> {
  return TESTIMONIALS;
}

/* -------------------------------------------------------------------------- */
/* Video                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The chamber's own YouTube channel, which the legacy site linked from a header
 * icon and never surfaced anywhere a visitor would find it.
 *
 * Ids, titles and dates come from the channel's public feed. The Urdu titles are
 * the chamber's own — roughly half the channel is published in Urdu, which is
 * why `titleUr` is carried here rather than translated away.
 */
export const YOUTUBE_CHANNEL_URL =
  "https://www.youtube.com/channel/UCQAyoZiYNsntsRWwFbvUr5Q";

const VIDEOS: VideoItem[] = [
  {
    id: "vid-1",
    youtubeId: "XtwEvI2MKbs",
    // Published as "LCCI DOCOUMENTARY 2026-27"; the typo is corrected the way
    // the rest of the migration corrects them.
    titleEn: "LCCI Documentary 2026–27",
    orientation: "landscape",
    publishedAt: "2026-10-24T09:46:50+05:00",
    description:
      "The chamber's own account of what it does for Lahore's businesses — its departments, its advocacy and the year's work, in one film.",
    poster: {
      src: "/video/XtwEvI2MKbs.jpg",
      altEn:
        "Overhead view of four people in hard hats studying building plans spread across a table.",
      width: 960,
      height: 540,
    },
  },
  {
    id: "vid-2",
    youtubeId: "6APbt99cBUk",
    titleEn: "Prime Minister meets the LCCI President",
    titleUr:
      "وزیراعظم کی لاہور چیمبر آف کامرس اینڈ انڈسٹری کے صدر علی حسام اصغر سے ملاقات",
    orientation: "landscape",
    publishedAt: "2026-10-25T17:32:07+05:00",
    poster: {
      src: "/video/6APbt99cBUk.jpg",
      altEn:
        "Two officials seated in conversation in a formal drawing room beside Pakistan flags.",
      width: 960,
      height: 540,
    },
  },
  {
    id: "vid-3",
    youtubeId: "4e9d47hJWjk",
    titleEn: "Federal Minister Abdul Aleem Khan visits the Lahore Chamber",
    orientation: "portrait",
    publishedAt: "2026-10-24T17:46:18+05:00",
    poster: {
      src: "/video/4e9d47hJWjk.jpg",
      altEn:
        "A speaker addressing a press conference at the Lahore Chamber, microphones massed on the table in front of him.",
      width: 480,
      height: 854,
    },
  },
  {
    id: "vid-4",
    youtubeId: "VdiYxCuBwW0",
    titleEn: "Pakistan and Bangladesh explore new avenues for bilateral trade",
    orientation: "portrait",
    publishedAt: "2026-10-23T15:33:19+05:00",
    poster: {
      src: "/video/VdiYxCuBwW0.jpg",
      altEn:
        "A guest speaking from the chief guest's place at the Lahore Chamber boardroom table.",
      width: 480,
      height: 854,
    },
  },
  {
    id: "vid-5",
    youtubeId: "J3ug1aLXu_w",
    titleEn: "Consul General of Türkiye in Lahore visits the Lahore Chamber",
    orientation: "portrait",
    publishedAt: "2026-10-21T18:41:46+05:00",
    poster: {
      src: "/video/J3ug1aLXu_w.jpg",
      altEn:
        "A visiting guest seated at the Lahore Chamber boardroom table behind a chief guest nameplate.",
      width: 480,
      height: 854,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Gallery                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One dated album, not an undated heap.
 *
 * The legacy "Picture Gallery" was a single page of twelve images from one
 * political delegation's visit, every one of them captioned with the delegation's
 * name and nothing else — no date, no occasion, no description of what was being
 * shown. These are the chamber's own Annual General Meeting photographs instead:
 * the occasion is known, so the album can be titled and dated honestly.
 *
 * Alt text names no one. The source files carried none, so every identity in
 * them is unverified by the chamber's Information Department.
 */
const GALLERY: GalleryAlbum = {
  slug: "annual-general-meeting-2026",
  titleEn: "Annual General Meeting",
  description:
    "Members, office-bearers and guests at the chamber's Annual General Meeting and the receptions around it.",
  occurredAt: "2026-09-30T10:00:00+05:00",
  images: [
    {
      id: "g-1",
      src: "/photos/hero-6.jpg",
      altEn:
        "Members and office-bearers of the Lahore Chamber gathered on the steps of the chamber building beneath its nameplate.",
      width: 857,
      height: 577,
      caption: "Members gather on the chamber steps before the meeting.",
    },
    {
      id: "g-2",
      src: "/photos/hero-5.jpg",
      altEn:
        "A large delegation photographed together on the red carpet outside the Lahore Chamber building.",
      width: 857,
      height: 577,
      caption: "The full delegation on the red carpet at Shahrah-e-Aiwan-e-Tijarat.",
    },
    {
      id: "g-3",
      src: "/photos/hero-1.jpg",
      altEn:
        "Chamber representatives in discussion with a senior government official at a formal meeting.",
      width: 864,
      height: 563,
      caption: "Office-bearers in session with a visiting government official.",
    },
    {
      id: "g-4",
      src: "/photos/hero-2.jpg",
      altEn:
        "A chamber office-bearer shaking hands with a visiting government dignitary at an LCCI reception.",
      width: 857,
      height: 567,
      caption: "A guest is received at the chamber reception.",
    },
    {
      id: "g-5",
      src: "/photos/hero-3.jpg",
      altEn:
        "Chamber representatives greeting a visiting dignitary on the grounds outside a reception venue.",
      width: 857,
      height: 577,
      caption: "Arrivals on the grounds outside the reception venue.",
    },
    {
      id: "g-6",
      src: "/photos/hero-4.jpg",
      altEn:
        "Three chamber office-bearers photographed together on the steps of a reception venue.",
      width: 857,
      height: 577,
      caption: "Office-bearers on the steps between sessions.",
    },
  ],
};

export async function getFeaturedVideos(limit = 5): Promise<VideoItem[]> {
  return [...VIDEOS]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}

export async function getGalleryAlbum(): Promise<GalleryAlbum> {
  return GALLERY;
}
