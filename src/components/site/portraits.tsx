import Image from "next/image";
import type { Portrait } from "@/content/types";

/**
 * The chamber's people, with their faces.
 *
 * lcci.com.pk prints a photograph beside each of its office-bearers and each
 * of its sixty-one former presidents. None of those pictures survived the
 * import, for a reason worth repeating here: `sanitiseBody` drops `<img>` on
 * write, because an image with no alt text is how an undescribed photograph
 * reaches a page. So a portrait is structured content — a name, a face, a
 * description and an owner — and these components are what render it.
 *
 * ## Why the frame is fixed and the image is not cropped by CSS alone
 *
 * The sources are sixty-two studio portraits scanned and re-scanned over
 * thirty years: some are 3:4, several are nearly square, two are landscape.
 * `object-cover` inside a fixed aspect ratio is what makes a grid of them read
 * as one set, and `object-top` is the part that matters — centring a tall
 * portrait crops the forehead, and cropping a face is worse than a margin.
 *
 * ## No lazy-loading opt-out, and no `priority`
 *
 * `images.unoptimized` is set in `next.config.ts` (see `DEPLOYMENT.md` §4:
 * `sharp` OOMs the Passenger worker), so `next/image` emits a plain `<img>`
 * with width, height and `loading="lazy"`. That is the behaviour we want on a
 * page carrying sixty-one of them, and the reason the import resized every
 * file to 480px wide: the whole set is 1.4 MB, so there is nothing to optimise
 * at request time.
 */

/** The photograph alone, in a fixed frame. */
function Photo({
  portrait,
  className,
  sizes,
}: {
  portrait: Portrait;
  className: string;
  sizes: string;
}) {
  return (
    <Image
      src={portrait.photo.src}
      // The media library's own alt text, which names the person — a
      // deliberate departure from the rule on the chamber's event photography,
      // where nobody had said who was in the frame. Here the chamber prints
      // the name beside the face on its own page. See
      // `scripts/import-portraits.ts`.
      alt={portrait.photo.altEn}
      width={portrait.photo.width}
      height={portrait.photo.height}
      sizes={sizes}
      className={className}
    />
  );
}

/**
 * One office-bearer: a large portrait with the post under the name.
 *
 * Not a link. There is no page for a person — the chamber publishes a message
 * from its President and contact details for its secretariat, and inventing a
 * profile page per office-bearer would be inventing content. So the card keeps
 * the green hairline the rest of the site uses and drops the hover lift, which
 * on a surface nothing happens when you click is a promise it cannot keep.
 */
export function OfficeBearerCard({ portrait }: { portrait: Portrait }) {
  return (
    <figure className="flex h-full flex-col overflow-hidden rounded-[20px] border border-brand-300 bg-white shadow-depth-1">
      {/* Inset, which looks like a detail and is not.
          Several of these photographs carry a frame baked into the pixels —
          a tan mount on the studio portraits, a black one on the older
          pictures, because they are photographs *of* framed portraits. Run
          flush to the card's edge, that frame meets our green hairline and
          the card reads as a border drawn twice. A margin of white turns the
          same pixels into what they are: a framed picture sitting on a card.
          Trimming the frames at import was the other option and is worse —
          the mounts vary, some carry a printed caption, and an automatic crop
          that gets one wrong takes somebody's chin off. */}
      <div className="p-3 pb-0">
        <div className="relative aspect-[4/5] overflow-hidden rounded-lg bg-stone-100">
          <Photo
            portrait={portrait}
            sizes="(min-width: 64rem) 20rem, (min-width: 40rem) 45vw, 90vw"
            className="h-full w-full object-cover object-top"
          />
        </div>
      </div>

      <figcaption className="flex flex-1 flex-col gap-1 p-5">
        {portrait.role ? (
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-brand-700">
            {portrait.role}
          </span>
        ) : null}
        <span className="font-display text-lg leading-snug font-semibold text-ink-950">
          {portrait.nameEn}
        </span>
        {portrait.term ? (
          <span className="text-[0.875rem] text-ink-600">{portrait.term}</span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/**
 * The office-bearers, as a band.
 *
 * Renders nothing at all when there are none, rather than an empty heading: a
 * chamber between terms is a real state, and a section header over no cards
 * reads as a page that failed to load.
 */
export function OfficeBearers({
  portraits,
  heading = "Office-bearers",
}: {
  portraits: readonly Portrait[];
  heading?: string;
}) {
  if (portraits.length === 0) return null;

  return (
    <section aria-labelledby="office-bearers">
      <h2
        id="office-bearers"
        className="font-display text-xl font-semibold tracking-tight text-ink-950"
      >
        {heading}
      </h2>

      <ul className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {portraits.map((portrait) => (
          <li key={portrait.slug}>
            <OfficeBearerCard portrait={portrait} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A portrait at thumbnail size, for a name inside a page's own prose.
 *
 * Square, because this sits at the top-left of a roster card beside a name of
 * one to four lines and a column of sixty-one differently-shaped frames is
 * what makes a list of people look like a database dump. `object-top` again:
 * a square crop of a tall portrait takes the chin off otherwise.
 */
export function PortraitThumb({ portrait }: { portrait: Portrait }) {
  return (
    <span className="relative block size-16 shrink-0 overflow-hidden rounded-lg bg-stone-100 ring-1 ring-inset ring-stone-200 sm:size-20">
      <Photo
        portrait={portrait}
        sizes="5rem"
        className="h-full w-full object-cover object-top"
      />
    </span>
  );
}

/**
 * The placeholder for a name with no photograph on file.
 *
 * A letter in a tinted square, not an icon of a person: a grey silhouette
 * repeated down a column reads as a column of broken images, and an initial
 * reads as a name. It keeps the thumbnail's exact footprint so the roster's
 * left edge stays straight whether or not a face was found, which is the only
 * reason it exists rather than rendering nothing.
 *
 * **The letter is drawn by CSS from `data-initial`, and that is not a style
 * choice.** A letter written into the markup is a word as far as
 * `scripts/verify-migrated-text.ts` is concerned, and on the roster it would
 * land between the last word of one person's entry and the first word of the
 * next — breaking every six-word run that spans them. `aria-hidden` does not
 * help: that check reads text, not the accessibility tree. See
 * `portrait-initial` in `globals.css`, and the same trick on the numbered
 * grid in `editorial-body.tsx`.
 */
export function PortraitPlaceholder({ name }: { name: string }) {
  // The first letter of the first word that starts with one, so "Mr." and
  // "M/s" do not give every third person the same initial.
  const initial = /\p{L}/u.exec(name)?.[0]?.toUpperCase() ?? "";

  return (
    <span
      aria-hidden
      data-initial={initial}
      className="portrait-initial flex size-16 shrink-0 items-center justify-center rounded-lg bg-stone-100 font-display text-xl font-semibold text-stone-400 ring-1 ring-inset ring-stone-200 sm:size-20 sm:text-2xl"
    />
  );
}
