/**
 * Content models for the LCCI platform.
 *
 * These mirror §5 of the developer spec. They are defined here — not inside a
 * CMS SDK — so that the choice of CMS stays a detail of `repository.ts`.
 * Payload was ruled out (no MySQL adapter); Directus, Strapi and headless
 * WordPress all remain viable behind this boundary.
 */

export type Locale = "en" | "ur";

/** Fields every content type carries. Spec §5. */
export interface BaseContent {
  id: string;
  slug: string;
  titleEn: string;
  titleUr?: string;
  status: "draft" | "in_review" | "published" | "archived";
  /** Required on every dated item — the legacy site showed none. */
  publishedAt: string;
  updatedAt: string;
  ownerDepartment: string;
  seoTitle?: string;
  seoDescription?: string;
  ogImage?: ImageRef;
}

/** Alt text is non-optional by design: the CMS must refuse to publish without it. */
export interface ImageRef {
  src: string;
  altEn: string;
  altUr?: string;
  width: number;
  height: number;
  caption?: string;
}

export type TopicSlug =
  | "taxation-budget"
  | "energy"
  | "exports-trade"
  | "regulation"
  | "law-order"
  | "smes"
  | "women-entrepreneurs"
  | "infrastructure";

export interface Topic {
  slug: TopicSlug;
  labelEn: string;
  labelUr?: string;
}

export interface PressRelease extends BaseContent {
  summary: string;
  /**
   * Sanitised HTML, or absent while nobody has written it.
   *
   * Present in the database and in the admin's editor since migration 0018,
   * and read by nothing until the index and detail pages landed — so an
   * editor could write the body of a press release and watch it appear
   * nowhere. Render it through `<Prose>`, never directly: that component adds
   * `rel="noopener"` to outbound links, which the sanitiser deliberately
   * leaves to the renderer.
   */
  bodyEn?: string;
  bodyUr?: string;
  heroImage?: ImageRef;
  topics: TopicSlug[];
  spokesperson?: string;
}

export interface EventItem extends BaseContent {
  type: "seminar" | "training" | "agm" | "delegation" | "exhibition";
  start: string;
  end?: string;
  venue: string;
  fee?: string;
  capacity?: number;
  registrationOpen: boolean;
  registrationDeadline?: string;
  bodyEn?: string;
  bodyUr?: string;
}

export interface PolicyPosition extends BaseContent {
  issue: string;
  chamberAsk: string;
  positionStatus: "raised" | "under_review" | "accepted" | "resolved";
  topics: TopicSlug[];
  bodyEn?: string;
  bodyUr?: string;
}

/**
 * A notice cannot exist without an end date. The legacy homepage stacked four
 * modal pop-ups with no expiry; `endAt` being required is the structural fix.
 */
/**
 * A page of editorial prose.
 *
 * `body` is sanitised HTML — sanitised on write, so the stored bytes are the
 * audited bytes and a render path that forgot to sanitise cannot produce an
 * unsanitised page. Render it through `<Prose>`, never directly: that
 * component is what adds `rel="noopener"` to outbound links, which the
 * sanitiser deliberately leaves to the renderer.
 */
export interface Page extends BaseContent {
  standfirstEn?: string;
  standfirstUr?: string;
  /**
   * Short standing facts for the chips beside the heading, already split.
   *
   * Absent rather than empty when the page has none, because the renderer's
   * question is "are there chips", and an empty array answers it with a
   * truthy value.
   */
  meta?: readonly string[];
  metaUr?: readonly string[];
  bodyEn?: string;
  bodyUr?: string;
  heroImage?: ImageRef;
}

/**
 * A call to action, as a pair of editable strings.
 *
 * The href is content and not configuration because it has already been
 * wrong once: the hero shipped linking members at `/portal`, a route this app
 * does not serve, and nothing in a build could have caught it.
 */
export interface HeroAction {
  labelEn: string;
  href: string;
}

/**
 * The homepage hero, above the fold.
 *
 * Every string a visitor reads here is editable, and the three photographs are
 * media-library references rather than paths in the source. The composition
 * itself — three frames on three planes — is not editable, and deliberately:
 * its depth comes from a fixed relationship between shadow, scale and
 * perspective across exactly three images, so "how many pictures" is a design
 * decision rather than an editorial one.
 */
export interface Hero {
  id: string;
  badgeEn: string;
  headlineEn: string;
  headlineUr?: string;
  /**
   * A phrase within `headlineEn` to render in brand green.
   *
   * Absent, or not found in the headline, means the headline renders plain.
   * See `splitHeadline` in `src/content/headline.ts`.
   */
  headlineHighlightEn?: string;
  subheadEn: string;
  subheadUr?: string;
  primaryAction: HeroAction;
  secondaryAction?: HeroAction;
  /** The quiet line under the buttons. All three parts or none. */
  memberPromptEn?: string;
  memberAction?: HeroAction;
  /** The glass chip naming the occasion in the lead photograph. */
  captionEn?: string;
  /** A figure and what it counts. Both or neither. */
  statValueEn?: string;
  statLabelEn?: string;
  leadImage: ImageRef;
  behindImage: ImageRef;
  frontImage: ImageRef;
}

export interface Notice {
  id: string;
  messageEn: string;
  messageUr?: string;
  href?: string;
  level: "info" | "urgent";
  startAt: string;
  endAt: string;
}

export interface KeyFigure {
  id: string;
  value: number;
  /** Rendered after the counter, e.g. "+" or "k+". */
  suffix?: string;
  labelEn: string;
  /** Shown as a "last verified" stamp so figures cannot silently go stale. */
  verifiedAt: string;
}

export interface EconomicIndicator {
  id: string;
  labelEn: string;
  value: string;
  changePct?: number;
  /** Direction that counts as good news, so colour does not mislead. */
  goodWhen: "up" | "down" | "neutral";
  source: string;
  updatedAt: string;
}

export interface ServiceTile {
  id: string;
  labelEn: string;
  description: string;
  href: string;
  icon: "renew" | "certificate" | "attestation" | "circular" | "directory";
}

export interface Committee {
  slug: string;
  nameEn: string;
  mandate: string;
  memberCount: number;
}

/**
 * A photograph of a named person.
 *
 * Keyed by name rather than carried on the page that shows it: the chamber’s
 * office-bearers and its sixty-one former presidents are named in prose
 * migrated off the old site, and those words cannot be rewritten to make room
 * for a photograph. So a page looks up each name it is already printing, and a
 * name with no portrait renders without one.
 *
 * `role` and `term` are what the old site printed beside the face and are both
 * routinely absent — see `migrations/0038_content_portrait.sql`.
 */
export interface Portrait {
  slug: string;
  nameEn: string;
  role?: string;
  term?: string;
  /** Required, unlike every other image on the site. */
  photo: ImageRef;
}

export interface Partner {
  id: string;
  name: string;
  tier: "strategic" | "gold" | "silver";
  logo?: ImageRef;
}

export interface Testimonial {
  id: string;
  quote: string;
  authorName: string;
  authorRole: string;
  company: string;
}

/**
 * A video on the chamber's own YouTube channel.
 *
 * `orientation` is part of the model, not a styling detail: the channel mixes
 * full landscape films with vertical Shorts, and YouTube pads a Short's
 * thumbnail out to 16:9 with a blurred copy of itself. Presenting a Short in a
 * widescreen frame therefore shows blurred bars around a cropped subject. The
 * shape has to travel with the content so the section can frame each one the
 * way it was shot.
 */
export interface VideoItem {
  id: string;
  /** YouTube video id. Nothing is requested from Google until a visitor plays. */
  youtubeId: string;
  titleEn: string;
  titleUr?: string;
  orientation: "landscape" | "portrait";
  publishedAt: string;
  /** Served from this origin, not hotlinked — see scripts/prepare-video-posters.mjs. */
  poster: ImageRef;
  /** Editorial standfirst. Carried by the feature film only. */
  description?: string;
}

export interface GalleryImage extends ImageRef {
  id: string;
}

/**
 * A set of photographs from one occasion.
 *
 * Albums are dated and titled because the legacy "Picture Gallery" was neither:
 * it held one undated album under a heading that said nothing about what was
 * being shown, so there was no way to tell a photograph from last month from one
 * from 2015.
 */
export interface GalleryAlbum {
  slug: string;
  titleEn: string;
  description: string;
  occurredAt: string;
  images: GalleryImage[];
}
