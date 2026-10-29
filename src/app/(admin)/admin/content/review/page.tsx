import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import {
  FRESHNESS_REASON_LABELS,
  staleContent,
  type FreshnessReason,
  type StaleItem,
} from "@/content/freshness";
import { CONTENT_FORMS } from "@/content/fields";
import { formatDateShort } from "@/lib/format";

export const metadata: Metadata = {
  title: "Needs a look",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The stale-content report §8.3 asks for.
 *
 * A static segment sitting beside `/admin/content/[type]`, which is safe
 * because Next resolves a static segment before a dynamic one and no content
 * type is named "review". If one ever is, this page shadows it — so the route
 * test asserts the list of kinds does not contain it.
 *
 * **Grouped by why, and the groups are in order of how much it matters.**
 * Something whose take-down date has passed is already off the site while the
 * database still calls it published, which is a contradiction worth seeing
 * first. A date an editor chose comes next, because they knew something the
 * blanket rule does not. The twelve-month sweep is last and is the longest
 * list, which is exactly why it is not at the top: a report that opens with
 * sixty committee pages nobody has retyped since 2024 trains everybody to
 * close it.
 *
 * **There is no "mark as checked" button here**, and that is deliberate.
 * Taking responsibility for a page being right means opening it, reading it
 * and putting it back through review — which the editorial workflow already
 * records. A button on this screen would let an editor clear the whole report
 * in a minute without reading a word, and the report would then be measuring
 * clicks instead of care.
 */

const ORDER: readonly FreshnessReason[] = [
  "taken_down_by_schedule",
  "due_for_review",
  "not_reviewed_in_a_year",
];

const BLURBS: Record<FreshnessReason, string> = {
  taken_down_by_schedule:
    "The take-down date has passed, so a visitor already cannot see these — but they are still marked published. Take them off the site or give them a new date.",
  due_for_review:
    "An editor set a date to check these by, and it has arrived.",
  not_reviewed_in_a_year:
    "Live for a year or more without anybody taking responsibility for it since. Open it, confirm it is still true, and put it back through review.",
};

/**
 * The last column, which is a different fact per group.
 *
 * There is no date to put against a page caught by the twelve-month sweep —
 * nobody set one, which is why the sweep caught it — so that column carries
 * how long it has been instead. A column reading "Not set" on every row is
 * one more thing to read past before reaching the row that matters.
 */
const COLUMN_HEADS: Record<FreshnessReason, string> = {
  taken_down_by_schedule: "Came down",
  due_for_review: "Due",
  not_reviewed_in_a_year: "Unchecked for",
};

/** Whole months, rounded down: "14 months", not "13.8". */
function monthsBetween(from: Date, to: Date): number {
  const months =
    (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  return to.getDate() < from.getDate() ? months - 1 : months;
}

function age(from: Date, now: Date): string {
  const months = Math.max(monthsBetween(from, now), 0);
  if (months < 24) return `${months} months`;

  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0 ? `${years} years` : `${years} yr ${rest} mo`;
}

export default async function ContentReviewPage() {
  const actor = await requireStaffPage("content.read_draft");
  // One `now` for the query and for the ages rendered beside it, so a row
  // cannot be found by one clock and described by another.
  const now = new Date();
  const items = await staleContent(actor, now);

  const groups = ORDER.map((reason) => ({
    reason,
    items: items.filter((item) => item.reason === reason),
  })).filter((group) => group.items.length > 0);

  return (
    <main className="mx-auto max-w-[72rem] px-5 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="text-[0.875rem]">
        <Link
          href="/admin/content"
          className="text-ink-600 underline decoration-ink-300 underline-offset-4 hover:text-ink-900"
        >
          Content
        </Link>
      </nav>

      <header className="mt-2">
        <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
          Needs a look
        </h1>
        <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-700">
          Everything live on the site that has gone a year without being
          checked, has reached a date somebody set for it, or has quietly
          passed its own take-down time. Drafts are not here — an unfinished
          draft is somebody&rsquo;s work in progress, not a page the public is
          reading.
          {actor.departmentScopes.length > 0 && (
            <>
              {" "}
              You are seeing the{" "}
              {actor.departmentScopes.length === 1 ? "department" : "departments"}{" "}
              you edit for.
            </>
          )}
        </p>
      </header>

      {items.length === 0 ? (
        <p className="mt-8 rounded-lg border border-success-600/40 bg-success-50 px-4 py-6 text-[0.9375rem] text-success-800">
          Nothing is overdue.{" "}
          {/* Scoped or not, the sentence has to be true of what was actually
              looked at. "Every published page" from a screen that queried one
              department is an overclaim, and the reassuring kind. */}
          {actor.departmentScopes.length > 0
            ? "Every published page in your department has been checked within the last year, no review date has passed, and nothing is sitting past its take-down time."
            : "Every published page has been checked within the last year, no review date has passed, and nothing is sitting past its take-down time."}
        </p>
      ) : (
        <>
          <p className="mt-6 text-[0.9375rem] text-ink-700">
            {items.length === 1 ? "One item needs" : `${items.length} items need`} a
            look.
          </p>

          <div className="mt-8 space-y-10">
            {groups.map((group) => (
              <section key={group.reason} aria-labelledby={`group-${group.reason}`}>
                <h2
                  id={`group-${group.reason}`}
                  className="text-[1.0625rem] font-semibold text-ink-950"
                >
                  {FRESHNESS_REASON_LABELS[group.reason]}
                  <span className="ml-2 text-[0.875rem] font-normal tabular-nums text-ink-600">
                    {group.items.length}
                  </span>
                </h2>
                <p className="mt-0.5 max-w-3xl text-[0.875rem] text-ink-600">
                  {BLURBS[group.reason]}
                </p>

                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[44rem] border-collapse text-left">
                    <caption className="sr-only">
                      {FRESHNESS_REASON_LABELS[group.reason]}, longest waiting first
                    </caption>
                    <thead>
                      <tr className="border-b border-stone-300 text-[0.8125rem] text-ink-600">
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Page
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Department
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          Last checked
                        </th>
                        <th scope="col" className="py-2 pr-4 font-medium">
                          {COLUMN_HEADS[group.reason]}
                        </th>
                        <th scope="col" className="py-2 font-medium">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map((item) => (
                        <Row
                          key={`${item.contentType}-${item.id}`}
                          item={item}
                          now={now}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function Row({ item, now }: { item: StaleItem; now: Date }) {
  const form = CONTENT_FORMS[item.contentType];
  const href = `/admin/content/${item.contentType}/${item.id}`;

  // The fact that explains the row, which is a different one per group.
  // `review_by` is a civil date and the take-down is an instant, so neither
  // can be rendered by the other's helper without lying by a few hours.
  const explains =
    item.reason === "taken_down_by_schedule"
      ? item.scheduledUnpublishAt
        ? formatDateShort(item.scheduledUnpublishAt.toISOString())
        : "—"
      : item.reason === "due_for_review"
        ? item.reviewBy
          ? formatDateShort(item.reviewBy)
          : "—"
        : item.lastTouchedAt
          ? age(item.lastTouchedAt, now)
          : "Ever";

  return (
    <tr className="border-b border-stone-200 align-top">
      <td className="py-3 pr-4">
        <Link
          href={href}
          className="text-[0.9375rem] font-medium text-ink-950 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
        >
          {item.titleEn}
        </Link>
        <p className="mt-0.5 text-[0.75rem] text-ink-600">
          {form.singular}
          <span className="text-ink-400"> · </span>
          <span className="font-mono">{item.slug}</span>
        </p>
      </td>
      <td className="py-3 pr-4 text-[0.875rem] text-ink-700">{item.departmentName}</td>
      <td className="py-3 pr-4 text-[0.875rem] whitespace-nowrap text-ink-700">
        {item.lastTouchedAt ? formatDateShort(item.lastTouchedAt.toISOString()) : "Never"}
      </td>
      <td className="py-3 pr-4 text-[0.875rem] whitespace-nowrap text-ink-700">{explains}</td>
      <td className="py-3 text-[0.875rem]">
        <Link
          href={href}
          className="text-brand-800 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Open
        </Link>
      </td>
    </tr>
  );
}
