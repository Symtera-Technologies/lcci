import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { SectionIndex } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";

/**
 * The Newsroom section's landing page.
 *
 * Prose above, the section's own index below it, generated from the navigation
 * so a page added to the section appears here with no second edit.
 */
const PATH = "/news" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "an introduction to the newsroom",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default function Page() {
  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
    >
      <SectionIndex section={PATH} />
    </CmsPage>
  );
}
