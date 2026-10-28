import { getPartners, getTestimonials } from "@/content/repository";
import { Tag } from "@/components/ui/tag";

/**
 * Member voices and institutional partners.
 *
 * Partner names render as typeset wordmarks rather than logo images until LCCI
 * supplies approved artwork — a placeholder grey box would say less and weigh
 * more, and wordmarks stay legible when a logo file is missing.
 */
export async function Testimonials() {
  const [testimonials, partners] = await Promise.all([
    getTestimonials(),
    getPartners(),
  ]);

  return (
    <section className="bg-stone-100">
      <div className="container-page py-20">
        <h2 className="font-display text-display-sm font-semibold text-ink-950">
          Why members stay
        </h2>

        <ul className="mt-8 grid gap-5 md:grid-cols-3">
          {testimonials.map((t) => (
            <li key={t.id}>
              <figure className="flex h-full flex-col rounded-xl border border-stone-200 bg-white p-6 shadow-card">
                <blockquote className="font-display text-lg leading-relaxed text-ink-900">
                  <p>&ldquo;{t.quote}&rdquo;</p>
                </blockquote>
                <figcaption className="mt-auto pt-6 text-sm">
                  <span className="block font-medium text-ink-950">{t.authorName}</span>
                  <span className="block text-stone-500">
                    {t.authorRole}, {t.company}
                  </span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>

        <div className="mt-16 border-t border-stone-300 pt-10">
          <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-stone-500">
            Institutional partners
          </h3>
          <ul className="mt-6 flex flex-wrap items-center gap-x-10 gap-y-5">
            {partners.map((p) => (
              <li key={p.id} className="flex items-center gap-2.5">
                <span className="font-display text-base font-medium text-ink-800">
                  {p.name}
                </span>
                {p.tier === "strategic" && <Tag tone="ink">Strategic</Tag>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
