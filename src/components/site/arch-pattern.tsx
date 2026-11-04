/**
 * The Mughal-arch motif that sits behind every dark panel on the site.
 *
 * Lifted out of `src/components/home/hero.tsx`, where it was written, because
 * the interior pages' header now uses the same dark panel and a second copy of
 * these paths is a second place for the opacity, the arch spacing or the green
 * to drift. The homepage and an interior header looking *nearly* the same is
 * worse than either looking different on purpose.
 *
 * It is `aria-hidden` and `pointer-events-none` throughout: it carries no
 * meaning and must never intercept a click on the heading or the breadcrumb
 * above it.
 *
 * `side` exists because the two placements want opposite anchors. The homepage
 * hero puts its message on the left, so the arches rise on the left behind it;
 * an interior header's text starts at the same left edge but the panel is a
 * third of the height, so the arches read better pushed to the trailing edge
 * where nothing sits on top of them.
 */

export function ArchPattern({
  side = "start",
  className,
}: {
  /** Which edge the arcade rises from. Logical, so it follows an RTL flip. */
  side?: "start" | "end";
  className?: string;
}) {
  const atStart = side === "start";

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className ?? ""}`}
    >
      <svg
        className={
          "absolute top-0 h-full w-[40rem] opacity-[0.12] " +
          (atStart ? "-start-24" : "-end-24")
        }
        viewBox="0 0 560 420"
        fill="none"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* The id is scoped to the instance so two panels on one page — a
              dark header above a dark closing band — cannot both resolve to
              whichever gradient the document happened to define first. */}
          <linearGradient id={`archFade-${side}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2cbd7d" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#2cbd7d" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3].map((i) => (
          <g key={i} transform={`translate(${i * 140} 0)`}>
            <path
              d="M20 420V150C20 95 55 55 90 55C125 55 160 95 160 150V420"
              stroke={`url(#archFade-${side})`}
              strokeWidth="2"
            />
            <path
              d="M55 420V190C55 160 70 140 90 140C110 140 125 160 125 190V420"
              stroke={`url(#archFade-${side})`}
              strokeWidth="1.25"
            />
          </g>
        ))}
      </svg>

      <div
        className={
          "absolute -top-32 h-[32rem] w-[32rem] rounded-full bg-brand-500/12 blur-3xl " +
          (atStart ? "-start-32" : "-end-32")
        }
      />
    </div>
  );
}
