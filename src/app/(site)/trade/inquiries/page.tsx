import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";

const PATH = "/trade/inquiries" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the trade inquiries and tender notices",
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
        <SectionFooter section="/trade" exclude={PATH} title="Other trade and events pages" />
      }
    />
  );
}
