import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { JOB_HANDLERS, type JobContext } from "@/server/jobs/registry";
import { revalidateCalls } from "../stubs/next-cache";
import { databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * The job that keeps a prerendered site honest about scheduled dates.
 *
 * Whether an item is public is decided in SQL on every read, so the database
 * is already right the moment a scheduled instant passes. What this job exists
 * for is the prerendered HTML, and the only logic it has is the question "did
 * anything cross a boundary since I last looked" — a window, a cursor, and one
 * decision about whether to revalidate at all.
 *
 * `revalidatePath` itself is stubbed, because it needs a request context and
 * the real caller is a route handler. See `tests/stubs/next-cache.ts`. What is
 * asserted here is everything up to and including *whether it was called*,
 * which is the whole of the job's judgement.
 *
 * The handler reads the real clock, so every fixture below is placed relative
 * to `Date.now()` rather than to a fixed instant.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping content revalidate tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  await teardown();
});

const TABLES = ["content_item_topics", "content_press_releases", "content_items"];

const job = JOB_HANDLERS["content-revalidate"];

const MINUTE = 60 * 1000;

beforeEach(async () => {
  if (!available) return;
  await resetTables(TABLES);
  revalidateCalls.length = 0;
});

function context(lastSummary: Record<string, unknown> | null = null): JobContext {
  return {
    runId: newUlid(),
    deadline: Date.now() + 30_000,
    lastSummary,
    heartbeat: async () => {},
  };
}

/** Straight into the table: the job reads columns, not the editorial workflow. */
async function item(
  slug: string,
  dates: { publishedAt: Date | null; scheduledUnpublishAt?: Date | null; status?: "published" | "draft" },
): Promise<void> {
  await getDb()
    .insertInto("content_items")
    .values({
      content_type: "press_release",
      slug,
      title_en: `Release ${slug}`,
      status: dates.status ?? "published",
      department_code: "info",
      published_at: dates.publishedAt,
      scheduled_unpublish_at: dates.scheduledUnpublishAt ?? null,
    })
    .execute();
}

/** A cursor as the previous run would have left it. */
function checkedThrough(at: Date): Record<string, unknown> {
  return { checkedThrough: at.toISOString(), revalidated: false, windowFrom: at.toISOString() };
}

describe.skipIf(!available)("deciding whether anything changed", () => {
  it("does nothing when no scheduled instant has passed", async () => {
    await item("quiet", { publishedAt: new Date(Date.now() - 48 * 60 * MINUTE) });

    const result = await job(context(checkedThrough(new Date(Date.now() - 10 * MINUTE))));

    expect(result.processed).toBe(0);
    expect(result.detail?.revalidated).toBe(false);
    expect(revalidateCalls).toEqual([]);
  });

  it("revalidates when a publication date came due inside the window", async () => {
    await item("just-published", { publishedAt: new Date(Date.now() - 5 * MINUTE) });

    const result = await job(context(checkedThrough(new Date(Date.now() - 10 * MINUTE))));

    expect(result.processed).toBe(1);
    expect(result.detail?.revalidated).toBe(true);
    // The whole tree, which is what the editor's own save path does: the
    // homepage renders ten of the twelve content types.
    expect(revalidateCalls).toEqual([{ path: "/", type: "layout" }]);
  });

  it("revalidates when a take-down time came due inside the window", async () => {
    await item("just-expired", {
      publishedAt: new Date(Date.now() - 48 * 60 * MINUTE),
      scheduledUnpublishAt: new Date(Date.now() - 5 * MINUTE),
    });

    const result = await job(context(checkedThrough(new Date(Date.now() - 10 * MINUTE))));

    expect(result.processed).toBe(1);
    expect(revalidateCalls).toHaveLength(1);
  });

  /**
   * The case that would make the job useless in the other direction. An item
   * scheduled for next week must not trigger a rebuild every ten minutes until
   * it arrives.
   */
  it("ignores a publication date still in the future", async () => {
    await item("next-week", { publishedAt: new Date(Date.now() + 7 * 24 * 60 * MINUTE) });

    const result = await job(context(checkedThrough(new Date(Date.now() - 10 * MINUTE))));

    expect(result.processed).toBe(0);
    expect(revalidateCalls).toEqual([]);
  });

  it("ignores a draft whose publication date has passed", async () => {
    // Taken off the site by hand; `published_at` is kept so republishing does
    // not re-date it. Nothing crossed a boundary.
    await item("unpublished", {
      status: "draft",
      publishedAt: new Date(Date.now() - 5 * MINUTE),
    });

    expect((await job(context(checkedThrough(new Date(Date.now() - 10 * MINUTE))))).processed).toBe(0);
  });
});

describe.skipIf(!available)("the cursor", () => {
  it("does not revalidate the same crossing twice", async () => {
    await item("just-published", { publishedAt: new Date(Date.now() - 5 * MINUTE) });

    const first = await job(context(checkedThrough(new Date(Date.now() - 10 * MINUTE))));
    expect(first.processed).toBe(1);

    // The second tick starts where the first finished, which is what
    // `job_runs.last_summary` hands back.
    const second = await job(context(first.detail as Record<string, unknown>));

    expect(second.processed).toBe(0);
    expect(revalidateCalls).toHaveLength(1);
  });

  it("covers the missed window when a tick does not happen", async () => {
    await item("published-an-hour-into-the-gap", {
      publishedAt: new Date(Date.now() - 90 * MINUTE),
    });

    // Three hours since the last successful run: the crossing is inside the
    // gap, and a job that only looked at the last ten minutes would miss it
    // for ever.
    const result = await job(context(checkedThrough(new Date(Date.now() - 180 * MINUTE))));

    expect(result.processed).toBe(1);
  });

  it("looks back an hour when there is no cursor at all", async () => {
    await item("recent", { publishedAt: new Date(Date.now() - 30 * MINUTE) });
    await item("older", { publishedAt: new Date(Date.now() - 300 * MINUTE) });

    const result = await job(context(null));

    // The first run ever, and any run after the cursor is lost. An hour is six
    // intervals — enough to cover a restart, and far short of revalidating the
    // whole site because a row was published last week.
    expect(result.processed).toBe(1);
  });

  /**
   * `last_summary` is JSON written by a previous version of this code and
   * editable by anyone with database access, so it is read as untrusted.
   * Throwing on it would leave the job dead until somebody cleared the column
   * by hand.
   */
  it("falls back rather than throwing on a cursor it cannot read", async () => {
    await item("recent", { publishedAt: new Date(Date.now() - 30 * MINUTE) });

    for (const summary of [
      { checkedThrough: "not a date" },
      { checkedThrough: null },
      { checkedThrough: 17 },
      {},
    ]) {
      revalidateCalls.length = 0;
      const result = await job(context(summary));
      expect(result.processed, JSON.stringify(summary)).toBe(1);
    }
  });

  it("hands back a cursor the next run can use", async () => {
    const before = Date.now();
    const result = await job(context(null));
    const stamped = new Date(String(result.detail?.checkedThrough)).getTime();

    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);
    expect(result.more).toBe(false);
  });
});
