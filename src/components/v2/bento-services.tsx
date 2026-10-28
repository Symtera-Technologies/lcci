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
import { TiltCard } from "@/components/v2/primitives";
import { cn } from "@/lib/cn";

const ICONS: Record<ServiceTile["icon"], React.ElementType> = {
  renew: RefreshCw,
  certificate: BadgeCheck,
  attestation: FileText,
  circular: ScrollText,
  directory: Search,
};

/**
 * The card surface for the whole /v2 page.
 *
 * Repeated verbatim in `committees.tsx` rather than shared, because the two
 * sections are the only owners of it and the variant's shared module
 * (`primitives.tsx`) belongs to the page's client layer. If the hairline weight
 * or the elevation step changes here it has to change there in the same commit,
 * or the page stops reading as one system.
 *
 * `focus-within` carries every state that `hover` does: TiltCard renders a
 * plain `<div>`, so the card itself can never take focus and the link inside it
 * is what the keyboard lands on. Without the paired state the entire depth
 * treatment would be mouse-only.
 */
const TILE_SURFACE =
  "group relative h-full rounded-[20px] border border-brand-300 bg-white " +
  "shadow-depth-1 transition-[transform,box-shadow,border-color] duration-300 ease-out-expo " +
  "hover:border-brand-500 hover:shadow-depth-2 " +
  "focus-within:border-brand-500 focus-within:shadow-depth-2";

/** Fills the card so the hit area is the card, not the headline. */
const TILE_LINK = "flex h-full flex-col overflow-hidden rounded-[inherit]";

/**
 * Icon chip. Stone-600-and-up greens only: brand-700 on brand-50 is an
 * institutional pairing rather than a startup's pastel badge.
 */
const CHIP =
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl " +
  "bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 " +
  "transition-colors duration-300 group-hover:bg-brand-100 group-focus-within:bg-brand-100";

/**
 * The outward arrow.
 *
 * Colour shift first, movement second — the movement is `motion-safe:` gated,
 * so under reduced motion the affordance still answers the pointer. stone-500
 * rather than the lighter stones the v1 tiles use: 3.8:1 against white clears
 * the non-text threshold at rest, not only on hover.
 */
function TileArrow({ className }: { className?: string }) {
  return (
    <ArrowUpRight
      aria-hidden
      className={cn(
        "h-5 w-5 shrink-0 text-stone-500 transition-[color,translate] duration-300 ease-out-expo",
        "group-hover:text-brand-600 group-focus-within:text-brand-600",
        "motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:translate-x-0.5",
        "motion-safe:group-focus-within:-translate-y-0.5 motion-safe:group-focus-within:translate-x-0.5",
        className,
      )}
    />
  );
}

/**
 * The five tasks members actually arrive to do — spec §3.1 asks that these be
 * one click from every page. KCCI already offers attestation and visa letters
 * online, so this block is the parity bar and has to read as the most
 * important thing on the page after the hero.
 *
 * A bento rather than a row of five equal tiles: equal tiles say the five jobs
 * are equally likely, and they are not. Renewal is the one task every member
 * repeats every year, so it takes the 2x2 and the only dark panel in the
 * section; the certificate of origin takes a double-width cell; attestation
 * and circulars take single cells; the directory takes a full-width band,
 * which is the shape a search actually wants.
 */
export async function BentoServices() {
  const tiles = await getServiceTiles();
  if (tiles.length === 0) return null;

  const [feature, ...rest] = tiles;

  /**
   * Spans are declared per position, not derived from the data: a bento is a
   * composition, and a cell that does not know where it sits cannot hold one.
   * Anything the repository adds beyond the fifth tile falls through to a
   * single cell, which keeps the grid whole instead of tearing a hole in it.
   */
  const spans = [
    "sm:col-span-2 lg:col-span-2",
    "lg:col-span-1",
    "lg:col-span-1",
    "sm:col-span-2 lg:col-span-4",
  ];

  return (
    <section
      aria-labelledby="v2-services-heading"
      className="relative isolate py-20 lg:py-28"
    >
      <Stage />

      <div className="container-page">
        <div className="max-w-2xl">
          <p className="inline-flex items-center gap-2.5 text-xs font-medium uppercase tracking-[0.14em] text-brand-700">
            <span className="h-px w-8 bg-brand-500" aria-hidden />
            Member services
          </p>
          <h2
            id="v2-services-heading"
            className="mt-4 font-display text-display-md font-semibold text-ink-950"
          >
            What members come here to do
          </h2>
          <p className="mt-4 text-base leading-relaxed text-stone-600">
            Five tasks, each one click from every page of the site. Four of them
            used to mean a trip across the city to Shahrah-e-Aiwan-e-Tijarat.
          </p>
        </div>

        {/*
          4 → 2 → 1 columns. The explicit row track only exists at `lg`, where
          the 2x2 feature has to agree with the two cells stacked beside it;
          `minmax` rather than a fixed height so a long label can grow the row
          instead of overflowing it. Below `lg` the spans collapse and the bento
          resolves into an ordinary stack, in the order the tasks are ranked.

          --v2-perspective is set once on the grid and inherited: TiltCard
          resolves perspective per element, so this sets the depth of the camera
          without the cards sharing a vanishing point. 1400px rather than the
          900px default because these cards are far larger than the v1 ones and
          a close camera turns a 7-degree tilt into a skew.
        */}
        <ul
          className={cn(
            "mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4",
            "lg:grid-rows-[minmax(11rem,auto)_minmax(11rem,auto)_auto]",
            "[--v2-perspective:1400px]",
          )}
        >
          {/*
            `v2-reveal` goes on the grid item, not on the TiltCard.
            Both write `transform`, and a scroll-driven animation with
            `fill-mode: both` holds its last keyframe — `transform: none` —
            forever once the range is past, which would silently flatten every
            tilt in any browser that supports `animation-timeline`. Revealing
            the cell and tilting the card inside it keeps the two off each
            other's property. Each cell still reveals on its own scroll
            position, which is the only stagger a view() timeline can have.
          */}
          <li className="v2-reveal sm:col-span-2 lg:col-span-2 lg:row-span-2">
            <FeatureTile tile={feature} />
          </li>

          {rest.map((tile, i) => (
            <li
              key={tile.id}
              className={cn("v2-reveal", spans[i] ?? "lg:col-span-1")}
            >
              {/* The directory is the band, and a band reads left-to-right. */}
              {tile.icon === "directory" ? (
                <BandTile tile={tile} />
              ) : (
                <StandardTile tile={tile} />
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/**
 * The stage the cards float above.
 *
 * Decorative only, and parallaxed rather than static so the depth survives
 * scrolling — `v2-parallax` is reduced-motion gated at source and never touches
 * text. Clipped by its own wrapper so the wash cannot bleed into the sections
 * either side, which are owned by other components.
 */
function Stage() {
  return (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden">
      <div className="v2-parallax absolute inset-x-0 -top-24 h-[36rem] bg-[radial-gradient(55%_55%_at_50%_0%,var(--color-brand-100),transparent_72%)] opacity-80" />
      <div className="absolute inset-x-0 bottom-0 h-px bg-[linear-gradient(to_right,transparent,var(--color-stone-300),transparent)]" />
    </div>
  );
}

/**
 * Renewal: the 2x2.
 *
 * It earns the size by carrying what the small cells cannot — a gradient
 * ground, a ghosted mark, and a second line of copy that frames the task
 * rather than repeating the label. The ink panel also gives the section a
 * single focal point, so the eye has somewhere to land before it starts
 * scanning the rest.
 *
 * Content is bottom-anchored. A heading floating in the middle of a tall cell
 * reads as an accident; sitting on the floor of it reads as a plate.
 */
function FeatureTile({ tile }: { tile: ServiceTile }) {
  const Icon = ICONS[tile.icon];

  return (
    <TiltCard
      maxTilt={4}
      lift={8}
      className={cn(
        "group relative h-full overflow-hidden rounded-[24px]",
        // brand-400 for the hairline, never the crest's own brand-800: at
        // 1.86:1 on an ink panel that border would simply not be there.
        "border border-brand-400/45 bg-linear-to-br from-ink-950 via-ink-900 to-brand-950",
        "shadow-depth-2 transition-[transform,box-shadow,border-color] duration-300 ease-out-expo",
        "hover:border-brand-400 hover:shadow-depth-3",
        "focus-within:border-brand-400 focus-within:shadow-depth-3",
        "[--v2-perspective:1800px]",
      )}
    >
      {/* The one element in this viewport that moves on its own. */}
      <Icon
        aria-hidden
        className="pointer-events-none absolute -bottom-12 -right-10 h-64 w-64 text-brand-400/12 motion-safe:animate-drift"
        strokeWidth={1}
      />

      <Link
        href={tile.href}
        className={cn(TILE_LINK, "p-6 sm:p-8", "rounded-[24px]")}
      >
        <div className="flex items-start justify-between gap-4">
          <span className="v2-glass inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-brand-300">
            <Icon className="h-6 w-6" aria-hidden />
          </span>
          <TileArrow className="text-brand-300 group-hover:text-white group-focus-within:text-white" />
        </div>

        <div className="mt-10 lg:mt-auto lg:pt-10">
          <span className="text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-brand-300">
            Most used
          </span>
          <h3 className="mt-3 font-display text-display-sm font-semibold text-white">
            {tile.labelEn}
          </h3>
          <p className="mt-3 max-w-md text-[0.9375rem] leading-relaxed text-ink-200">
            {tile.description}
          </p>
          {/* The supporting line the small cells do not get. Framing, not a
              claim about processing times the chamber has not published. */}
          <p className="mt-4 max-w-md border-t border-white/10 pt-4 text-sm leading-relaxed text-ink-300">
            Renewal is the one task every member repeats. Start here and your
            directory listing, committee seats and document rates all stay
            current.
          </p>
        </div>
      </Link>
    </TiltCard>
  );
}

/** The 2x1 and 1x1 cells. Label, one line, nothing it has not room for. */
function StandardTile({ tile }: { tile: ServiceTile }) {
  const Icon = ICONS[tile.icon];

  return (
    <TiltCard maxTilt={7} lift={6} className={TILE_SURFACE}>
      <Link href={tile.href} className={cn(TILE_LINK, "p-5 sm:p-6")}>
        <div className="flex items-start justify-between gap-3">
          <span className={CHIP}>
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <TileArrow />
        </div>

        <div className="mt-8 sm:mt-auto sm:pt-8">
          <h3 className="font-display text-[1.0625rem] font-semibold leading-snug text-ink-950">
            {tile.labelEn}
          </h3>
          <p className="mt-2 text-[0.875rem] leading-relaxed text-stone-600">
            {tile.description}
          </p>
        </div>
      </Link>
    </TiltCard>
  );
}

/**
 * The directory: the full-width band on the bottom row.
 *
 * Horizontal only from `lg`, where it actually spans four columns; narrower
 * than that it stacks like every other tile so the bottom of the grid does not
 * turn into a cramped three-column strip.
 */
function BandTile({ tile }: { tile: ServiceTile }) {
  const Icon = ICONS[tile.icon];

  return (
    <TiltCard maxTilt={3} lift={5} className={TILE_SURFACE}>
      <Link
        href={tile.href}
        className={cn(
          TILE_LINK,
          "gap-5 p-5 sm:p-6 lg:flex-row lg:items-center lg:gap-6 lg:py-7",
        )}
      >
        <span className={CHIP}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>

        <div className="lg:flex lg:flex-1 lg:items-baseline lg:gap-5">
          <h3 className="font-display text-[1.0625rem] font-semibold leading-snug text-ink-950 lg:shrink-0 lg:text-lg">
            {tile.labelEn}
          </h3>
          <p className="mt-2 text-[0.875rem] leading-relaxed text-stone-600 lg:mt-0">
            {tile.description}
          </p>
        </div>

        <span className="flex items-center gap-2 text-sm font-medium text-ink-800 lg:shrink-0">
          Search the directory
          <TileArrow className="h-4 w-4" />
        </span>
      </Link>
    </TiltCard>
  );
}
