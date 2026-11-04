import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Users } from "lucide-react";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { navEntry } from "@/components/site/nav-data";
import { SectionFooter } from "@/components/site/section-index";
import { pageSlug } from "@/content/page-slug";
import { getCommittees } from "@/content/repository";

/**
 * The committee index.
 *
 * This is the page the homepage's committee band points at, and the one the
 * legacy site did not have: there, "Standing Committees" and "Advisory
 * Committee" were both dead `#` links, so a member could not find out which
 * body handled their sector.
 *
 * The list is the content. The editable prose above it is an introduction and
 * nothing more, which is why `CmsPage` is handed `children` — with no prose
 * published this page still shows every committee rather than an "under
 * construction" panel, because the committees *are* published.
 */
const PATH = "/about/committees" as const;

const PAGE = {
  ...navEntry(PATH),
  slug: pageSlug(PATH),
  path: PATH,
  missing: "an introduction to the committees",
} as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

const CARD =
  "group flex h-full flex-col rounded-[20px] border border-brand-300 bg-white p-6 " +
  "shadow-depth-1 transition-[transform,box-shadow,border-color] duration-300 ease-out-expo " +
  "hover:border-brand-500 hover:shadow-depth-2 motion-safe:hover:-translate-y-1 " +
  "focus-visible:border-brand-500 focus-visible:shadow-depth-2 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700";

export default async function CommitteesPage() {
  const committees = await getCommittees();

  return (
    <CmsPage
      {...PAGE}
      header="feature"
      footer={
        <SectionFooter section="/about" exclude={PATH} title="More about the chamber" />
      }
    >
      {committees.length === 0 ? null : (
        <section aria-labelledby="committee-list">
          <h2
            id="committee-list"
            className="font-display text-xl font-semibold text-ink-950"
          >
            {committees.length} committees
          </h2>

          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {committees.map((c) => (
              <li key={c.slug}>
                <Link href={`/about/committees/${c.slug}`} className={CARD}>
                  <span className="flex items-start justify-between gap-4">
                    <span className="font-display text-lg font-semibold text-ink-950">
                      {c.nameEn}
                    </span>
                    <ArrowRight
                      aria-hidden
                      className="mt-1 h-4 w-4 shrink-0 text-brand-600 transition-transform duration-300 ease-out-expo motion-safe:group-hover:translate-x-1"
                    />
                  </span>
                  <span className="mt-2 text-[0.9375rem] leading-relaxed text-ink-700">
                    {c.mandate}
                  </span>
                  <span className="mt-4 flex items-center gap-2 text-[0.8125rem] text-ink-600">
                    <Users className="h-3.5 w-3.5 text-brand-600" aria-hidden />
                    {/* Pluralised rather than "member(s)": one committee of one
                        is possible and reads as a bug otherwise. */}
                    {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </CmsPage>
  );
}
