import Link from "next/link";
import { ArrowUpRight, Users } from "lucide-react";
import { getCommittees } from "@/content/repository";
import { ButtonLink } from "@/components/ui/button";
import { TiltCard } from "@/components/v2/primitives";
import { cn } from "@/lib/cn";

/**
 * Deliberately identical to `TILE_SURFACE` in `bento-services.tsx`.
 *
 * The two sections are its only owners and the variant's shared module
 * (`primitives.tsx`) belongs to the page's client layer, so the string is
 * repeated rather than extracted. If the hairline weight or the elevation step
 * changes in one, it changes in the other in the same commit — otherwise the
 * committees stop looking like the services.
 *
 * `focus-within` mirrors every `hover` state: TiltCard renders a `<div>`, so
 * the keyboard lands on the link inside the card and never on the card.
 */
const CARD_SURFACE =
  "group relative h-full rounded-[20px] border border-brand-300 bg-white " +
  "shadow-depth-1 transition-[transform,box-shadow,border-color] duration-300 ease-out-expo " +
  "hover:border-brand-500 hover:shadow-depth-2 " +
  "focus-within:border-brand-500 focus-within:shadow-depth-2";

/**
 * The chamber's working structure, one card per committee.
 *
 * On the legacy site "Standing Committees" and "Advisory Committee" were both
 * dead "#" links, so the body that actually carries a sector's case to
 * government was invisible — a member could not find out which committee
 * handled refunds, let alone who sat on it. This section is the fix, which is
 * why it is sized as a section of its own rather than a footnote to the
 * about page.
 *
 * The totals in the header are summed from the same data, not typed in, so a
 * committee added to the repository cannot leave a stale count behind it.
 */
export async function CommitteesV2() {
  const committees = await getCommittees();
  if (committees.length === 0) return null;

  const members = committees.reduce((sum, c) => sum + c.memberCount, 0);

  return (
    <section
      aria-labelledby="v2-committees-heading"
      className="relative isolate py-20 lg:py-28"
    >
      <Stage />

      <div className="container-page">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-12">
          <div className="max-w-2xl">
            <p className="inline-flex items-center gap-2.5 text-xs font-medium uppercase tracking-[0.14em] text-brand-700">
              <span className="h-px w-8 bg-brand-500" aria-hidden />
              Working structure
            </p>
            <h2
              id="v2-committees-heading"
              className="mt-4 font-display text-display-md font-semibold text-ink-950"
            >
              Committees &amp; sector groups
            </h2>
            <p className="mt-4 text-base leading-relaxed text-stone-600">
              Every position the chamber takes to government starts in one of
              these rooms. Each committee lists its mandate, its membership and
              the asks it is currently carrying.
            </p>

            <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-stone-600">
              <span className="font-medium text-ink-900">
                {committees.length} committees
              </span>
              <span className="text-stone-400" aria-hidden>
                &middot;
              </span>
              <span>{members} serving members</span>
            </p>
          </div>

          <ButtonLink
            href="/about/committees"
            variant="ghost"
            size="md"
            className="group shrink-0 self-start lg:self-auto"
          >
            All committees
            <ArrowUpRight
              aria-hidden
              className="h-4 w-4 transition-transform duration-300 ease-out-expo motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:translate-x-0.5"
            />
          </ButtonLink>
        </div>

        {/*
          See the note in bento-services.tsx: `v2-reveal` belongs on the grid
          item, because it and `v2-tilt` both write `transform` and the reveal's
          fill would hold the card flat for good.

          --v2-perspective matches the bento exactly, so a committee card and a
          service tile tilt by the same amount under the pointer. Set on the
          grid and inherited; TiltCard resolves perspective per element, so the
          cards keep their own centres rather than sharing a vanishing point.
        */}
        <ul className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 [--v2-perspective:1400px]">
          {committees.map((c, i) => (
            <li key={c.slug} className="v2-reveal">
              <TiltCard maxTilt={7} lift={6} className={CARD_SURFACE}>
                <Link
                  href={`/about/committees/${c.slug}`}
                  className="flex h-full flex-col overflow-hidden rounded-[inherit] p-6"
                >
                  <div className="flex items-start justify-between gap-4">
                    {/* An index, not data: it gives a grid of six same-shaped
                        cards an editorial spine to be read down. Hidden from
                        assistive tech, which already gets the list semantics. */}
                    <span
                      aria-hidden
                      className="font-display text-sm tabular-nums text-brand-600"
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <ArrowUpRight
                      aria-hidden
                      className={cn(
                        "h-5 w-5 shrink-0 text-stone-500 transition-[color,translate] duration-300 ease-out-expo",
                        "group-hover:text-brand-600 group-focus-within:text-brand-600",
                        "motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:translate-x-0.5",
                        "motion-safe:group-focus-within:-translate-y-0.5 motion-safe:group-focus-within:translate-x-0.5",
                      )}
                    />
                  </div>

                  <h3 className="mt-5 font-display text-lg font-semibold leading-snug text-ink-950">
                    {c.nameEn}
                  </h3>
                  <p className="mt-2.5 text-[0.875rem] leading-relaxed text-stone-600">
                    {c.mandate}
                  </p>

                  {/* `mt-auto` rather than a fixed height: the footer rule
                      lines up across a row whatever length the mandates run
                      to, which is what makes six cards read as one body. */}
                  <p className="mt-auto flex items-center gap-2 border-t border-stone-200 pt-5 text-xs font-medium text-stone-600 group-hover:border-brand-200 group-focus-within:border-brand-200">
                    <Users className="h-4 w-4 text-brand-600" aria-hidden />
                    {c.memberCount} members
                  </p>
                </Link>
              </TiltCard>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * The stage. Decorative, parallaxed, and clipped by its own wrapper so nothing
 * bleeds into the neighbouring sections, which other components own.
 *
 * Warmer and lower than the services wash on purpose — the two sections sit on
 * the same page and should read as two plates on one table, not as the same
 * plate twice.
 */
function Stage() {
  return (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden">
      <div className="v2-parallax absolute inset-x-0 bottom-[-18rem] h-[36rem] bg-[radial-gradient(50%_50%_at_50%_100%,var(--color-brand-50),transparent_70%)]" />
      <div className="absolute inset-x-0 top-0 h-px bg-[linear-gradient(to_right,transparent,var(--color-stone-300),transparent)]" />
    </div>
  );
}
