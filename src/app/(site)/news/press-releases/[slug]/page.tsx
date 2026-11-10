import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { InteriorPage } from "@/components/site/interior-page";
import { Prose } from "@/components/site/prose";
import { Tag, TOPIC_LABELS } from "@/components/ui/tag";
import { navEntry } from "@/components/site/nav-data";
import { getPressRelease, getPressReleases } from "@/content/repository";
import { isUnpublishedArchiveSlug } from "@/content/press-archive";
import { formatDate } from "@/lib/format";

/**
 * One press release.
 *
 * This route is also the destination of ~895 redirects: every
 * `press.php?id=N` on the old site becomes a `/news/press-releases/{slug}`
 * here, which is why it exists before the archive has been imported. Until it
 * did, the homepage's news cards linked at `/news/{slug}` — a route that was
 * never built, so every one of them 404'd.
 *
 * **A release with no body renders its summary and stops.** `body_en` has been
 * in the table and in the admin's editor since migration 0018 and was read by
 * nothing until now, so the seven seeded releases have summaries and no
 * bodies. Showing the summary alone is the honest result: it is what the
 * chamber has published about that release, and an empty page under a real
 * headline would look broken.
 */

const INDEX = "/news/press-releases" as const;
const ENTRY = navEntry(INDEX);

/**
 * Every published release gets a prerendered page.
 *
 * **`dynamicParams` is deliberately left at its default of `true`**, so a slug
 * that is not in this list renders on demand rather than being refused at the
 * route level. That is not a performance choice; it is the only way the
 * archive fallback below can run at all. 686 of the 699 imported releases are
 * drafts awaiting dates from LCCI, so their slugs are absent from this list
 * while being the destination of a 308 from `press.php?id=N`. With
 * `dynamicParams = false` Next answers those 404 before the component is
 * reached, and the redirect-onto-404 chain that `src/content/press-archive.ts`
 * exists to prevent happens anyway, silently, because the code preventing it
 * is unreachable.
 *
 * The cost is one indexed `WHERE slug = ?` for a slug nobody published —
 * which is what every other dynamic route on this site already pays, and what
 * the `notFound()` below turns into a cached 404.
 */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  // One read, large enough for the whole archive. `getPressReleases` is
  // paginated for the index's sake; here the whole set is the point.
  const { items } = await getPressReleases({ limit: 2_000 });
  return items.map((item) => ({ slug: item.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const release = await getPressRelease(slug);
  if (!release) return {};

  return {
    title: release.seoTitle ?? release.titleEn,
    description: release.seoDescription ?? release.summary,
    alternates: { canonical: `${INDEX}/${slug}` },
    openGraph: {
      type: "article",
      publishedTime: release.publishedAt,
      // The sharing image where an editor set one, the article's own hero
      // otherwise. That order round, because the whole reason to offer a
      // separate sharing image is that the picture which reads well at the top
      // of an article is often the wrong crop for a 1200×630 card.
      ...(release.ogImage
        ? { images: [{ url: release.ogImage.src, alt: release.ogImage.altEn }] }
        : release.heroImage
          ? { images: [{ url: release.heroImage.src, alt: release.heroImage.altEn }] }
          : {}),
    },
  };
}

/**
 * Does the standfirst say anything the body is not about to say again?
 *
 * `summary` is NOT NULL and the index renders it under every headline, so the
 * press archive imported from lcci.com.pk fills it from each release's opening
 * paragraph — only a handful of those pages carry a separate bolded lead. That
 * is right for the index and wrong here: a detail page that prints the opening
 * paragraph as a standfirst and then again as the first paragraph of the body
 * reads as a layout bug, on several hundred pages.
 *
 * Compared as text, because `summary` is plain and `bodyEn` is markup, and by
 * prefix, because `fitSummary` in the importer truncates at the column width —
 * so the standfirst is a *prefix* of the paragraph it came from, never equal
 * to it. The trailing ellipsis that marks the truncation is dropped first.
 *
 * A release with a real standfirst — one the chamber wrote as a subhead — is
 * not a prefix of its own body and still shows.
 */
function standfirstAddsSomething(summary: string, body: string | undefined): boolean {
  if (!body) return true;

  const normalise = (value: string) =>
    value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

  const lead = normalise(summary).replace(/…$/, "").trim();
  if (lead === "") return false;

  return !normalise(body).startsWith(lead);
}

export default async function PressReleaseDetail({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const release = await getPressRelease(slug);

  if (!release) {
    // A slug the archive holds but has not published yet goes on to the index
    // rather than to a Not Found page. 686 of the 699 imported releases are
    // drafts awaiting dates from LCCI, and every one of them is the
    // destination of a 301 from `press.php?id=N` — a permanent redirect onto
    // a 404 loses the ranking the redirect exists to carry. See
    // src/content/press-archive.ts.
    if (isUnpublishedArchiveSlug(slug)) redirect(INDEX);
    notFound();
  }

  const standfirst = standfirstAddsSomething(release.summary, release.bodyEn);

  return (
    <InteriorPage
      trail={[...ENTRY.trail, { label: ENTRY.title, href: INDEX }]}
      title={release.titleEn}
      // The same dark panel the rest of the site uses on a page somebody
      // arrives on directly — which a press release almost always is, from a
      // search result or a link in somebody's message, rather than from the
      // archive index.
      header="feature"
      eyebrow="Press release"
      {...(standfirst ? { standfirst: release.summary } : {})}
      {...(release.heroImage ? { banner: release.heroImage } : {})}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* The date is a `<time>` carrying the instant, and the visible string
            is Karachi time — a press release dated the 3rd in Lahore must not
            read as the 2nd to a reader in London. */}
        <time
          dateTime={release.publishedAt}
          className="text-[0.875rem] font-medium uppercase tracking-wide text-ink-600"
        >
          {formatDate(release.publishedAt)}
        </time>
        {release.topics.map((topic) => (
          <Tag key={topic} tone="clay">
            {TOPIC_LABELS[topic]}
          </Tag>
        ))}
      </div>

      {release.bodyEn ? (
        <div className="mt-6">
          <Prose html={release.bodyEn} />
        </div>
      ) : null}

      {release.spokesperson ? (
        <p className="mt-8 max-w-[68ch] border-t border-stone-200 pt-5 text-[0.9375rem] text-ink-700">
          <span className="font-medium text-ink-900">Quoted:</span>{" "}
          {release.spokesperson}
        </p>
      ) : null}

      <p className="mt-8 text-[0.9375rem] text-ink-700">
        Issued by the {release.ownerDepartment}.
      </p>
    </InteriorPage>
  );
}
