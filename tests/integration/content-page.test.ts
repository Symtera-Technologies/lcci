import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import type { ContentStatus } from "@/db/schema";
import { getPage } from "@/content/repository";
import { databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * Interior-page prose, read back out of the database.
 *
 * `getPage` is the one getter in the repository that returns **null** rather
 * than throwing or returning an empty list, and that difference is load
 * bearing: 48 routes go in ahead of the copy for them, and each renders a
 * correct, navigable page from its own typed place in the IA when there is
 * nothing published at its slug. So the tests that matter most here are the
 * ones that assert *absence* resolves to null rather than to a throw or to a
 * half-populated object — a page that threw would fail the whole site's build.
 *
 * The second group asserts the live predicate, one condition at a time. A
 * draft page is prose somebody is still writing; letting it resolve would put
 * an unfinished paragraph on `/about` with no way for a visitor to tell.
 *
 * Every assertion is against rows this file inserts, and the tables are
 * emptied first, so nothing here is testing `0025_seed_pages.sql`.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping page tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  await teardown();
});

// Children before parents: `content_pages` has FKs to `content_items` and to
// `media_assets`, so it empties before either.
const TABLES = ["content_pages", "content_items", "media_assets"];

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
    .values({ src, alt_en: altEn, width: 1600, height: 900, caption: "On the steps." })
    .executeTakeFirst();
  return Number(result.insertId ?? 0);
}

interface PageFixture {
  slug: string;
  status?: ContentStatus;
  publishedAt?: Date | null;
  unpublishAt?: Date | null;
  title?: string;
  standfirst?: string | null;
  body?: string | null;
  bodyUr?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  withBanner?: boolean;
}

async function insertPage(fields: PageFixture): Promise<number> {
  const item = await getDb()
    .insertInto("content_items")
    .values({
      content_type: "page",
      slug: fields.slug,
      title_en: fields.title ?? `Page ${fields.slug}`,
      status: fields.status ?? "published",
      published_at: fields.publishedAt === undefined ? ago(DAY) : fields.publishedAt,
      scheduled_unpublish_at: fields.unpublishAt ?? null,
      department_code: "info",
      seo_title: fields.seoTitle ?? null,
      seo_description: fields.seoDescription ?? null,
      sort_order: 100,
      updated_at: ago(DAY),
    })
    .executeTakeFirst();

  const id = Number(item.insertId ?? 0);

  await getDb()
    .insertInto("content_pages")
    .values({
      content_item_id: id,
      standfirst_en:
        fields.standfirst === undefined ? "One sentence under the heading." : fields.standfirst,
      standfirst_ur: null,
      body_en: fields.body === undefined ? "<p>The body.</p>" : fields.body,
      body_ur: fields.bodyUr ?? null,
      hero_image_id: fields.withBanner
        ? await insertMedia(`/photos/${fields.slug}.jpg`, "Members at the chamber.")
        : null,
    })
    .execute();

  return id;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("getPage", () => {
  it("returns null for a slug nobody has created", async () => {
    expect(await getPage("about-history")).toBeNull();
  });

  it("reads a published page by slug", async () => {
    await insertPage({ slug: "about", title: "About the chamber" });

    const page = await getPage("about");

    expect(page).not.toBeNull();
    expect(page?.slug).toBe("about");
    expect(page?.titleEn).toBe("About the chamber");
    expect(page?.standfirstEn).toBe("One sentence under the heading.");
    expect(page?.bodyEn).toBe("<p>The body.</p>");
  });

  it("does not confuse one slug for another", async () => {
    await insertPage({ slug: "about", title: "About the chamber" });
    await insertPage({ slug: "about-careers", title: "Careers" });

    expect((await getPage("about"))?.titleEn).toBe("About the chamber");
    expect((await getPage("about-careers"))?.titleEn).toBe("Careers");
  });

  it("does not match a slug that is only a prefix of a real one", async () => {
    // `/about` and `/about/history` are different pages, and their slugs are
    // `about` and `about-history`. A `LIKE` or a prefix match here would make
    // the landing page's prose appear on all seven of its children.
    await insertPage({ slug: "about-history" });

    expect(await getPage("about")).toBeNull();
  });

  /* ---------------------------------------------------------------------- */

  describe("the live predicate", () => {
    it("hides a draft", async () => {
      await insertPage({ slug: "about", status: "draft" });
      expect(await getPage("about")).toBeNull();
    });

    it("hides a page in review", async () => {
      await insertPage({ slug: "about", status: "in_review" });
      expect(await getPage("about")).toBeNull();
    });

    it("hides an archived page", async () => {
      // Archived pages are excluded here on purpose. The press archive resolves
      // at its URL with `noindex` because ~890 legacy press URLs are being
      // redirected into that space; an archived *interior* page has no such
      // inbound traffic, and the route still renders from its IA either way.
      await insertPage({ slug: "about", status: "archived" });
      expect(await getPage("about")).toBeNull();
    });

    it("hides a page with no publication date", async () => {
      await insertPage({ slug: "about", publishedAt: null });
      expect(await getPage("about")).toBeNull();
    });

    it("hides a page published in the future", async () => {
      await insertPage({ slug: "about", publishedAt: ahead(DAY) });
      expect(await getPage("about")).toBeNull();
    });

    it("shows a page published a moment ago", async () => {
      await insertPage({ slug: "about", publishedAt: ago(1_000) });
      expect(await getPage("about")).not.toBeNull();
    });

    it("hides a page whose unpublish date has passed", async () => {
      await insertPage({ slug: "about", unpublishAt: ago(1_000) });
      expect(await getPage("about")).toBeNull();
    });

    it("shows a page whose unpublish date is still ahead", async () => {
      await insertPage({ slug: "about", unpublishAt: ahead(DAY) });
      expect(await getPage("about")).not.toBeNull();
    });

    it("honours an explicit `now`", async () => {
      // The route reads `getPage(slug)` with no argument and the default is
      // `new Date()`, so this is the only place the parameter is exercised —
      // and it is what B4's scheduled publish is built on.
      await insertPage({ slug: "about", publishedAt: ahead(DAY) });

      expect(await getPage("about")).toBeNull();
      expect(await getPage("about", ahead(2 * DAY))).not.toBeNull();
    });
  });

  /* ---------------------------------------------------------------------- */

  describe("optional fields", () => {
    it("omits a standfirst rather than returning an empty string", async () => {
      // The route falls back to the description typed in the IA, and it does
      // that on `undefined`. A `""` would satisfy `??` and render a page with
      // a heading and a blank line under it.
      await insertPage({ slug: "about", standfirst: null });

      const page = await getPage("about");
      expect(page).not.toBeNull();
      expect(page?.standfirstEn).toBeUndefined();
    });

    it("omits a body rather than returning an empty string", async () => {
      // `Prose` renders whatever it is handed through
      // `dangerouslySetInnerHTML`, so an empty body must be absent and not
      // falsy-but-present: the route tests for it to decide between the prose
      // and the "being prepared" panel.
      await insertPage({ slug: "about", body: null });

      const page = await getPage("about");
      expect(page).not.toBeNull();
      expect(page?.bodyEn).toBeUndefined();
    });

    it("omits the banner when none is chosen", async () => {
      await insertPage({ slug: "about" });

      expect((await getPage("about"))?.heroImage).toBeUndefined();
    });

    it("reads the banner's alt text and caption from the media library", async () => {
      // Alt text lives on `media_assets` and nowhere else, so the same
      // photograph cannot be described two different ways on two pages.
      await insertPage({ slug: "about", withBanner: true });

      const banner = (await getPage("about"))?.heroImage;
      expect(banner?.src).toBe("/photos/about.jpg");
      expect(banner?.altEn).toBe("Members at the chamber.");
      expect(banner?.caption).toBe("On the steps.");
      expect(banner?.width).toBe(1600);
      expect(banner?.height).toBe(900);
    });

    it("carries the SEO overrides through", async () => {
      await insertPage({
        slug: "about",
        title: "About the chamber",
        seoTitle: "About LCCI",
        seoDescription: "Who we are.",
      });

      const page = await getPage("about");
      expect(page?.titleEn).toBe("About the chamber");
      expect(page?.seoTitle).toBe("About LCCI");
      expect(page?.seoDescription).toBe("Who we are.");
    });

    it("reads an Urdu body back without touching the English one", async () => {
      await insertPage({ slug: "about", bodyUr: "<p>اردو</p>" });

      const page = await getPage("about");
      expect(page?.bodyEn).toBe("<p>The body.</p>");
      expect(page?.bodyUr).toBe("<p>اردو</p>");
    });
  });
});
