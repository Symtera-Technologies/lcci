import { describe, expect, it } from "vitest";
import {
  FRESHNESS_REASON_LABELS,
  classifyFreshness,
  todayInLahore,
  type FreshnessFacts,
} from "@/content/freshness";
import { CONTENT_KINDS } from "@/content/fields";

/**
 * The half of the stale-content report that needs no database.
 *
 * `classifyFreshness` is the priority order; the `WHERE` clause beside it in
 * `freshness.ts` is the union of the same three conditions, and the two have
 * to agree. This file pins the order and the boundaries; the integration test
 * pins the agreement, because only a real query can disagree.
 */

const NOW = new Date("2026-10-29T09:00:00.000Z");

function facts(overrides: Partial<FreshnessFacts> = {}): FreshnessFacts {
  return {
    reviewBy: null,
    scheduledUnpublishAt: null,
    lastReviewedAt: null,
    publishedAt: null,
    ...overrides,
  };
}

describe("what counts as needing a look", () => {
  it("clears a page published last week and never reviewed", () => {
    const verdict = classifyFreshness(
      facts({ publishedAt: new Date("2026-10-20T06:00:00.000Z") }),
      NOW,
    );
    expect(verdict.reason).toBeNull();
  });

  it("catches a page published more than a year ago and never reviewed", () => {
    const verdict = classifyFreshness(
      facts({ publishedAt: new Date("2025-06-01T06:00:00.000Z") }),
      NOW,
    );
    expect(verdict.reason).toBe("not_reviewed_in_a_year");
    expect(verdict.lastTouchedAt).toEqual(new Date("2025-06-01T06:00:00.000Z"));
  });

  /**
   * The point of reading `last_reviewed_at` at all. A 2019 release that a
   * reviewer confirmed last month is not stale, and a report that said
   * otherwise would send somebody to re-read a page that had just been read.
   */
  it("counts a recent review, not the publication date, as the check", () => {
    const verdict = classifyFreshness(
      facts({
        publishedAt: new Date("2019-03-02T06:00:00.000Z"),
        lastReviewedAt: new Date("2026-09-15T06:00:00.000Z"),
      }),
      NOW,
    );
    expect(verdict.reason).toBeNull();
    expect(verdict.lastTouchedAt).toEqual(new Date("2026-09-15T06:00:00.000Z"));
  });

  it("counts a stale review as stale even when it was published later", () => {
    // Republished after correction, but nobody has reviewed it since 2024.
    const verdict = classifyFreshness(
      facts({
        publishedAt: new Date("2026-08-01T06:00:00.000Z"),
        lastReviewedAt: new Date("2024-08-01T06:00:00.000Z"),
      }),
      NOW,
    );
    expect(verdict.reason).toBe("not_reviewed_in_a_year");
  });

  it("takes twelve months as the line, to the day", () => {
    // One day inside the window clears; one day outside does not. The spec
    // words it as "12 months", so the boundary is calendar months rather than
    // 365 days — a leap year must not move it.
    const inside = classifyFreshness(
      facts({ publishedAt: new Date("2025-10-30T09:00:00.000Z") }),
      NOW,
    );
    const outside = classifyFreshness(
      facts({ publishedAt: new Date("2025-10-28T09:00:00.000Z") }),
      NOW,
    );

    expect(inside.reason).toBeNull();
    expect(outside.reason).toBe("not_reviewed_in_a_year");
  });

  it("catches a review date that has arrived, and clears one still ahead", () => {
    expect(classifyFreshness(facts({ reviewBy: "2026-10-29" }), NOW).reason).toBe(
      "due_for_review",
    );
    expect(classifyFreshness(facts({ reviewBy: "2026-10-28" }), NOW).reason).toBe(
      "due_for_review",
    );
    expect(classifyFreshness(facts({ reviewBy: "2026-10-30" }), NOW).reason).toBeNull();
  });

  it("catches a take-down time that has passed", () => {
    expect(
      classifyFreshness(
        facts({
          publishedAt: new Date("2026-10-01T06:00:00.000Z"),
          scheduledUnpublishAt: new Date("2026-10-28T06:00:00.000Z"),
        }),
        NOW,
      ).reason,
    ).toBe("taken_down_by_schedule");
  });

  it("leaves a take-down still in the future alone", () => {
    expect(
      classifyFreshness(
        facts({
          publishedAt: new Date("2026-10-01T06:00:00.000Z"),
          scheduledUnpublishAt: new Date("2026-11-30T06:00:00.000Z"),
        }),
        NOW,
      ).reason,
    ).toBeNull();
  });
});

describe("the priority order", () => {
  /**
   * All three true at once, which is the common case for something nobody has
   * touched: the one that gets reported is the one that is actually wrong with
   * the site right now.
   */
  it("reports the take-down above the review date and the year", () => {
    const verdict = classifyFreshness(
      facts({
        publishedAt: new Date("2023-01-01T06:00:00.000Z"),
        reviewBy: "2025-01-01",
        scheduledUnpublishAt: new Date("2026-02-01T06:00:00.000Z"),
      }),
      NOW,
    );
    expect(verdict.reason).toBe("taken_down_by_schedule");
  });

  it("reports the editor's own date above the blanket year", () => {
    const verdict = classifyFreshness(
      facts({
        publishedAt: new Date("2023-01-01T06:00:00.000Z"),
        reviewBy: "2026-03-01",
      }),
      NOW,
    );
    expect(verdict.reason).toBe("due_for_review");
  });
});

describe("the chamber's own day", () => {
  /**
   * A `review_by` of today must be due from the first minute of the Lahore
   * day, not from five in the morning. The failure this prevents is small and
   * permanent: every review date in the system lands a day late for the first
   * five hours of its day, which nobody would ever report as a bug.
   */
  it("reads a Lahore date as due before UTC has reached it", () => {
    // 02:00 in Lahore on 30 October is still 21:00 UTC on the 29th.
    const earlyMorning = new Date("2026-10-29T21:00:00.000Z");

    expect(todayInLahore(earlyMorning)).toBe("2026-10-30");
    expect(
      classifyFreshness(facts({ reviewBy: "2026-10-30" }), earlyMorning).reason,
    ).toBe("due_for_review");
  });

  it("formats the day as the plain date MySQL hands back", () => {
    // `dateStrings: ['DATE']` means `review_by` arrives as "YYYY-MM-DD" and is
    // compared as a string. A different format here would compare unequal
    // shapes and silently never match.
    expect(todayInLahore(NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("the report's own route", () => {
  /**
   * `/admin/content/review` is a static segment beside `/admin/content/[type]`.
   * Next resolves static before dynamic, so a content type named "review"
   * would become unreachable — its list would silently render this report
   * instead, and the only symptom would be an editor saying the screen looks
   * wrong.
   */
  it("does not collide with a content type", () => {
    expect(CONTENT_KINDS as readonly string[]).not.toContain("review");
  });
});

describe("the labels", () => {
  it("names every reason in words an editor would use", () => {
    for (const [reason, label] of Object.entries(FRESHNESS_REASON_LABELS)) {
      expect(label.length, reason).toBeGreaterThan(5);
      expect(label, reason).not.toMatch(/_/);
    }
  });
});
