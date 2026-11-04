import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import type { EconomicIndicator } from "@/content/types";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * The full set of indicators the Research Department tracks.
 *
 * A table, where the homepage's band is a grid of cells. The homepage shows
 * five figures at a glance; this page is the reference, and the question asked
 * of a reference is "how does this one compare to that one" — which means the
 * values have to line up in a column. `tabular-nums` is what makes them line
 * up to the digit.
 *
 * **Every row carries its source and the date the figure is current to.** That
 * is not decoration: what discredited the legacy site's economic analysis was
 * not the numbers but that a 2015 survey sat on the page with nothing to say
 * how old it was. `updatedAt` is `measured_at` — the date the *figure* is
 * current to, not the row's last edit — so correcting a typo cannot make it
 * look as though the State Bank republished its reserves.
 *
 * Colour follows whether a move is good news rather than which way it went:
 * falling inflation is good, falling exports are not. `goodWhen` carries that
 * per indicator, and the arrow and the sign state the direction in a second
 * channel, so nothing here is encoded by colour alone.
 */

const TH =
  "px-4 py-3 text-left text-[0.75rem] font-semibold uppercase tracking-wide text-ink-600";
const TD = "px-4 py-4 align-top text-ink-800";

export function IndicatorTable({ items }: { items: readonly EconomicIndicator[] }) {
  if (items.length === 0) return null;

  return (
    // Scrolls rather than wraps on a narrow screen: a five-column table of
    // figures that reflows stops being a table, and the only column a reader
    // can afford to lose sight of is the last one.
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[34rem] border-collapse text-[0.9375rem]">
        <caption className="sr-only">
          Economic indicators tracked by the LCCI Research Department, with the
          source and the date each figure is current to.
        </caption>
        <thead>
          <tr className="border-b border-stone-300">
            <th scope="col" className={TH}>
              Indicator
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Latest
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Change
            </th>
            <th scope="col" className={TH}>
              Source
            </th>
            <th scope="col" className={TH}>
              As at
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((indicator) => (
            <Row key={indicator.id} indicator={indicator} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ indicator }: { indicator: EconomicIndicator }) {
  const { changePct, goodWhen } = indicator;
  const rising = (changePct ?? 0) > 0;

  const good =
    goodWhen === "neutral" || changePct === undefined
      ? null
      : goodWhen === "up"
        ? rising
        : !rising;

  const Trend = changePct === undefined ? Minus : rising ? TrendingUp : TrendingDown;

  return (
    <tr className="border-b border-stone-200">
      <th scope="row" className={`${TD} font-medium text-ink-950`}>
        {indicator.labelEn}
      </th>
      <td className={`${TD} text-right font-display text-lg font-semibold tabular-nums text-ink-950`}>
        {indicator.value}
      </td>
      <td className={`${TD} text-right`}>
        {changePct === undefined ? (
          <span className="text-ink-600">&mdash;</span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center gap-1 font-medium tabular-nums",
              // On white: success-700 is 4.76:1, clay-700 5.41:1, ink-700
              // 7.52:1. The 500 weights both fail at this size.
              good === null && "text-ink-700",
              good === true && "text-success-700",
              good === false && "text-clay-700",
            )}
          >
            <Trend className="h-3.5 w-3.5" aria-hidden />
            {rising ? "+" : ""}
            {changePct}%
          </span>
        )}
      </td>
      <td className={`${TD} text-[0.875rem] text-ink-700`}>{indicator.source}</td>
      <td className={`${TD} whitespace-nowrap text-[0.875rem] text-ink-700`}>
        <time dateTime={indicator.updatedAt}>
          {formatDateShort(indicator.updatedAt)}
        </time>
      </td>
    </tr>
  );
}
