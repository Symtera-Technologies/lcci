import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { navEntry } from "@/components/site/nav-data";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";

/**
 * The Executive Committee's meeting minutes.
 *
 * The body is an index of PDFs on the old server, which is what the legacy
 * page is — the documents themselves still have to be moved before
 * lcci.com.pk is switched off, and until they are these links point at the old
 * host.
 *
 * `body="editorial"` is what turns that index into one. As migrated, it is
 * thirty-nine `<ul>`s of a single `<li>` each, separated by paragraphs holding
 * nothing but a zero-width space — so the page rendered as thirty-nine
 * one-bullet lists with gaps between them. The parser merges consecutive
 * single-link lists into one block and the renderer sets it as an archive of
 * rows. No link, label or date changes; see `src/content/editorial.ts`.
 */
const PATH = "/about/minutes" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the committee's minutes",
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
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    />
  );
}
