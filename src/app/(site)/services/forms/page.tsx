import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";

const PATH = "/services/forms" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's forms and downloads",
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
        <SectionFooter section="/services" exclude={PATH} title="Other services the chamber runs" />
      }
    />
  );
}
