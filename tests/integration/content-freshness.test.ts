import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { ForbiddenError, type ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import { permissionsForRole } from "@/server/permissions";
import { createContentItem } from "@/content/admin";
import { staleContent } from "@/content/freshness";
import { createUser, databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * The stale-content report against a real database.
 *
 * `tests/content-freshness.test.ts` pins the priority order, which is pure.
 * What can only be tested here is the half written in SQL: that the `WHERE`
 * clause finds every row the classifier would catch and no row it would
 * clear, that drafts are excluded in the statement rather than filtered after,
 * and that a department-scoped editor's report is narrowed by a predicate.
 *
 * The two halves are deliberately written in two languages and have to agree.
 * A row the query returns and the classifier clears is dropped silently, so
 * the counting tests below are the only thing that would notice.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping content freshness tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  await teardown();
});

const TABLES = ["content_item_topics", "content_press_releases", "content_items"];

const NOW = new Date("2026-10-29T09:00:00.000Z");

let editorId = 0;

beforeEach(async () => {
  if (!available) return;
  await resetTables(TABLES);
  editorId = await createUser(`fresh-${newUlid()}@lcci.test`, "staff", "E. Editor");
});

function actor(
  permissions: readonly PermissionCode[],
  departmentScopes: readonly string[] = [],
): ActorContext {
  return {
    userId: editorId,
    userType: "staff",
    roleCode: "content_editor",
    roleCodes: ["content_editor"],
    permissions: new Set(permissions),
    departmentScopes,
    requestId: newUlid(),
    ipHash: null,
    userAgentHash: null,
    onBehalfOfUserId: null,
  };
}

/** The whole chamber, which is what a reviewer or an administrator holds. */
function reviewer(): ActorContext {
  return actor(permissionsForRole("reviewer"));
}

/** Scoped, which is what a department editor holds. */
function scoped(...departments: string[]): ActorContext {
  return actor(permissionsForRole("reviewer"), departments);
}

interface Dates {
  readonly status?: "draft" | "in_review" | "published" | "archived";
  readonly publishedAt?: Date | null;
  readonly lastReviewedAt?: Date | null;
  readonly reviewBy?: string | null;
  readonly scheduledUnpublishAt?: Date | null;
}

/**
 * A row with the dates the report reads, set directly.
 *
 * Written with an `UPDATE` rather than by driving the workflow, because every
 * date here is in the past and the workflow stamps the present — there is no
 * sequence of real transitions that produces a page published in 2019.
 */
async function anItem(
  slug: string,
  department: string,
  dates: Dates = {},
): Promise<number> {
  // An administrator, because `reviewer` holds no `content.create` — the role
  // that reads this report is not the role that writes the site.
  const author = actor(permissionsForRole("super_admin"), [department]);

  const saved = await createContentItem(author, "press_release", {
    slug,
    title_en: `Release ${slug}`,
    department_code: department,
    summary: "A release, for the freshness report to judge.",
  });

  await getDb()
    .updateTable("content_items")
    .set({
      status: dates.status ?? "published",
      published_at: dates.publishedAt ?? NOW,
      last_reviewed_at: dates.lastReviewedAt ?? null,
      review_by: dates.reviewBy ?? null,
      scheduled_unpublish_at: dates.scheduledUnpublishAt ?? null,
    })
    .where("id", "=", saved.id)
    .execute();

  return saved.id;
}

const TWO_YEARS_AGO = new Date("2024-09-01T06:00:00.000Z");
const LAST_MONTH = new Date("2026-09-20T06:00:00.000Z");

describe.skipIf(!available)("what the report finds", () => {
  it("leaves a recently published page out of it", async () => {
    await anItem("fresh-release", "info", { publishedAt: LAST_MONTH });
    expect(await staleContent(reviewer(), NOW)).toEqual([]);
  });

  it("finds a page published two years ago and never reviewed", async () => {
    const id = await anItem("old-release", "info", { publishedAt: TWO_YEARS_AGO });

    const items = await staleContent(reviewer(), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe(id);
    expect(items[0]!.reason).toBe("not_reviewed_in_a_year");
    expect(items[0]!.lastTouchedAt).toEqual(TWO_YEARS_AGO);
    // The join is carried, so the report names the department rather than its
    // code: "Information" is what an editor recognises.
    expect(items[0]!.departmentName.length).toBeGreaterThan(0);
  });

  it("leaves an old page alone once somebody has reviewed it", async () => {
    await anItem("reviewed-release", "info", {
      publishedAt: TWO_YEARS_AGO,
      lastReviewedAt: LAST_MONTH,
    });
    expect(await staleContent(reviewer(), NOW)).toEqual([]);
  });

  it("finds a page whose review date has arrived", async () => {
    await anItem("due-release", "info", {
      publishedAt: LAST_MONTH,
      reviewBy: "2026-10-01",
    });

    const items = await staleContent(reviewer(), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toBe("due_for_review");
    expect(items[0]!.reviewBy).toBe("2026-10-01");
  });

  it("finds a page sitting past its own take-down time", async () => {
    await anItem("expired-notice", "info", {
      publishedAt: LAST_MONTH,
      scheduledUnpublishAt: new Date("2026-10-10T06:00:00.000Z"),
    });

    const items = await staleContent(reviewer(), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toBe("taken_down_by_schedule");
  });

  it("leaves a take-down still in the future alone", async () => {
    await anItem("scheduled-notice", "info", {
      publishedAt: LAST_MONTH,
      scheduledUnpublishAt: new Date("2026-12-01T06:00:00.000Z"),
    });
    expect(await staleContent(reviewer(), NOW)).toEqual([]);
  });

  /**
   * The exclusion that keeps the report usable. A draft abandoned in 2024 is
   * somebody's unfinished work, not a page the public is reading, and the two
   * kinds in one list means the second kind is never seen.
   */
  it("ignores everything that is not published, however old", async () => {
    for (const status of ["draft", "in_review", "archived"] as const) {
      await anItem(`old-${status.replace("_", "-")}`, "info", {
        status,
        publishedAt: TWO_YEARS_AGO,
        reviewBy: "2025-01-01",
      });
    }

    expect(await staleContent(reviewer(), NOW)).toEqual([]);
  });

  it("puts the take-downs first and the oldest first within a group", async () => {
    await anItem("stale-older", "info", {
      publishedAt: new Date("2023-01-01T06:00:00.000Z"),
    });
    await anItem("stale-newer", "info", {
      publishedAt: new Date("2025-01-01T06:00:00.000Z"),
    });
    await anItem("down", "info", {
      publishedAt: LAST_MONTH,
      scheduledUnpublishAt: new Date("2026-10-10T06:00:00.000Z"),
    });

    const items = await staleContent(reviewer(), NOW);
    expect(items.map((item) => item.slug)).toEqual([
      "down",
      "stale-older",
      "stale-newer",
    ]);
  });
});

describe.skipIf(!available)("department scope", () => {
  it("narrows the report to the departments the editor covers", async () => {
    await anItem("info-release", "info", { publishedAt: TWO_YEARS_AGO });
    await anItem("research-release", "research", { publishedAt: TWO_YEARS_AGO });

    const mine = await staleContent(scoped("info"), NOW);
    expect(mine.map((item) => item.slug)).toEqual(["info-release"]);

    // And the row is really there — the test above would also pass if nothing
    // had been written.
    const all = await staleContent(reviewer(), NOW);
    expect(all).toHaveLength(2);
  });

  it("treats an empty scope list as the whole chamber", async () => {
    await anItem("info-release", "info", { publishedAt: TWO_YEARS_AGO });
    await anItem("research-release", "research", { publishedAt: TWO_YEARS_AGO });

    expect(await staleContent(reviewer(), NOW)).toHaveLength(2);
  });
});

describe.skipIf(!available)("who may read it", () => {
  it("refuses an actor without the draft-reading grant", async () => {
    await anItem("info-release", "info", { publishedAt: TWO_YEARS_AGO });

    // A cashier: a real staff account, with no content grant at all.
    await expect(staleContent(actor(permissionsForRole("cashier")), NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
