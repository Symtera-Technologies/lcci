import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { InteriorPage } from "@/components/site/interior-page";
import { SectionFooter } from "@/components/site/section-index";
import { getCommittees } from "@/content/repository";
import { CHAMBER } from "@/content/chamber";

/**
 * One committee.
 *
 * It exists because the homepage's committee band already links here, and a
 * card that 404s is worse than no card. What it can honestly show today is
 * what the `committee` content type holds — the name, the mandate and the size
 * of the body — plus where to ask for more.
 *
 * **The roster is not here, and not invented.** Who sits on a committee is a
 * fact about named people that LCCI's Information Department confirms before
 * publication, and the same reasoning that keeps names off `/about/leadership`
 * keeps them off this page. The current asks a committee is carrying are
 * policy positions, which have their own content type and their own section;
 * when those are tagged by committee this page is where the link goes.
 *
 * ## Why it reads the whole list
 *
 * There are six committees, this page is statically prerendered, and
 * `generateStaticParams` has already fetched all of them to enumerate the
 * routes. A `getCommittee(slug)` getter would add repository surface to save a
 * query that happens at build time against a local socket. If committees ever
 * become numerous or editable without a rebuild, that getter is the change.
 */

export async function generateStaticParams() {
  const committees = await getCommittees();
  return committees.map((c) => ({ slug: c.slug }));
}

async function committeeOf(slug: string) {
  const committees = await getCommittees();
  return committees.find((c) => c.slug === slug);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const committee = await committeeOf(slug);
  if (!committee) return {};

  return {
    title: committee.nameEn,
    description: committee.mandate,
    alternates: { canonical: `/about/committees/${slug}` },
  };
}

export default async function CommitteePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const committee = await committeeOf(slug);

  // A slug that is not published is a 404 and not an empty page: unlike the
  // routes in the navigation, nothing promises this address exists.
  if (!committee) notFound();

  return (
    <InteriorPage
      trail={[
        { label: "About", href: "/about" },
        { label: "Committees", href: "/about/committees" },
      ]}
      title={committee.nameEn}
      standfirst={committee.mandate}
      // The section this sits in is "Committees" and not "About", which is
      // what the trail's first crumb would otherwise give it. A visitor
      // arriving cold on one committee needs to know it is one of a set.
      eyebrow="Committees"
      header="feature"
      meta={[
        `${committee.memberCount} ${committee.memberCount === 1 ? "member" : "members"}`,
      ]}
      footer={<SectionFooter section="/about" title="More about the chamber" />}
    >
      <div className="max-w-[68ch] space-y-6">
        <p className="flex items-center gap-2 text-[0.9375rem] text-ink-700">
          <Users className="h-4 w-4 text-brand-600" aria-hidden />
          {committee.memberCount}{" "}
          {committee.memberCount === 1 ? "serving member" : "serving members"}
        </p>

        <div className="rounded-xl border border-stone-200 bg-stone-50 p-6">
          <h2 className="font-display text-lg font-semibold text-ink-950">
            Membership and current work
          </h2>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-800">
            The committee&rsquo;s membership and the positions it is currently
            carrying are confirmed by the chamber before publication. To ask who
            sits on this committee, to raise a matter with it, or to apply to
            join it, write to{" "}
            <a
              href={`mailto:${CHAMBER.correspondenceEmail}`}
              className="font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 hover:decoration-brand-700"
            >
              {CHAMBER.correspondenceEmail}
            </a>{" "}
            or telephone{" "}
            <a
              href={CHAMBER.telephone.href}
              className="font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 hover:decoration-brand-700"
            >
              {CHAMBER.telephone.display}
            </a>
            .
          </p>
        </div>
      </div>
    </InteriorPage>
  );
}
