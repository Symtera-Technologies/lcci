import Image from "next/image";
import { ArrowRight, ChevronDown, Landmark } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { TiltCard } from "@/components/v2/primitives";
import { splitHeadline } from "@/content/headline";
import { getHero } from "@/content/repository";
import type { Hero, ImageRef } from "@/content/types";
import { cn } from "@/lib/cn";

/**
 * Variant 2 hero — "Chamber in Depth".
 *
 * Same message as the live hero, staged differently: an ink hall lit by a
 * slow green mesh, a colonnade receding behind it, and the chamber's own
 * photography held forward on three planes.
 *
 * Three decisions worth recording, because each one had an obvious-looking
 * alternative:
 *
 *  - The copy is unchanged from the live hero. This is a presentation variant
 *    that will be compared against `/` on layout, not on claims; rewriting the
 *    headline would make that comparison meaningless, and the 20,000 figure
 *    and the 1923 date are both approved.
 *  - No `v2-reveal` anywhere. `view()` timelines resolve against the viewport
 *    on first paint, so a hero is already past its entry range when the page
 *    loads: a reveal here either does nothing or flickers. Reveals belong to
 *    the sections below the fold.
 *  - Motion is confined to two decorative systems — the mesh and the
 *    colonnade — plus the scroll cue. The headline, the buttons and the
 *    photographs never move on scroll. Depth here is shadow, scale and
 *    perspective, which cost nothing and cannot drift text out from under a
 *    reader's cursor.
 *
 * Renders entirely on the server. `TiltCard` is the only client code and it
 * no-ops without a fine pointer, so with JS disabled the composition is a set
 * of flat, correctly stacked frames rather than a hole.
 *
 * **Every string and all three photographs are editorial**, read from the
 * `hero` content type by this component. What stays in this file is
 * the composition: which plane each photograph occupies, the perspective
 * length and shadow step that make the staging read as depth, and the
 * `sizes` attributes those positions imply. Those are not editable on purpose
 * — they are a fixed relationship between three frames, and "how many
 * pictures" is a design decision rather than an editorial one.
 */

/* -------------------------------------------------------------------------- */
/* Staging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How one plane is staged. Not editorial: see the note above.
 *
 * `sizes` is derived from the `lg:w-[…]` the plane is rendered at, so it has
 * to live beside that class or the two drift and the browser downloads the
 * wrong candidate.
 */
interface Plane {
  /** Lower value = stronger foreshortening, so the card reads nearer. */
  perspective: string;
  sizes: string;
}

const PLANES = {
  lead: {
    perspective: "900px",
    sizes: "(min-width: 1024px) 38vw, (min-width: 640px) 88vw, 92vw",
  },
  behind: {
    perspective: "1400px",
    sizes: "(min-width: 1024px) 16vw, (min-width: 640px) 43vw, 92vw",
  },
  front: {
    perspective: "640px",
    sizes: "(min-width: 1024px) 27vw, (min-width: 640px) 43vw, 92vw",
  },
} satisfies Record<string, Plane>;

/* -------------------------------------------------------------------------- */
/* Hero                                                                      */
/* -------------------------------------------------------------------------- */

export async function HeroV2() {
  // Read here rather than taken as a prop, because every other section in this
  // directory reads its own content the same way. Plumbing one section's data
  // through the page would make the hero the exception and give `page.tsx` a
  // reason to change every time the hero does.
  const hero = await getHero();

  return (
    <section
      className={cn(
        "relative isolate flex flex-col overflow-hidden bg-ink-950",
        // Only tall on desktop. A forced 88vh on a phone pushes the CTAs below
        // the fold to buy empty space, which is the opposite of the point.
        "lg:min-h-[88vh]",
      )}
    >
      <GradientMesh />
      <Colonnade />

      <div className="container-page relative flex flex-1 flex-col justify-center py-14 sm:py-16 lg:py-20">
        <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-14 xl:gap-16">
          <div className="lg:col-span-6 xl:col-span-5">
            <Message hero={hero} />
          </div>

          {/* Pushed a column right at xl so the composition has room to breathe
              without the headline measure growing past ~60 characters. */}
          <div className="lg:col-span-6 xl:col-span-6 xl:col-start-7">
            <Composition hero={hero} />
          </div>
        </div>
      </div>

      <ScrollCue />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Message                                                                    */
/* -------------------------------------------------------------------------- */

function Message({ hero }: { hero: Hero }) {
  // Split here rather than in the repository: which words are green is a
  // presentation decision, and the stored row holds the headline and the
  // phrase without an opinion about markup.
  const headline = splitHeadline(hero.headlineEn, hero.headlineHighlightEn);

  return (
    <div>
      <p className="v2-glass inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium uppercase tracking-[0.14em] text-brand-300">
        <Landmark className="h-3.5 w-3.5" aria-hidden />
        {hero.badgeEn}
      </p>

      {/* The one h1 on the page. Steps up to text-display-xl rather than
          starting there: 60px over a 375px viewport breaks mid-word.

          The three parts are rendered without any JSX whitespace between them,
          because the spaces around the highlighted phrase belong to the stored
          headline — adding `{" "}` here would double them for an editor who
          typed them and invent them for one who did not. */}
      <h1 className="mt-6 font-display text-[2.125rem] font-semibold leading-[1.08] tracking-tight text-white sm:text-display-lg lg:text-display-xl">
        {headline.before}
        {headline.highlight ? (
          <span className="text-brand-300">{headline.highlight}</span>
        ) : null}
        {headline.after}
      </h1>

      <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-200">
        {hero.subheadEn}
      </p>

      <div className="mt-9 flex flex-wrap items-center gap-3">
        <ButtonLink href={hero.primaryAction.href} size="lg">
          {hero.primaryAction.labelEn}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </ButtonLink>
        {hero.secondaryAction ? (
          <ButtonLink href={hero.secondaryAction.href} size="lg" variant="onDark">
            {hero.secondaryAction.labelEn}
          </ButtonLink>
        ) : null}
      </div>

      {/* ink-200, not the ink-400 a "quiet" line invites. ink-400 measures
          5.1:1 on flat ink-950, but the stage is not flat ink-950 — the mesh
          lifts the local background, and 5.1:1 is not enough headroom to spend
          on that. Quiet is carried by size here instead of by colour.

          Both the prompt and the link are needed. A prompt with no link is a
          question with no answer, and a bare link with no lead-in reads as a
          third button competing with the two above it. */}
      {hero.memberPromptEn && hero.memberAction ? (
        <p className="mt-7 text-sm text-ink-200">
          {hero.memberPromptEn}{" "}
          <a
            href={hero.memberAction.href}
            className="font-medium text-white underline decoration-brand-400 decoration-2 underline-offset-4 transition-colors hover:decoration-brand-300"
          >
            {hero.memberAction.labelEn}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Composition                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Three photographs on three planes.
 *
 * The staging is absolute only from `lg` up. Below that the same markup is a
 * plain grid — one wide frame, then a pair — because overlapping cards scaled
 * down to a phone become unreadable slivers of other people's elbows. The
 * percentage insets are deliberate: they hold the composition together at
 * 1024px and 1440px alike without a single fixed pixel offset.
 *
 * Depth is spelled three ways at once, since any one of them alone reads as a
 * mistake rather than as perspective: shadow step, scale, and the perspective
 * length fed to each tilt surface.
 */
function Composition({ hero }: { hero: Hero }) {
  return (
    <div className="relative grid gap-4 sm:grid-cols-2 sm:gap-5 lg:block lg:aspect-[1/0.86]">
      {/* Behind — smallest, faintest shadow, held back by scale. */}
      <TiltCard
        maxTilt={4}
        lift={3}
        style={{ "--v2-perspective": PLANES.behind.perspective } as React.CSSProperties}
        className="z-10 lg:absolute lg:right-0 lg:top-[13%] lg:w-[34%] lg:scale-[0.96]"
      >
        <Frame
          className="aspect-[4/3] shadow-depth-1 ring-white/10"
          image={hero.behindImage}
          plane={PLANES.behind}
        />
      </TiltCard>

      {/* Lead — the LCP image, and the only one carrying a caption. */}
      <TiltCard
        maxTilt={6}
        lift={6}
        style={{ "--v2-perspective": PLANES.lead.perspective } as React.CSSProperties}
        className="order-first z-20 sm:col-span-2 lg:absolute lg:left-0 lg:top-0 lg:w-[82%]"
      >
        <Frame
          className="aspect-[16/10] shadow-depth-2 ring-white/15"
          image={hero.leadImage}
          plane={PLANES.lead}
          priority
        >
          {/* The scrim renders whether or not there is a caption: it is what
              grades the photograph into the stage below it, and removing it
              along with the caption would restage the composition every time
              an editor cleared one field.

              Scrim first, chip second: v2-glass only resolves as frosted glass
              over a dark saturated backdrop, and a photograph is neither. The
              scrim guarantees both the panel's look and the label's 4.5:1. */}
          <div
            aria-hidden
            className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-ink-950/90 via-ink-950/55 to-transparent"
          />
          {hero.captionEn ? (
            <figcaption className="v2-glass absolute bottom-3 start-3 inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-white sm:bottom-4 sm:start-4">
              <span className="h-1.5 w-1.5 rounded-full bg-brand-400" aria-hidden />
              {hero.captionEn}
            </figcaption>
          ) : null}
        </Frame>
      </TiltCard>

      {/* Front — heaviest shadow, shortest perspective, strongest tilt. */}
      <TiltCard
        maxTilt={8}
        lift={9}
        style={{ "--v2-perspective": PLANES.front.perspective } as React.CSSProperties}
        className="z-30 lg:absolute lg:bottom-0 lg:right-[2%] lg:w-[58%]"
      >
        <Frame
          className="aspect-[3/2] shadow-depth-3 ring-white/20"
          image={hero.frontImage}
          plane={PLANES.front}
        />
      </TiltCard>

      {/* Second glass chip, parked on the ink rather than on a photograph so
          it needs no scrim of its own. Hidden until there is empty stage to
          park it on. */}
      {hero.statValueEn && hero.statLabelEn ? (
        <p className="v2-glass absolute bottom-[7%] left-0 hidden items-baseline gap-2 rounded-xl px-4 py-3 lg:inline-flex">
          <span className="font-display text-2xl font-semibold leading-none text-brand-300">
            {hero.statValueEn}
          </span>
          {/* The hard-coded line break went with the hard-coded words. The
              chip is narrow, so the label wraps on its own, and a break
              positioned for "years of / advocacy" lands in the wrong place for
              every other label an editor might type. */}
          <span className="max-w-[7rem] text-[0.6875rem] font-medium uppercase leading-tight tracking-[0.12em] text-white">
            {hero.statLabelEn}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Shared frame treatment. The photographs are real `<Image>` elements inside a
 * clipped panel — never a CSS background — so they are crawlable, have alt
 * text, and get Next's responsive sources. This is a standing requirement from
 * the client and not a stylistic choice.
 */
function Frame({
  image,
  plane,
  className,
  priority,
  children,
}: {
  image: ImageRef;
  plane: Plane;
  className?: string;
  priority?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <figure
      className={cn(
        "relative overflow-hidden rounded-xl bg-ink-900 ring-1 ring-inset",
        className,
      )}
    >
      {/* `alt` comes from the media library, which is the only place it can be
          right: the same photograph in the hero and in a press release has to
          describe itself the same way, and a second copy of the description is
          a second copy to get wrong. The CMS refuses to register an image
          without alt text, so this is never empty.

          The standing rule that alt text describes the event and never a
          participant is therefore enforced where the text is written rather
          than here. The identities in this photography are unverified, and
          attaching the wrong name to a public figure in a chamber photograph
          is a real-world harm rather than a content nit. */}
      <Image
        src={image.src}
        alt={image.altEn}
        fill
        priority={priority}
        sizes={plane.sizes}
        className="object-cover"
      />
      {children}
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Decorative layers                                                          */
/* -------------------------------------------------------------------------- */

interface Blob {
  /** Carries the position, size, colour and its own `animate-aurora-*` path. */
  className: string;
  /** Negative, so the blob starts part-way through its cycle rather than at rest. */
  delay: string;
}

/**
 * Four radial washes, each on its own path and its own clock.
 *
 * Each blob takes a different `animate-aurora-*` route rather than sharing one
 * keyframe at four speeds — four elements tracing the same shape still read as
 * a single pulse however the timings are staggered. The negative delays then
 * drop each one in part-way through its cycle, so nothing starts from rest
 * together on load, which is what makes this effect look like a token sale.
 * Offset and on separate paths, it reads as light moving through a room.
 *
 * Opacity is capped low and the brightest washes sit right of centre, behind
 * the photography — the headline needs an even field, not a gradient running
 * under it.
 */
const BLOBS: Blob[] = [
  {
    className:
      "-top-[22%] -left-[12%] h-[40rem] w-[40rem] animate-aurora-a bg-[radial-gradient(closest-side,var(--color-brand-600),transparent)] opacity-40",
    delay: "-3s",
  },
  {
    className:
      "top-[6%] -right-[10%] h-[44rem] w-[44rem] animate-aurora-b bg-[radial-gradient(closest-side,var(--color-brand-500),transparent)] opacity-30",
    delay: "-13s",
  },
  {
    className:
      "-bottom-[26%] left-[22%] h-[36rem] w-[36rem] animate-aurora-c bg-[radial-gradient(closest-side,var(--color-brand-400),transparent)] opacity-25",
    delay: "-9s",
  },
  {
    className:
      "top-[42%] -left-[16%] h-[28rem] w-[28rem] animate-aurora-d bg-[radial-gradient(closest-side,var(--color-brand-700),transparent)] opacity-50",
    delay: "-5s",
  },
];

function GradientMesh() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {BLOBS.map((blob) => (
        <div
          key={blob.className}
          // The negative delay is still the load-bearing part: it drops each
          // blob in part-way through its own cycle, so nothing starts from
          // rest together on load.
          style={{ animationDelay: blob.delay }}
          className={cn(
            "absolute rounded-full blur-3xl motion-reduce:animate-none",
            blob.className,
          )}
        />
      ))}

      {/* A slow pass of light across the stage, under the vignette so it dies
          out at the edges rather than sliding in as a visible band. Kept at
          6% white: the point is that the hall is never quite still, not that
          anyone should catch a highlight going past. */}
      <div className="absolute inset-y-0 -left-1/3 w-1/3 animate-sheen bg-[linear-gradient(100deg,transparent,rgb(255_255_255/0.06),transparent)] blur-2xl motion-reduce:hidden" />

      {/* Vignette. Pulls the corners back to ink so the washes read as light
          in a dark hall rather than as a coloured panel. */}
      <div className="absolute inset-0 bg-[radial-gradient(130%_100%_at_50%_0%,transparent_30%,var(--color-ink-950)_100%)]" />
    </div>
  );
}

/**
 * A pointed-arch colonnade in two ranks, echoing the arcades of the Walled
 * City. Purely structural decoration.
 *
 * Two kinds of motion, deliberately on different properties so they can run at
 * once without fighting:
 *
 *  - **Scroll parallax** on each rank's wrapper (`v2-parallax`, which drives
 *    `translate`). The near rank moves faster than the page and the far rank
 *    slower, which is the only way a parallax reads as distance rather than as
 *    a glitch. It is gated on `prefers-reduced-motion` and on
 *    `animation-timeline` support.
 *  - **A continuous walk** inside each SVG (`animate-colonnade-*`, which
 *    drives `transform` on a group). This runs whether or not the reader ever
 *    scrolls, so the arcade is never completely still.
 *
 * Without either — no scroll-timeline support, or reduced motion — the arches
 * simply sit still, which is a perfectly good resting state.
 */
function Colonnade() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Far rank: tall, wide bays, barely there. */}
      <div
        className="v2-parallax absolute inset-x-0 -top-[8%] h-[116%]"
        style={
          { "--v2-parallax-from": "3%", "--v2-parallax-to": "-3%" } as React.CSSProperties
        }
      >
        <ArchRank
          bays={6}
          opacity={0.1}
          strokeWidth={1.5}
          drift="animate-colonnade-far"
        />
      </div>

      {/* Near rank: a shorter arcade sitting on the base line, denser bays. */}
      <div
        className="v2-parallax absolute inset-x-0 bottom-0 h-[52%]"
        style={
          { "--v2-parallax-from": "10%", "--v2-parallax-to": "-10%" } as React.CSSProperties
        }
      >
        <ArchRank
          bays={10}
          opacity={0.14}
          strokeWidth={1}
          drift="animate-colonnade-near"
        />
      </div>

      {/* Ground line, so the near rank stands on something. */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-brand-400/25 to-transparent" />
    </div>
  );
}

/**
 * One rank of pointed arches as a single stretched SVG.
 *
 * Quadratic curves rather than elliptical arcs: the control point sits
 * directly above the springing, which keeps the tangent vertical where the
 * curve meets the pier and gives a clean point at the apex. Arcs with the same
 * geometry bulge at the springing and read as Roman, not Mughal.
 */
function ArchRank({
  bays,
  opacity,
  strokeWidth,
  drift,
}: {
  bays: number;
  opacity: number;
  strokeWidth: number;
  /** The `animate-colonnade-*` class that walks this rank past the viewer. */
  drift: string;
}) {
  const bay = 100;
  const gradientId = `v2-arch-${bays}`;

  return (
    <svg
      className="h-full w-full"
      viewBox={`0 0 ${bays * bay} 400`}
      fill="none"
      preserveAspectRatio="none"
      style={{ opacity }}
    >
      <defs>
        {/* Fades the arches out at the top, so they never form a hard band
            across the headline. */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-brand-300)" stopOpacity="0" />
          <stop offset="45%" stopColor="var(--color-brand-400)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--color-brand-400)" stopOpacity="0.15" />
        </linearGradient>
      </defs>

      {/* One bay more than the viewBox shows, so the vacancy the slide opens
          on the right is already filled. The group returns to its start after
          exactly one bay, which is why the loop cannot be seen. */}
      <g className={cn(drift, "motion-reduce:animate-none")}>
        {Array.from({ length: bays + 1 }, (_, i) => (
          <g key={i} transform={`translate(${i * bay} 0)`}>
            <path
              d="M6 400V170Q6 70 50 18Q94 70 94 170V400"
              stroke={`url(#${gradientId})`}
              strokeWidth={strokeWidth}
              vectorEffect="non-scaling-stroke"
            />
            <path
              d="M28 400V215Q28 150 50 118Q72 150 72 215V400"
              stroke={`url(#${gradientId})`}
              strokeWidth={strokeWidth * 0.75}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        ))}
      </g>
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Scroll cue                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Purely visual, so it is hidden from assistive tech: a screen reader already
 * knows the document continues, and "scroll" is not an instruction that
 * survives being read aloud. In flow rather than absolutely positioned, so it
 * cannot land on top of the CTAs at an awkward height.
 *
 * The bounce is slowed to a 3s cycle. At Tailwind's default 1s it reads as a
 * mobile app nudging you; at 3s it is a slow breath, which is the register a
 * 103-year-old institution should be in.
 */
function ScrollCue() {
  return (
    <div
      aria-hidden
      className="container-page relative flex justify-center pb-8 lg:justify-start lg:pb-10"
    >
      <span className="inline-flex items-center gap-2.5 text-[0.6875rem] font-medium uppercase tracking-[0.18em] text-ink-200">
        <ChevronDown
          className="h-4 w-4 text-brand-300 motion-safe:animate-bounce motion-reduce:animate-none [animation-duration:3s]"
        />
        Explore the chamber
      </span>
    </div>
  );
}
