import { Quote } from "lucide-react";
import { TiltCard } from "@/components/v2/primitives";
import { Tag } from "@/components/ui/tag";
import { getPartners, getTestimonials } from "@/content/repository";
import { cn } from "@/lib/cn";
import type { Partner } from "@/content/types";

/** Strategic first, then gold, then silver — the board should read as a hierarchy. */
const TIER_RANK: Record<Partner["tier"], number> = {
  strategic: 0,
  gold: 1,
  silver: 2,
};

/**
 * Member voices, then the institutional partners.
 *
 * Staged on stone between two ink bands (advocacy above, the closing band
 * below) so the page breathes before its last word. The depth here comes from
 * elevation and an offset middle card rather than from glass, which only works
 * over a dark saturated backdrop.
 *
 * The headings match the first variant's on purpose. The question these two
 * homepages exist to answer is "which layout?", and rewriting the copy as well
 * would make the comparison dishonest.
 */
export async function TestimonialsV2() {
  const [testimonials, partners] = await Promise.all([
    getTestimonials(),
    getPartners(),
  ]);

  const board = [...partners].sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier],
  );

  return (
    <section
      aria-labelledby="v2-testimonials-heading"
      className="relative isolate overflow-hidden bg-stone-100"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="v2-parallax absolute -right-32 top-[-6rem] h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(circle,var(--color-brand-200)_0%,transparent_70%)] opacity-50 blur-3xl" />
      </div>

      <div className="container-page py-20 lg:py-28">
        <div className="v2-reveal max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-clay-600">
            Members
          </p>
          <h2
            id="v2-testimonials-heading"
            className="mt-4 font-display text-display-md font-semibold text-ink-950"
          >
            Why members stay
          </h2>
          <p className="mt-5 text-[0.9375rem] leading-relaxed text-stone-600">
            Three member firms on what the chamber is actually worth to them, in
            their own words.
          </p>
        </div>

        <ul className="mt-12 grid items-start gap-6 md:grid-cols-2 lg:grid-cols-3">
          {testimonials.map((t, i) => (
            <li key={t.id} className="h-full">
              <TiltCard
                maxTilt={5}
                lift={6}
                className={cn(
                  "h-full rounded-2xl border border-stone-200 bg-white p-7 shadow-depth-2",
                  // The middle card sits a step lower so the row reads as three
                  // floating planes rather than one ruled band. Only from the
                  // three-up breakpoint, where there is a middle card to offset.
                  // `h-full` resolves against the grid area, not the aligned box,
                  // so the three cards stay the same height and this is a true
                  // vertical offset rather than a shortened card.
                  i === 1 && "lg:mt-10",
                )}
              >
                <figure className="flex h-full flex-col">
                  <Quote
                    className="h-5 w-5 shrink-0 text-brand-500"
                    aria-hidden
                  />
                  <blockquote className="mt-4">
                    {/* Display size and the serif: a member's sentence should
                        carry the same typographic weight as a heading, because
                        it is doing the same persuasive work. */}
                    <p className="font-display text-display-sm font-normal leading-[1.35] text-ink-900">
                      {t.quote}
                    </p>
                  </blockquote>
                  <figcaption className="mt-auto pt-7 text-sm">
                    <span className="block font-medium text-ink-950">
                      {t.authorName}
                    </span>
                    <span className="block text-stone-600">
                      {t.authorRole}, {t.company}
                    </span>
                  </figcaption>
                </figure>
              </TiltCard>
            </li>
          ))}
        </ul>

        {/* ------------------------------------------------------------------
            Institutional partners.
            ------------------------------------------------------------------
            A static board, not a marquee — and not because a marquee would look
            wrong. Nothing in this strip is a link, so nothing inside it can take
            focus, which leaves `Marquee`'s pause-on-hover as the only way to
            stop it. A hover-only pause is WCAG 2.2 2.2.2 unmet for anyone
            driving the page from the keyboard. These names are also long enough
            ("Trade Development Authority of Pakistan") that a moving strip shows
            two of six at a time; a board shows the whole roster at once, which
            is the actual point of naming your partners.

            Wordmarks are typeset from `partner.name` because `logo` is in
            practice absent — LCCI has not supplied approved artwork. A grey
            placeholder box would say less, weigh more and promise a file that
            does not exist.
            ------------------------------------------------------------------ */}
        {/* Clears the offset card's overhang with room to spare. */}
        <div className="mt-24 border-t border-stone-300 pt-10">
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-600">
            Institutional partners
          </h3>

          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {board.map((p) => (
              <li
                key={p.id}
                className="flex h-full items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-5 py-4 shadow-depth-1"
              >
                <span className="font-display text-base font-medium leading-snug text-ink-900">
                  {p.name}
                </span>
                {p.tier === "strategic" && (
                  <Tag tone="ink" className="shrink-0">
                    Strategic
                  </Tag>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
