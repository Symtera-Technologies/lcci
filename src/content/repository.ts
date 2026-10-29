/**
 * Content repository — the single seam between the site and its CMS.
 *
 * Every function here is async and returns plain domain objects, and the public
 * signatures are exactly what they were when this module returned fixtures:
 * `getLatestPressReleases(limit = 4)`, `getActiveNotice(now = new Date())` and
 * the rest. Not one of the seventeen components that read them was touched when
 * migration 0016 gave the content types tables of their own. That is what the
 * seam is for.
 *
 * What changed is inside. The fixtures became SQL, and the business rules that
 * were JavaScript `filter`s became `WHERE` clauses — which matters beyond
 * tidiness, because a filter can only exclude rows the query already fetched.
 * `status` and `ownerDepartment` have been declared in `types.ts` since the
 * first commit and read by nothing; here they finally decide what a visitor
 * sees.
 *
 * **The live predicate, on every list read.** A row is public when it is
 * `published`, its `published_at` has passed, and its `scheduled_unpublish_at`
 * has not. All three in SQL, in one helper, so scheduled publishing needs no
 * cron for *correctness* — the row simply starts and stops matching. See
 * `liveItems`.
 *
 * **No caching layer here, deliberately.** This module reads rows; deciding
 * how long a rendered page may hold them is the rendering layer's job, and the
 * site's public pages are statically prerendered today, so a cache inside the
 * repository would be a second, invisible staleness on top of the page's own.
 * It would also drag `next/cache` into a module the seed script and the
 * integration tests call outside any request. When B4 attaches revalidation it
 * attaches it to the pages and to a tag, not to this file.
 *
 * **No fixture fallback.** An unreachable database or an empty table shows
 * empty sections, which is the honest result and the one somebody notices. A
 * silent fallback would make a broken connection look exactly like a working
 * site, in production, until somebody thought to read the newsroom.
 *
 * Preview — reading drafts — is not here. It needs an actor and a permission,
 * and every public page imports this module, so putting authorisation behind
 * this seam would pull the auth DAL into the homepage's dependency graph for
 * the sake of a screen only staff can reach. It lives in `./preview`, which
 * takes an explicit `ActorContext`, for the same reason membership does not go
 * behind this seam at all.
 */

import { getDb } from "@/db/client";
import type { ContentKind } from "@/db/schema";

import type {
  Committee,
  EconomicIndicator,
  EventItem,
  GalleryAlbum,
  GalleryImage,
  ImageRef,
  KeyFigure,
  Notice,
  Partner,
  PolicyPosition,
  PressRelease,
  ServiceTile,
  Testimonial,
  TopicSlug,
  VideoItem,
} from "./types";

/* -------------------------------------------------------------------------- */
/* The live predicate                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Rows a visitor is allowed to see, for one content type.
 *
 * Three conditions, and the second two are the reason `published_at` and
 * `scheduled_unpublish_at` are instants rather than flags somebody has to
 * remember to set:
 *
 *   - `status = 'published'` excludes drafts, items in review, and archived
 *     ones. Archived rows stay in the table with their slugs for ever — around
 *     890 legacy press URLs are being redirected into this space and archiving
 *     must not manufacture 404s — so they are excluded from lists and from the
 *     sitemap, and resolve at their own URL with `noindex` when the detail
 *     routes land.
 *   - `published_at <= now` makes a future date a scheduled publish. A row
 *     that has never been published has NULL here, and NULL fails the
 *     comparison: the absence of a publication date is not a publication date
 *     of zero.
 *   - `scheduled_unpublish_at` in the future, or absent, is the other half.
 *
 * `now` is passed in rather than taken from `UTC_TIMESTAMP(3)` so that the two
 * getters whose signatures promise the caller a clock —`getActiveNotice` and
 * `getUpcomingEvents` — use the same one for the window as for their own
 * filtering. One clock per call, and a test can move it.
 */
function liveItems(type: ContentKind, now: Date) {
  return getDb()
    .selectFrom("content_items as ci")
    .where("ci.content_type", "=", type)
    .where("ci.status", "=", "published")
    .where("ci.published_at", "<=", now)
    .where((eb) =>
      eb.or([
        eb("ci.scheduled_unpublish_at", "is", null),
        eb("ci.scheduled_unpublish_at", ">", now),
      ]),
    );
}

/* -------------------------------------------------------------------------- */
/* Mappers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The `BaseContent` half of a row.
 *
 * `id` is the primary key rendered as a string, because the public types say
 * `id: string` and every caller uses it as a React key. The fixtures' `"pr-1"`
 * style ids are gone; what is stable and externally meaningful is the slug,
 * which is what the URLs are built from.
 *
 * `publishedAt` is asserted non-null rather than defaulted. Every row reaching
 * a mapper has come through `liveItems`, which requires `published_at <= now`,
 * so a null here would mean the predicate had been bypassed — and quietly
 * substituting the epoch or the current time would hide that rather than
 * report it.
 */
function baseOf(row: {
  id: number;
  slug: string;
  title_en: string;
  title_ur: string | null;
  status: string;
  published_at: Date | null;
  updated_at: Date;
  department_name: string;
  seo_title: string | null;
  seo_description: string | null;
}) {
  if (row.published_at === null) {
    throw new Error(`content item ${row.id} is live with no published_at`);
  }

  return {
    id: String(row.id),
    slug: row.slug,
    titleEn: row.title_en,
    ...(row.title_ur ? { titleUr: row.title_ur } : {}),
    status: row.status as "draft" | "in_review" | "published" | "archived",
    publishedAt: row.published_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ownerDepartment: row.department_name,
    ...(row.seo_title ? { seoTitle: row.seo_title } : {}),
    ...(row.seo_description ? { seoDescription: row.seo_description } : {}),
  };
}

/**
 * An `ImageRef` from a left-joined `media_assets` row.
 *
 * `src` being null means the join found nothing, which for a nullable image
 * column is the normal case. `alt_en` is NOT NULL in the schema, so an image
 * that exists always has a description — the `?? ""` is unreachable and is
 * there only because the column types cannot say so.
 */
function imageOf(row: {
  src: string | null;
  alt_en: string | null;
  alt_ur: string | null;
  width: number | null;
  height: number | null;
  caption: string | null;
}): ImageRef | undefined {
  if (row.src === null) return undefined;
  return {
    src: row.src,
    altEn: row.alt_en ?? "",
    ...(row.alt_ur ? { altUr: row.alt_ur } : {}),
    width: row.width ?? 0,
    height: row.height ?? 0,
    ...(row.caption ? { caption: row.caption } : {}),
  };
}

/**
 * Topics for a set of items, in one query.
 *
 * A second round trip rather than `GROUP_CONCAT`, which has a configurable
 * length limit that truncates silently at 1024 bytes by default — a tag list
 * is short enough today and would be the kind of thing that breaks on the
 * press release somebody files under five topics.
 */
async function topicsFor(itemIds: readonly number[]): Promise<Map<number, TopicSlug[]>> {
  const byItem = new Map<number, TopicSlug[]>();
  if (itemIds.length === 0) return byItem;

  const rows = await getDb()
    .selectFrom("content_item_topics")
    .select(["content_item_id", "topic_slug"])
    .where("content_item_id", "in", itemIds)
    .orderBy("sort_order")
    .execute();

  for (const row of rows) {
    const list = byItem.get(row.content_item_id) ?? [];
    list.push(row.topic_slug as TopicSlug);
    byItem.set(row.content_item_id, list);
  }
  return byItem;
}

/* -------------------------------------------------------------------------- */
/* Notices                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The single live notice, or null.
 *
 * Expiry is enforced here, not by an editor remembering to take a notice down:
 * the window is two columns and the query compares against them. Spec section
 * 5 allows at most one notice on screen at a time and urgent outranks info,
 * which was a JavaScript sort and is now `ORDER BY level` — `ENUM('info',
 * 'urgent')` sorts by declaration order, so `level DESC` puts urgent first.
 * Spelt out because it is the one ordering in this file that depends on the
 * ENUM's declaration order rather than on its values.
 */
export async function getActiveNotice(now = new Date()): Promise<Notice | null> {
  const row = await liveItems("notice", now)
    .innerJoin("content_notices as n", "n.content_item_id", "ci.id")
    .select([
      "ci.id",
      "n.message_en",
      "n.message_ur",
      "n.href",
      "n.level",
      "n.starts_at",
      "n.ends_at",
    ])
    .where("n.starts_at", "<=", now)
    .where("n.ends_at", ">=", now)
    .orderBy("n.level", "desc")
    .orderBy("ci.sort_order")
    .limit(1)
    .executeTakeFirst();

  if (!row) return null;

  return {
    id: String(row.id),
    messageEn: row.message_en,
    ...(row.message_ur ? { messageUr: row.message_ur } : {}),
    ...(row.href ? { href: row.href } : {}),
    level: row.level,
    startAt: row.starts_at.toISOString(),
    endAt: row.ends_at.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Newsroom                                                                   */
/* -------------------------------------------------------------------------- */

export async function getLatestPressReleases(limit = 4): Promise<PressRelease[]> {
  const now = new Date();

  const rows = await liveItems("press_release", now)
    .innerJoin("content_press_releases as pr", "pr.content_item_id", "ci.id")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    .leftJoin("media_assets as hero", "hero.id", "pr.hero_image_id")
    .select([
      "ci.id",
      "ci.slug",
      "ci.title_en",
      "ci.title_ur",
      "ci.status",
      "ci.published_at",
      "ci.updated_at",
      "ci.seo_title",
      "ci.seo_description",
      "d.name_en as department_name",
      "pr.summary",
      "pr.spokesperson",
      "hero.src",
      "hero.alt_en",
      "hero.alt_ur",
      "hero.width",
      "hero.height",
      "hero.caption",
    ])
    .orderBy("ci.published_at", "desc")
    .limit(limit)
    .execute();

  const topics = await topicsFor(rows.map((row) => row.id));

  return rows.map((row) => {
    const heroImage = imageOf(row);
    return {
      ...baseOf(row),
      summary: row.summary,
      ...(heroImage ? { heroImage } : {}),
      topics: topics.get(row.id) ?? [],
      ...(row.spokesperson ? { spokesperson: row.spokesperson } : {}),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Events still to come.
 *
 * `starts_at >= now` was a `filter` over every event in memory; as a `WHERE`
 * against `idx_event_start` it reads only the rows it returns, which is the
 * difference that matters once the chamber's 180 events a year have
 * accumulated for a decade.
 */
export async function getUpcomingEvents(limit = 3, now = new Date()): Promise<EventItem[]> {
  const rows = await liveItems("event", now)
    .innerJoin("content_events as e", "e.content_item_id", "ci.id")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    .select([
      "ci.id",
      "ci.slug",
      "ci.title_en",
      "ci.title_ur",
      "ci.status",
      "ci.published_at",
      "ci.updated_at",
      "ci.seo_title",
      "ci.seo_description",
      "d.name_en as department_name",
      "e.event_type",
      "e.starts_at",
      "e.ends_at",
      "e.venue",
      "e.fee",
      "e.capacity",
      "e.registration_open",
      "e.registration_deadline",
    ])
    .where("e.starts_at", ">=", now)
    .orderBy("e.starts_at")
    .limit(limit)
    .execute();

  return rows.map((row) => ({
    ...baseOf(row),
    type: row.event_type,
    start: row.starts_at.toISOString(),
    ...(row.ends_at ? { end: row.ends_at.toISOString() } : {}),
    venue: row.venue,
    ...(row.fee ? { fee: row.fee } : {}),
    ...(row.capacity !== null ? { capacity: row.capacity } : {}),
    // TINYINT(1) arrives as 0 or 1, not as a boolean.
    registrationOpen: row.registration_open === 1,
    ...(row.registration_deadline
      ? { registrationDeadline: row.registration_deadline.toISOString() }
      : {}),
  }));
}

/* -------------------------------------------------------------------------- */
/* Advocacy                                                                   */
/* -------------------------------------------------------------------------- */

export async function getAdvocacySpotlight(): Promise<PolicyPosition[]> {
  const now = new Date();

  const rows = await liveItems("policy_position", now)
    .innerJoin("content_policy_positions as p", "p.content_item_id", "ci.id")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    .select([
      "ci.id",
      "ci.slug",
      "ci.title_en",
      "ci.title_ur",
      "ci.status",
      "ci.published_at",
      "ci.updated_at",
      "ci.seo_title",
      "ci.seo_description",
      "d.name_en as department_name",
      "p.issue",
      "p.chamber_ask",
      "p.position_status",
    ])
    .orderBy("ci.sort_order")
    .execute();

  const topics = await topicsFor(rows.map((row) => row.id));

  return rows.map((row) => ({
    ...baseOf(row),
    issue: row.issue,
    chamberAsk: row.chamber_ask,
    positionStatus: row.position_status,
    topics: topics.get(row.id) ?? [],
  }));
}

/* -------------------------------------------------------------------------- */
/* Figures and indicators                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The counters in the figures band.
 *
 * `sort_order` and not a date: these have no publication date anybody renders,
 * and their order on the homepage is editorial. Without the column the order
 * would be whatever InnoDB returned, which is stable enough to pass review and
 * then change for no reason anyone can trace.
 */
export async function getKeyFigures(): Promise<KeyFigure[]> {
  const rows = await liveItems("key_figure", new Date())
    .innerJoin("content_key_figures as k", "k.content_item_id", "ci.id")
    .select([
      "ci.id",
      "ci.title_en",
      "k.figure_value",
      "k.suffix",
      "k.verified_at",
    ])
    .orderBy("ci.sort_order")
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    value: row.figure_value,
    ...(row.suffix ? { suffix: row.suffix } : {}),
    labelEn: row.title_en,
    // Already "YYYY-MM-DD": the pool sets `dateStrings: ["DATE"]`, which is
    // what keeps a civil date from becoming the day before in another zone.
    verifiedAt: row.verified_at,
  }));
}

export async function getEconomicIndicators(): Promise<EconomicIndicator[]> {
  const rows = await liveItems("economic_indicator", new Date())
    .innerJoin("content_economic_indicators as i", "i.content_item_id", "ci.id")
    .select([
      "ci.id",
      "ci.title_en",
      "i.display_value",
      "i.change_pct",
      "i.good_when",
      "i.source",
      "i.measured_at",
    ])
    .orderBy("ci.sort_order")
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    labelEn: row.title_en,
    value: row.display_value,
    // DECIMAL arrives as a string. The public type says `number`, and this is
    // a percentage for display rather than money, so converting here is safe —
    // which is exactly not true of `payments.amount`, and the reason
    // `formatMoney` takes a string.
    ...(row.change_pct !== null ? { changePct: Number(row.change_pct) } : {}),
    goodWhen: row.good_when,
    source: row.source,
    // The date the *figure* is current to, not the row's edit time. Mapping
    // `ci.updated_at` here would make correcting a typo claim the State Bank
    // republished its reserves.
    updatedAt: row.measured_at,
  }));
}

/* -------------------------------------------------------------------------- */
/* Services, committees, partners, testimonials                               */
/* -------------------------------------------------------------------------- */

export async function getServiceTiles(): Promise<ServiceTile[]> {
  const rows = await liveItems("service_tile", new Date())
    .innerJoin("content_service_tiles as s", "s.content_item_id", "ci.id")
    .select(["ci.id", "ci.title_en", "s.description", "s.href", "s.icon"])
    .orderBy("ci.sort_order")
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    labelEn: row.title_en,
    description: row.description,
    href: row.href,
    icon: row.icon,
  }));
}

export async function getCommittees(): Promise<Committee[]> {
  const rows = await liveItems("committee", new Date())
    .innerJoin("content_committees as c", "c.content_item_id", "ci.id")
    .select(["ci.slug", "ci.title_en", "c.mandate", "c.member_count"])
    .orderBy("ci.sort_order")
    .execute();

  return rows.map((row) => ({
    slug: row.slug,
    nameEn: row.title_en,
    mandate: row.mandate,
    memberCount: row.member_count,
  }));
}

export async function getPartners(): Promise<Partner[]> {
  const rows = await liveItems("partner", new Date())
    .innerJoin("content_partners as p", "p.content_item_id", "ci.id")
    .leftJoin("media_assets as logo", "logo.id", "p.logo_id")
    .select([
      "ci.id",
      "ci.title_en",
      "p.tier",
      "logo.src",
      "logo.alt_en",
      "logo.alt_ur",
      "logo.width",
      "logo.height",
      "logo.caption",
    ])
    .orderBy("ci.sort_order")
    .execute();

  return rows.map((row) => {
    const logo = imageOf(row);
    return {
      id: String(row.id),
      name: row.title_en,
      tier: row.tier,
      ...(logo ? { logo } : {}),
    };
  });
}

export async function getTestimonials(): Promise<Testimonial[]> {
  const rows = await liveItems("testimonial", new Date())
    .innerJoin("content_testimonials as t", "t.content_item_id", "ci.id")
    .select([
      "ci.id",
      "t.quote",
      "t.author_name",
      "t.author_role",
      "t.company",
    ])
    .orderBy("ci.sort_order")
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    quote: row.quote,
    authorName: row.author_name,
    authorRole: row.author_role,
    company: row.company,
  }));
}

/* -------------------------------------------------------------------------- */
/* Video                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The chamber's own YouTube channel, which the legacy site linked from a header
 * icon and never surfaced anywhere a visitor would find it.
 *
 * A constant and not a content row: it is the channel's identity, not an item
 * somebody publishes, and an editor who could change it could repoint the
 * site's only outbound video link.
 */
export const YOUTUBE_CHANNEL_URL =
  "https://www.youtube.com/channel/UCQAyoZiYNsntsRWwFbvUr5Q";

/**
 * Featured videos, newest first.
 *
 * The fixture version sorted with `b.publishedAt.localeCompare(a.publishedAt)`,
 * which compares ISO strings carrying `+05:00` offsets as text — correct only
 * while every offset is identical. `ORDER BY published_at DESC` compares
 * instants, so the first video published from a different timezone no longer
 * sorts into the wrong place.
 */
export async function getFeaturedVideos(limit = 5): Promise<VideoItem[]> {
  const rows = await liveItems("video", new Date())
    .innerJoin("content_videos as v", "v.content_item_id", "ci.id")
    .innerJoin("media_assets as poster", "poster.id", "v.poster_id")
    .select([
      "ci.id",
      "ci.title_en",
      "ci.title_ur",
      "ci.published_at",
      "v.youtube_id",
      "v.orientation",
      "v.description",
      "poster.src",
      "poster.alt_en",
      "poster.alt_ur",
      "poster.width",
      "poster.height",
      "poster.caption",
    ])
    .orderBy("ci.published_at", "desc")
    .limit(limit)
    .execute();

  return rows.map((row) => {
    const poster = imageOf(row);
    if (!poster || row.published_at === null) {
      // Unreachable: both joins are inner and `liveItems` requires the date.
      throw new Error(`video ${row.id} is missing its poster or publication date`);
    }
    return {
      id: String(row.id),
      youtubeId: row.youtube_id,
      titleEn: row.title_en,
      ...(row.title_ur ? { titleUr: row.title_ur } : {}),
      orientation: row.orientation,
      publishedAt: row.published_at.toISOString(),
      poster,
      ...(row.description ? { description: row.description } : {}),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Gallery                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The newest published album.
 *
 * The signature promises an album rather than `GalleryAlbum | null`, and
 * changing it would touch a caller — so with nothing published this throws
 * instead of returning an empty one. That is the right failure: `GalleryV2`
 * renders the title, the standfirst and the date unconditionally, so an empty
 * album would put a headed section with three blank lines on the homepage,
 * while a throw stops the build with the cause named.
 *
 * It does mean archiving the last published album breaks the homepage, which
 * is a validation B2's editor owes rather than something this read can fix:
 * refusing to archive the only album is a sentence in the admin, and a schema
 * constraint could not express it.
 */
export async function getGalleryAlbum(): Promise<GalleryAlbum> {
  const now = new Date();

  const album = await liveItems("gallery_album", now)
    .innerJoin("content_gallery_albums as a", "a.content_item_id", "ci.id")
    .select(["ci.id", "ci.slug", "ci.title_en", "a.description", "a.occurred_at"])
    .orderBy("a.occurred_at", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!album) {
    throw new Error(
      "no published gallery album: the homepage gallery section cannot render " +
        "without one. Publish an album, or remove the section.",
    );
  }

  const images = await getDb()
    .selectFrom("content_gallery_images as gi")
    .innerJoin("media_assets as m", "m.id", "gi.media_id")
    .select([
      "gi.id",
      "m.src",
      "m.alt_en",
      "m.alt_ur",
      "m.width",
      "m.height",
      "m.caption",
    ])
    .where("gi.album_item_id", "=", album.id)
    .orderBy("gi.sort_order")
    .execute();

  return {
    slug: album.slug,
    titleEn: album.title_en,
    description: album.description,
    occurredAt: album.occurred_at.toISOString(),
    images: images.map((row): GalleryImage => {
      const image = imageOf(row);
      if (!image) {
        // Unreachable: the join is inner and `src` is NOT NULL.
        throw new Error(`gallery image ${row.id} has no media row`);
      }
      return { id: String(row.id), ...image };
    }),
  };
}
