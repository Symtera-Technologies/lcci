import Link from "next/link";
import {
  ArrowUpRight,
  BadgeCheck,
  FileText,
  RefreshCw,
  ScrollText,
  Search,
} from "lucide-react";
import { getServiceTiles } from "@/content/repository";
import type { ServiceTile } from "@/content/types";
import { CARD_BASE, CARD_FOCUS_SELF, CARD_GRID } from "@/components/ui/card";
import { cn } from "@/lib/cn";

const ICONS: Record<ServiceTile["icon"], React.ElementType> = {
  renew: RefreshCw,
  certificate: BadgeCheck,
  attestation: FileText,
  circular: ScrollText,
  directory: Search,
};

/**
 * The five tasks members actually arrive to do — spec §3.1 asks that these be
 * one click from every page. KCCI already offers attestation and visa letters
 * online, so these are the parity bar, not a differentiator.
 */
export async function ServiceTiles() {
  const tiles = await getServiceTiles();

  return (
    // `relative z-10` is load-bearing, not decoration. The negative margin
    // lifts these cards into the hero, which is itself `position: relative`;
    // positioned elements paint above static ones, so without this the hero's
    // panel covers the top ~56px of every card.
    <section className="container-page relative z-10 -mt-10 lg:-mt-14">
      <h2 className="sr-only">Common tasks</h2>
      <ul
        className={cn(
          "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5",
          CARD_GRID,
        )}
      >
        {tiles.map((tile) => {
          const Icon = ICONS[tile.icon];
          return (
            <li key={tile.id}>
              <Link
                href={tile.href}
                className={cn(
                  "group flex h-full flex-col p-5",
                  CARD_BASE,
                  CARD_FOCUS_SELF,
                )}
              >
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200/70">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>

                <span className="mt-4 flex items-start justify-between gap-2">
                  <span className="font-display text-base font-semibold text-ink-950">
                    {tile.labelEn}
                  </span>
                  <ArrowUpRight
                    className="h-4 w-4 shrink-0 text-stone-300 transition-colors group-hover:text-brand-600"
                    aria-hidden
                  />
                </span>

                <span className="mt-1.5 text-[0.8125rem] leading-snug text-stone-500">
                  {tile.description}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
