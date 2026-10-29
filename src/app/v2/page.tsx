import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";
import { Header } from "@/components/site/header";
import { Footer } from "@/components/site/footer";
import { NoticeStrip } from "@/components/home/notice-strip";
import { Hero } from "@/components/home/hero";
import { ServiceTiles } from "@/components/home/service-tiles";
import { KeyFigures } from "@/components/home/key-figures";
import { NewsAndEvents } from "@/components/home/news-and-events";
import { AdvocacySpotlight } from "@/components/home/advocacy-spotlight";
import { EconomyStrip } from "@/components/home/economy-strip";
import { Committees } from "@/components/home/committees";
import { Testimonials } from "@/components/home/testimonials";
import { StayInformed } from "@/components/home/stay-informed";
import { ButtonLink } from "@/components/ui/button";

/**
 * The first homepage direction, kept for comparison.
 *
 * This was `/` until the "Chamber in Depth" direction was chosen; the two
 * swapped rather than one being deleted, so the chamber can still open them
 * side by side while the decision is confirmed.
 *
 * Deliberately `noindex`: two near-identical homepages competing in search
 * results is a real SEO problem rather than a hypothetical one, and this one
 * no longer carries the Organization markup or the canonical tag — both of
 * those belong to `/` whatever design it serves.
 *
 * **This route is meant to go.** Once LCCI has signed off on the homepage,
 * delete this file and `src/components/home/` with it. A variant left standing
 * becomes a second homepage nobody maintains, and the first thing to rot in it
 * will be the content types it reads.
 */
export const metadata: Metadata = {
  title: "Homepage variant 1",
  description:
    "The earlier homepage direction for the Lahore Chamber of Commerce & Industry, kept for comparison.",
  robots: { index: false, follow: false },
};

export default function VariantOnePage() {
  return (
    <>
      <NoticeStrip />
      <Header />

      <main id="main">
        <Hero />
        <ServiceTiles />
        <KeyFigures />
        <NewsAndEvents />
        <AdvocacySpotlight />
        <EconomyStrip />
        <Committees />
        <Testimonials />
        <JoinBand />
        <StayInformed />
      </main>

      <Footer />
    </>
  );
}

function JoinBand() {
  return (
    <section className="container-page py-6">
      <div className="flex flex-col items-start gap-6 rounded-2xl border border-brand-200 bg-brand-50 p-8 lg:flex-row lg:items-center lg:justify-between lg:p-10">
        <div className="max-w-2xl">
          <h2 className="font-display text-display-sm font-semibold text-ink-950">
            Join the Lahore Chamber
          </h2>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-800">
            Membership gets you the directory listing buyers search, discounted
            trade documents, a seat on the committees that carry your sector&rsquo;s
            case to government, and alerts before the rules change.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-3">
          <ButtonLink href="/membership/apply" size="lg" variant="secondary">
            Apply online
            <ArrowRight className="h-4 w-4" aria-hidden />
          </ButtonLink>
          <ButtonLink href="/membership/categories" size="lg" variant="ghost">
            Categories &amp; dues
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
