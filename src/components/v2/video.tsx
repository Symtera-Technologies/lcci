import Link from "next/link";
import { ArrowRight, ExternalLink, ShieldCheck } from "lucide-react";
import { getFeaturedVideos, YOUTUBE_CHANNEL_URL } from "@/content/repository";
import { VideoPlayer } from "@/components/v2/video-player";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { VideoItem } from "@/content/types";

/**
 * The channel — variant 2.
 *
 * A dark band between the newsroom and the advocacy section. Every other
 * section on this page earns a light surface; this one does not, because the
 * content is moving pictures and a stage reads as a stage.
 *
 * The layout is built around the one fact the data insists on: `orientation`.
 * The chamber's channel genuinely carries a widescreen documentary alongside
 * vertical Shorts filmed on a phone in the boardroom, so the section is two
 * deliberate registers rather than one grid with two aspect ratios in it —
 * a widescreen row (the film large, the week's meeting beside it at a smaller
 * size, both 16:9) over a filmstrip of 9:16 Shorts. Shapes are grouped with
 * their own kind, which is what stops the mix reading as a mistake.
 *
 * Nothing here contacts Google until a visitor presses play; see
 * `video-player.tsx` for why that is worth a component.
 */
export async function VideoV2() {
  const videos = await getFeaturedVideos(5);

  const landscape = videos.filter((v) => v.orientation === "landscape");
  const shorts = videos.filter((v) => v.orientation === "portrait").slice(0, 3);

  // The feature is chosen by the thing that makes it a feature — it is the one
  // upload with an editorial description — not by position in the array, which
  // is publication order and would hand the big frame to whatever went up last.
  const feature = landscape.find((v) => v.description) ?? landscape[0] ?? videos[0];
  if (!feature) return null;

  const alsoWidescreen = landscape.filter((v) => v.id !== feature.id).slice(0, 2);

  return (
    <section
      aria-labelledby="v2-video-heading"
      className="relative isolate overflow-hidden bg-ink-950 text-white"
    >
      {/* A still wash, not a drifting one. This band sits between two others
          that already move, and light crawling behind a video frame competes
          with the only thing in the section that is meant to move. It is also
          why there is no `v2-parallax` here: that utility drives `translate`,
          which is the property holding this layer on centre. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-[-20rem] h-[34rem] w-[56rem] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse,var(--color-brand-700)_0%,transparent_70%)] opacity-40 blur-3xl" />
        <div className="absolute -right-40 bottom-[-12rem] h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle,var(--color-ink-700)_0%,transparent_72%)] opacity-60 blur-3xl" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
      </div>

      <div className="container-page py-20 lg:py-28">
        <div className="flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-300">
              On the channel
            </p>
            <h2
              id="v2-video-heading"
              className="mt-4 font-display text-display-lg font-semibold text-white"
            >
              The chamber on film
            </h2>
            <p className="mt-5 text-base leading-relaxed text-ink-300">
              A documentary on the year&rsquo;s work, the meetings that make the
              news, and short dispatches filmed in the chamber&rsquo;s own rooms.
            </p>
          </div>

          {/* The archive on this site is the primary destination; YouTube is
              offered second and marked as leaving, because a reader who wants
              the chamber's video record should not have to accept Google's
              terms to see it. */}
          <div className="flex shrink-0 flex-col items-start gap-3.5 sm:flex-row sm:items-center sm:gap-7">
            <Link
              href="/news/videos"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-white underline decoration-brand-400 decoration-from-font underline-offset-4 hover:text-brand-200"
            >
              All videos
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <a
              href={YOUTUBE_CHANNEL_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-2 text-sm text-ink-300 underline-offset-4 hover:text-white hover:underline"
            >
              {/* An outbound mark rather than a YouTube logo: lucide carries
                  no brand glyph, and a borrowed wordmark on a chamber page
                  implies an endorsement neither party has given. */}
              <ExternalLink className="h-4 w-4" aria-hidden />
              The chamber&rsquo;s channel on YouTube
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        </div>

        {/* --- Widescreen -------------------------------------------------- */}

        <div className="mt-12 grid gap-12 lg:mt-16 lg:grid-cols-12 lg:gap-x-10">
          <article className="lg:col-span-7">
            {/* The reveal is on this wrapper and never on the frame itself: an
                element that is still animating in while its iframe mounts is
                the one way to make a click-to-load player feel unreliable. */}
            <div className="v2-reveal">
              <VideoPlayer
                youtubeId={feature.youtubeId}
                title={feature.titleEn}
                poster={feature.poster}
                orientation={feature.orientation}
                scale="lg"
                sizes="(min-width: 1280px) 44rem, (min-width: 1024px) 56vw, 100vw"
                className="shadow-depth-3"
              />
            </div>

            <h3 className="mt-7 font-display text-display-sm font-semibold text-white">
              {feature.titleEn}
            </h3>
            <UrduTitle item={feature} />
            {feature.description && (
              <p className="mt-3.5 max-w-xl text-[0.9375rem] leading-relaxed text-ink-300">
                {feature.description}
              </p>
            )}
            <Published item={feature} className="mt-4" />
          </article>

          {alsoWidescreen.length > 0 && (
            <div className="lg:col-span-5">
              <h3
                id="v2-video-more-heading"
                className="border-b border-white/15 pb-3 text-xs font-semibold uppercase tracking-[0.14em] text-ink-300"
              >
                Also this week
              </h3>

              <ul
                aria-labelledby="v2-video-more-heading"
                className="mt-7 space-y-9"
              >
                {alsoWidescreen.map((v) => (
                  <li key={v.id} className="v2-reveal">
                    <article>
                      <VideoPlayer
                        youtubeId={v.youtubeId}
                        title={v.titleEn}
                        poster={v.poster}
                        orientation={v.orientation}
                        scale="sm"
                        sizes="(min-width: 1280px) 30rem, (min-width: 1024px) 40vw, 100vw"
                        className="shadow-depth-2"
                      />
                      <h4 className="mt-5 font-display text-lg font-semibold leading-snug text-white">
                        {v.titleEn}
                      </h4>
                      <UrduTitle item={v} />
                      <Published item={v} className="mt-3" />
                    </article>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* --- Shorts ------------------------------------------------------ */}

        {shorts.length > 0 && (
          <div className="mt-16 lg:mt-24">
            <div className="flex items-end justify-between gap-4 border-b border-white/15 pb-3">
              <h3
                id="v2-shorts-heading"
                className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-300"
              >
                Shorts from the building
              </h3>
              {/* Says the shape out loud. The rail looks like an editorial
                  decision rather than a broken grid once the reader is told
                  these were filmed vertically. */}
              <p className="text-xs text-ink-400">Filmed vertically, 9:16</p>
            </div>

            <div className="mt-7 grid gap-5 lg:grid-cols-4">
              {/* A scroll-snapping rail on small screens and a grid from `sm`
                  up. Three 9:16 cards stacked in one phone column would be
                  nearly two thousand pixels of scrolling for three videos,
                  which is how a vertical format ends up punished for being
                  vertical. The negative inline margin lets the rail bleed to
                  both edges of the viewport, so a half-visible fourth edge
                  shows there is more to drag. The rail needs no `tabindex` of
                  its own: every card holds a button, so tabbing through them
                  scrolls the strip, which is the keyboard path 2.1.1 asks for
                  without adding a focus stop that announces nothing. */}
              <ul
                aria-labelledby="v2-shorts-heading"
                className="-mx-4 flex snap-x snap-mandatory gap-5 overflow-x-auto px-4 pb-3 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0 lg:col-span-3"
              >
                {shorts.map((v) => (
                  <li
                    key={v.id}
                    className="v2-reveal w-[13.5rem] shrink-0 snap-start sm:w-auto"
                  >
                    <article>
                      <VideoPlayer
                        youtubeId={v.youtubeId}
                        title={v.titleEn}
                        poster={v.poster}
                        orientation={v.orientation}
                        scale="sm"
                        sizes="(min-width: 1024px) 18rem, (min-width: 640px) 30vw, 13.5rem"
                        className="shadow-depth-2"
                      />
                      <h4 className="mt-4 font-display text-[0.9375rem] font-semibold leading-snug text-white">
                        {v.titleEn}
                      </h4>
                      <UrduTitle item={v} />
                      <Published item={v} className="mt-2.5" />
                    </article>
                  </li>
                ))}
              </ul>

              {/* The fourth column. Not a video, deliberately: it keeps the
                  rail from trailing off into empty stage, and it is where the
                  section's actual promise to the reader is written down.
                  Text here is ink-300, not ink-400 — the glass panel sits a
                  few per cent lighter than ink-950 and ink-400 is only 5.05:1
                  against the flat colour, so it has no contrast to spare. */}
              <aside className="v2-glass flex flex-col rounded-2xl p-6 shadow-depth-2">
                <ShieldCheck className="h-5 w-5 text-brand-300" aria-hidden />
                <h3 className="mt-4 font-display text-lg font-semibold leading-snug text-white">
                  Nothing loads until you press play
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-300">
                  Every still on this page is served from the chamber&rsquo;s own
                  site. No request reaches YouTube and no cookie is set until you
                  start a video yourself.
                </p>
              </aside>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The Urdu title, where there is one.
 *
 * Shown rather than dropped: roughly half the chamber's own uploads are
 * published in Urdu, and hiding that behind an English translation would
 * misrepresent the channel to the readers most likely to watch it. Tagged
 * `lang` and `dir` so it is announced in the right voice and laid out from
 * the right edge, and given loose leading because Urdu ascenders and
 * descenders need the room.
 */
function UrduTitle({ item }: { item: VideoItem }) {
  if (!item.titleUr) return null;
  return (
    <p
      lang="ur"
      dir="rtl"
      className="mt-2.5 text-[0.9375rem] leading-loose text-ink-300"
    >
      {item.titleUr}
    </p>
  );
}

function Published({ item, className }: { item: VideoItem; className?: string }) {
  return (
    <p
      className={cn(
        "text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-ink-400 tabular-nums",
        className,
      )}
    >
      {/* ink-400 is 5.05:1 on ink-950 and is used only against that flat
          colour. Nothing in this section puts it on a panel. */}
      <time dateTime={item.publishedAt}>{formatDate(item.publishedAt)}</time>
    </p>
  );
}
