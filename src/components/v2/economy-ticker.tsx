import Link from "next/link";
import { ArrowRight, Minus, Pause, TrendingDown, TrendingUp } from "lucide-react";
import { getEconomicIndicators } from "@/content/repository";
import { Marquee } from "@/components/v2/marquee";
import { formatDateShort } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { EconomicIndicator } from "@/content/types";

const PAUSE_ID = "v2-ticker-pause";

/**
 * Economy at a glance, as a moving rail of chips.
 *
 * Deliberately a *light* band, although the rest of the variant leans dark.
 * The semantic scales only have 50/500/700 steps, and neither `success-500`
 * (3.7:1) nor `urgent-500` (3.5:1) is legible as text on `ink-950` — a ticker
 * whose whole job is to say "this is good news" cannot carry that meaning in a
 * colour that fails AA. On white the 700 steps clear 7:1 and the chips float
 * off the stone stage on a contact shadow, which keeps the depth without
 * borrowing a colour that does not work.
 */
export async function EconomyTicker() {
  const indicators = await getEconomicIndicators();

  return (
    <section
      aria-labelledby="v2-economy-heading"
      className="border-y border-stone-200 bg-stone-100"
    >
      <div className="container-page pt-14">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="max-w-xl">
            <h2
              id="v2-economy-heading"
              className="font-display text-display-sm font-semibold text-ink-950"
            >
              Economy at a glance
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              Tracked by the LCCI Research Department. Every figure carries the
              body it came from and the day it was last checked.
            </p>
          </div>

          <Link
            href="/advocacy/economy"
            className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink-700 underline-offset-4 hover:text-ink-950 hover:underline"
          >
            Full indicators
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>

      {/*
        A keyboard-operable pause, not only the hover pause the strip provides.
        Hovering is a pointer affordance; WCAG 2.2.2 asks for a mechanism
        everyone can reach, so this is a real checkbox — focusable, announced
        with its state, and needing no JavaScript on a band that is otherwise
        entirely static.

        The pause is wired with `:has()` on this wrapper rather than a sibling
        selector, so the control can sit in the page gutter while the rail runs
        full-bleed. It stops every animation beneath the wrapper, which is the
        strip's own track and nothing else. Where `:has()` is unsupported the
        rail simply keeps its hover pause, which is a degradation rather than a
        break.

        The whole control is hidden under reduced motion, where the global rule
        has already stopped the track and a pause button would control nothing.
      */}
      <div className="pb-14 has-[:checked]:[&_*]:[animation-play-state:paused]">
        <div className="container-page mt-8 motion-reduce:hidden">
          <input type="checkbox" id={PAUSE_ID} className="peer sr-only" />
          <label
            htmlFor={PAUSE_ID}
            className={cn(
              "inline-flex cursor-pointer select-none items-center gap-2 rounded-full",
              // stone-500 rather than a lighter hairline: this is a control, so
              // its boundary owes 3:1 on white, which stone-300 (1.4:1) misses.
              "bg-white px-3.5 py-1.5 text-xs font-medium text-ink-800 ring-1 ring-inset ring-stone-500",
              "hover:ring-ink-800",
              "peer-checked:bg-ink-950 peer-checked:text-white peer-checked:ring-ink-950",
              "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500",
            )}
          >
            <Pause className="h-3.5 w-3.5" aria-hidden />
            Pause ticker
          </label>
        </div>

        {/* Vertical padding inside the strip, because it clips its overflow and
            the chips' contact shadows would otherwise be sheared off. */}
        <Marquee className="mt-6 py-3">
          {indicators.map((indicator) => (
            <IndicatorChip key={indicator.id} indicator={indicator} />
          ))}
        </Marquee>
      </div>
    </section>
  );
}

/**
 * One indicator.
 *
 * Nothing inside is focusable on purpose: `Marquee` renders its children twice
 * and marks the copy `aria-hidden`, so a link in here would become a phantom
 * tab stop inside hidden content.
 */
function IndicatorChip({ indicator }: { indicator: EconomicIndicator }) {
  const { changePct, goodWhen } = indicator;

  const direction =
    changePct === undefined || changePct === 0
      ? "flat"
      : changePct > 0
        ? "up"
        : "down";

  // Colour follows whether the move is *good news*, not which way the number
  // went: inflation falling is good, exports falling is not. `goodWhen` is the
  // editor's answer to that, so comparing it with the direction is the whole
  // rule.
  const good =
    direction === "flat" || goodWhen === "neutral"
      ? null
      : goodWhen === direction;

  const Trend =
    direction === "flat" ? Minus : direction === "up" ? TrendingUp : TrendingDown;

  // Colour is never the only carrier: the arrow gives the direction, the signed
  // number gives it again, and this word gives the judgement in text. A
  // deuteranopic reader loses the hue and still has all three.
  const verdict =
    good === null
      ? direction === "flat"
        ? "unchanged"
        : direction
      : good
        ? "improving"
        : "worsening";

  return (
    <div className="w-[17.5rem] shrink-0 rounded-xl border border-stone-200 bg-white p-4 shadow-depth-1">
      <dl>
        <dt className="text-xs font-medium uppercase tracking-[0.08em] text-stone-600">
          {indicator.labelEn}
        </dt>
        <dd className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
          <span className="font-display text-2xl font-semibold tabular-nums text-ink-950">
            {indicator.value}
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset",
              good === null && "bg-stone-100 text-stone-700 ring-stone-300",
              good === true && "bg-success-50 text-success-700 ring-success-500/30",
              good === false && "bg-urgent-50 text-urgent-700 ring-urgent-500/30",
            )}
          >
            <Trend className="h-3.5 w-3.5" aria-hidden />
            {changePct === undefined ? (
              "change not published"
            ) : (
              <>
                {/* A true minus sign rather than a hyphen: these sit in tabular
                    figures and a hyphen reads as punctuation at this size. */}
                {changePct > 0 ? "+" : changePct < 0 ? "−" : ""}
                {Math.abs(changePct)}%
                <span className="font-medium"> {verdict}</span>
              </>
            )}
          </span>
        </dd>
      </dl>
      <p className="mt-3 text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-stone-600">
        {indicator.source} · checked {formatDateShort(indicator.updatedAt)}
      </p>
    </div>
  );
}
