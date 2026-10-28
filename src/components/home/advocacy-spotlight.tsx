import Link from "next/link";
import { ArrowRight, Quote } from "lucide-react";
import { getAdvocacySpotlight } from "@/content/repository";
import { PositionStatus, Tag, TOPIC_LABELS } from "@/components/ui/tag";
import { ButtonLink } from "@/components/ui/button";
import { formatDate } from "@/lib/format";

/**
 * Advocacy spotlight — the clearest gap against every chamber in the benchmark.
 *
 * The point of a position page is that the ask and its status are both visible:
 * a reader can see what the chamber wants and whether anything moved. Press
 * releases alone cannot carry that, because they only ever report the asking.
 */
export async function AdvocacySpotlight() {
  const positions = await getAdvocacySpotlight();

  return (
    <section className="bg-stone-100">
      <div className="container-page py-20">
        <div className="grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-clay-600">
              Advocacy
            </p>
            <h2 className="mt-3 font-display text-display-md font-semibold text-ink-950">
              What the chamber is asking for
            </h2>
            <p className="mt-4 text-[0.9375rem] leading-relaxed text-stone-600">
              Every position carries the ask, the department that owns it and where
              it currently stands — so members can see whether representation turned
              into a result.
            </p>
            <ButtonLink href="/advocacy/positions" variant="secondary" className="mt-7">
              All policy positions
              <ArrowRight className="h-4 w-4" aria-hidden />
            </ButtonLink>
          </div>

          <ul className="grid gap-5 sm:grid-cols-2 lg:col-span-8">
            {positions.map((p) => (
              <li key={p.id}>
                <article className="flex h-full flex-col rounded-xl border border-stone-200 bg-white p-6 shadow-card">
                  <div className="flex flex-wrap items-center gap-2">
                    <PositionStatus status={p.positionStatus} />
                    {p.topics.slice(0, 1).map((t) => (
                      <Tag key={t} tone="neutral">
                        {TOPIC_LABELS[t]}
                      </Tag>
                    ))}
                  </div>

                  <h3 className="mt-4 font-display text-lg font-semibold leading-snug">
                    <Link
                      href={`/advocacy/positions/${p.slug}`}
                      className="text-ink-950 decoration-brand-400 decoration-2 underline-offset-4 hover:underline"
                    >
                      {p.titleEn}
                    </Link>
                  </h3>

                  <p className="mt-2 text-sm text-stone-500">{p.issue}</p>

                  <blockquote className="mt-4 flex gap-3 border-s-2 border-brand-400 ps-4 text-[0.9375rem] leading-relaxed text-ink-800">
                    <Quote className="mt-1 h-4 w-4 shrink-0 text-brand-500" aria-hidden />
                    <p>{p.chamberAsk}</p>
                  </blockquote>

                  <p className="mt-auto pt-5 text-xs text-stone-400">
                    {p.ownerDepartment} · Updated{" "}
                    <time dateTime={p.updatedAt}>{formatDate(p.updatedAt)}</time>
                  </p>
                </article>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
