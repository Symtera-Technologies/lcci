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
import { portraitKey, splitMeta } from "./fields";

import type {
  Committee,
  EconomicIndicator,
  EventItem,
  GalleryAlbum,
  GalleryImage,
  Hero,
  HeroAction,
  Page,
  ImageRef,
  KeyFigure,
  Notice,
  Partner,
  PolicyPosition,
  Portrait,
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
 * The sharing image, from the aliased columns a second join brings back.
 *
 * Separate from `imageOf` rather than reusing it, because a row that carries
 * two images cannot name both sets of columns `src`/`alt_en`/`width`. The
 * aliases are explicit at every call site for the same reason.
 *
 * Why this exists at all: `og_image_id` has been on `content_items` and on the
 * admin's form since the content types landed, under the help text "Shown when
 * the page is shared on WhatsApp or LinkedIn" — and no getter selected it, so
 * `BaseContent.ogImage` was never assigned and `cmsMetadata`'s `openGraph`
 * branch was dead. An editor set it, saw "Saved.", and every share of the page
 * still had no picture. A field that saves and does nothing is worse than a
 * field that was never offered, which is why this is wired rather than the
 * control removed.
 */
function ogImageOf(row: {
  og_src: string | null;
  og_alt_en: string | null;
  og_alt_ur: string | null;
  og_width: number | null;
  og_height: number | null;
}): ImageRef | undefined {
  if (row.og_src === null) return undefined;
  return {
    src: row.og_src,
    altEn: row.og_alt_en ?? "",
    ...(row.og_alt_ur ? { altUr: row.og_alt_ur } : {}),
    width: row.og_width ?? 0,
    height: row.og_height ?? 0,
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
/* Pages                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One page of prose by slug, or null when nothing is published at it.
 *
 * **Null rather than a throw**, which is the opposite call to `getHero` and
 * `getGalleryAlbum`, because the consequence is different. Those two are bands
 * on the homepage that render unconditionally, so an absent row leaves a hole
 * in a page that is otherwise fine. A page’s route, by contrast, carries its
 * own heading, breadcrumb and description from the typed IA — so with nothing
 * published it still renders a correct, navigable page that simply has no
 * prose on it yet.
 *
 * That difference matters for 48 routes going in before the copy for them
 * exists. The alternative — throwing — would mean the whole site failing to
 * build until every page had been written, which is not a sequence anybody can
 * work in.
 *
 * It also means a slug nobody has created is indistinguishable from one left
 * in draft, which is correct: in both cases there is no published prose at
 * that address.
 */
export async function getPage(slug: string, now = new Date()): Promise<Page | null> {
  const row = await liveItems("page", now)
    .innerJoin("content_pages as p", "p.content_item_id", "ci.id")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    .leftJoin("media_assets as hero", "hero.id", "p.hero_image_id")
    .leftJoin("media_assets as og", "og.id", "ci.og_image_id")
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
      "og.src as og_src",
      "og.alt_en as og_alt_en",
      "og.alt_ur as og_alt_ur",
      "og.width as og_width",
      "og.height as og_height",
      "d.name_en as department_name",
      "p.standfirst_en",
      "p.standfirst_ur",
      "p.meta_en",
      "p.meta_ur",
      "p.body_en",
      "p.body_ur",
      "hero.src",
      "hero.alt_en",
      "hero.alt_ur",
      "hero.width",
      "hero.height",
      "hero.caption",
    ])
    .where("ci.slug", "=", slug)
    .executeTakeFirst();

  if (!row) return null;

  const heroImage = imageOf(row);
  const ogImage = ogImageOf(row);
  // Absent, not empty: see the note on `Page.meta`. A column holding nothing
  // but separators has to behave the same way a NULL does, which is why this
  // is a length check on the split and not a truthiness check on the column.
  const meta = splitMeta(row.meta_en);
  const metaUr = splitMeta(row.meta_ur);

  return {
    ...baseOf(row),
    ...(row.standfirst_en ? { standfirstEn: row.standfirst_en } : {}),
    ...(row.standfirst_ur ? { standfirstUr: row.standfirst_ur } : {}),
    ...(meta.length > 0 ? { meta } : {}),
    ...(metaUr.length > 0 ? { metaUr } : {}),
    ...(row.body_en ? { bodyEn: row.body_en } : {}),
    ...(row.body_ur ? { bodyUr: row.body_ur } : {}),
    ...(heroImage ? { heroImage } : {}),
    ...(ogImage ? { ogImage } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An editable link, when both halves are present.
 *
 * The label and the href are two nullable columns that only mean anything
 * together, and the alternative to checking both is a button with no text or a
 * word that goes nowhere.
 */
function actionOf(label: string | null, href: string | null): HeroAction | undefined {
  if (!label?.trim() || !href?.trim()) return undefined;
  return { labelEn: label, href };
}

/**
 * The live homepage hero.
 *
 * **Throws rather than returning null**, which is the same call
 * `getGalleryAlbum` makes below and for the same reason: `HeroV2` renders the
 * headline, the standfirst and the buttons unconditionally, so an absent hero
 * would put an empty 88vh stage at the top of the homepage. A throw stops the
 * build and names the cause instead.
 *
 * It does mean that archiving the only published hero breaks the homepage.
 * That is a validation the admin owes — refusing to archive the last one is a
 * sentence on a screen, and no schema constraint can express "unless it is the
 * only one" — and it is a louder, more recoverable failure than a homepage
 * that quietly loses its headline.
 *
 * **The newest published row wins.** There is no `is_active` flag: publishing
 * a hero with a future `published_at` schedules it, and reverting is
 * republishing the previous row. Both come free from the workflow that every
 * other content type already uses, and both are audited.
 */
export async function getHero(now = new Date()): Promise<Hero> {
  const row = await liveItems("hero", now)
    .innerJoin("content_heroes as h", "h.content_item_id", "ci.id")
    // Three inner joins, so a hero can only be read with all three planes
    // present. The FKs are NOT NULL, so this cannot fail for a row that
    // exists — the joins are inner to say so to the type checker as well.
    .innerJoin("media_assets as lead", "lead.id", "h.lead_image_id")
    .innerJoin("media_assets as behind", "behind.id", "h.behind_image_id")
    .innerJoin("media_assets as front", "front.id", "h.front_image_id")
    .select([
      "ci.id",
      "h.badge_en",
      "h.headline_en",
      "h.headline_ur",
      "h.headline_highlight_en",
      "h.subhead_en",
      "h.subhead_ur",
      "h.primary_cta_label_en",
      "h.primary_cta_href",
      "h.secondary_cta_label_en",
      "h.secondary_cta_href",
      "h.member_prompt_en",
      "h.member_link_label_en",
      "h.member_link_href",
      "h.caption_en",
      "h.stat_value_en",
      "h.stat_label_en",
      // Aliased per plane, because `imageOf` reads one flat set of media
      // column names and there are three of them in this row.
      "lead.src as lead_src",
      "lead.alt_en as lead_alt_en",
      "lead.alt_ur as lead_alt_ur",
      "lead.width as lead_width",
      "lead.height as lead_height",
      "lead.caption as lead_caption",
      "behind.src as behind_src",
      "behind.alt_en as behind_alt_en",
      "behind.alt_ur as behind_alt_ur",
      "behind.width as behind_width",
      "behind.height as behind_height",
      "behind.caption as behind_caption",
      "front.src as front_src",
      "front.alt_en as front_alt_en",
      "front.alt_ur as front_alt_ur",
      "front.width as front_width",
      "front.height as front_height",
      "front.caption as front_caption",
    ])
    .orderBy("ci.published_at", "desc")
    .orderBy("ci.id", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!row) {
    throw new Error(
      "No homepage hero is published. The homepage cannot render without one: " +
        "publish a hero under Content → Homepage → Homepage heroes.",
    );
  }

  const leadImage = imageOf({
    src: row.lead_src,
    alt_en: row.lead_alt_en,
    alt_ur: row.lead_alt_ur,
    width: row.lead_width,
    height: row.lead_height,
    caption: row.lead_caption,
  });
  const behindImage = imageOf({
    src: row.behind_src,
    alt_en: row.behind_alt_en,
    alt_ur: row.behind_alt_ur,
    width: row.behind_width,
    height: row.behind_height,
    caption: row.behind_caption,
  });
  const frontImage = imageOf({
    src: row.front_src,
    alt_en: row.front_alt_en,
    alt_ur: row.front_alt_ur,
    width: row.front_width,
    height: row.front_height,
    caption: row.front_caption,
  });

  if (!leadImage || !behindImage || !frontImage) {
    // Unreachable: all three joins are inner and all three FKs are NOT NULL.
    throw new Error(`hero ${row.id} is missing one of its three photographs`);
  }

  const primaryAction = actionOf(row.primary_cta_label_en, row.primary_cta_href);
  if (!primaryAction) {
    // Unreachable for the same reason: both columns are NOT NULL.
    throw new Error(`hero ${row.id} has no primary call to action`);
  }

  const secondaryAction = actionOf(row.secondary_cta_label_en, row.secondary_cta_href);
  const memberAction = actionOf(row.member_link_label_en, row.member_link_href);

  return {
    id: String(row.id),
    badgeEn: row.badge_en,
    headlineEn: row.headline_en,
    ...(row.headline_ur ? { headlineUr: row.headline_ur } : {}),
    ...(row.headline_highlight_en
      ? { headlineHighlightEn: row.headline_highlight_en }
      : {}),
    subheadEn: row.subhead_en,
    ...(row.subhead_ur ? { subheadUr: row.subhead_ur } : {}),
    primaryAction,
    ...(secondaryAction ? { secondaryAction } : {}),
    ...(row.member_prompt_en ? { memberPromptEn: row.member_prompt_en } : {}),
    ...(memberAction ? { memberAction } : {}),
    ...(row.caption_en ? { captionEn: row.caption_en } : {}),
    // Both or neither: a figure with nothing beside it is not a statistic.
    ...(row.stat_value_en && row.stat_label_en
      ? { statValueEn: row.stat_value_en, statLabelEn: row.stat_label_en }
      : {}),
    leadImage,
    behindImage,
    frontImage,
  };
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

/**
 * The columns every press-release read selects, and the mapper for them.
 *
 * One builder and one mapper rather than three copies, because there are now
 * three reads of this table -- the homepage's four, the newsroom index's page,
 * and one by slug -- and a column added to the type has to reach all three or
 * the same press release renders differently depending on which page you are
 * on. `body_en` is exactly that case: it has been in the table and in the
 * admin's editor since migration 0018 and was selected by nothing, so an
 * editor could write the body of a press release and watch it appear nowhere.
 */
function pressReleaseRows(now: Date) {
  return liveItems("press_release", now)
    .innerJoin("content_press_releases as pr", "pr.content_item_id", "ci.id")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    .leftJoin("media_assets as hero", "hero.id", "pr.hero_image_id")
    .leftJoin("media_assets as og", "og.id", "ci.og_image_id")
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
      "og.src as og_src",
      "og.alt_en as og_alt_en",
      "og.alt_ur as og_alt_ur",
      "og.width as og_width",
      "og.height as og_height",
      "d.name_en as department_name",
      "pr.summary",
      "pr.body_en",
      "pr.body_ur",
      "pr.spokesperson",
      "hero.src",
      "hero.alt_en",
      "hero.alt_ur",
      "hero.width",
      "hero.height",
      "hero.caption",
    ]);
}

type PressReleaseRow = Awaited<ReturnType<ReturnType<typeof pressReleaseRows>["execute"]>>[number];

function mapPressRelease(
  row: PressReleaseRow,
  topics: Map<number, TopicSlug[]>,
): PressRelease {
  const heroImage = imageOf(row);
  const ogImage = ogImageOf(row);
  return {
    ...baseOf(row),
    summary: row.summary,
    ...(row.body_en ? { bodyEn: row.body_en } : {}),
    ...(row.body_ur ? { bodyUr: row.body_ur } : {}),
    ...(heroImage ? { heroImage } : {}),
    ...(ogImage ? { ogImage } : {}),
    topics: topics.get(row.id) ?? [],
    ...(row.spokesperson ? { spokesperson: row.spokesperson } : {}),
  };
}

export async function getLatestPressReleases(limit = 4): Promise<PressRelease[]> {
  const rows = await pressReleaseRows(new Date())
    .orderBy("ci.published_at", "desc")
    .limit(limit)
    .execute();

  const topics = await topicsFor(rows.map((row) => row.id));
  return rows.map((row) => mapPressRelease(row, topics));
}

/**
 * One page of the press archive, newest first, with the total beside it.
 *
 * The total is a second query rather than a window function, because
 * `COUNT(*) OVER ()` needs MySQL 8 and this ships to a host that serves
 * MariaDB as often as not -- see the stack notes in the README. It is also the
 * cheaper read of the two: the count touches only `idx_content_live`.
 *
 * Paginated rather than complete because the archive is ~895 items once the
 * legacy press releases are imported. Rendering all of them would be a 2 MB
 * page, and `OFFSET` is the right tool here despite its reputation: these
 * pages are statically prerendered at build time, so the deep pages' cost is
 * paid once by the build and never by a visitor.
 */
export async function getPressReleases({
  limit = 12,
  offset = 0,
}: { limit?: number; offset?: number } = {}): Promise<{
  items: PressRelease[];
  total: number;
}> {
  const now = new Date();

  const [rows, count] = await Promise.all([
    pressReleaseRows(now).orderBy("ci.published_at", "desc").limit(limit).offset(offset).execute(),
    liveItems("press_release", now)
      .select((eb) => eb.fn.countAll<number>().as("total"))
      .executeTakeFirst(),
  ]);

  const topics = await topicsFor(rows.map((row) => row.id));

  return {
    items: rows.map((row) => mapPressRelease(row, topics)),
    // `countAll` comes back as a string from mysql2 for BIGINT counts.
    total: Number(count?.total ?? 0),
  };
}

/**
 * One press release by slug, or null when nothing is published at it.
 *
 * Null rather than a throw, for the reason `getPage` gives: the route turns it
 * into `notFound()`, and a throw would make a mistyped URL a 500 rather than a
 * 404. Archived releases do not resolve here yet -- around 890 legacy press
 * URLs are being redirected into this space and archiving one must not
 * manufacture a 404, so `liveItems`' note about resolving archived rows with
 * `noindex` is work this function owes once the archive is imported.
 */
export async function getPressRelease(slug: string): Promise<PressRelease | null> {
  const row = await pressReleaseRows(new Date())
    .where("ci.slug", "=", slug)
    .executeTakeFirst();

  if (!row) return null;

  const topics = await topicsFor([row.id]);
  return mapPressRelease(row, topics);
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
function eventRows(now: Date) {
  return liveItems("event", now)
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
      "e.body_en",
      "e.body_ur",
      "e.fee",
      "e.capacity",
      "e.registration_open",
      "e.registration_deadline",
    ]);
}

type EventRow = Awaited<ReturnType<ReturnType<typeof eventRows>["execute"]>>[number];

function mapEvent(row: EventRow): EventItem {
  return {
    ...baseOf(row),
    type: row.event_type,
    start: row.starts_at.toISOString(),
    ...(row.ends_at ? { end: row.ends_at.toISOString() } : {}),
    venue: row.venue,
    ...(row.body_en ? { bodyEn: row.body_en } : {}),
    ...(row.body_ur ? { bodyUr: row.body_ur } : {}),
    ...(row.fee ? { fee: row.fee } : {}),
    ...(row.capacity !== null ? { capacity: row.capacity } : {}),
    // TINYINT(1) arrives as 0 or 1, not as a boolean.
    registrationOpen: row.registration_open === 1,
    ...(row.registration_deadline
      ? { registrationDeadline: row.registration_deadline.toISOString() }
      : {}),
  };
}

/**
 * Events still to come.
 *
 * `starts_at >= now` was a `filter` over every event in memory; as a `WHERE`
 * against `idx_event_start` it reads only the rows it returns, which is the
 * difference that matters once the chamber's 180 events a year have
 * accumulated for a decade.
 */
export async function getUpcomingEvents(limit = 3, now = new Date()): Promise<EventItem[]> {
  const rows = await eventRows(now)
    .where("e.starts_at", ">=", now)
    .orderBy("e.starts_at")
    .limit(limit)
    .execute();

  return rows.map(mapEvent);
}

/**
 * Events that have been and gone, most recent first.
 *
 * The calendar needs both halves and they sort in opposite directions: what is
 * coming reads soonest-first, what has happened reads most-recent-first. Two
 * functions rather than one with a flag, because the flag would have to change
 * the `ORDER BY` as well as the `WHERE` and a caller passing `"past"` and
 * expecting ascending order would get a plausible, wrong page.
 *
 * `starts_at < now` and not `COALESCE(ends_at, starts_at) < now`, so a
 * three-day exhibition leaves the upcoming list the morning it opens. That is
 * the wrong call for a visitor looking for something to attend today, and it
 * is what `getUpcomingEvents` has always done; both are fixed together or not
 * at all, since an event in neither list would vanish.
 */
export async function getPastEvents(limit = 12, now = new Date()): Promise<EventItem[]> {
  const rows = await eventRows(now)
    .where("e.starts_at", "<", now)
    .orderBy("e.starts_at", "desc")
    .limit(limit)
    .execute();

  return rows.map(mapEvent);
}

/* -------------------------------------------------------------------------- */
/* Advocacy                                                                   */
/* -------------------------------------------------------------------------- */

function positionRows(now: Date) {
  return liveItems("policy_position", now)
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
      "p.body_en",
      "p.body_ur",
      "p.position_status",
    ]);
}

type PositionRow = Awaited<ReturnType<ReturnType<typeof positionRows>["execute"]>>[number];

function mapPosition(row: PositionRow, topics: Map<number, TopicSlug[]>): PolicyPosition {
  return {
    ...baseOf(row),
    issue: row.issue,
    chamberAsk: row.chamber_ask,
    ...(row.body_en ? { bodyEn: row.body_en } : {}),
    ...(row.body_ur ? { bodyUr: row.body_ur } : {}),
    positionStatus: row.position_status,
    topics: topics.get(row.id) ?? [],
  };
}

export async function getAdvocacySpotlight(): Promise<PolicyPosition[]> {
  const rows = await positionRows(new Date()).orderBy("ci.sort_order").execute();
  const topics = await topicsFor(rows.map((row) => row.id));
  return rows.map((row) => mapPosition(row, topics));
}

/**
 * Every published position, newest first.
 *
 * Ordered by publication date and not by `sort_order`, which is the one
 * difference from the homepage's spotlight: the spotlight is an editor's pick
 * of three or four and its order is editorial, while the index is the record
 * of what the chamber has asked for and the useful question of it is "what has
 * it asked for lately".
 *
 * Not paginated. The chamber's positions are counted in tens, not hundreds --
 * each one is an issue it is actively pressing, and a list a visitor cannot
 * read in one page would mean the chamber was pressing too many things to be
 * taken seriously on any of them.
 */
export async function getPolicyPositions(): Promise<PolicyPosition[]> {
  const rows = await positionRows(new Date())
    .orderBy("ci.published_at", "desc")
    .execute();
  const topics = await topicsFor(rows.map((row) => row.id));
  return rows.map((row) => mapPosition(row, topics));
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
    .leftJoin("media_assets as og", "og.id", "ci.og_image_id")
    .select([
      "ci.slug",
      "ci.title_en",
      "c.mandate",
      "c.member_count",
      // A committee is the one content type besides `page` and
      // `press_release` with a URL of its own, so its search title,
      // description and sharing image are things a visitor can actually be
      // shown. All three were offered on the admin form and read by nothing.
      "ci.seo_title",
      "ci.seo_description",
      "og.src as og_src",
      "og.alt_en as og_alt_en",
      "og.alt_ur as og_alt_ur",
      "og.width as og_width",
      "og.height as og_height",
    ])
    .orderBy("ci.sort_order")
    .execute();

  return rows.map((row) => {
    const ogImage = ogImageOf(row);
    return {
      slug: row.slug,
      nameEn: row.title_en,
      mandate: row.mandate,
      memberCount: row.member_count,
      ...(row.seo_title ? { seoTitle: row.seo_title } : {}),
      ...(row.seo_description ? { seoDescription: row.seo_description } : {}),
      ...(ogImage ? { ogImage } : {}),
    };
  });
}

/**
 * Every published portrait, in the order an editor put them in.
 *
 * One query for all of them, because the pages that use these ask two
 * different questions of the same small set — "who holds office" and "is
 * there a face for this name" — and sixty-odd rows of name, role and image
 * path is a few kilobytes.
 */
export async function getPortraits(): Promise<Portrait[]> {
  const rows = await liveItems("portrait", new Date())
    .innerJoin("content_portraits as p", "p.content_item_id", "ci.id")
    .innerJoin("media_assets as photo", "photo.id", "p.photo_id")
    .select([
      "ci.slug",
      "ci.title_en",
      "p.role",
      "p.term",
      "photo.src",
      "photo.alt_en",
      "photo.alt_ur",
      "photo.width",
      "photo.height",
      "photo.caption",
    ])
    // `sort_order` governs the office-bearers band and nothing else; the
    // roster's order is its own prose. Name second so the sixty rows that
    // share the default order are at least stable between builds.
    .orderBy("ci.sort_order")
    .orderBy("ci.title_en")
    .execute();

  const portraits: Portrait[] = [];

  for (const row of rows) {
    const photo = imageOf(row);
    // `photo_id` is NOT NULL and the join is inner, so this cannot happen.
    // The check is here because `imageOf` is typed to allow it, and a portrait
    // with no photograph must never reach a page as an empty frame.
    if (!photo) continue;

    portraits.push({
      slug: row.slug,
      nameEn: row.title_en,
      ...(row.role ? { role: row.role } : {}),
      ...(row.term ? { term: row.term } : {}),
      photo,
    });
  }

  return portraits;
}

/**
 * The people holding office, as the chamber lists them.
 *
 * "Has a post written against them" is the whole definition, and it is the
 * right one: a former president has no post on the old site either — the
 * roster prints the year instead — so the column being empty is what
 * distinguishes them, rather than a flag somebody has to remember to unset
 * when a term ends.
 */
export async function getOfficeBearers(): Promise<Portrait[]> {
  return (await getPortraits()).filter((portrait) => portrait.role !== undefined);
}

/**
 * The same portraits, keyed by the name they belong to.
 *
 * For the pages that are already printing names — as prose migrated off the
 * old site, which cannot be rewritten to carry a photograph — and want the
 * face for each name they come to. A lookup per name, not a query per name.
 *
 * `portraitKey` and not the row’s slug is the key, so that the same person
 * written "Mr. Ali Hassan" on one page and "Ali Hassan" on another is found
 * both times. A name with no entry is not an error: the caller renders the
 * name without a face, which is what the page did before any of this existed.
 *
 * Two people whose names reduce to one key would collide. The seed refuses to
 * emit two rows with the same slug and the admin refuses a duplicate, so
 * reaching that state takes a deliberate edit — and the first row wins, so
 * the result does not depend on the order MySQL returned them in.
 */
export function portraitsByName(portraits: readonly Portrait[]): Map<string, Portrait> {
  const byName = new Map<string, Portrait>();
  for (const portrait of portraits) {
    const key = portraitKey(portrait.nameEn);
    if (key === "" || byName.has(key)) continue;
    byName.set(key, portrait);
  }
  return byName;
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
/**
 * Every published video, newest first.
 *
 * The same read as `getFeaturedVideos` with a different default, and
 * deliberately a separate name rather than a bigger `limit` at the call site:
 * "featured" is what the homepage band asks for and "every one of them" is
 * what the videos page asks for, and a reader of either page should be able to
 * tell which they are looking at from the function it calls. If a `featured`
 * flag is ever added to the type, this is the seam it goes behind.
 */
export function getVideos(limit = 24): Promise<VideoItem[]> {
  return getFeaturedVideos(limit);
}

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

/**
 * Every published album, most recent occasion first, with its photographs.
 *
 * Two queries and not one per album: the images come back in a single read
 * keyed by album, because the galleries page renders every album on it and
 * one query per album is the N+1 that turns a page of six albums into seven
 * round trips. It matters less than usual here — these pages are prerendered,
 * so the cost is the build's — and it still matters, because the admin's
 * preview of this page is not prerendered.
 *
 * Returns an empty array rather than throwing, unlike `getGalleryAlbum`. The
 * difference is the consequence: that one feeds a homepage band which renders
 * its heading unconditionally, so an empty album would ship a headed section
 * with three blank lines. This feeds a page whose own route carries a heading,
 * a breadcrumb and a standfirst, and which says plainly that nothing is
 * published yet.
 */
export async function getGalleryAlbums(limit = 24): Promise<GalleryAlbum[]> {
  const albums = await liveItems("gallery_album", new Date())
    .innerJoin("content_gallery_albums as a", "a.content_item_id", "ci.id")
    .select(["ci.id", "ci.slug", "ci.title_en", "a.description", "a.occurred_at"])
    .orderBy("a.occurred_at", "desc")
    .limit(limit)
    .execute();

  if (albums.length === 0) return [];

  const images = await getDb()
    .selectFrom("content_gallery_images as gi")
    .innerJoin("media_assets as m", "m.id", "gi.media_id")
    .select([
      "gi.id",
      "gi.album_item_id",
      "m.src",
      "m.alt_en",
      "m.alt_ur",
      "m.width",
      "m.height",
      "m.caption",
    ])
    .where(
      "gi.album_item_id",
      "in",
      albums.map((a) => a.id),
    )
    .orderBy("gi.sort_order")
    .execute();

  const byAlbum = new Map<number, GalleryImage[]>();
  for (const row of images) {
    const image = imageOf(row);
    if (!image) {
      // Unreachable: the join is inner and `src` is NOT NULL.
      throw new Error(`gallery image ${row.id} has no media row`);
    }
    const list = byAlbum.get(row.album_item_id) ?? [];
    list.push({ id: String(row.id), ...image });
    byAlbum.set(row.album_item_id, list);
  }

  return albums.map((album) => ({
    slug: album.slug,
    titleEn: album.title_en,
    description: album.description,
    occurredAt: album.occurred_at.toISOString(),
    images: byAlbum.get(album.id) ?? [],
  }));
}

/* -------------------------------------------------------------------------- */
/* Slug index                                                                 */
/* -------------------------------------------------------------------------- */

/** One row's address and the last time it changed. */
export interface SlugIndexEntry {
  slug: string;
  /** `updated_at`, which is what a sitemap's `lastmod` means. */
  updatedAt: Date;
}

/**
 * Every live row of one type, as slug and modification date only.
 *
 * The sitemap's query, and the reason it is not `getPressReleases({ limit:
 * 1000 })`. That would be correct today — seven releases are published — and
 * would become a read of 693 rows with their sanitised bodies, their hero
 * images and a second round trip for their topics, to build a list of URLs
 * that uses none of it. The archive is already in the table waiting on dates,
 * so the wasteful version is not hypothetical; it is next month.
 *
 * Two columns, one index, no joins. It carries the same live predicate as
 * every other list read, which is the property that matters: a sitemap is a
 * promise to a crawler that these URLs exist, and a draft's URL is a 404 that
 * costs crawl budget and shows up in Search Console as an error against the
 * chamber's name.
 *
 * `updatedAt` rather than `publishedAt`. A press release edited for a typo six
 * months after publication has changed, and `lastmod` is the signal a crawler
 * uses to decide whether to fetch it again — reporting the original date would
 * tell it not to bother.
 */
export async function getSlugIndex(
  type: ContentKind,
  now = new Date(),
): Promise<SlugIndexEntry[]> {
  const rows = await liveItems(type, now)
    .select(["ci.slug", "ci.updated_at"])
    .orderBy("ci.slug")
    .execute();

  return rows.map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
}
