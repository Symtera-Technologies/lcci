import type { Metadata } from "next";
import { CmsPage, cmsMetadata } from "@/components/site/cms-page";
import { SectionIndex } from "@/components/site/section-index";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { CHAMBER } from "@/content/chamber";

/**
 * The About section's landing page.
 *
 * The heading is written here rather than taken from the navigation, which is
 * the one place that override is right: "About" is the correct label in a menu
 * sitting under the chamber's own logo, and a wrong `<h1>` and `<title>` on a
 * page a search engine serves cold. Everything below it is the IA.
 *
 * The chips beside the heading are the chamber's two standing facts, from
 * `CHAMBER` — which is the one place its own details are written down, and
 * every value in it is quoted from lcci.com.pk. They are a default: published
 * `Heading facts` replace them, so an editor can change what this page says
 * about the chamber without a deploy. See `migrations/0039_page_meta.sql`.
 */
const PATH = "/about" as const;

const PAGE = {
  ...navEntry(PATH),
  title: "About the chamber",
  description:
    "How the Lahore Chamber of Commerce & Industry is governed, who runs it, and where to find the department you need.",
  slug: pageSlug(PATH),
  path: PATH,
  missing: "an introduction to the chamber",
} as const;

const META = [`Established ${CHAMBER.foundedYear}`, CHAMBER.address.locality] as const;

export function generateMetadata(): Promise<Metadata> {
  return cmsMetadata(PAGE);
}

export default function AboutPage() {
  return (
    <CmsPage {...PAGE} header="feature" meta={META}>
      <SectionIndex section={PATH} />
    </CmsPage>
  );
}
