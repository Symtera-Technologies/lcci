import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { SectionIndex } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";

/**
 * The reference section's landing page.
 *
 * Carries the old site's own "Useful Links" index above the list of the
 * sixteen pages it leads to. The index below it is generated from the
 * navigation, so a list added to the section appears here with no second edit.
 */
const PATH = "/resources" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "an introduction to these lists",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default function ResourcesPage() {
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
