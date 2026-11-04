import type { VideoItem } from "@/content/types";
import { VideoPlayer } from "@/components/v2/video-player";
import { formatDate } from "@/lib/format";

/**
 * The chamber's videos, newest first.
 *
 * Each one is a click-to-load facade, not an embed: until a visitor presses
 * play, the page serves a poster from this origin and a button, and contacts
 * Google for nothing. On a page of a dozen videos that is the difference
 * between one request and a dozen player bundles, and it is why the public
 * CSP has no YouTube `script-src` entry at all. `VideoPlayer` is the same
 * component the homepage band uses, so there is one implementation of that
 * promise rather than two.
 *
 * **`orientation` decides the frame.** The channel mixes landscape films with
 * vertical Shorts, and YouTube pads a Short's thumbnail out to 16:9 with a
 * blurred copy of itself — so presenting one in a widescreen frame shows
 * blurred bars around a cropped subject. The shape travels with the content
 * for exactly this reason, and the grid gives a portrait video a narrower cell
 * rather than a letterboxed one.
 */

export function VideoList({ items }: { items: readonly VideoItem[] }) {
  return (
    <ul className="grid grid-cols-1 gap-8 sm:grid-cols-2">
      {items.map((video) => (
        <li key={video.id}>
          <article>
            <VideoPlayer
              youtubeId={video.youtubeId}
              title={video.titleEn}
              poster={video.poster}
              orientation={video.orientation}
              sizes="(min-width: 40rem) 50vw, 100vw"
              scale="sm"
              // A portrait video in a half-width cell would be taller than the
              // viewport, so it is capped and centred rather than stretched.
              className={
                video.orientation === "portrait" ? "mx-auto max-w-[18rem]" : undefined
              }
            />

            <h2 className="mt-3 font-display text-lg font-semibold leading-snug text-ink-950">
              {video.titleEn}
            </h2>
            <time
              dateTime={video.publishedAt}
              className="mt-1 block text-[0.8125rem] text-ink-600"
            >
              {formatDate(video.publishedAt)}
            </time>

            {video.description ? (
              <p className="mt-2 max-w-[60ch] text-[0.9375rem] leading-relaxed text-ink-700">
                {video.description}
              </p>
            ) : null}
          </article>
        </li>
      ))}
    </ul>
  );
}
