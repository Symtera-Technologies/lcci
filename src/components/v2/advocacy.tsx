import Link from "next/link";
import { ArrowRight, ChevronRight, Quote } from "lucide-react";
import { TiltCard } from "@/components/v2/primitives";
import { ButtonLink } from "@/components/ui/button";
import { PositionStatus, Tag, TOPIC_LABELS } from "@/components/ui/tag";
import { getAdvocacySpotlight } from "@/content/repository";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * The four states a position can be in, in the order it moves through them.
 *
 * Shown as a ladder in the header because the status chip on a card is only
 * meaningful if the reader knows what the other three words would have been:
 * "Raised" reads as a dead end on its own and as the first rung here.
 */
const STATUS_LADDER = ["Raised", "Under review", "Accepted", "Resolved"] as const;

/**
 * Advocacy — the clearest gap against every chamber in the benchmark, and so
 * the section that carries the most weight in this variant.
 *
 * The point of a position is that the ask and its status are both visible: a
 * reader can see what the chamber wants and whether anything actually moved.
 * Press releases alone cannot carry that, because they only ever report the
 * asking.
 *
 * It is the one section staged on ink rather than on stone. Partly for rhythm,
 * but mostly because the ask is set as a pull-quote and a large serif line
 * reversed out of a dark panel is the oldest way in print of saying "this
 * sentence is the point". The frosted cards need a dark, saturated backdrop to
 * read as glass at all, so the two decisions pay for each other.
 */
export async function AdvocacyV2() {
  const positions = await getAdvocacySpotlight();

  return (
    <section
      aria-labelledby="v2-advocacy-heading"
      className="relative isolate overflow-hidden bg-ink-950 text-white"
    >
      {/* The stage. Decorative only: a brand wash to give the glass something
          saturated to sit over, and hairlines to seat the band in the page. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="v2-parallax absolute -left-40 -top-24 h-[34rem] w-[34rem] rounded-full bg-[radial-gradient(circle,var(--color-brand-600)_0%,transparent_68%)] opacity-40 blur-3xl" />
        <div className="absolute -bottom-32 right-[-8rem] h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,var(--color-ink-700)_0%,transparent_70%)] opacity-60 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </div>

      <div className="container-page py-20 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          {/* Header. The only reveal in this viewport — the cards earn their
              depth from elevation and tilt, not from arriving. */}
          <div className="v2-reveal lg:col-span-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-300">
              Advocacy
            </p>
            <h2
              id="v2-advocacy-heading"
              className="mt-4 font-display text-display-md font-semibold text-white"
            >
              What the chamber is asking for
            </h2>
            <p className="mt-5 max-w-prose text-[0.9375rem] leading-relaxed text-ink-200">
              Every position carries the ask in the chamber&rsquo;s own words, the
              department that owns it, and where it currently stands — so members
              can see whether representation turned into a result rather than
              only into a press release.
            </p>

            <div className="mt-8 border-t border-white/10 pt-6">
              <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-300">
                How a position moves
              </h3>
              <ol className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.8125rem] text-ink-200">
                {STATUS_LADDER.map((label, i) => (
                  <li key={label} className="flex items-center gap-1.5">
                    {i > 0 && (
                      <ChevronRight
                        className="h-3.5 w-3.5 shrink-0 text-ink-400"
                        aria-hidden
                      />
                    )}
                    <span>{label}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* The shared `onDark` ring sits at 25% white, which is 2.2:1 against
                ink-950 — under the 3:1 that 1.4.11 asks of a control's boundary.
                Lifted here rather than in the shared variant, which is tuned for
                the lighter ink panels it was written for. */}
            <ButtonLink
              href="/advocacy/positions"
              variant="onDark"
              className="mt-8 ring-white/40"
            >
              All policy positions
              <ArrowRight className="h-4 w-4" aria-hidden />
            </ButtonLink>
          </div>

          {/* One card per row rather than a two-up grid: the ask is the most
              important sentence here and a half-column measure would set it at
              five words a line. */}
          <ol className="flex flex-col gap-6 lg:col-span-7">
            {positions.map((p) => (
              <li key={p.id}>
                <TiltCard
                  maxTilt={4}
                  lift={5}
                  // A longer focal length than the 900px default: these cards are
                  // wide, and at 900px a 4° tilt skews the pull-quote's baseline
                  // enough to notice. Gravitas, not a trading-card flip.
                  style={{ "--v2-perspective": "1600px" } as React.CSSProperties}
                  className={cn(
                    "v2-glass h-full rounded-2xl p-6 shadow-depth-3 sm:p-9",
                    // The card's own affordance is keyboard-reachable because it
                    // keys off focus-within, not hover; TiltCard's pointer lift
                    // is the enhancement on top.
                    "focus-within:ring-1 focus-within:ring-brand-400",
                  )}
                >
                  <article className="flex h-full flex-col">
                    {/* Status is never colour alone — the chip carries the word,
                        and the ladder above gives the word its scale. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <PositionStatus status={p.positionStatus} />
                      {p.topics.slice(0, 1).map((t) => (
                        <Tag key={t} tone="neutral">
                          {TOPIC_LABELS[t]}
                        </Tag>
                      ))}
                    </div>

                    <h3 className="mt-5 font-display text-display-sm font-semibold leading-snug">
                      <Link
                        href={`/advocacy/positions/${p.slug}`}
                        className="text-white decoration-brand-300 decoration-2 underline-offset-[6px] hover:underline focus-visible:underline"
                      >
                        {p.titleEn}
                      </Link>
                    </h3>

                    <p className="mt-2.5 text-sm leading-relaxed text-ink-200">
                      {p.issue}
                    </p>

                    {/* The ask, typeset as the pull-quote it is. Deliberately not
                        wrapped in the card link: it is prose a reader may want to
                        quote, and a full-card hit area would make it unselectable. */}
                    <figure className="mt-6">
                      <figcaption className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-brand-300">
                        <Quote className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        The chamber&rsquo;s ask
                      </figcaption>
                      <blockquote className="mt-3 border-s-2 border-brand-400 ps-5">
                        <p className="font-display text-xl leading-[1.45] text-brand-50 sm:text-[1.5rem]">
                          {p.chamberAsk}
                        </p>
                      </blockquote>
                    </figure>

                    <p className="mt-auto pt-7 text-xs text-ink-300">
                      {p.ownerDepartment} · Updated{" "}
                      <time dateTime={p.updatedAt}>{formatDate(p.updatedAt)}</time>
                    </p>
                  </article>
                </TiltCard>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
