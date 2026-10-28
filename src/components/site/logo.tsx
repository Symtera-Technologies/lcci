import Image from "next/image";
import { cn } from "@/lib/cn";

/**
 * The official LCCI logo — the cogwheel crest around Minar-e-Pakistan with the
 * "Service · Prosperity" motto and the 1923 founding date, plus the wordmark.
 *
 * The artwork already contains the chamber's name, so nothing is typeset beside
 * it. Two files rather than a CSS filter: the supplied PNG is dark green line
 * art that vanishes on the ink panels, and `invert()` would render the crest
 * magenta. `scripts/prepare-brand.mjs` derives the reversed version.
 */

const LOGO_W = 400;
const LOGO_H = 111;

export function Logo({
  className,
  onDark = false,
  priority = false,
}: {
  className?: string;
  onDark?: boolean;
  priority?: boolean;
}) {
  return (
    <Image
      src={onDark ? "/brand/lcci-logo-reversed.png" : "/brand/lcci-logo.png"}
      alt="The Lahore Chamber of Commerce & Industry"
      width={LOGO_W}
      height={LOGO_H}
      priority={priority}
      // The lockup is wide (400x111) and sets its name in two small lines, so
      // it needs real height to stay legible — 44px rendered the crest as mush.
      className={cn("h-12 w-auto sm:h-14", className)}
    />
  );
}
