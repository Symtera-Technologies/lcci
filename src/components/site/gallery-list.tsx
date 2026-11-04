import Image from "next/image";
import type { GalleryAlbum } from "@/content/types";
import { formatDate } from "@/lib/format";

/**
 * Every published album, each a dated heading over its photographs.
 *
 * **No lightbox.** The homepage's gallery has one, and it is a client
 * component; these interior pages otherwise ship no JavaScript at all, and the
 * thing a lightbox adds here — a bigger copy of the photograph — is already
 * one tap away, because each thumbnail is a link to the full image. That is
 * also the behaviour that works with JavaScript off, on a slow connection, and
 * for anyone who wants to save the picture.
 *
 * Albums are titled and dated because the legacy "Picture Gallery" was
 * neither: one undated album under a heading that said nothing about what was
 * being shown, so there was no way to tell last month's photographs from
 * 2015's.
 *
 * Every image's `alt` comes from `media_assets.alt_en`, which is NOT NULL —
 * the schema is what guarantees there is a description, rather than a habit
 * here. The alt text describes the photograph and names nobody, which is a
 * standing rule for the chamber's photography: a caption that identifies a
 * person is a claim about who was in the room.
 */

export function GalleryList({ albums }: { albums: readonly GalleryAlbum[] }) {
  return (
    <div className="space-y-16">
      {albums.map((album) => (
        <section key={album.slug} aria-labelledby={`album-${album.slug}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <h2
              id={`album-${album.slug}`}
              className="font-display text-xl font-semibold text-ink-950"
            >
              {album.titleEn}
            </h2>
            <time
              dateTime={album.occurredAt}
              className="text-[0.875rem] text-ink-600"
            >
              {formatDate(album.occurredAt)}
            </time>
          </div>

          <p className="mt-2 max-w-[68ch] leading-relaxed text-ink-700">
            {album.description}
          </p>

          <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {album.images.map((image) => (
              <li key={image.id}>
                <a
                  href={image.src}
                  // The photographs are the chamber's own, served from this
                  // origin, so this is a navigation to a larger copy rather
                  // than an outbound link.
                  className="group relative block aspect-[4/3] overflow-hidden rounded-xl bg-stone-100 ring-1 ring-inset ring-stone-200 transition-shadow hover:shadow-depth-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
                >
                  <Image
                    src={image.src}
                    alt={image.altEn}
                    fill
                    sizes="(min-width: 64rem) 18rem, (min-width: 40rem) 30vw, 45vw"
                    className="object-cover transition-transform duration-500 ease-out-expo motion-safe:group-hover:scale-[1.03]"
                  />
                </a>
                {image.caption ? (
                  <p className="mt-1.5 text-[0.8125rem] leading-snug text-ink-600">
                    {image.caption}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
