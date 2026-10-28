import { ShieldCheck } from "lucide-react";
import { getKeyFigures } from "@/content/repository";
import { Counter } from "@/components/v2/primitives";
import { formatDate } from "@/lib/format";

/**
 * The chamber in numbers — variant 2.
 *
 * An ink stage with the figures floating on glass above it. The depth is the
 * point of this variant, but it is spent on the panels rather than on the
 * numerals: a statistic has to be read, and text sitting on its own moving
 * surface is harder to read, not more impressive.
 *
 * Two deliberate restraints:
 *  - the panels do not tilt. `TiltCard` is reserved for cards that are links,
 *    where the lean answers a pointer that is about to click something. A
 *    figure that chases the cursor is decoration with no referent.
 *  - exactly one decorative layer moves, slowly, behind everything, and the
 *    counters are the only other motion in the viewport.
 *
 * Contrast, because this band is dark: the crest green (`brand-800`) is 1.86:1
 * on `ink-950` and appears nowhere here. `brand-300` carries the eyebrow and
 * the month-style accents (10.4:1), `brand-400` is used only as a fill, and the
 * numerals are white on glass.
 */
export async function FiguresV2() {
  const figures = await getKeyFigures();

  // The oldest stamp in the set, not the first one. One line covering four
  // figures can only honestly claim the weakest of them — if the Research
  // Department re-checks membership but not the sector count, the band must
  // say so by getting older, not by quietly showing the freshest date.
  const verifiedAt = figures.reduce<string | undefined>(
    (oldest, f) => (!oldest || f.verifiedAt < oldest ? f.verifiedAt : oldest),
    undefined,
  );

  return (
    <section
      aria-labelledby="v2-figures-heading"
      className="relative isolate overflow-hidden bg-ink-950 text-white"
    >
      {/* Stage. Decorative only: no text, no controls, and it carries the only
          ambient motion in the band. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -start-32 -top-40 h-[34rem] w-[34rem] rounded-full bg-brand-700/30 blur-3xl motion-safe:animate-drift" />
        <div className="absolute -end-24 -bottom-48 h-[28rem] w-[28rem] rounded-full bg-ink-700/60 blur-3xl v2-parallax" />
        {/* A hairline of light along the top edge reads as the stage catching
            the section above it, which is what sells the layering. */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      </div>

      <div className="container-page py-20 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">
              Since 1923
            </p>
            <h2
              id="v2-figures-heading"
              className="mt-4 font-display text-display-md font-semibold text-white"
            >
              The chamber in numbers
            </h2>
            <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-200">
              A century of membership, in the only form that can be checked:
              counted, dated and attributed to the department that holds the
              record.
            </p>

            {verifiedAt && (
              <p className="mt-8 flex items-start gap-2.5 text-[0.8125rem] leading-relaxed text-ink-200">
                <ShieldCheck
                  className="mt-0.5 h-4 w-4 shrink-0 text-brand-300"
                  aria-hidden
                />
                <span>
                  Figures verified {formatDate(verifiedAt)} by the Research
                  Department.
                </span>
              </p>
            )}
          </div>

          {/* One reveal for the whole group rather than four. The figures are
              read together — as a set they are the chamber's scale — and four
              panels arriving separately turns a statement into a sequence. */}
          <dl className="v2-reveal grid gap-5 sm:grid-cols-2 lg:col-span-8">
            {figures.map((f) => (
              <div
                key={f.id}
                className="v2-glass relative overflow-hidden rounded-2xl p-6 shadow-depth-2 sm:p-7"
              >
                {/* brand-400 as a fill, which clears 3:1 on ink; the crest
                    green would be invisible here. */}
                <span
                  aria-hidden
                  className="absolute inset-y-6 start-0 w-[3px] rounded-full bg-brand-400"
                />
                <div className="flex flex-col-reverse gap-2.5">
                  <dt className="text-sm font-medium text-ink-100">
                    {f.labelEn}
                  </dt>
                  <dd>
                    {/* Tabular figures so the count-up cannot change the
                        number's width while it runs. */}
                    <Counter
                      value={f.value}
                      suffix={f.suffix}
                      className="block font-display text-display-lg font-semibold tabular-nums text-white"
                    />
                  </dd>
                </div>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
