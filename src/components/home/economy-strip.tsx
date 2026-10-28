import Link from "next/link";
import { ArrowRight, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { getEconomicIndicators } from "@/content/repository";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { EconomicIndicator } from "@/content/types";

/**
 * Economy at a glance — spec §8.1.
 *
 * Each figure carries its source and a "last updated" stamp, because the thing
 * that discredited the legacy site's analysis was not the numbers but that a
 * 2015 survey sat on the page with nothing to say how old it was.
 */
export async function EconomyStrip() {
  const indicators = await getEconomicIndicators();

  return (
    <section className="bg-ink-950 text-white">
      <div className="container-page py-14">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-display-sm font-semibold text-white">
              Economy at a glance
            </h2>
            <p className="mt-1.5 text-sm text-ink-300">
              Tracked by the LCCI Research Department.
            </p>
          </div>
          <Link
            href="/advocacy/economy"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-300 underline-offset-4 hover:underline"
          >
            Full indicators
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>

        <dl className="mt-9 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-white/10 md:grid-cols-3 lg:grid-cols-5">
          {indicators.map((i) => (
            <IndicatorCell key={i.id} indicator={i} />
          ))}
        </dl>
      </div>
    </section>
  );
}

function IndicatorCell({ indicator }: { indicator: EconomicIndicator }) {
  const { changePct, goodWhen } = indicator;
  const rising = (changePct ?? 0) > 0;

  // Colour follows whether the move is good news, not merely which way it went:
  // falling inflation is green, falling exports would be red.
  const good =
    goodWhen === "neutral" || changePct === undefined
      ? null
      : goodWhen === "up"
        ? rising
        : !rising;

  const Trend = changePct === undefined ? Minus : rising ? TrendingUp : TrendingDown;

  return (
    <div className="bg-ink-950 p-5">
      <dt className="text-[0.8125rem] font-medium text-ink-300">{indicator.labelEn}</dt>
      <dd className="mt-2">
        <span className="font-display text-2xl font-semibold tabular-nums text-white">
          {indicator.value}
        </span>
        {changePct !== undefined && (
          <span
            className={cn(
              "ms-2 inline-flex items-center gap-1 text-sm font-medium tabular-nums",
              // These sit on ink-950, so each has to clear 4.5:1 as text:
              // ink-300 9.63:1, success-300 9.58:1, clay-400 6.01:1. The
              // success 500 that was here measured 3.68:1 and failed.
              good === null && "text-ink-300",
              good === true && "text-success-300",
              good === false && "text-clay-400",
            )}
          >
            <Trend className="h-3.5 w-3.5" aria-hidden />
            {rising ? "+" : ""}
            {changePct}%
          </span>
        )}
      </dd>
      {/* ink-400 (5.05:1), not ink-500 (3.18:1) — small uppercase text still
          has to clear 4.5:1, and this line is the provenance the section's
          credibility rests on. It stays quieter than the ink-300 label. */}
      <p className="mt-2.5 text-[0.6875rem] uppercase tracking-wide text-ink-400">
        {indicator.source} · {formatDateShort(indicator.updatedAt)}
      </p>
    </div>
  );
}
