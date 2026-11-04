import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import {
  PRESS_RELEASES_PER_PAGE,
  PressReleaseList,
  PressReleasePager,
} from "@/components/site/press-release-list";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { getPressReleases } from "@/content/repository";

/**
 * The newsroom: page one of the press archive.
 *
 * Page one lives here and pages two onward at `/news/press-releases/page/[n]`,
 * so the first page has exactly one address. Two URLs for one page of content
 * is a duplicate a search engine has to choose between, and it does not
 * necessarily choose the one the navigation links to.
 *
 * Only this page carries the editable introduction. Repeating it on all 38
 * pages of the archive would put the same paragraph above every one of them,
 * which reads as boilerplate to a visitor and as near-duplicate content to a
 * crawler.
 */
const PATH = "/news/press-releases" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's press releases",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default async function PressReleasesPage() {
  const { items, total } = await getPressReleases({
    limit: PRESS_RELEASES_PER_PAGE,
  });

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
      footer={
        <SectionFooter section="/news" exclude={PATH} title="More from the newsroom" />
      }
    >
      {items.length > 0 ? (
        <>
          <PressReleaseList items={items} />
          <PressReleasePager
            page={1}
            pageCount={Math.ceil(total / PRESS_RELEASES_PER_PAGE)}
            total={total}
          />
        </>
      ) : null}
    </CmsPage>
  );
}
