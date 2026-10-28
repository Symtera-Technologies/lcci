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

export const metadata: Metadata = {
  // Overrides the template so the homepage is not "Home | LCCI".
  title: {
    absolute:
      "Lahore Chamber of Commerce & Industry — the voice of Lahore's business community",
  },
  alternates: { canonical: "/" },
};

/** Schema.org Organization markup — spec §9. */
function OrganizationSchema() {
  const schema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Lahore Chamber of Commerce & Industry",
    alternateName: "LCCI",
    foundingDate: "1923",
    url: "https://lcci.com.pk",
    telephone: "+92-111-222-499",
    address: {
      "@type": "PostalAddress",
      streetAddress: "11 Shahrah-e-Aiwan-e-Tijarat",
      addressLocality: "Lahore",
      addressRegion: "Punjab",
      postalCode: "54000",
      addressCountry: "PK",
    },
    sameAs: [
      "https://www.facebook.com/LCCIOfficial",
      "https://x.com/LCCI_Official",
      "https://www.instagram.com/lcci_official",
      "https://www.youtube.com/@LCCIOfficial",
    ],
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

export default function HomePage() {
  return (
    <>
      <OrganizationSchema />
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
