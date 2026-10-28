"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Expand, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GalleryImage } from "@/content/types";

/**
 * Where each photograph sits in the mosaic, and how wide it will actually be
 * rendered.
 *
 * Six landscape photographs in a 3×2 grid is the single thing that would make
 * this band look bought rather than made, so the grid is twelve columns of
 * 6.5rem rows and every cell is placed by hand in two bands:
 *
 *  - Band one is a lead photograph seven columns wide beside a stack of two
 *    five-column frames. At the page's full width the lead lands at roughly
 *    3:2, which is the source ratio, so the album's best photograph is the one
 *    cell that is barely cropped at all.
 *  - Band two steps down 5 / 4 / 3, which gives the band a falling cadence and
 *    hands the last frame an upright crop. Reading left to right the eye meets
 *    six different widths and four different shapes.
 *
 * Nothing taller than about 4:3 upright is asked of a landscape source: every
 * cell crops with `object-cover` from the centre, and a crop tighter than that
 * would start throwing away the people the photograph is of.
 *
 * `sizes` is measured against the real cell width at each breakpoint rather
 * than guessed, because the whole point of a mosaic of small frames is that the
 * small ones are cheap — a 300px cell must not fetch the 1080px candidate.
 */
const TILES: ReadonlyArray<{ cell: string; sizes: string }> = [
  {
    cell: "sm:col-span-2 lg:col-start-1 lg:col-span-7 lg:row-start-1 lg:row-span-4",
    sizes: "(min-width: 1280px) 700px, (min-width: 1024px) 57vw, 94vw",
  },
  {
    cell: "lg:col-start-8 lg:col-span-5 lg:row-start-1 lg:row-span-2",
    sizes:
      "(min-width: 1280px) 500px, (min-width: 1024px) 41vw, (min-width: 640px) 46vw, 94vw",
  },
  {
    cell: "lg:col-start-8 lg:col-span-5 lg:row-start-3 lg:row-span-2",
    sizes:
      "(min-width: 1280px) 500px, (min-width: 1024px) 41vw, (min-width: 640px) 46vw, 94vw",
  },
  {
    cell: "lg:col-start-1 lg:col-span-5 lg:row-start-5 lg:row-span-3",
    sizes:
      "(min-width: 1280px) 500px, (min-width: 1024px) 41vw, (min-width: 640px) 46vw, 94vw",
  },
  {
    cell: "lg:col-start-6 lg:col-span-4 lg:row-start-5 lg:row-span-3",
    sizes:
      "(min-width: 1280px) 400px, (min-width: 1024px) 33vw, (min-width: 640px) 46vw, 94vw",
  },
  {
    cell: "sm:col-span-2 lg:col-start-10 lg:col-span-3 lg:row-start-5 lg:row-span-3",
    sizes: "(min-width: 1280px) 300px, (min-width: 1024px) 25vw, 94vw",
  },
];

/**
 * Shared chrome for the viewer's three controls.
 *
 * The fill is near-transparent on purpose — these sit over a photograph — so
 * the ring is what makes them findable, and `white/40` is the thinnest ring
 * that still clears 3:1 against the ink backdrop. `white/25` reads nicer and
 * fails, which is why it is not here.
 */
const CONTROL = cn(
  "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
  "pointer-events-auto bg-white/10 text-white ring-1 ring-white/40",
  "transition-colors duration-200 ease-out-quint",
  "hover:bg-white/20 hover:ring-white/70",
  // The global focus ring squares its radius off to 2px, which looks like a
  // mistake on a circle.
  "focus-visible:rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400",
);

interface GalleryLightboxProps {
  images: GalleryImage[];
  albumTitle: string;
  className?: string;
}

export function GalleryLightbox({
  images,
  albumTitle,
  className,
}: GalleryLightboxProps) {
  const [index, setIndex] = useState<number | null>(null);
  const triggers = useRef<Array<HTMLButtonElement | null>>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Which tile opened the viewer, remembered separately from the index because
  // prev/next move the index and focus must go back where it came from.
  // Deliberately not `document.activeElement` at open time: Safari does not
  // focus a button on click, so that read lands on the body and the reader is
  // returned to the top of the document instead of to the photograph.
  const openedFrom = useRef<number | null>(null);

  const open = index !== null;

  // Resolved lazily rather than in an effect, mirroring the mobile drawer in
  // the site header. There is no hydration hazard because the dialog only ever
  // mounts after a click, by which time the document exists either way.
  const [container] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" ? null : document.body,
  );

  const close = useCallback(() => setIndex(null), []);

  // Wrapping rather than clamping, so neither control is ever disabled. A
  // disabled button at the end of an album drops out of the tab ring and takes
  // the reader's focus with it, which is a worse failure than looping.
  const step = useCallback(
    (delta: number) => {
      setIndex((current) =>
        current === null
          ? current
          : (current + delta + images.length) % images.length,
      );
    },
    [images.length],
  );

  /**
   * Everything that happens because the dialog is open, in one effect keyed on
   * the boolean rather than on the index — stepping between photographs must
   * not re-run any of it, or every arrow press would snatch focus back out of
   * the control the reader is holding.
   *
   * Three jobs:
   *  - Seal the page. `aria-modal` is a promise to assistive technology, not an
   *    enforcement; `inert` on the dialog's siblings is what actually stops a
   *    virtual cursor, a Tab press or a trackpad scroll reaching the page
   *    behind. Only elements that were not already inert are touched, so the
   *    cleanup cannot un-inert something that someone else owns.
   *  - Move focus in, to the panel itself, so the dialog's name and the live
   *    region are read before the controls.
   *  - Give focus back on the way out. It belongs in the cleanup because the
   *    trigger is a child of a sealed element: `focus()` is silently ignored
   *    while `inert` is still set, so the restore has to come after the
   *    attributes are removed, in that order.
   */
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;

    // Read now rather than in the cleanup. The array itself never changes
    // identity and `openedFrom` is already set by the click that opened the
    // viewer, so this is the same value either way — and it keeps the
    // stale-ref lint rule satisfied honestly rather than by suppression.
    const tiles = triggers.current;
    const opener = openedFrom.current;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    const sealed = Array.from(body.children).filter(
      (el) => el !== panel && !el.hasAttribute("inert"),
    );
    for (const el of sealed) el.setAttribute("inert", "");

    panel.focus();

    return () => {
      for (const el of sealed) el.removeAttribute("inert");
      body.style.overflow = previousOverflow;
      if (opener !== null) tiles[opener]?.focus();
      openedFrom.current = null;
    };
  }, [open]);

  /**
   * The trap. Focus cannot leave the panel, so every key the dialog cares about
   * arrives here by bubbling and no document-level listener is needed.
   *
   * Only buttons are queried because the dialog contains nothing else focusable
   * — no links, no fields — and a generic focusable selector would have to
   * filter out the panel's own `tabIndex={-1}` and anything hidden.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key !== "Tab") return;

    const panel = panelRef.current;
    if (!panel) return;

    const stops = Array.from(
      panel.querySelectorAll<HTMLButtonElement>("button:not([disabled])"),
    );
    if (stops.length === 0) {
      event.preventDefault();
      return;
    }

    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panel)) {
      event.preventDefault();
      first.focus();
    }
  };

  const current = index === null ? null : images[index];

  return (
    <>
      <ul
        className={cn(
          "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-12 lg:auto-rows-[6.5rem]",
          className,
        )}
      >
        {images.map((image, i) => (
          <li key={image.id} className={TILES[i].cell}>
            {/* Below `lg` the mosaic collapses to stacked 3:2 frames, which is
                the source ratio and so the one arrangement that crops nothing.
                `lg:aspect-auto` then hands the height back to the grid rows. */}
            <figure className="group relative aspect-[3/2] h-full overflow-hidden rounded-2xl bg-stone-200 ring-1 ring-stone-200 transition-shadow duration-300 ease-out-expo hover:shadow-depth-3 hover:ring-brand-500 focus-within:shadow-depth-3 focus-within:ring-brand-500 lg:aspect-auto">
              <Image
                src={image.src}
                alt={image.altEn}
                width={image.width}
                height={image.height}
                sizes={TILES[i].sizes}
                className={cn(
                  "h-full w-full object-cover object-center",
                  // Scale rather than tilt: tilting a photograph swings its
                  // plane and exposes the rounded corners it is clipped by,
                  // whereas a push inside a fixed frame is how a photograph has
                  // always been given weight. It is also `scale` and not
                  // `transform`, which is a separate property in Tailwind 4.
                  "transition-[scale] duration-500 ease-out-expo group-hover:scale-[1.04]",
                  "motion-reduce:transition-none motion-reduce:group-hover:scale-100",
                )}
              />

              {image.caption && (
                <>
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-ink-950/92 via-ink-950/55 to-transparent"
                  />
                  {/* The caption is always on the photograph, never revealed on
                      hover. A hover-only caption does not exist on a phone and
                      cannot be read by anyone tabbing, and a dated, described
                      album is the entire argument this section is making. */}
                  <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 p-4">
                    <p className="line-clamp-3 text-[0.8125rem] font-medium leading-snug text-white">
                      {image.caption}
                    </p>
                  </figcaption>
                </>
              )}

              <span
                aria-hidden
                className="pointer-events-none absolute end-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-ink-950/80 text-white ring-1 ring-white/40 transition-colors duration-200 ease-out-quint group-hover:bg-brand-600"
              >
                <Expand className="h-3.5 w-3.5" />
              </span>

              {/* The whole frame is the control, so the button is laid over it
                  rather than wrapped around it: that keeps the image's own alt
                  text out of the button's accessible name, which is composed
                  here instead. */}
              <button
                ref={(el) => {
                  triggers.current[i] = el;
                }}
                type="button"
                onClick={() => {
                  openedFrom.current = i;
                  setIndex(i);
                }}
                aria-label={`View photograph ${i + 1} of ${images.length} at full size: ${image.altEn}`}
                className="absolute inset-0 cursor-pointer rounded-2xl focus-visible:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
              />
            </figure>
          </li>
        ))}
      </ul>

      {/* Portalled to the body, and not merely for tidiness: an ancestor with
          `backdrop-filter` becomes the containing block for `position: fixed`,
          so a viewer rendered in place would be trapped inside whichever
          frosted panel happened to be above it in the tree and would scroll
          with the page. */}
      {open && current && container
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              className="fixed inset-0 z-[70] bg-ink-950/95 outline-none"
            >
              {/* Click-anywhere-else to close. The chrome above it is laid out
                  across the whole viewport, so rather than guess at click
                  targets the chrome is made click-through and only the three
                  controls and the photograph itself take the pointer back. */}
              <div aria-hidden onClick={close} className="absolute inset-0" />

              <div className="pointer-events-none relative flex h-full flex-col">
                <div className="flex items-start justify-between gap-4 p-4 sm:p-6">
                  <div className="min-w-0">
                    <h2
                      id={titleId}
                      className="font-display text-lg font-semibold text-white"
                    >
                      {albumTitle}
                      <span className="sr-only"> — photograph viewer</span>
                    </h2>

                    {/* The counter is announced from a hidden live region and
                        the visible copy is hidden from assistive technology, so
                        a reader stepping through the album hears the new
                        position and its caption once rather than twice. */}
                    <p
                      role="status"
                      aria-live="polite"
                      aria-atomic="true"
                      className="sr-only"
                    >
                      Photograph {index + 1} of {images.length}.{" "}
                      {current.caption ?? current.altEn}
                    </p>
                    <p
                      aria-hidden
                      className="mt-1 text-sm text-ink-300 tabular-nums"
                    >
                      {index + 1} of {images.length}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={close}
                    aria-label="Close photograph viewer"
                    className={CONTROL}
                  >
                    <X className="h-5 w-5" aria-hidden />
                  </button>
                </div>

                <div className="flex min-h-0 flex-1 items-center justify-center px-4 sm:px-6">
                  <figure className="pointer-events-auto flex w-full max-w-5xl flex-col items-center gap-4">
                    {/* Capped against the viewport rather than against the flex
                        parent: a percentage max-height inside an auto-height
                        flex column resolves to none in some engines, and the
                        failure mode is a photograph that pushes the controls
                        off a short screen. */}
                    <Image
                      key={current.id}
                      src={current.src}
                      alt={current.altEn}
                      width={current.width}
                      height={current.height}
                      priority={false}
                      sizes="(min-width: 1024px) 1024px, 92vw"
                      className="h-auto w-auto max-h-[56vh] max-w-full rounded-xl object-contain shadow-depth-3 sm:max-h-[66vh]"
                    />
                    {current.caption && (
                      <figcaption className="v2-glass w-full rounded-xl px-4 py-3">
                        <p className="text-sm leading-relaxed text-white">
                          {current.caption}
                        </p>
                      </figcaption>
                    )}
                  </figure>
                </div>

                <div className="flex items-center justify-center gap-4 p-4 sm:p-6">
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    aria-label="Previous photograph"
                    className={CONTROL}
                  >
                    <ChevronLeft className="h-5 w-5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => step(1)}
                    aria-label="Next photograph"
                    className={CONTROL}
                  >
                    <ChevronRight className="h-5 w-5" aria-hidden />
                  </button>
                </div>
              </div>
            </div>,
            container,
          )
        : null}
    </>
  );
}
