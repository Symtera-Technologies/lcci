import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { VideoList } from "@/components/site/video-list";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { getVideos } from "@/content/repository";

/**
 * The chamber's videos.
 *
 * Every one is a click-to-load facade rather than an embed, so this page
 * contacts Google for nothing until a visitor presses play. On a page of a
 * dozen videos an embed each would be a dozen player bundles, and it is why
 * the public CSP carries no YouTube `script-src` entry at all — see
 * `components/v2/video-player.tsx`, which is the same component the homepage
 * band uses.
 */
const PATH = "/news/videos" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's videos",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default async function VideosPage() {
  const videos = await getVideos();

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
      footer={
        <SectionFooter section="/news" exclude={PATH} title="More from the newsroom" />
      }
    >
      {videos.length > 0 ? <VideoList items={videos} /> : null}
    </CmsPage>
  );
}
