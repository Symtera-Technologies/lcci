import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { navEntry } from "@/components/site/nav-data";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";

/**
 * The roll of past presidents, and of past vice presidents.
 *
 * The whole roll is here already, migrated word for word off
 * `presidents.php`: sixty former presidents with their year, firm and contact
 * line, then a hundred and seventeen former vice presidents as year-and-name
 * pairs. It was unreadable — the old site wrote a name as a heading, the year
 * as a bare text node and everything else as one run-together paragraph, and
 * the import kept all of that exactly.
 *
 * `body="roster"` reads those records back out and sets them as records, with
 * the chamber's own photograph beside each name. Nothing is rewritten: see
 * `src/content/roster.ts`, which compares the words of its own output against
 * the words of the stored body and declines the whole layout if they differ by
 * one.
 *
 * ## Why this is still a `page` and not sixty rows
 *
 * The earlier note here said a content type per former president would be the
 * better home once there was a reason to filter or link them, and that there
 * was no such reason for a list read top to bottom. That still holds, and
 * there is now a second reason: these words are the chamber's, under the
 * six-word rule, so a content type would have to reproduce them exactly to
 * keep the build passing — which is a migration with nothing to gain. The
 * photographs are the part that needed structure, and they have it.
 */
const PATH = "/about/past-leadership" as const;

const PAGE = {
  ...navEntry(PATH),
  description:
    "The chamber's former presidents, in order of office, since its founding in 1923.",
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the roll of past presidents",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default function PastLeadershipPage() {
  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="roster"
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    />
  );
}
