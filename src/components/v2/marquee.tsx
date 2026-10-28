import { cn } from "@/lib/cn";

/**
 * A continuously scrolling strip, with no JS at all.
 *
 * The children are rendered twice and the track translates by exactly -50%, so
 * the second copy lands precisely where the first began and the loop is
 * seamless. The duplicate is `aria-hidden` and the whole track is marked
 * `role="marquee"`-free on purpose: to assistive tech this is one plain list,
 * read once.
 *
 * It pauses on hover and on focus-within, so a reader can actually stop and
 * read an item — an endlessly moving strip that cannot be paused is a WCAG 2.2
 * failure, not a flourish. Under reduced motion the animation is suppressed by
 * the global rule and the strip simply sits still.
 */
export function Marquee({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "group relative flex overflow-hidden",
        // Fade the strip into the background at both ends rather than letting
        // items be guillotined by the container edge.
        "[mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]",
        className,
      )}
    >
      <div className="flex w-max animate-marquee gap-4 group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused] motion-reduce:animate-none">
        <div className="flex shrink-0 items-stretch gap-4">{children}</div>
        <div className="flex shrink-0 items-stretch gap-4" aria-hidden>
          {children}
        </div>
      </div>
    </div>
  );
}
