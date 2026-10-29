import type { Metadata } from "next";
import { Header } from "@/components/site/header";
import { Footer } from "@/components/site/footer";
import { NoticeStrip } from "@/components/home/notice-strip";
import { HeroV2 } from "@/components/v2/hero";
import { BentoServices } from "@/components/v2/bento-services";
import { FiguresV2 } from "@/components/v2/figures";
import { EconomyTicker } from "@/components/v2/economy-ticker";
import { NewsEventsV2 } from "@/components/v2/news-events";
import { VideoV2 } from "@/components/v2/video";
import { GalleryV2 } from "@/components/v2/gallery";
import { AdvocacyV2 } from "@/components/v2/advocacy";
import { CommitteesV2 } from "@/components/v2/committees";
import { TestimonialsV2 } from "@/components/v2/testimonials";
import { ClosingBand } from "@/components/v2/closing-band";

/**
 * The homepage — the "Chamber in Depth" direction.
 *
 * This was built as the second of two variants and has been chosen. The first
 * direction is still served, at `/v2` and `noindex`, so the two can be opened
 * side by side while the decision is being confirmed; see that file for when
 * it should go.
 *
 * The sections come from `@/components/v2/*` and the first direction's from
 * `@/components/home/*`, and neither set imports the other. The only things
 * they share are the site chrome, the design tokens and the content
 * repository, which is what should be shared when the question is "which
 * layout?" — it is also why this swap is two files and no component changes.
 *
 * `NoticeStrip` is the one exception and belongs to neither variant: it is the
 * chamber's own alert band, read from the `notice` content type.
 */

export const metadata: Metadata = {
  // Overrides the template so the homepage is not "Home | LCCI".
  title: {
    absolute:
      "Lahore Chamber of Commerce & Industry — the voice of Lahore's business community",
  },
  alternates: { canonical: "/" },
};

/**
 * Schema.org Organization markup — spec §9.
 *
 * Belongs to the canonical homepage rather than to a layout: it describes the
 * organisation that owns the site, and search engines expect it once, at the
 * site's root. It stayed here when the variants were swapped for that reason —
 * it is a property of `/`, not of whichever design `/` is currently serving.
 */
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
        <HeroV2 />
        <BentoServices />
        <FiguresV2 />
        <EconomyTicker />
        <NewsEventsV2 />
        <VideoV2 />
        <GalleryV2 />
        <AdvocacyV2 />
        <CommitteesV2 />
        <TestimonialsV2 />
        <ClosingBand />
      </main>

      <Footer />
    </>
  );
}
