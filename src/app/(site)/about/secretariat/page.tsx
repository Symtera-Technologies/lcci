import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { OfficeContacts } from "@/components/site/contact-blocks";
import { navEntry } from "@/components/site/nav-data";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";

/**
 * The permanent staff, and which department answers what.
 *
 * The contact list below the prose is not editable, and that is the point: it
 * is the same four addresses the footer offers and the same four the contact
 * page offers, from `src/content/chamber.ts`. A second, CMS-editable copy of
 * it here would eventually disagree with the footer, and the copy a visitor
 * trusts is whichever one they read last.
 *
 * Those four are the chamber's office bearers, not departmental desks, because
 * office bearers are what lcci.com.pk actually publishes — four plausible
 * departmental addresses stood here until they were checked against it.
 *
 * The prose above it is editable, because "what the secretariat does and how
 * it is organised" is exactly the kind of thing LCCI will want to reword
 * without a deploy.
 *
 * `body="editorial"` divides that prose at its own department headings, which
 * is what the page needed most: three departments, two tariff tables and four
 * contact blocks arrived as one unbroken column of paragraphs. It also fixed a
 * bug worth knowing about — the R&D department’s list has a nested list
 * inside it, which the first version of the parser mis-closed and refused the
 * whole page over. See `topLevelBlocks` in `src/content/editorial.ts`.
 */
const PATH = "/about/secretariat" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "how the secretariat is organised",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default function SecretariatPage() {
  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    >
      <OfficeContacts />
    </CmsPage>
  );
}
