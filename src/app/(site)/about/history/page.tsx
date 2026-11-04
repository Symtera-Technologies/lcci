import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { navEntry } from "@/components/site/nav-data";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";
import { CHAMBER } from "@/content/chamber";

const PATH = "/about/history" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's history",
} as const;

/**
 * Standing facts, not a summary of the page.
 *
 * Both come from `CHAMBER`, which is the one place the chamber's own details
 * are written down and every value in it is quoted from lcci.com.pk. A chip
 * reading anything editorial would be a second standfirst that no editor can
 * reach from the admin, which is the opposite of what these pages are for.
 */
const META = [
  `Established ${CHAMBER.foundedYear}`,
  CHAMBER.address.locality,
] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

/**
 * The first page moved onto the designed shell.
 *
 * `header="feature"` is the dark panel with the arcade; `body="editorial"`
 * reads the stored prose as sections, so the vision is set as a statement, the
 * five mission commitments become a numbered grid and the five values become
 * named cards. None of the words change — they cannot, see
 * `src/content/editorial.ts` — and if an editor rewrites the body into a shape
 * the parser does not recognise, the page falls back to ordinary prose.
 *
 * `footer` is the rest of About, because somebody who has just read the
 * chamber's vision is one click from wanting its leadership or its history of
 * office-bearers, and the plain shell left them with nowhere to go.
 */
export default function HistoryPage() {
  return (
    <CmsPage
      {...PAGE}
      header="feature"
      meta={META}
      body="editorial"
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    />
  );
}
