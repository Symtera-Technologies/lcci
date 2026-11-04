import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InteriorPage } from "@/components/site/interior-page";
import {
  PRESS_RELEASES_PER_PAGE,
  PressReleaseList,
  PressReleasePager,
} from "@/components/site/press-release-list";
import { navEntry } from "@/components/site/nav-data";
import { getPressReleases } from "@/content/repository";

/**
 * Pages two onward of the press archive.
 *
 * Prerendered, one URL per page, which is what makes the whole archive
 * crawlable and the pager work with JavaScript off. `generateStaticParams`
 * asks the database how many pages there are, so the set grows with the
 * archive and no number is written down twice.
 *
 * **`/news/press-releases/page` is a reserved slug.** This static segment sits
 * beside `[slug]`, and Next resolves a static segment first — so a press
 * release published at the slug `page` would be unreachable at its own URL.
 * The slug is generated from the headline, so it would take a release titled
 * exactly "Page" to collide; it is called out here because the failure would
 * be a 404 on one item with nothing to explain it.
 *
 * `dynamicParams = false` makes a page number past the end a 404 rather than
 * a request rendered on demand. An out-of-range page is either a stale link or
 * a crawler guessing, and serving it an empty list under a real heading would
 * invite it to keep counting.
 */
export const dynamicParams = false;

const PATH = "/news/press-releases" as const;
const ENTRY = navEntry(PATH);

export async function generateStaticParams(): Promise<{ n: string }[]> {
  const { total } = await getPressReleases({ limit: 1 });
  const pageCount = Math.ceil(total / PRESS_RELEASES_PER_PAGE);

  // From 2: page one is the parent route, and listing it here would publish
  // the same content at a second address.
  return Array.from({ length: Math.max(0, pageCount - 1) }, (_, i) => ({
    n: String(i + 2),
  }));
}

function pageNumber(n: string): number {
  // A leading zero or a `+` would make `/page/02` a second URL for page 2, so
  // only the canonical decimal form is accepted.
  if (!/^[1-9][0-9]*$/.test(n)) return 0;
  return Number(n);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ n: string }>;
}): Promise<Metadata> {
  const { n } = await params;
  const page = pageNumber(n);

  return {
    title: `${ENTRY.title} — page ${page}`,
    ...(ENTRY.description ? { description: ENTRY.description } : {}),
    alternates: { canonical: `${PATH}/page/${page}` },
  };
}

export default async function PressReleasePage({
  params,
}: {
  params: Promise<{ n: string }>;
}) {
  const { n } = await params;
  const page = pageNumber(n);
  if (page < 2) notFound();

  const { items, total } = await getPressReleases({
    limit: PRESS_RELEASES_PER_PAGE,
    offset: (page - 1) * PRESS_RELEASES_PER_PAGE,
  });

  if (items.length === 0) notFound();

  return (
    <InteriorPage
      // The index itself is in the trail, which `navEntry` does not supply: it
      // answers "where does this route sit" for routes that are in the
      // navigation, and a page of the archive is not.
      trail={[...ENTRY.trail, { label: ENTRY.title, href: PATH }]}
      title={`${ENTRY.title} — page ${page}`}
      standfirst={`${total} press releases, newest first.`}
      header="feature"
    >
      <PressReleaseList items={items} />
      <PressReleasePager
        page={page}
        pageCount={Math.ceil(total / PRESS_RELEASES_PER_PAGE)}
        total={total}
      />
    </InteriorPage>
  );
}
