import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { GalleryList } from "@/components/site/gallery-list";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { getGalleryAlbums } from "@/content/repository";

/**
 * The chamber's photograph albums, most recent occasion first.
 *
 * `getGalleryAlbums` returns an empty array rather than throwing, unlike the
 * homepage's `getGalleryAlbum` — this route carries its own heading,
 * breadcrumb and standfirst, so with nothing published it says so plainly
 * instead of leaving a headed band with blank lines in it.
 *
 * The two legacy albums — `about.php?id=137` and `about.php?id=142`, 42
 * photographs between them — are not here yet: they hold no text, so the page
 * migration had nothing to carry, and each photograph needs a description
 * before it can go into the media library. That is a real piece of work and
 * not a scrape.
 */
const PATH = "/news/galleries" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's photo galleries",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default async function GalleriesPage() {
  const albums = await getGalleryAlbums();

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
      footer={
        <SectionFooter section="/news" exclude={PATH} title="More from the newsroom" />
      }
    >
      {albums.length > 0 ? <GalleryList albums={albums} /> : null}
    </CmsPage>
  );
}
