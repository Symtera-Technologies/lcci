import "server-only";

import { getDb } from "@/db/client";
import type { ContentKind, ContentStatus } from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { requirePermission } from "@/server/actor";

/**
 * What on the site has stopped being looked after.
 *
 * §8.3 commits to a report of "stale content not updated in 12 months", and
 * that sentence alone would make a thin report: a committee page that has been
 * correct for two years is not stale, and a notice that expired on Tuesday is
 * a problem the same week. So three questions are asked rather than one, and
 * each row says which one caught it.
 *
 * **Everything here is a published row.** A draft nobody has touched in a year
 * is somebody's abandoned work, not a liability on the public site, and
 * putting both in one list would bury the second kind under the first. Drafts
 * are already visible, and counted, on each type's own screen.
 *
 * **Nothing here is computed from `updated_at`.** That column moves when
 * anybody saves anything, including fixing a typo in a search description, so
 * a report keyed on it says a page was "checked" when nobody read a word of
 * it. The question is when somebody last took responsibility for the content
 * being right, which is `last_reviewed_at` — written by the editorial
 * workflow when a reviewer publishes or sends back — falling back to the
 * publication date for everything that went up before anybody reviewed
 * anything.
 */

/** Twelve months, as §8.3 words it. */
const STALE_AFTER_MONTHS = 12;

export type FreshnessReason =
  /** The editor set a date to check this by, and it has passed. */
  | "due_for_review"
  /** Nobody has taken responsibility for it within the §8.3 window. */
  | "not_reviewed_in_a_year"
  /** Its scheduled take-down passed, so it is invisible but still `published`. */
  | "taken_down_by_schedule";

export const FRESHNESS_REASON_LABELS: Record<FreshnessReason, string> = {
  due_for_review: "Due for a check",
  not_reviewed_in_a_year: "Not checked in a year",
  taken_down_by_schedule: "Came down on schedule",
};

export interface StaleItem {
  readonly id: number;
  readonly contentType: ContentKind;
  readonly slug: string;
  readonly titleEn: string;
  readonly status: ContentStatus;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly publishedAt: Date | null;
  /** Civil date: "check this by", not an instant anybody schedules against. */
  readonly reviewBy: string | null;
  readonly scheduledUnpublishAt: Date | null;
  /** When somebody last took responsibility, or the publication date. */
  readonly lastTouchedAt: Date | null;
  readonly reason: FreshnessReason;
}

function monthsAgo(from: Date, months: number): Date {
  const date = new Date(from);
  date.setMonth(date.getMonth() - months);
  return date;
}

/** The dates a freshness decision is made from, in the shape the row has. */
export interface FreshnessFacts {
  readonly reviewBy: string | null;
  readonly scheduledUnpublishAt: Date | null;
  readonly lastReviewedAt: Date | null;
  readonly publishedAt: Date | null;
}

export interface FreshnessVerdict {
  /** `null` when nothing is wrong with it. */
  readonly reason: FreshnessReason | null;
  /** When somebody last took responsibility, or the publication date. */
  readonly lastTouchedAt: Date | null;
}

/**
 * Which of the three questions catches this row, if any.
 *
 * Exported because it is the half of the report that can be tested without a
 * database, and because the `WHERE` clause below is a *union* of the same
 * three conditions while this is a *priority order* over them — two things
 * that have to agree and are written in two languages. A row the query finds
 * and this function clears is a disagreement between them.
 *
 * Ordered by how much it matters rather than by how it was found. Something
 * already off the site outranks something due a check, and an explicit date
 * the editor chose outranks the blanket twelve months — the editor who set
 * "check by March" knows something the default does not.
 */
export function classifyFreshness(
  facts: FreshnessFacts,
  now: Date = new Date(),
): FreshnessVerdict {
  const lastTouchedAt = facts.lastReviewedAt ?? facts.publishedAt;
  const today = todayInLahore(now);
  const threshold = monthsAgo(now, STALE_AFTER_MONTHS);

  if (facts.scheduledUnpublishAt !== null && facts.scheduledUnpublishAt <= now) {
    return { reason: "taken_down_by_schedule", lastTouchedAt };
  }
  if (facts.reviewBy !== null && facts.reviewBy <= today) {
    return { reason: "due_for_review", lastTouchedAt };
  }
  if (lastTouchedAt !== null && lastTouchedAt < threshold) {
    return { reason: "not_reviewed_in_a_year", lastTouchedAt };
  }
  return { reason: null, lastTouchedAt };
}

/**
 * `YYYY-MM-DD` in the chamber's own day, not UTC's.
 *
 * `review_by` is a civil date an editor typed, and Lahore is five hours ahead
 * of UTC — so for the first five hours of a Lahore day a UTC "today" is still
 * yesterday, and a page due to be checked today would not appear on the report
 * until the morning was half over.
 */
export function todayInLahore(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export async function staleContent(
  actor: ActorContext,
  now: Date = new Date(),
): Promise<readonly StaleItem[]> {
  requirePermission(actor, "content.read_draft");

  const threshold = monthsAgo(now, STALE_AFTER_MONTHS);
  const today = todayInLahore(now);

  let query = getDb()
    .selectFrom("content_items as ci")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    .select([
      "ci.id",
      "ci.content_type",
      "ci.slug",
      "ci.title_en",
      "ci.status",
      "ci.department_code",
      "ci.published_at",
      "ci.review_by",
      "ci.scheduled_unpublish_at",
      "ci.last_reviewed_at",
      "d.name_en as department_name",
    ])
    .where("ci.status", "=", "published")
    .where((eb) =>
      eb.or([
        // A date the editor chose, now passed.
        eb("ci.review_by", "<=", today),
        // Off the site by its own schedule, and still marked published.
        eb("ci.scheduled_unpublish_at", "<=", now),
        // The §8.3 window, against the later of review and publication.
        eb.and([
          eb("ci.last_reviewed_at", "is not", null),
          eb("ci.last_reviewed_at", "<", threshold),
        ]),
        eb.and([
          eb("ci.last_reviewed_at", "is", null),
          eb("ci.published_at", "is not", null),
          eb("ci.published_at", "<", threshold),
        ]),
      ]),
    );

  // The scope as a predicate, never a filter after the fact: a post-fetch
  // filter has already read the rows and will leak them through the count.
  if (actor.departmentScopes.length > 0) {
    query = query.where("ci.department_code", "in", actor.departmentScopes);
  }

  const rows = await query.execute();

  const items: StaleItem[] = [];
  for (const row of rows) {
    const { reason, lastTouchedAt } = classifyFreshness(
      {
        reviewBy: row.review_by,
        scheduledUnpublishAt: row.scheduled_unpublish_at,
        lastReviewedAt: row.last_reviewed_at,
        publishedAt: row.published_at,
      },
      now,
    );
    // The `WHERE` is deliberately the union of three conditions and the
    // classifier re-asks them in priority order, so a row can match the query
    // and still be classified by a different clause than the one that found
    // it. A row that matches none is a bug in one of the two, and is dropped
    // rather than rendered with an invented reason.
    if (!reason) continue;

    items.push({
      id: row.id,
      contentType: row.content_type,
      slug: row.slug,
      titleEn: row.title_en,
      status: row.status,
      departmentCode: row.department_code,
      departmentName: row.department_name,
      publishedAt: row.published_at,
      reviewBy: row.review_by,
      scheduledUnpublishAt: row.scheduled_unpublish_at,
      lastTouchedAt,
      reason,
    });
  }

  const order: Record<FreshnessReason, number> = {
    taken_down_by_schedule: 0,
    due_for_review: 1,
    not_reviewed_in_a_year: 2,
  };

  return items.sort((a, b) => {
    if (order[a.reason] !== order[b.reason]) return order[a.reason] - order[b.reason];
    // Oldest first within a group: the thing nobody has looked at since 2023
    // is the one to open.
    return (a.lastTouchedAt?.getTime() ?? 0) - (b.lastTouchedAt?.getTime() ?? 0);
  });
}
