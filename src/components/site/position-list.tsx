import type { PolicyPosition } from "@/content/types";
import { PositionStatus, Tag, TOPIC_LABELS } from "@/components/ui/tag";
import { Prose } from "./prose";
import { formatDate } from "@/lib/format";

/**
 * What the chamber is asking for, and where each ask stands.
 *
 * Three parts per position, in this order and always all three: the issue, the
 * chamber's ask, and the status. That shape is the whole argument for having a
 * `policy_position` type rather than writing advocacy as prose — the legacy
 * site's advocacy was press releases, so a reader could see that the chamber
 * had said something and never find out whether anything came of it.
 *
 * **The status is never colour alone.** `PositionStatus` renders the words
 * "Raised", "Under review", "Accepted" or "Resolved" in a tinted pill, so the
 * tint reinforces a label rather than carrying the meaning.
 *
 * Full width and stacked rather than a grid: each of these is an argument to
 * be read, and side-by-side columns would halve the measure of the body copy
 * for no gain.
 */

export function PositionList({ items }: { items: readonly PolicyPosition[] }) {
  return (
    <ul className="space-y-8">
      {items.map((item) => (
        <li
          key={item.id}
          className="rounded-[20px] border border-brand-300 bg-white p-6 shadow-depth-1 sm:p-7"
        >
          <article>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <PositionStatus status={item.positionStatus} />
              {item.topics.map((topic) => (
                <Tag key={topic} tone="clay">
                  {TOPIC_LABELS[topic]}
                </Tag>
              ))}
              <time
                dateTime={item.publishedAt}
                className="text-[0.8125rem] text-ink-600"
              >
                {formatDate(item.publishedAt)}
              </time>
            </div>

            <h3 className="mt-3 max-w-[48ch] font-display text-xl font-semibold leading-snug text-ink-950">
              {item.titleEn}
            </h3>

            <dl className="mt-4 space-y-4">
              <div>
                <dt className="text-[0.8125rem] font-semibold uppercase tracking-wide text-ink-600">
                  The issue
                </dt>
                <dd className="mt-1 max-w-[68ch] leading-relaxed text-ink-800">
                  {item.issue}
                </dd>
              </div>
              <div>
                <dt className="text-[0.8125rem] font-semibold uppercase tracking-wide text-brand-700">
                  What the chamber is asking for
                </dt>
                {/* The one indented quote on the page. An ask is the sentence
                    a reader should be able to find without reading the rest,
                    and an official quoting it back should be able to see
                    exactly where it ends. */}
                <dd className="mt-1 max-w-[68ch] border-l-2 border-brand-400 pl-4 font-medium leading-relaxed text-ink-900">
                  {item.chamberAsk}
                </dd>
              </div>
            </dl>

            {item.bodyEn ? (
              <div className="mt-5 border-t border-stone-200 pt-5">
                <Prose html={item.bodyEn} />
              </div>
            ) : null}
          </article>
        </li>
      ))}
    </ul>
  );
}
