import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { EventList } from "@/components/site/event-list";
import { SectionFooter } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { getPastEvents, getUpcomingEvents } from "@/content/repository";

/**
 * The events calendar: what is coming, then what has been held.
 *
 * `revalidate` is set, and it is the one page on the public site that needs
 * it. Every other interior page changes only when an editor publishes, and
 * `revalidatePath` in the admin covers that. This page changes on its own: an
 * event crosses from "coming up" to "already held" at a particular minute with
 * nobody editing anything, and a page prerendered at build time would go on
 * advertising a seminar that finished last week.
 *
 * Six hours rather than minutes, because the consequence of being a few hours
 * stale is small and the cost of regenerating is a database read per window.
 * Spec §7's committed figure for the events listing is a day; this is tighter
 * than that and still cheap.
 */
export const revalidate = 21_600;

const PATH = "/trade/events" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "the events calendar",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default async function EventsPage() {
  // One clock for both halves, so an event starting in this instant cannot
  // land in neither list or in both.
  const now = new Date();
  const [upcoming, past] = await Promise.all([
    getUpcomingEvents(24, now),
    getPastEvents(12, now),
  ]);

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      body="editorial"
      footer={
        <SectionFooter section="/trade" exclude={PATH} title="Other trade and events pages" />
      }
    >
      <EventList upcoming={upcoming} past={past} />
    </CmsPage>
  );
}
