import { cn } from "@/lib/cn";
import type { ContentKind, ContentStatus } from "@/db/schema";

/**
 * The content workflow badge.
 *
 * The same four token pairs as `status-pill.tsx`, measured against the real
 * palette rather than reached for by eye, and the same rule: the colour is
 * never the only signal. Every pill carries its word, because a content queue
 * is read in a printout as often as on screen and a hue is nothing on paper.
 *
 * Four statuses, not twelve. `in_review` and `published` look close together
 * here on purpose — they are the two an editor scans for — while `archived`
 * deliberately recedes, since an archived item is still reachable at its URL
 * and will outnumber everything else once roughly 890 legacy press releases
 * are imported.
 */
const STYLES: Record<ContentStatus, { label: string; className: string }> = {
  draft: {
    label: "Draft",
    className: "border-stone-300 bg-stone-100 text-ink-700",
  },
  in_review: {
    label: "In review",
    className: "border-brand-600/40 bg-brand-50 text-brand-800",
  },
  published: {
    label: "Published",
    className: "border-success-700/50 bg-success-100 text-success-900",
  },
  archived: {
    label: "Archived",
    className: "border-ink-300 bg-ink-50 text-ink-800",
  },
};

export function ContentStatusPill({ status }: { status: ContentStatus }) {
  const style = STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[0.75rem] font-medium whitespace-nowrap",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

export function contentStatusLabel(status: ContentStatus): string {
  return STYLES[status].label;
}

/**
 * What a published item is actually doing right now.
 *
 * `published` is not the same as visible: the status says an editor finished
 * with it, the three-part live predicate says whether a visitor can see it. An
 * embargoed release and a retired notice are both `published` and neither is
 * on the site, and an editor looking for "why is this not showing" needs that
 * distinction on the row rather than in a help page.
 */
export function visibilityNote(item: {
  status: ContentStatus;
  contentType: ContentKind;
  isLive: boolean;
  publishedAt: Date | null;
  scheduledUnpublishAt: Date | null;
  typeWindow?: { startsAt: Date | null; endsAt: Date | null };
}): string | null {
  if (item.status !== "published") return null;

  const now = new Date();

  // The parent predicate first: publication date and scheduled unpublish
  // govern every type, and a row excluded by them is not showing whatever its
  // own dates say.
  if (!item.isLive) {
    if (item.publishedAt && item.publishedAt > now) return "Scheduled, not yet showing";
    return "No longer showing";
  }

  // Then the two types whose satellites carry their own window. Without this a
  // notice whose run finished last month is indistinguishable from the live
  // one — which is how the old site kept a notice up for months.
  const window = item.typeWindow;
  if (window) {
    if (item.contentType === "notice") {
      if (window.endsAt && window.endsAt <= now) return "Finished, no longer showing";
      if (window.startsAt && window.startsAt > now) return "Not showing yet";
      return "Showing on every page";
    }
    if (item.contentType === "event" && window.startsAt && window.startsAt <= now) {
      return "Date has passed, off the upcoming list";
    }
  }

  return item.scheduledUnpublishAt ? "Live, until the take-down date" : null;
}
