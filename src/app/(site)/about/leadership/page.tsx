import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { navEntry } from "@/components/site/nav-data";
import { OfficeBearers } from "@/components/site/portraits";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";
import { getOfficeBearers } from "@/content/repository";

/**
 * Who holds office, and the President's message.
 *
 * ## The names and faces are content now, and were not
 *
 * This page shipped with a note saying there was deliberately no content type
 * for office-bearers, because nothing in the repository carried their names
 * and a placeholder name reaching production would be a false statement about
 * who speaks for the chamber. That reasoning was right and the premise has
 * changed: lcci.com.pk publishes all three — name, post and photograph — on
 * `about.php?id=19`, `=21` and `=22`, and those pages are the source for the
 * `portrait` rows this reads. Nothing here is invented, and every one of them
 * is editable in the admin under *People*.
 *
 * The body is the President's message, migrated off `about.php?id=5` and
 * signed with his name at the foot — which is why it is set as a letter rather
 * than as page prose. See `src/components/site/letter-body.tsx`.
 *
 * ## Why the band is below the message and not above it
 *
 * The body is what an editor controls and what a visitor arriving from a
 * search result came for. The three cards are a roster: useful, and not the
 * reason anybody opened the page. `CmsPage` renders `children` under the body
 * for exactly this, and it is also why the photographs are not an `aside` —
 * a letter with the writer's own face floated beside it would show the
 * President twice on one page.
 */
const PATH = "/about/leadership" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the current office bearers",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default async function LeadershipPage() {
  const officeBearers = await getOfficeBearers();

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="letter"
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    >
      <OfficeBearers portraits={officeBearers} />
    </CmsPage>
  );
}
