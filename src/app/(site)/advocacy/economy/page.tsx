import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { IndicatorTable } from "@/components/site/indicator-table";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { getEconomicIndicators } from "@/content/repository";

/**
 * The indicators the Research Department tracks, in full.
 *
 * The homepage shows five of these at a glance and links here for the rest;
 * this is the reference, so it is a table — the question asked of a reference
 * is how one figure compares to another, which needs the values in a column.
 *
 * Every row states its source and the date the figure is current to. The
 * legacy site's economic analysis was discredited not by its numbers but by a
 * 2015 survey sitting on the page with nothing to say how old it was.
 */
const PATH = "/advocacy/economy" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's economic indicators",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default async function EconomyPage() {
  const indicators = await getEconomicIndicators();

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
      footer={
        <SectionFooter section="/advocacy" exclude={PATH} title="More of the chamber's advocacy" />
      }
    >
      {indicators.length > 0 ? <IndicatorTable items={indicators} /> : null}
    </CmsPage>
  );
}
