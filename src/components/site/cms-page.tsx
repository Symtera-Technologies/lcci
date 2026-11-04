import type { Metadata } from "next";
import { getPage } from "@/content/repository";
import { Prose } from "./prose";
import { EditorialBody } from "./editorial-body";
import { LetterBody } from "./letter-body";
import { RosterBody } from "./roster-body";
import { EmptyBody, InteriorPage, type Crumb } from "./interior-page";

/**
 * A route that renders its prose from the CMS, with the route still in charge.
 *
 * Every interior page in the site is the same shape — breadcrumb, heading,
 * standfirst, editable body, sometimes a block of structured data underneath —
 * so this is written once rather than 48 times. What each route supplies is
 * its *place*: the trail, the title it carries in the navigation, and the slug
 * its prose is published at.
 *
 * ## The fallbacks are the point, not a convenience
 *
 * `getPage` returns null for a slug with nothing published at it, and every
 * field on a `page` row but the title is nullable. So this component is built
 * to render a correct page from **nothing**: the heading and description come
 * from `src/components/site/nav-data.ts`, which is typed, in the repository,
 * and already the single answer to "what is this page called". Published prose
 * overrides the title and the standfirst — renaming a page is a legitimate
 * editorial act — and the trail is never overridable, because a content row
 * does not know where it sits and a page that invented its own breadcrumb
 * could point at an address that does not exist.
 *
 * That is what lets the IA go in ahead of the copy. A route with no row behind
 * it is navigable, indexable, correctly titled and says who to write to; it is
 * visibly unfinished to LCCI's staff and useful to a visitor, which is the
 * right failure. Throwing instead would mean the whole site failing to build
 * until all 48 pages had been written.
 *
 * ## Why `children` come after the prose
 *
 * Some of these pages are prose plus a list the database already holds — the
 * committees, the secretariat's departments, the chamber's own contact
 * details. Those render *below* the editable body, so an editor can write an
 * introduction without being able to displace or break the structured part.
 */

export interface CmsPageProps {
  /** Ancestors, nearest last. "Home" is added for you; this page is not in it. */
  trail: readonly Crumb[];
  /** The title from the navigation. Published prose may override it. */
  title: string;
  /** The description from the navigation, used until a standfirst is published. */
  description?: string;
  /** The `page` slug whose prose belongs at this route. */
  slug: string;
  /** What is missing, as a noun phrase: "the chamber's history". */
  missing: string;
  /** Structured content rendered below the editable body. */
  children?: React.ReactNode;
  aside?: React.ReactNode;
  /** `feature` for the dark header. See `InteriorPage`. */
  header?: "plain" | "feature";
  /** Overrides the section name the feature header takes from the trail. */
  eyebrow?: string;
  /**
   * Short standing facts, as chips under a feature heading.
   *
   * A default, in the same sense as `title` and `description`: published
   * `Heading facts` replace it, so a page that has never been edited still
   * shows the right chips and an editor who writes their own is obeyed.
   */
  meta?: readonly string[];
  /** Full-width content below the body — a related-pages grid, say. */
  footer?: React.ReactNode;
  /**
   * How the editable body is laid out.
   *
   * `prose` is the default and is what 61 routes use: one measured column,
   * exactly as the CMS stored it. `editorial` reads the body as sections and
   * gives each recognised shape a layout — see
   * `src/components/site/editorial-body.tsx`, which also explains why this is
   * opt-in per route rather than switched on everywhere.
   *
   * It is safe on any body: an unrecognised shape renders as `prose`. It is
   * opt-in because *looking right* is the part that has to be checked by
   * looking, one page at a time.
   *
   * `letter` is for a body that is one person writing to the reader — see
   * `src/components/site/letter-body.tsx`. It only styles, so it is safe on
   * any body too, but it says something about the words that is only true of
   * a few of them.
   *
   * `roster` is for a body that is a list of people, and is the one that puts
   * the chamber’s portrait photographs beside the names in it — see
   * `src/components/site/roster-body.tsx`.
   */
  body?: "prose" | "editorial" | "letter" | "roster";
}

/**
 * The body layouts, by name.
 *
 * A lookup rather than a chain of ternaries, so adding one is a line here and
 * a word in the union above. Every one of them takes `{ html }` and renders
 * the same words: that is the contract, and `RosterBody` and `EditorialBody`
 * each have a test that holds them to it.
 */
const BODIES = {
  prose: Prose,
  editorial: EditorialBody,
  letter: LetterBody,
  roster: RosterBody,
} as const;

export async function CmsPage({
  trail,
  title,
  description,
  slug,
  missing,
  children,
  aside,
  header = "plain",
  eyebrow,
  meta,
  footer,
  body = "prose",
}: CmsPageProps) {
  const page = await getPage(slug);
  const standfirst = page?.standfirstEn ?? description;
  const chips = page?.meta ?? meta;
  const Body = BODIES[body];

  return (
    <InteriorPage
      trail={trail}
      title={page?.titleEn ?? title}
      header={header}
      {...(standfirst ? { standfirst } : {})}
      {...(page?.heroImage ? { banner: page.heroImage } : {})}
      {...(aside ? { aside } : {})}
      {...(eyebrow ? { eyebrow } : {})}
      {...(chips ? { meta: chips } : {})}
      {...(footer ? { footer } : {})}
    >
      {page?.bodyEn ? <Body html={page.bodyEn} /> : null}
      {/* Shown only when there is no prose *and* nothing structured to read.
          A page whose database-backed list is its real content — the committee
          index, say — is not unfinished merely because nobody wrote an
          introduction for it. */}
      {!page?.bodyEn && !children ? <EmptyBody what={missing} /> : null}
      {children ? <div className={page?.bodyEn ? "mt-12" : undefined}>{children}</div> : null}
    </InteriorPage>
  );
}

/**
 * The same page's `<head>`, built from the same two sources.
 *
 * Separate from the component because Next resolves `generateMetadata` before
 * rendering and the two cannot share a return value. They do share the read:
 * `getPage` is called twice per request, which is one extra indexed primary-key
 * lookup against a local socket, and these pages are statically prerendered, so
 * it happens at build time and not per visitor.
 *
 * `alternates.canonical` is set on every page. The legacy site served the same
 * URL with and without a trailing slash and with `?page=` noise, and ~890 of
 * those URLs are being 301'd into this space; a declared canonical is what
 * stops a redirected duplicate competing with its own target.
 */
export async function cmsMetadata({
  title,
  description,
  slug,
  path,
}: {
  title: string;
  description?: string;
  slug: string;
  /** This route's own URL, for the canonical. */
  path: `/${string}`;
}): Promise<Metadata> {
  const page = await getPage(slug);
  const resolved = page?.seoDescription ?? page?.standfirstEn ?? description;

  return {
    title: page?.seoTitle ?? page?.titleEn ?? title,
    ...(resolved ? { description: resolved } : {}),
    alternates: { canonical: path },
    ...(page?.ogImage ? { openGraph: { images: [{ url: page.ogImage.src }] } } : {}),
  };
}
