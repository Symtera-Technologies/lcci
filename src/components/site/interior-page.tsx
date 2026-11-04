import Link from "next/link";
import Image from "next/image";
import { ChevronRight } from "lucide-react";
import type { ImageRef } from "@/content/types";
import { CHAMBER } from "@/content/chamber";
import { cn } from "@/lib/cn";
import { ArchPattern } from "./arch-pattern";

/**
 * The shell every interior page wears: breadcrumb, heading, standfirst, body.
 *
 * Built once because there are 48 of these behind the navigation, and a
 * heading level or a breadcrumb that is right on 40 pages and wrong on 8 is
 * exactly the kind of inconsistency nobody files a bug about. It also fixes
 * the document outline in one place: one `h1` per page, and the page's own
 * prose starting at `h2`, which is what the sanitiser's allowlist already
 * assumes by permitting `h2`–`h4` and nothing above.
 *
 * **The heading and the breadcrumb come from the route, not from the CMS.**
 * A route file knows where it sits in the IA; a content row does not, and a
 * page that decided its own breadcrumb could point at an address that does not
 * exist. Published prose may override the *title* — an editor renaming a page
 * is a legitimate editorial act — but never the trail to it. See
 * `src/components/site/nav-data.ts`, which is where the trail is typed.
 *
 * It renders correctly with no content at all, which is deliberate: the routes
 * go in before the copy for them is written, and a page with a heading, a
 * description and a working breadcrumb is a usable page. See `EmptyBody`.
 */

export interface Crumb {
  readonly label: string;
  readonly href: `/${string}`;
}

/**
 * The trail above the heading.
 *
 * "Home" is prepended here rather than passed by every caller, and the current
 * page is the last item and is *not* a link — `aria-current="page"` on plain
 * text, because a link to the page you are on is a trap for anyone navigating
 * by keyboard who expects a link to move them.
 */
function Breadcrumb({
  trail,
  current,
  tone = "light",
}: {
  trail: readonly Crumb[];
  current: string;
  /** `dark` for the feature header's ink panel. */
  tone?: "light" | "dark";
}) {
  const links: Crumb[] = [{ label: "Home", href: "/" }, ...trail];
  const dark = tone === "dark";

  return (
    <nav
      aria-label="Breadcrumb"
      className={cn("text-[0.8125rem]", dark ? "text-white/60" : "text-ink-600")}
    >
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {links.map((crumb) => (
          <li key={crumb.href} className="flex items-center gap-x-1.5">
            <Link
              href={crumb.href}
              className={cn(
                "rounded underline underline-offset-4 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
                dark
                  ? "decoration-white/25 hover:text-white hover:decoration-brand-300 focus-visible:outline-brand-300"
                  : "decoration-stone-300 hover:text-ink-900 hover:decoration-brand-600 focus-visible:outline-brand-700",
              )}
            >
              {crumb.label}
            </Link>
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                dark ? "text-white/35" : "text-stone-400",
              )}
              aria-hidden
            />
          </li>
        ))}
        {/* Truncated rather than wrapped at the narrowest widths: a long page
            title is the one crumb that can push the trail onto three lines. */}
        <li
          aria-current="page"
          className={cn(
            "max-w-full truncate font-medium",
            dark ? "text-white" : "text-ink-900",
          )}
        >
          {current}
        </li>
      </ol>
    </nav>
  );
}

/**
 * The header a page gets when it is one somebody will arrive on directly.
 *
 * The same dark panel and Mughal arcade as the homepage hero, at a third of
 * the height — see `./arch-pattern.tsx` for why that decoration is shared
 * rather than copied. What it adds over the plain header is a *place*: the
 * eyebrow names the section, so a visitor landing from a search result knows
 * what part of the chamber they are in before they read the heading.
 *
 * It is opt-in rather than the default, and deliberately so: 62 routes wear
 * this shell, the plain header is correct on all of them, and switching every
 * page's header in one commit is a change nobody can review by looking. Pages
 * move over as each one is designed.
 *
 * Contrast was measured, not guessed: `brand-300` on `ink-950` is 8.9:1,
 * `white/70` resolves to 11.7:1, and the breadcrumb's `white/60` to 8.8:1.
 */
function FeatureHeader({
  trail,
  title,
  standfirst,
  eyebrow,
  meta,
}: {
  trail: readonly Crumb[];
  title: string;
  standfirst?: string;
  eyebrow?: string;
  meta?: readonly string[];
}) {
  // The section this page sits in, which is the first crumb after Home. A
  // top-level page has an empty trail and gets no eyebrow rather than an
  // invented one.
  const label = eyebrow ?? trail[0]?.label;

  return (
    <div className="relative overflow-hidden bg-ink-950">
      <ArchPattern side="end" />

      <div className="container-page relative py-10 sm:py-14">
        <Breadcrumb trail={trail} current={title} tone="dark" />

        {label ? (
          <p className="mt-7 text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-brand-300">
            {label}
          </p>
        ) : null}

        <h1
          className={cn(
            "max-w-3xl font-display font-semibold leading-[1.1] tracking-tight text-white",
            "text-[2rem] sm:text-display-sm lg:text-display-md",
            label ? "mt-2.5" : "mt-7",
          )}
        >
          {title}
        </h1>

        {standfirst ? (
          <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-white/70">
            {standfirst}
          </p>
        ) : null}

        {meta && meta.length > 0 ? (
          <ul className="mt-7 flex flex-wrap gap-2">
            {meta.map((item) => (
              <li
                key={item}
                className="rounded-full bg-white/5 px-3 py-1 text-xs font-medium text-white/80 ring-1 ring-inset ring-white/10"
              >
                {item}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function InteriorPage({
  trail,
  title,
  standfirst,
  banner,
  children,
  aside,
  header = "plain",
  eyebrow,
  meta,
  footer,
}: {
  /** Ancestors, nearest last. "Home" is added for you; this page is not in it. */
  trail: readonly Crumb[];
  title: string;
  standfirst?: string;
  banner?: ImageRef;
  children: React.ReactNode;
  /** Optional sidebar, which moves below the body on narrow screens. */
  aside?: React.ReactNode;
  /** `feature` for the dark header. See `FeatureHeader`. */
  header?: "plain" | "feature";
  /** Overrides the section name the feature header derives from the trail. */
  eyebrow?: string;
  /**
   * Short standing facts, as chips under a feature heading.
   *
   * Facts about the chamber, never a summary of the page: they sit above the
   * body, so anything editorial here would be a second standfirst that no
   * editor can reach from the admin.
   */
  meta?: readonly string[];
  /**
   * Full-width content below the body, outside the sidebar grid.
   *
   * For what belongs at the end of a page rather than inside its argument — a
   * related-pages grid, a contact band. Separate from `children` because those
   * keep the body's reading measure and this does not.
   */
  footer?: React.ReactNode;
}) {
  return (
    <main id="main" className="pb-20">
      {header === "feature" ? (
        <FeatureHeader
          trail={trail}
          title={title}
          {...(standfirst ? { standfirst } : {})}
          {...(eyebrow ? { eyebrow } : {})}
          {...(meta ? { meta } : {})}
        />
      ) : (
        <div className="border-b border-stone-200 bg-stone-50">
          <div className="container-page py-8 sm:py-10">
            <Breadcrumb trail={trail} current={title} />

            <h1 className="mt-4 max-w-3xl font-display text-[1.875rem] font-semibold leading-tight tracking-tight text-ink-950 sm:text-display-sm">
              {title}
            </h1>

            {standfirst ? (
              // Capped at the same measure as the body so the standfirst and
              // the first paragraph share a left edge and a line length.
              <p className="mt-4 max-w-[68ch] text-lg leading-relaxed text-ink-700">
                {standfirst}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {banner ? (
        <div className="container-page mt-8 sm:mt-10">
          <figure className="relative aspect-[16/7] overflow-hidden rounded-xl bg-ink-900 ring-1 ring-inset ring-stone-200">
            <Image
              src={banner.src}
              alt={banner.altEn}
              fill
              priority
              sizes="(min-width: 80rem) 75rem, 100vw"
              className="object-cover"
            />
          </figure>
          {banner.caption ? (
            <p className="mt-2 text-[0.8125rem] text-ink-600">{banner.caption}</p>
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          "container-page mt-10 sm:mt-12",
          // The sidebar is a sibling column only where there is room for the
          // body to keep its measure beside it. Below that it stacks, body
          // first, because the body is what the visitor came for.
          aside && "lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-14",
        )}
      >
        <div className="min-w-0">{children}</div>
        {aside ? <div className="mt-12 lg:mt-0">{aside}</div> : null}
      </div>

      {footer ? <div className="container-page mt-16">{footer}</div> : null}
    </main>
  );
}

/**
 * What a page shows before anybody has written it.
 *
 * Stated plainly rather than dressed up as "coming soon", and it names the
 * department to write to — a visitor who arrived looking for the attestation
 * fee is better served by an address than by an apology. It is also visibly
 * unfinished to LCCI's own staff, which is the point: an empty page that looks
 * designed stays empty.
 */
export function EmptyBody({
  what,
  email = CHAMBER.correspondenceEmail,
}: {
  /** What is missing, as a noun phrase: "the chamber's history". */
  what: string;
  email?: string;
}) {
  return (
    <div className="max-w-[68ch] rounded-xl border border-dashed border-stone-300 bg-stone-50 p-6">
      {/* An em dash and not a full stop: `what` is a lowercase noun phrase
          ("the chamber's history"), so a sentence boundary in front of it
          reads as a typo — which is exactly how it shipped. */}
      <p className="text-ink-800">
        This page is being prepared &mdash; {what} is not published here yet.
      </p>
      <p className="mt-3 text-[0.9375rem] text-ink-700">
        For anything you need in the meantime, write to{" "}
        <a
          href={`mailto:${email}`}
          className="font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 hover:decoration-brand-700"
        >
          {email}
        </a>{" "}
        or telephone the chamber on{" "}
        <a
          href={CHAMBER.telephone.href}
          className="font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 hover:decoration-brand-700"
        >
          {CHAMBER.telephone.display}
        </a>
        .
      </p>
    </div>
  );
}
