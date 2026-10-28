import Link from "next/link";
import { ArrowUpRight, Users } from "lucide-react";
import { getCommittees } from "@/content/repository";
import { CARD_BASE, CARD_FOCUS_SELF, CARD_GRID } from "@/components/ui/card";
import { cn } from "@/lib/cn";

/**
 * Committee pages, each with a mandate and a membership count.
 *
 * On the legacy site "Standing Committees" and "Advisory Committee" were both
 * dead "#" links — the chamber's actual working structure was invisible.
 */
export async function Committees() {
  const committees = await getCommittees();

  return (
    <section className="container-page py-20">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-ink-950 pb-3">
        <h2 className="font-display text-display-sm font-semibold text-ink-950">
          Committees &amp; sector groups
        </h2>
        <Link
          href="/about/committees"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-700 underline-offset-4 hover:text-ink-950 hover:underline"
        >
          All committees
          <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>

      <ul
        className={cn(
          "mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3",
          CARD_GRID,
        )}
      >
        {committees.map((c) => (
          <li key={c.slug}>
            <Link
              href={`/about/committees/${c.slug}`}
              className={cn(
                "group flex h-full flex-col p-6",
                CARD_BASE,
                CARD_FOCUS_SELF,
              )}
            >
              <span className="flex items-start justify-between gap-3">
                <span className="font-display text-base font-semibold text-ink-950">
                  {c.nameEn}
                </span>
                <ArrowUpRight
                  className="h-4 w-4 shrink-0 text-stone-300 transition-colors group-hover:text-brand-600"
                  aria-hidden
                />
              </span>

              <span className="mt-2 text-[0.875rem] leading-relaxed text-stone-600">
                {c.mandate}
              </span>

              <span className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-stone-500">
                <Users className="h-3.5 w-3.5" aria-hidden />
                {c.memberCount} members
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
