"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Play } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ImageRef } from "@/content/types";

interface VideoPlayerProps {
  youtubeId: string;
  /** Used verbatim in the control's accessible name and the iframe title. */
  title: string;
  poster: ImageRef;
  orientation: "landscape" | "portrait";
  /** `sizes` for the poster: every slot in the section is a different width. */
  sizes: string;
  /** The feature film carries the larger affordance; rail cards the smaller. */
  scale?: "sm" | "lg";
  className?: string;
}

/**
 * Click-to-load YouTube facade.
 *
 * Until a visitor asks for the video this renders a poster served from this
 * origin and a button, and nothing else. That is the entire point of it: a
 * real embed on page load contacts Google for every reader, including the
 * majority who never press play, pulls several hundred kilobytes of player
 * script ahead of the page's own content, and sets identifiers the chamber has
 * no reason to be responsible for. The embed goes to youtube-nocookie.com for
 * the same reason, once the reader has made the choice themselves.
 *
 * The wrapper reserves the aspect ratio, so swapping poster for iframe moves
 * nothing else on the page.
 */
export function VideoPlayer({
  youtubeId,
  title,
  poster,
  orientation,
  sizes,
  scale = "lg",
  className,
}: VideoPlayerProps) {
  const [playing, setPlaying] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // The button unmounts the moment it is pressed, which would otherwise drop
  // focus back to the document and leave a keyboard reader at the top of the
  // page with a video playing somewhere below them.
  useEffect(() => {
    if (playing) frameRef.current?.focus();
  }, [playing]);

  return (
    <div
      className={cn(
        "relative w-full",
        // Portrait stays portrait. Fitting a Short into a 16:9 frame either
        // crops the speaker out of the top of the picture or sits the whole
        // thing between two black bars, and the posters are cropped 9:16 to
        // match the source. The shape is information about how it was filmed.
        orientation === "portrait" ? "aspect-[9/16]" : "aspect-video",
        className,
      )}
    >
      {playing ? (
        <iframe
          ref={frameRef}
          // Autoplay is honest at this point: the reader has just pressed play
          // and would otherwise have to press it a second time inside the
          // player they have only now been given.
          src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1`}
          title={`YouTube video player: ${title}`}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          className="absolute inset-0 h-full w-full rounded-2xl border-0 bg-ink-900"
        />
      ) : (
        /* A real button: keyboard reachable, announced as a control, and
           operable with Space as well as Enter, none of which a div with an
           onClick gives you.

           The rounding and the clipping sit on the button rather than on the
           wrapper, because `overflow-hidden` on an ancestor would crop this
           button's own focus outline, which is drawn outside its border box.

           The name is an `aria-label` rather than visually hidden text inside:
           the poster's alt text is a child of the button, so hidden text would
           be concatenated onto it and the control would announce a sentence
           about hard hats before it ever said "play". */
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play video: ${title}`}
          className="group absolute inset-0 w-full overflow-hidden rounded-2xl ring-1 ring-inset ring-white/15"
        >
          <Image
            src={poster.src}
            alt={poster.altEn}
            width={poster.width}
            height={poster.height}
            sizes={sizes}
            className="h-full w-full object-cover transition-[scale] duration-700 ease-out-expo motion-safe:group-hover:scale-[1.04]"
          />

          {/* A scrim. Not for legibility — every title sits outside the frame —
              but so the affordance holds against a bright photograph. It eases
              back on hover, which hands the picture to the reader. */}
          <span
            aria-hidden
            className="absolute inset-0 bg-gradient-to-t from-ink-950/70 via-ink-950/15 to-ink-950/10 transition-colors duration-500 ease-out-expo group-hover:from-ink-950/55"
          />

          {/* ring-white/40, not /25. A near-transparent fill means the ring is
              the control's only boundary, and 1.4.11 asks 3:1 of it: white at
              40% on ink-950 is 3.81:1, at 25% it is 2.22:1 and fails. On hover
              and on focus the fill becomes brand-400, which is 7.7:1 here, and
              the icon flips to ink so the glyph keeps its contrast too. */}
          <span
            aria-hidden
            className={cn(
              "absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full",
              "bg-ink-950/80 text-white ring-1 ring-white/40 shadow-depth-2",
              "transition-[background-color,color,scale] duration-300 ease-out-expo",
              "group-hover:bg-brand-400 group-hover:text-ink-950 group-hover:ring-brand-400",
              "group-focus-visible:bg-brand-400 group-focus-visible:text-ink-950",
              "motion-safe:group-hover:scale-110",
              scale === "lg" ? "h-20 w-20" : "h-14 w-14",
            )}
          >
            <Play
              className={cn("fill-current", scale === "lg" ? "h-7 w-7" : "h-5 w-5")}
            />
          </span>
        </button>
      )}
    </div>
  );
}
