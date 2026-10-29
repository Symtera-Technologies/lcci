import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { ForbiddenError, type ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import type { ContentKind, ContentStatus } from "@/db/schema";
import {
  getActiveNotice,
  getCommittees,
  getEconomicIndicators,
  getFeaturedVideos,
  getGalleryAlbum,
  getKeyFigures,
  getLatestPressReleases,
  getPartners,
  getServiceTiles,
  getTestimonials,
  getUpcomingEvents,
} from "@/content/repository";
import { editableDepartments, previewItem, previewList } from "@/content/preview";
import { databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * What `status` and `ownerDepartment` now decide.
 *
 * Both have been declared in `src/content/types.ts` since the first commit and
 * read by nothing, because the repository returned fixtures: a "draft" press
 * release was a value in an object literal that no code branch tested. This
 * suite is the branch. Every case below is a row that exists in the database
 * and must not reach a visitor, which is a claim that could not even be stated
 * before migration 0016.
 *
 * The five exclusions are deliberately tested one row at a time rather than
 * as one "unpublished content is hidden" assertion. They fail independently —
 * a predicate can get `status` right and the publication date wrong, and the
 * two mistakes have different consequences: the first shows an editor's
 * unfinished sentence, the second breaks an embargo.
 *
 * Nothing here trusts the seeded launch content. The tables are emptied first,
 * because an assertion that counts rows would otherwise be asserting against
 * `0017_seed_content.sql` as much as against the code — and the day somebody
 * adds a seventh press release to the seed, the test would fail for a reason
 * that has nothing to do with the repository.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping content tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  await teardown();
});

/**
 * Children before parents, and `departments` and `content_topics` left alone.
 *
 * Those two are reference data seeded by migration 0016, not test fixtures:
 * emptying them would break the foreign keys every insert below depends on,
 * and nothing would put them back. Nothing outside these tables references
 * them, so the AUTO_INCREMENT reset cannot leave another suite's rows pointing
 * at ids this one reissues.
 */
const TABLES = [
  "content_gallery_images",
  "content_gallery_albums",
  "content_videos",
  "content_testimonials",
  "content_partners",
  "content_committees",
  "content_service_tiles",
  "content_economic_indicators",
  "content_key_figures",
  "content_notices",
  "content_policy_positions",
  "content_events",
  "content_press_releases",
  "content_item_topics",
  "content_items",
  "media_assets",
];

beforeEach(async () => {
  if (!available) return;
  await resetTables(TABLES);
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

function ahead(ms: number): Date {
  return new Date(Date.now() + ms);
}

async function insertItem(fields: {
  type: ContentKind;
  slug: string;
  titleEn?: string;
  titleUr?: string | null;
  status?: ContentStatus;
  publishedAt?: Date | null;
  unpublishAt?: Date | null;
  department?: string;
  sortOrder?: number;
}): Promise<number> {
  const result = await getDb()
    .insertInto("content_items")
    .values({
      content_type: fields.type,
      slug: fields.slug,
      title_en: fields.titleEn ?? fields.slug,
      title_ur: fields.titleUr ?? null,
      status: fields.status ?? "published",
      published_at: fields.publishedAt === undefined ? ago(DAY) : fields.publishedAt,
      scheduled_unpublish_at: fields.unpublishAt ?? null,
      department_code: fields.department ?? "info",
      sort_order: fields.sortOrder ?? 100,
      updated_at: ago(DAY),
    })
    .executeTakeFirst();

  return Number(result.insertId ?? 0);
}

async function insertMedia(src: string, altEn = "A photograph."): Promise<number> {
  const result = await getDb()
    .insertInto("media_assets")
    .values({ src, alt_en: altEn, width: 800, height: 600 })
    .executeTakeFirst();
  return Number(result.insertId ?? 0);
}

async function insertPress(fields: {
  slug: string;
  status?: ContentStatus;
  publishedAt?: Date | null;
  unpublishAt?: Date | null;
  department?: string;
  topics?: readonly string[];
  heroSrc?: string;
}): Promise<number> {
  const id = await insertItem({ type: "press_release", ...fields });

  const heroImageId = fields.heroSrc ? await insertMedia(fields.heroSrc) : null;

  await getDb()
    .insertInto("content_press_releases")
    .values({
      content_item_id: id,
      summary: `Summary of ${fields.slug}.`,
      hero_image_id: heroImageId,
      spokesperson: "The President",
    })
    .execute();

  if (fields.topics?.length) {
    await getDb()
      .insertInto("content_item_topics")
      .values(
        fields.topics.map((slug, index) => ({
          content_item_id: id,
          topic_slug: slug,
          sort_order: (index + 1) * 10,
        })),
      )
      .execute();
  }

  return id;
}

function staffActor(permissions: readonly PermissionCode[], scopes: readonly string[] = []): ActorContext {
  return {
    userId: 1,
    userType: "staff",
    roleCode: "department_editor",
    roleCodes: ["department_editor"],
    permissions: new Set(permissions),
    departmentScopes: scopes,
    requestId: newUlid(),
    ipHash: null,
    userAgentHash: null,
    onBehalfOfUserId: null,
  };
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("the live predicate", () => {
  /**
   * One row per way of not being public, and one that is.
   *
   * The assertion is on the returned slugs rather than on a count, so a
   * failure says which row leaked rather than that one did.
   */
  beforeEach(async () => {
    await insertPress({ slug: "live", publishedAt: ago(DAY) });
    await insertPress({ slug: "draft", status: "draft", publishedAt: null });
    await insertPress({ slug: "in-review", status: "in_review", publishedAt: null });
    await insertPress({ slug: "archived", status: "archived", publishedAt: ago(30 * DAY) });
    await insertPress({ slug: "scheduled", publishedAt: ahead(DAY) });
    await insertPress({ slug: "unpublished-already", unpublishAt: ago(HOUR) });
    await insertPress({ slug: "unpublishes-later", unpublishAt: ahead(DAY) });
    // Published status with no date at all: reachable only by a bad write, and
    // the one case where a mistake in the predicate would show a draft. NULL
    // must fail the comparison rather than be treated as the epoch.
    await insertPress({ slug: "published-no-date", publishedAt: null });
  });

  it("returns only what a visitor may see", async () => {
    const releases = await getLatestPressReleases(20);
    expect(releases.map((release) => release.slug).sort()).toEqual([
      "live",
      "unpublishes-later",
    ]);
  });

  it("excludes a draft", async () => {
    const slugs = (await getLatestPressReleases(20)).map((r) => r.slug);
    expect(slugs).not.toContain("draft");
    expect(slugs).not.toContain("in-review");
  });

  it("excludes an archived item from the list, and keeps its row", async () => {
    const slugs = (await getLatestPressReleases(20)).map((r) => r.slug);
    expect(slugs).not.toContain("archived");

    // Around 890 legacy press URLs are being redirected into this space, so
    // archiving must not delete anything: the row and its slug survive for the
    // detail route to resolve with `noindex`.
    const row = await getDb()
      .selectFrom("content_items")
      .select(["slug", "status"])
      .where("slug", "=", "archived")
      .executeTakeFirst();
    expect(row).toEqual({ slug: "archived", status: "archived" });
  });

  it("excludes a future publication date, which is what makes scheduling work", async () => {
    expect((await getLatestPressReleases(20)).map((r) => r.slug)).not.toContain("scheduled");
  });

  it("excludes an item whose scheduled unpublish has passed", async () => {
    const slugs = (await getLatestPressReleases(20)).map((r) => r.slug);
    expect(slugs).not.toContain("unpublished-already");
    expect(slugs).toContain("unpublishes-later");
  });

  it("does not treat a missing publication date as the epoch", async () => {
    expect((await getLatestPressReleases(20)).map((r) => r.slug)).not.toContain(
      "published-no-date",
    );
  });
});

describe.skipIf(!available)("press releases", () => {
  it("come back newest first, honouring the limit", async () => {
    await insertPress({ slug: "oldest", publishedAt: ago(10 * DAY) });
    await insertPress({ slug: "newest", publishedAt: ago(DAY) });
    await insertPress({ slug: "middle", publishedAt: ago(5 * DAY) });

    expect((await getLatestPressReleases(2)).map((r) => r.slug)).toEqual([
      "newest",
      "middle",
    ]);
  });

  it("carry their topics in order", async () => {
    await insertPress({ slug: "tagged", topics: ["energy", "taxation-budget"] });

    const [release] = await getLatestPressReleases(1);
    expect(release.topics).toEqual(["energy", "taxation-budget"]);
  });

  it("carry no topics as an empty array, not as undefined", async () => {
    await insertPress({ slug: "untagged" });

    const [release] = await getLatestPressReleases(1);
    expect(release.topics).toEqual([]);
  });

  it("report the department's name, not its code", async () => {
    await insertPress({ slug: "owned", department: "research" });

    const [release] = await getLatestPressReleases(1);
    expect(release.ownerDepartment).toBe("Research Department");
  });

  it("carry the hero image with its alt text", async () => {
    await insertPress({ slug: "illustrated", heroSrc: "/photos/hero-1.jpg" });

    const [release] = await getLatestPressReleases(1);
    expect(release.heroImage).toEqual({
      src: "/photos/hero-1.jpg",
      altEn: "A photograph.",
      width: 800,
      height: 600,
    });
  });

  it("omit the hero image rather than returning a half-empty one", async () => {
    await insertPress({ slug: "plain" });

    const [release] = await getLatestPressReleases(1);
    expect(release.heroImage).toBeUndefined();
  });
});

describe.skipIf(!available)("the active notice", () => {
  async function insertNotice(fields: {
    slug: string;
    level: "info" | "urgent";
    startAt: Date;
    endAt: Date;
    status?: ContentStatus;
    publishedAt?: Date;
  }): Promise<void> {
    const id = await insertItem({
      type: "notice",
      slug: fields.slug,
      status: fields.status,
      publishedAt: fields.publishedAt,
      department: "secretariat",
    });
    await getDb()
      .insertInto("content_notices")
      .values({
        content_item_id: id,
        message_en: `Message for ${fields.slug}.`,
        level: fields.level,
        starts_at: fields.startAt,
        ends_at: fields.endAt,
      })
      .execute();
  }

  it("returns the one notice inside its window", async () => {
    await insertNotice({
      slug: "n-live",
      level: "info",
      startAt: ago(DAY),
      endAt: ahead(DAY),
    });

    const notice = await getActiveNotice();
    expect(notice?.messageEn).toBe("Message for n-live.");
    expect(notice?.level).toBe("info");
  });

  it("ranks urgent above info when both are live", async () => {
    await insertNotice({
      slug: "n-info",
      level: "info",
      startAt: ago(DAY),
      endAt: ahead(DAY),
    });
    await insertNotice({
      slug: "n-urgent",
      level: "urgent",
      startAt: ago(DAY),
      endAt: ahead(DAY),
    });

    const notice = await getActiveNotice();
    expect(notice?.level).toBe("urgent");
    expect(notice?.messageEn).toBe("Message for n-urgent.");
  });

  /**
   * The expiry the legacy homepage did not have.
   *
   * Four modal pop-ups with no end date is what this replaces, and the point
   * is that nobody has to remember to take a notice down.
   */
  it("returns null once the window has closed", async () => {
    await insertNotice({
      slug: "n-expired",
      level: "urgent",
      startAt: ago(10 * DAY),
      endAt: ago(DAY),
    });

    expect(await getActiveNotice()).toBeNull();
  });

  it("returns null before the window opens", async () => {
    await insertNotice({
      slug: "n-future",
      level: "urgent",
      startAt: ahead(DAY),
      endAt: ahead(10 * DAY),
    });

    expect(await getActiveNotice()).toBeNull();
  });

  /**
   * The window and the editorial status are different gates.
   *
   * A notice drafted for next week's closure has a live-looking window the
   * moment somebody mistypes the dates; `status` is what keeps it off the
   * homepage until it is approved.
   */
  it("returns null for an unapproved notice inside a live window", async () => {
    await insertNotice({
      slug: "n-draft",
      level: "urgent",
      startAt: ago(DAY),
      endAt: ahead(DAY),
      status: "draft",
    });

    expect(await getActiveNotice()).toBeNull();
  });

  it("evaluates the window against the clock it is given", async () => {
    await insertNotice({
      slug: "n-past",
      level: "info",
      startAt: ago(10 * DAY),
      endAt: ago(5 * DAY),
      publishedAt: ago(20 * DAY),
    });

    expect(await getActiveNotice()).toBeNull();
    expect((await getActiveNotice(ago(7 * DAY)))?.messageEn).toBe("Message for n-past.");
  });

  /**
   * `now` is one clock, and it moves the publication check too.
   *
   * Not only the notice's own window. Asking "what was live a week ago" and
   * getting back something published yesterday would be a different and less
   * useful question, and the asymmetry would be invisible until somebody built
   * an as-of view on top of it. Stated as a test because it is a decision
   * rather than an accident: the fixture version had no publication date to
   * check, so this behaviour is new with the SQL.
   */
  it("applies the given clock to publication as well as to the window", async () => {
    await insertNotice({
      slug: "n-recent",
      level: "info",
      startAt: ago(30 * DAY),
      endAt: ahead(30 * DAY),
      publishedAt: ago(DAY),
    });

    expect((await getActiveNotice())?.messageEn).toBe("Message for n-recent.");
    // Inside its window a week ago, but not yet published then.
    expect(await getActiveNotice(ago(7 * DAY))).toBeNull();
  });
});

describe.skipIf(!available)("upcoming events", () => {
  async function insertEvent(
    slug: string,
    startsAt: Date,
    endsAt: Date | null = null,
    publishedAt?: Date,
  ): Promise<void> {
    const id = await insertItem({
      type: "event",
      slug,
      publishedAt,
      department: "secretariat",
    });
    await getDb()
      .insertInto("content_events")
      .values({
        content_item_id: id,
        event_type: "seminar",
        starts_at: startsAt,
        ends_at: endsAt,
        venue: "Auditorium, LCCI",
        registration_open: 1,
      })
      .execute();
  }

  it("excludes events that have started and sorts the rest ascending", async () => {
    await insertEvent("yesterday", ago(DAY));
    await insertEvent("next-week", ahead(7 * DAY));
    await insertEvent("tomorrow", ahead(DAY));

    const events = await getUpcomingEvents(10);
    expect(events.map((event) => event.slug)).toEqual(["tomorrow", "next-week"]);
  });

  it("honours the limit", async () => {
    await insertEvent("first", ahead(DAY));
    await insertEvent("second", ahead(2 * DAY));
    await insertEvent("third", ahead(3 * DAY));

    expect((await getUpcomingEvents(2)).map((event) => event.slug)).toEqual([
      "first",
      "second",
    ]);
  });

  it("evaluates against the clock it is given", async () => {
    // Announced two months ago, so it was both published and still upcoming
    // at the earlier clock. One clock governs publication and the start date
    // alike; see the notice suite for why.
    await insertEvent("last-month", ago(30 * DAY), null, ago(60 * DAY));

    expect(await getUpcomingEvents(10)).toHaveLength(0);
    expect((await getUpcomingEvents(10, ago(40 * DAY))).map((e) => e.slug)).toEqual([
      "last-month",
    ]);
  });

  it("returns registrationOpen as a boolean, not as MySQL's 1", async () => {
    await insertEvent("open", ahead(DAY));

    const [event] = await getUpcomingEvents(1);
    expect(event.registrationOpen).toBe(true);
  });
});

describe.skipIf(!available)("the ordered sections", () => {
  it("returns key figures in editorial order, with the verification date intact", async () => {
    const second = await insertItem({
      type: "key_figure",
      slug: "kf-second",
      titleEn: "Years since 1923",
      department: "research",
      sortOrder: 20,
    });
    const first = await insertItem({
      type: "key_figure",
      slug: "kf-first",
      titleEn: "Member businesses",
      department: "research",
      sortOrder: 10,
    });

    await getDb()
      .insertInto("content_key_figures")
      .values([
        { content_item_id: first, figure_value: 20, suffix: "k+", verified_at: "2026-10-01" },
        { content_item_id: second, figure_value: 103, suffix: null, verified_at: "2026-10-01" },
      ])
      .execute();

    const figures = await getKeyFigures();
    expect(figures.map((figure) => figure.labelEn)).toEqual([
      "Member businesses",
      "Years since 1923",
    ]);
    // A civil date, unchanged by any timezone: `dateStrings: ["DATE"]` is what
    // keeps 1 October from becoming 30 September for a reader abroad.
    expect(figures[0].verifiedAt).toBe("2026-10-01");
    expect(figures[0].suffix).toBe("k+");
    expect(figures[1].suffix).toBeUndefined();
  });

  it("converts an indicator's change to a number and keeps its own as-of date", async () => {
    const id = await insertItem({
      type: "economic_indicator",
      slug: "ei-1",
      titleEn: "CPI inflation",
      department: "research",
    });
    await getDb()
      .insertInto("content_economic_indicators")
      .values({
        content_item_id: id,
        display_value: "6.1%",
        change_pct: "-0.40",
        good_when: "down",
        source: "PBS",
        measured_at: "2026-10-22",
      })
      .execute();

    const [indicator] = await getEconomicIndicators();
    // DECIMAL arrives from mysql2 as a string; the public type says `number`.
    expect(indicator.changePct).toBe(-0.4);
    expect(indicator.value).toBe("6.1%");
    expect(indicator.goodWhen).toBe("down");
    // The figure's own date, not the row's edit time. If this ever reads as
    // today, somebody has mapped `content_items.updated_at` here and the
    // ticker is now claiming the State Bank republished its figures.
    expect(indicator.updatedAt).toBe("2026-10-22");
  });

  it("returns service tiles, committees, partners and testimonials in order", async () => {
    const tile = await insertItem({
      type: "service_tile",
      slug: "s-1",
      titleEn: "Renew membership",
      department: "secretariat",
      sortOrder: 10,
    });
    await getDb()
      .insertInto("content_service_tiles")
      .values({
        content_item_id: tile,
        description: "Pay online.",
        href: "/membership/renew",
        icon: "renew",
      })
      .execute();

    const committee = await insertItem({
      type: "committee",
      slug: "taxation",
      titleEn: "Taxation",
      department: "secretariat",
    });
    await getDb()
      .insertInto("content_committees")
      .values({ content_item_id: committee, mandate: "Tax policy.", member_count: 24 })
      .execute();

    const partner = await insertItem({
      type: "partner",
      slug: "p-1",
      titleEn: "State Bank of Pakistan",
      department: "secretariat",
    });
    await getDb()
      .insertInto("content_partners")
      .values({ content_item_id: partner, tier: "strategic", logo_id: null })
      .execute();

    const testimonial = await insertItem({
      type: "testimonial",
      slug: "t-1",
      titleEn: "Farhan Qureshi, Ravi Textiles",
    });
    await getDb()
      .insertInto("content_testimonials")
      .values({
        content_item_id: testimonial,
        quote: "It cut two days out of every shipment.",
        author_name: "Farhan Qureshi",
        author_role: "Export Manager",
        company: "Ravi Textiles (Pvt) Ltd",
      })
      .execute();

    expect((await getServiceTiles()).map((t) => t.labelEn)).toEqual(["Renew membership"]);
    expect(await getCommittees()).toEqual([
      {
        slug: "taxation",
        nameEn: "Taxation",
        mandate: "Tax policy.",
        memberCount: 24,
      },
    ]);
    // No artwork yet, so the logo is omitted rather than returned empty — a
    // half-built `ImageRef` would render a broken image on the homepage.
    const [onePartner] = await getPartners();
    expect(onePartner.name).toBe("State Bank of Pakistan");
    expect(onePartner.logo).toBeUndefined();
    expect((await getTestimonials())[0].company).toBe("Ravi Textiles (Pvt) Ltd");
  });
});

describe.skipIf(!available)("video", () => {
  async function insertVideo(
    slug: string,
    youtubeId: string,
    publishedAt: Date,
  ): Promise<void> {
    const id = await insertItem({ type: "video", slug, publishedAt });
    const posterId = await insertMedia(`/video/${youtubeId}.jpg`, "A still from the film.");
    await getDb()
      .insertInto("content_videos")
      .values({
        content_item_id: id,
        youtube_id: youtubeId,
        orientation: "landscape",
        poster_id: posterId,
        description: null,
      })
      .execute();
  }

  /**
   * Ordered by instant, not by the text of an ISO string.
   *
   * The fixture version sorted with `localeCompare` on strings carrying
   * `+05:00` offsets, which is correct only while every offset is identical.
   */
  it("returns the newest first", async () => {
    await insertVideo("vid-old", "aaaaaaaaaaa", ago(10 * DAY));
    await insertVideo("vid-new", "bbbbbbbbbbb", ago(HOUR));

    const videos = await getFeaturedVideos(5);
    expect(videos.map((video) => video.youtubeId)).toEqual([
      "bbbbbbbbbbb",
      "aaaaaaaaaaa",
    ]);
    expect(videos[0].poster.altEn).toBe("A still from the film.");
  });
});

describe.skipIf(!available)("the gallery album", () => {
  async function insertAlbum(
    slug: string,
    occurredAt: Date,
    imageSrcs: readonly string[],
    status: ContentStatus = "published",
  ): Promise<void> {
    const id = await insertItem({ type: "gallery_album", slug, status });
    await getDb()
      .insertInto("content_gallery_albums")
      .values({
        content_item_id: id,
        description: `Photographs from ${slug}.`,
        occurred_at: occurredAt,
      })
      .execute();

    for (const [index, src] of imageSrcs.entries()) {
      const mediaId = await insertMedia(src, `Photograph ${index + 1}.`);
      await getDb()
        .insertInto("content_gallery_images")
        .values({
          album_item_id: id,
          media_id: mediaId,
          sort_order: (index + 1) * 10,
        })
        .execute();
    }
  }

  it("returns the newest published album with its images in order", async () => {
    await insertAlbum("agm-2025", ago(400 * DAY), ["/photos/old-1.jpg"]);
    await insertAlbum("agm-2026", ago(30 * DAY), [
      "/photos/new-1.jpg",
      "/photos/new-2.jpg",
    ]);

    const album = await getGalleryAlbum();
    expect(album.slug).toBe("agm-2026");
    expect(album.images.map((image) => image.src)).toEqual([
      "/photos/new-1.jpg",
      "/photos/new-2.jpg",
    ]);
    expect(album.images[0].altEn).toBe("Photograph 1.");
  });

  it("ignores an unpublished album even when it is the newest", async () => {
    await insertAlbum("agm-2026", ago(30 * DAY), ["/photos/new-1.jpg"]);
    await insertAlbum("agm-2027", ago(DAY), ["/photos/draft-1.jpg"], "draft");

    expect((await getGalleryAlbum()).slug).toBe("agm-2026");
  });

  /**
   * Throws rather than returning an empty album.
   *
   * The signature promises a `GalleryAlbum` and changing it would touch a
   * caller. `GalleryV2` renders the title, standfirst and date
   * unconditionally, so an empty album would put a headed section with three
   * blank lines on the homepage; a throw stops the build and names the cause.
   */
  it("throws when nothing is published", async () => {
    await expect(getGalleryAlbum()).rejects.toThrow(/no published gallery album/);
  });
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("preview", () => {
  beforeEach(async () => {
    await insertPress({ slug: "info-draft", status: "draft", publishedAt: null, department: "info" });
    await insertPress({
      slug: "research-draft",
      status: "draft",
      publishedAt: null,
      department: "research",
    });
    await insertPress({ slug: "info-live", department: "info" });
    await insertPress({ slug: "info-scheduled", department: "info", publishedAt: ahead(DAY) });
  });

  it("refuses an actor without content.read_draft", async () => {
    const actor = staffActor(["application.read"]);
    await expect(previewItem(actor, "press_release", "info-draft")).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("returns a draft to an actor who holds the permission", async () => {
    const actor = staffActor(["content.read_draft"]);
    const item = await previewItem(actor, "press_release", "info-draft");

    expect(item?.slug).toBe("info-draft");
    expect(item?.status).toBe("draft");
    expect(item?.isLive).toBe(false);
    expect(item?.departmentName).toBe("Information Department");
  });

  /**
   * The department scope, as a `WHERE` and not a filter.
   *
   * A post-fetch filter has already read the row and will leak it through a
   * count, an export or a log line. This asserts the narrower claim the SQL
   * makes: the row never comes back at all.
   */
  it("hides another department's draft from a scoped editor", async () => {
    const actor = staffActor(["content.read_draft"], ["info"]);

    expect((await previewItem(actor, "press_release", "info-draft"))?.slug).toBe("info-draft");
    expect(await previewItem(actor, "press_release", "research-draft")).toBeNull();
  });

  /**
   * Null for "not yours" and for "not there", alike.
   *
   * 403-on-real and 404-on-fake is an existence oracle: it would let an editor
   * enumerate another department's unpublished slugs one guess at a time,
   * which on embargoed press releases is the thing worth protecting.
   */
  it("gives the same answer for a scoped-out row as for one that does not exist", async () => {
    const actor = staffActor(["content.read_draft"], ["info"]);

    expect(await previewItem(actor, "press_release", "research-draft")).toBeNull();
    expect(await previewItem(actor, "press_release", "no-such-slug")).toBeNull();
  });

  it("treats an empty scope list as the whole chamber, not as no access", async () => {
    const actor = staffActor(["content.read_draft"]);
    expect((await previewItem(actor, "press_release", "research-draft"))?.slug).toBe(
      "research-draft",
    );
  });

  it("reports isLive from the same three conditions the public read uses", async () => {
    const actor = staffActor(["content.read_draft"]);

    expect((await previewItem(actor, "press_release", "info-live"))?.isLive).toBe(true);
    expect((await previewItem(actor, "press_release", "info-scheduled"))?.isLive).toBe(false);
    expect((await previewItem(actor, "press_release", "info-draft"))?.isLive).toBe(false);
  });

  it("lists every status, filtered on request", async () => {
    const actor = staffActor(["content.read_draft"]);

    const all = await previewList(actor, "press_release");
    expect(all.map((item) => item.slug).sort()).toEqual([
      "info-draft",
      "info-live",
      "info-scheduled",
      "research-draft",
    ]);

    const drafts = await previewList(actor, "press_release", { status: "draft" });
    expect(drafts.map((item) => item.slug).sort()).toEqual([
      "info-draft",
      "research-draft",
    ]);
  });

  it("scopes the list the same way as the single read", async () => {
    const actor = staffActor(["content.read_draft"], ["info"]);
    const items = await previewList(actor, "press_release");
    expect(items.map((item) => item.slug)).not.toContain("research-draft");
  });

  it("offers only the departments an editor may file under", async () => {
    expect(
      (await editableDepartments(staffActor(["content.read_draft"], ["info"]))).map(
        (department) => department.code,
      ),
    ).toEqual(["info"]);

    expect(
      (await editableDepartments(staffActor(["content.read_draft"]))).map(
        (department) => department.code,
      ),
    ).toEqual(["info", "research", "secretariat"]);
  });
});
