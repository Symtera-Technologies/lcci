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
 * Homepage variant 2 — "Chamber in Depth".
 *
 * A second design direction for the homepage, kept at its own route so both can
 * be opened side by side and compared honestly. Nothing here is imported by
 * `/`, and `/` imports nothing from here: the two variants share only the
 * content repository, the design tokens and the site chrome, which is exactly
 * what should be shared when the question being asked is "which layout?".
 *
 * Deliberately `noindex`: this is a decision aid for the chamber, and two
 * near-identical homepages competing in search results would be a real SEO
 * problem rather than a hypothetical one. Whichever variant wins becomes `/`
 * and this route goes away.
 */
export const metadata: Metadata = {
  title: "Homepage variant 2",
  description:
    "Alternative homepage direction for the Lahore Chamber of Commerce & Industry.",
  robots: { index: false, follow: false },
};

export default function VariantTwoPage() {
  return (
    <>
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
