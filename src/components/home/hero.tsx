import Image from "next/image";
import { ArrowRight } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";

/**
 * One message, two calls to action — spec §4.3 — beside a collage of the
 * chamber's own photography.
 *
 * Deliberately not a slider. The legacy hero rotated the same items as the news
 * list below it and truncated its own headlines; a fixed composition also
 * removes the page's largest source of layout shift.
 *
 * The photographs are not a background image: they sit in framed panels, so the
 * headline never fights them for contrast and nothing has to be scrimmed to
 * stay readable.
 */

interface HeroPhoto {
  src: string;
  alt: string;
}

/**
 * Alt text describes what is happening without naming individuals. The source
 * images carried "..." as their alt text, so who appears in them is unverified
 * — LCCI's Information Department should confirm names before any are added.
 */
const PHOTOS: Record<"main" | "left" | "right", HeroPhoto> = {
  main: {
    src: "/photos/hero-6.jpg",
    alt: "Members and office-bearers of the Lahore Chamber gathered on the steps of the chamber building beneath its nameplate.",
  },
  // The seated meeting reads fine in a narrow crop; the handshake needs the
  // wider slot or it collapses into the backs of people's heads.
  left: {
    src: "/photos/hero-1.jpg",
    alt: "Chamber representatives in discussion with a senior government official at a formal meeting.",
  },
  right: {
    src: "/photos/hero-2.jpg",
    alt: "A chamber office-bearer shaking hands with a visiting government dignitary at an LCCI reception.",
  },
};

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-ink-950">
      <ArchPattern />

      <div className="container-page relative py-16 lg:py-24">
        <div className="grid items-center gap-14 lg:grid-cols-12 lg:gap-16">
          {/* Message */}
          <div className="lg:col-span-6">
            <p className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-[0.14em] text-brand-300 ring-1 ring-inset ring-white/10">
              Serving Lahore&rsquo;s businesses since 1923
            </p>

            <h1 className="mt-6 font-display text-[2.125rem] font-semibold leading-[1.1] tracking-tight text-white sm:text-display-lg lg:text-display-xl">
              The chamber that speaks for{" "}
              <span className="text-brand-300">20,000 businesses</span> in
              Lahore.
            </h1>

            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-200">
              Join or renew online, get your certificates of origin and
              attestation without a trip across the city, and put your case to
              government through the chamber&rsquo;s committees.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3">
              <ButtonLink href="/membership/apply" size="lg">
                Join LCCI
                <ArrowRight className="h-4 w-4" aria-hidden />
              </ButtonLink>
              <ButtonLink href="/services" size="lg" variant="onDark">
                Smart Services
              </ButtonLink>
            </div>

            <p className="mt-6 text-sm text-ink-400">
              Already a member?{" "}
              <a
                href="/portal"
                className="font-medium text-ink-200 underline underline-offset-4 hover:text-white"
              >
                Sign in to renew or track a request
              </a>
            </p>
          </div>

          {/* Collage */}
          <div className="lg:col-span-6">
            <PhotoCollage />
          </div>
        </div>
      </div>
    </section>
  );
}

function PhotoCollage() {
  return (
    <div className="relative">
      {/* Offset outline behind the stack, giving the group a pinned-print feel
          without rotating the photographs themselves (which would soften the
          faces and risk clipping at narrow widths). */}
      <div
        aria-hidden
        className="absolute -inset-3 rounded-2xl border border-brand-400/30 lg:-inset-4"
      />
      <div
        aria-hidden
        className="absolute -inset-3 translate-x-2 translate-y-2 rounded-2xl border border-white/5 lg:-inset-4 lg:translate-x-3 lg:translate-y-3"
      />

      <div className="relative space-y-3">
        <Frame className="aspect-[16/10]">
          <Image
            src={PHOTOS.main.src}
            alt={PHOTOS.main.alt}
            fill
            priority
            sizes="(min-width: 1024px) 42vw, 92vw"
            className="object-cover"
          />
          <figcaption className="absolute bottom-0 start-0 m-3 inline-flex items-center gap-2 rounded-md bg-ink-950/80 px-2.5 py-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-white backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-300" aria-hidden />
            Annual General Meeting
          </figcaption>
        </Frame>

        <div className="grid h-32 grid-cols-5 gap-3 sm:h-40 lg:h-36 xl:h-44">
          <Frame className="col-span-2 h-full">
            <Image
              src={PHOTOS.left.src}
              alt={PHOTOS.left.alt}
              fill
              sizes="(min-width: 1024px) 17vw, 37vw"
              className="object-cover"
            />
          </Frame>
          <Frame className="col-span-3 h-full">
            <Image
              src={PHOTOS.right.src}
              alt={PHOTOS.right.alt}
              fill
              sizes="(min-width: 1024px) 25vw, 55vw"
              className="object-cover"
            />
          </Frame>
        </div>
      </div>
    </div>
  );
}

/** Shared panel treatment: rounded, inset hairline, warm shadow. */
function Frame({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <figure
      className={`relative overflow-hidden rounded-xl bg-ink-900 shadow-raised ring-1 ring-inset ring-white/15 ${className ?? ""}`}
    >
      {children}
    </figure>
  );
}

/** Repeating pointed-arch colonnade, echoing Lahore's own architecture. */
function ArchPattern() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        className="absolute -start-24 top-0 h-full w-[40rem] opacity-[0.12]"
        viewBox="0 0 560 420"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <linearGradient id="archFade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2cbd7d" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#2cbd7d" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((i) => (
          <g key={i} transform={`translate(${i * 140} 0)`}>
            <path
              d="M20 420V150C20 95 55 55 90 55C125 55 160 95 160 150V420"
              stroke="url(#archFade)"
              strokeWidth="2"
            />
            <path
              d="M55 420V190C55 160 70 140 90 140C110 140 125 160 125 190V420"
              stroke="url(#archFade)"
              strokeWidth="1.25"
            />
          </g>
        ))}
      </svg>

      <div className="absolute -start-32 -top-32 h-[32rem] w-[32rem] rounded-full bg-brand-500/12 blur-3xl" />
    </div>
  );
}
