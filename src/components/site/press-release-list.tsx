import Link from "next/link";
import Image from "next/image";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import type { PressRelease } from "@/content/types";
import { Tag, TOPIC_LABELS } from "@/components/ui/tag";
import { formatDate } from "@/lib/format";

/**
 * The press archive, as a list.
 *
 * **Not a card grid**, which is the one deliberate departure from the rest of
 * the site's surfaces. A chamber's press releases are a chronological record
 * and the useful question of them is "what has happened, in what order" — a
 * grid answers "which of these appeals to me", which is the wrong question and
 * gives every item the same weight regardless of when it was published. The
 * date leads each row for the same reason.
 *
 * One photograph per row where there is one, small and to the side, because
 * the legacy site has no press photography at all: most of these rows will not
 * have an image for a long time, and a layout that reserves a large one would
 * leave the archive looking broken rather than looking plain.
 */

/**
 * Press releases per page.
 *
 * Shared by the index route, the `page/[n]` route and that route's
 * `generateStaticParams`, because all three have to agree: a different number
 * in any one of them prerenders a set of pages that either skips releases or
 * repeats them, and nothing would report it.
 */
export const PRESS_RELEASES_PER_PAGE = 24;

const ROW =
  "group flex gap-5 border-b border-stone-200 py-6 first:pt-0 " +
  "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-700";

export function PressReleaseList({ items }: { items: readonly PressRelease[] }) {
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          <Link href={`/news/press-releases/${item.slug}`} className={ROW}>
            {item.heroImage ? (
              <span className="relative hidden h-24 w-36 shrink-0 overflow-hidden rounded-lg bg-stone-100 ring-1 ring-inset ring-stone-200 sm:block">
                <Image
                  src={item.heroImage.src}
                  alt={item.heroImage.altEn}
                  fill
                  sizes="9rem"
                  className="object-cover"
                />
              </span>
            ) : null}

            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {/* `dateTime` carries the instant; the visible string is
                    Karachi time, pinned in `formatDate`, so a reader abroad
                    never sees the chamber's Tuesday as a Monday. */}
                <time
                  dateTime={item.publishedAt}
                  className="text-[0.8125rem] font-medium uppercase tracking-wide text-ink-600"
                >
                  {formatDate(item.publishedAt)}
                </time>
                {item.topics.map((topic) => (
                  <Tag key={topic} tone="clay">
                    {TOPIC_LABELS[topic]}
                  </Tag>
                ))}
              </span>

              <span className="mt-2 flex items-start justify-between gap-4">
                <span className="font-display text-lg font-semibold leading-snug text-ink-950 transition-colors group-hover:text-brand-800">
                  {item.titleEn}
                </span>
                <ArrowRight
                  aria-hidden
                  className="mt-1.5 h-4 w-4 shrink-0 text-brand-600 transition-transform duration-300 ease-out-expo motion-safe:group-hover:translate-x-1"
                />
              </span>

              <span className="mt-2 block max-w-[68ch] text-[0.9375rem] leading-relaxed text-ink-700">
                {item.summary}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Previous and next, and nothing else.
 *
 * No numbered pages. The archive runs to ~895 items once the legacy press
 * releases are imported, which is 38 pages — a row of 38 numbers is unusable,
 * and the usual answer, an elided range, is a lot of arithmetic for a reader
 * who is either reading backwards from today or arrived from a search engine
 * at one release. The page count is stated in words instead, so the reader
 * knows how deep the archive goes without being asked to navigate it by
 * number.
 *
 * Real links, not buttons: every page of this is prerendered at its own URL,
 * so these work with JavaScript off, can be opened in a new tab, and are what
 * a crawler follows to reach the whole archive.
 */
export function PressReleasePager({
  page,
  pageCount,
  total,
}: {
  page: number;
  pageCount: number;
  total: number;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label="Press release archive"
      className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-stone-200 pt-6"
    >
      <p className="text-[0.9375rem] text-ink-700">
        Page {page} of {pageCount}
        <span className="text-ink-600"> — {total} press releases in all</span>
      </p>

      <div className="flex items-center gap-2">
        <PagerLink page={page - 1} disabled={page <= 1} direction="prev" />
        <PagerLink page={page + 1} disabled={page >= pageCount} direction="next" />
      </div>
    </nav>
  );
}

const PAGER =
  "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[0.9375rem] font-medium " +
  "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700";

function PagerLink({
  page,
  disabled,
  direction,
}: {
  page: number;
  disabled: boolean;
  direction: "prev" | "next";
}) {
  const label = direction === "prev" ? "Newer" : "Older";
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;

  if (disabled) {
    // Rendered rather than omitted, so the pair does not move between pages,
    // and as plain text rather than a disabled link — `aria-disabled` on an
    // anchor still lets a keyboard reach and follow it.
    return (
      <span className={`${PAGER} border-stone-200 text-ink-500`} aria-hidden>
        {direction === "prev" ? <Icon className="h-4 w-4" /> : null}
        {label}
        {direction === "next" ? <Icon className="h-4 w-4" /> : null}
      </span>
    );
  }

  return (
    <Link
      href={pressReleasePageHref(page)}
      rel={direction === "prev" ? "prev" : "next"}
      className={`${PAGER} border-brand-300 text-brand-800 hover:border-brand-500 hover:bg-brand-50`}
    >
      {direction === "prev" ? <Icon className="h-4 w-4" aria-hidden /> : null}
      {label}
      {direction === "next" ? <Icon className="h-4 w-4" aria-hidden /> : null}
    </Link>
  );
}

/**
 * Page 1 is `/news/press-releases`, not `/news/press-releases/page/1`.
 *
 * Two URLs for one page of content is a duplicate a search engine has to pick
 * between, and the one it picks is not necessarily the one the navigation
 * links to. So the first page has exactly one address, and `page/[n]`'s own
 * `generateStaticParams` starts at 2.
 */
export function pressReleasePageHref(page: number): `/${string}` {
  return page <= 1 ? "/news/press-releases" : `/news/press-releases/page/${page}`;
}
