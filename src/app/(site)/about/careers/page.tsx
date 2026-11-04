import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { navEntry } from "@/components/site/nav-data";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";

/**
 * Working at the chamber.
 *
 * A `page` and not a vacancy board. The secretariat recruits a handful of
 * people a year, so the honest shape of this page is "here is how the chamber
 * hires and where to send a CV", with any open position written into the body
 * while it is open. A `vacancy` content type with a closing date, a scheduled
 * unpublish and its own index would be a workflow built for a volume that does
 * not exist — and an empty vacancy index reads as a chamber that is not
 * hiring, which is a different and wrong statement from one that is not
 * advertising.
 *
 * If LCCI starts recruiting at volume this is the route the content type goes
 * behind, and the prose above it survives.
 */
const PATH = "/about/careers" as const;

const PAGE = {
  ...navEntry(PATH),
  description:
    "How the secretariat recruits, and where to send an application or a CV.",
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's current vacancies and how it recruits",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default function CareersPage() {
  return (
    <CmsPage
      {...PAGE}
      header="feature"
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    />
  );
}
