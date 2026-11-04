import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { PositionList } from "@/components/site/position-list";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { getPolicyPositions } from "@/content/repository";

/**
 * What the chamber is asking for, and where each ask stands.
 *
 * The list is `policy_position` rows and not prose, which is the point of
 * having that type: the legacy site's advocacy was press releases, so a reader
 * could see that the chamber had said something and never find out whether
 * anything came of it. Each position carries a status, and the status is what
 * makes this a record rather than an archive of announcements.
 *
 * An editable introduction sits above it, as on every page of this shape, so
 * the Research Department can frame the list without being able to displace
 * it.
 */
const PATH = "/advocacy/positions" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the chamber's policy positions",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default async function PositionsPage() {
  const positions = await getPolicyPositions();

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
      footer={
        <SectionFooter section="/advocacy" exclude={PATH} title="More of the chamber's advocacy" />
      }
    >
      {positions.length > 0 ? <PositionList items={positions} /> : null}
    </CmsPage>
  );
}
