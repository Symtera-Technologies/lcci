import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getGalleryAlbum } from "@/content/repository";
import { GalleryLightbox } from "@/components/v2/gallery-lightbox";
import { formatDate } from "@/lib/format";

/**
 * Photo gallery — variant 2.
 *
 * The only light band between the video section above and the advocacy band
 * below, so it is the page's breath: white rather than stone, and the one
 * place where photographs are allowed to carry the section on their own.
 *
 * The album is deliberately presented as *an album* — one title, one
 * standfirst, one date — rather than as loose images. The legacy site's gallery
 * is an undated heap in which no photograph can be placed in time or context,
 * and no amount of layout fixes that; a date and a caption do.
 */
export async function GalleryV2() {
  const album = await getGalleryAlbum();

  return (
    <section aria-labelledby="v2-gallery-heading" className="bg-white">
      <div className="container-page py-20 lg:py-28">
        {/* The section's only reveal. Six photographs arriving one after another
            would read as a slot machine, and the mosaic already carries enough
            movement on its own. */}
        <div className="v2-reveal grid gap-6 lg:grid-cols-12 lg:items-end lg:gap-10">
          <div className="lg:col-span-7">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
              Photo gallery
            </p>
            <h2
              id="v2-gallery-heading"
              className="mt-3 font-display text-display-md font-semibold text-ink-950"
            >
              {album.titleEn}
            </h2>
            <p className="mt-3 max-w-prose text-base leading-relaxed text-stone-600">
              {album.description}
            </p>
          </div>

          <div className="lg:col-span-5 lg:text-end">
            <p className="text-sm text-stone-600">
              Photographed{" "}
              <time
                dateTime={album.occurredAt}
                className="font-medium text-ink-950 tabular-nums"
              >
                {formatDate(album.occurredAt)}
              </time>
            </p>
            <p className="mt-2">
              <Link
                href="/news/galleries"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-700 underline-offset-4 hover:text-ink-950 hover:underline"
              >
                All galleries
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </p>
          </div>
        </div>

        {/* The mosaic and its viewer are one client component: a tile and the
            button that opens it are the same object, so splitting them would
            only buy a context provider. */}
        <GalleryLightbox
          className="mt-10 lg:mt-14"
          albumTitle={album.titleEn}
          images={album.images}
        />
      </div>
    </section>
  );
}
