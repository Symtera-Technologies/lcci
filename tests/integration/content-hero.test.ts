import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import type { ContentStatus } from "@/db/schema";
import { getHero } from "@/content/repository";
import { databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * The homepage hero, read back out of the database.
 *
 * Two questions this suite answers that nothing else can. First, that the live
 * predicate applies to the hero as it does to every other type — a draft hero
 * is an unfinished headline and an embargoed one is an announcement with a
 * date, and either reaching the homepage is worse here than anywhere else on
 * the site, because this is the first thing anybody reads.
 *
 * Second, **which** hero is live. There is no `is_active` flag: the newest
 * published row wins, which is what makes scheduling and reverting free. That
 * rule exists only in an `ORDER BY`, so it is asserted here rather than
 * documented and hoped for.
 *
 * Every assertion is against rows this file inserts. The tables are emptied
 * first, so nothing here is really testing `0023_seed_hero.sql`.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping hero tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  await teardown();
});

// Children before parents. `content_heroes` has FKs to both `content_items`
// and `media_assets`, so it empties before either.
const TABLES = ["content_heroes", "content_items", "media_assets"];

beforeEach(async () => {
  if (!available) return;
  await resetTables(TABLES);
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const DAY = 24 * 3_600_000;

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

function ahead(ms: number): Date {
  return new Date(Date.now() + ms);
}

async function insertMedia(src: string, altEn: string): Promise<number> {
  const result = await getDb()
    .insertInto("media_assets")
    .values({ src, alt_en: altEn, width: 1600, height: 1000 })
    .executeTakeFirst();
  return Number(result.insertId ?? 0);
}

interface HeroFixture {
  slug: string;
  status?: ContentStatus;
  publishedAt?: Date | null;
  unpublishAt?: Date | null;
  headline?: string;
  highlight?: string | null;
  secondaryLabel?: string | null;
  secondaryHref?: string | null;
  memberPrompt?: string | null;
  memberLabel?: string | null;
  memberHref?: string | null;
  caption?: string | null;
  statValue?: string | null;
  statLabel?: string | null;
}

/** One hero, with its own three photographs so each slug is independent. */
async function insertHero(fields: HeroFixture): Promise<number> {
  const item = await getDb()
    .insertInto("content_items")
    .values({
      content_type: "hero",
      slug: fields.slug,
      title_en: `Hero ${fields.slug}`,
      status: fields.status ?? "published",
      published_at: fields.publishedAt === undefined ? ago(DAY) : fields.publishedAt,
      scheduled_unpublish_at: fields.unpublishAt ?? null,
      department_code: "info",
      sort_order: 100,
      updated_at: ago(DAY),
    })
    .executeTakeFirst();

  const id = Number(item.insertId ?? 0);

  await getDb()
    .insertInto("content_heroes")
    .values({
      content_item_id: id,
      badge_en: "Since 1923",
      headline_en: fields.headline ?? "The chamber that speaks for 20,000 businesses.",
      headline_ur: null,
      headline_highlight_en:
        fields.highlight === undefined ? "20,000 businesses" : fields.highlight,
      subhead_en: "Join or renew online.",
      subhead_ur: null,
      primary_cta_label_en: "Join LCCI",
      primary_cta_href: "/membership/apply",
      secondary_cta_label_en:
        fields.secondaryLabel === undefined ? "Smart Services" : fields.secondaryLabel,
      secondary_cta_href:
        fields.secondaryHref === undefined ? "/services" : fields.secondaryHref,
      member_prompt_en:
        fields.memberPrompt === undefined ? "Already a member?" : fields.memberPrompt,
      member_link_label_en:
        fields.memberLabel === undefined ? "Sign in" : fields.memberLabel,
      member_link_href:
        fields.memberHref === undefined ? "/membership/sign-in" : fields.memberHref,
      caption_en: fields.caption === undefined ? "Annual General Meeting" : fields.caption,
      stat_value_en: fields.statValue === undefined ? "103" : fields.statValue,
      stat_label_en: fields.statLabel === undefined ? "years of advocacy" : fields.statLabel,
      lead_image_id: await insertMedia(
        `/photos/${fields.slug}-lead.jpg`,
        "Members gathered on the chamber steps.",
      ),
      behind_image_id: await insertMedia(
        `/photos/${fields.slug}-behind.jpg`,
        "Representatives in discussion with an official.",
      ),
      front_image_id: await insertMedia(
        `/photos/${fields.slug}-front.jpg`,
        "A guest is received at a reception.",
      ),
    })
    .execute();

  return id;
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("getHero", () => {
  it("returns the published hero with all three planes resolved", async () => {
    await insertHero({ slug: "launch" });

    const hero = await getHero();

    expect(hero.badgeEn).toBe("Since 1923");
    expect(hero.headlineEn).toBe("The chamber that speaks for 20,000 businesses.");
    expect(hero.headlineHighlightEn).toBe("20,000 businesses");
    expect(hero.primaryAction).toEqual({ labelEn: "Join LCCI", href: "/membership/apply" });
    expect(hero.secondaryAction).toEqual({ labelEn: "Smart Services", href: "/services" });
    expect(hero.leadImage.src).toBe("/photos/launch-lead.jpg");
    expect(hero.behindImage.src).toBe("/photos/launch-behind.jpg");
    expect(hero.frontImage.src).toBe("/photos/launch-front.jpg");
  });

  /**
   * Alt text is the media library's, not the hero's.
   *
   * The point of having no `alt` column on `content_heroes`: correct the
   * description once and every page using that photograph is corrected.
   */
  it("takes each photograph's description from the media library", async () => {
    await insertHero({ slug: "launch" });

    const hero = await getHero();

    expect(hero.leadImage.altEn).toBe("Members gathered on the chamber steps.");
    expect(hero.behindImage.altEn).toBe(
      "Representatives in discussion with an official.",
    );
    expect(hero.frontImage.altEn).toBe("A guest is received at a reception.");
    // Dimensions travel with it, which is what keeps the frames from shifting
    // as the images load.
    expect(hero.leadImage.width).toBe(1600);
    expect(hero.leadImage.height).toBe(1000);
  });

  /* ---- the live predicate, one row at a time ---------------------------- */

  it("does not serve a draft hero", async () => {
    await insertHero({ slug: "unfinished", status: "draft" });

    await expect(getHero()).rejects.toThrow(/no homepage hero is published/i);
  });

  it("does not serve a hero whose publication date has not arrived", async () => {
    await insertHero({ slug: "monday", publishedAt: ahead(DAY) });

    await expect(getHero()).rejects.toThrow(/no homepage hero is published/i);
  });

  it("does not serve a hero that has been scheduled down", async () => {
    await insertHero({ slug: "expired", unpublishAt: ago(1) });

    await expect(getHero()).rejects.toThrow(/no homepage hero is published/i);
  });

  it("still serves a hero whose take-down date is in the future", async () => {
    await insertHero({ slug: "current", unpublishAt: ahead(DAY) });

    await expect(getHero()).resolves.toMatchObject({ badgeEn: "Since 1923" });
  });

  /* ---- which hero is live ---------------------------------------------- */

  it("serves the most recently published of several", async () => {
    await insertHero({ slug: "old", publishedAt: ago(30 * DAY) });
    await insertHero({ slug: "newest", publishedAt: ago(DAY) });
    await insertHero({ slug: "middle", publishedAt: ago(7 * DAY) });

    const hero = await getHero();

    expect(hero.leadImage.src).toBe("/photos/newest-lead.jpg");
  });

  it("prefers the hero published for today over one scheduled for tomorrow", async () => {
    // The scheduling case, from the editor's side: a hero queued for Monday
    // must not displace Friday's until Monday.
    await insertHero({ slug: "today", publishedAt: ago(1) });
    await insertHero({ slug: "tomorrow", publishedAt: ahead(DAY) });

    const hero = await getHero();

    expect(hero.leadImage.src).toBe("/photos/today-lead.jpg");
  });

  it("breaks a tie on publication date by taking the newer row", async () => {
    // Two heroes published in the same second is a real possibility for seeded
    // or bulk-edited rows, and an unbroken tie means InnoDB decides which
    // headline the chamber shows.
    const sameInstant = ago(DAY);
    await insertHero({ slug: "first", publishedAt: sameInstant });
    await insertHero({ slug: "second", publishedAt: sameInstant });

    const hero = await getHero();

    expect(hero.leadImage.src).toBe("/photos/second-lead.jpg");
  });

  it("names the fix when nothing is published", async () => {
    // The homepage cannot render without a hero, so this failure reaches a
    // build log. It has to say what to do about it.
    await expect(getHero()).rejects.toThrow(/Content → Homepage → Homepage heroes/);
  });

  /* ---- the optional parts ---------------------------------------------- */

  it("omits the second button when it has no label", async () => {
    await insertHero({ slug: "one-button", secondaryLabel: null, secondaryHref: null });

    const hero = await getHero();

    expect(hero.secondaryAction).toBeUndefined();
  });

  it("omits the second button when it has a label but nowhere to go", async () => {
    // Half-filled is the likely editing mistake, and a button with no
    // destination is worse than no button.
    await insertHero({ slug: "half", secondaryHref: null });

    const hero = await getHero();

    expect(hero.secondaryAction).toBeUndefined();
  });

  it("omits the members' line unless the prompt and the link are both set", async () => {
    await insertHero({ slug: "no-prompt", memberPrompt: null });
    let hero = await getHero();
    expect(hero.memberPromptEn).toBeUndefined();

    await resetTables(TABLES);

    await insertHero({ slug: "no-link", memberLabel: null, memberHref: null });
    hero = await getHero();
    expect(hero.memberAction).toBeUndefined();
  });

  it("omits the caption chip when there is no caption", async () => {
    await insertHero({ slug: "uncaptioned", caption: null });

    const hero = await getHero();

    expect(hero.captionEn).toBeUndefined();
  });

  it("treats the figure and its label as both or neither", async () => {
    // A bare "103" on the stage is not a statistic, and a label with no
    // figure is a caption nobody asked for.
    await insertHero({ slug: "figure-only", statLabel: null });
    let hero = await getHero();
    expect(hero.statValueEn).toBeUndefined();
    expect(hero.statLabelEn).toBeUndefined();

    await resetTables(TABLES);

    await insertHero({ slug: "label-only", statValue: null });
    hero = await getHero();
    expect(hero.statValueEn).toBeUndefined();
    expect(hero.statLabelEn).toBeUndefined();
  });

  it("omits the highlight when the editor has cleared it", async () => {
    await insertHero({ slug: "plain", highlight: null });

    const hero = await getHero();

    expect(hero.headlineHighlightEn).toBeUndefined();
    // The headline itself is untouched, which is the whole point.
    expect(hero.headlineEn).toBe("The chamber that speaks for 20,000 businesses.");
  });
});
