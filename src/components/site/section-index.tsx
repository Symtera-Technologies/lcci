import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PRIMARY_NAV } from "./nav-data";

/**
 * A section's own children, as a grid of cards.
 *
 * Six section landing pages need exactly this — About, Membership, Services,
 * Advocacy, Trade & Events and Newsroom — and each of them reads its children
 * straight from `PRIMARY_NAV`, so a page added to the navigation appears on its
 * section's landing page with no second edit. The alternative, a hand-written
 * list per landing page, is six places for the IA to drift out of step with
 * the header that renders it.
 *
 * ## The card treatment is deliberately the homepage's
 *
 * Green hairline that deepens on hover, one elevation step, and a hover lift —
 * the same surface as the service tiles and committee cards, minus the pointer
 * tilt. The tilt lives in `@/components/v2/primitives`, which is a client
 * component; these are static pages that otherwise ship no JavaScript at all,
 * and a pointer-tracking card is not worth a hydration boundary on 48 routes.
 *
 * `focus-visible` mirrors every `hover` state, because the whole card is the
 * link here and the keyboard must see what the pointer sees.
 */

const CARD =
  "group flex h-full flex-col rounded-[20px] border border-brand-300 bg-white p-6 " +
  "shadow-depth-1 transition-[transform,box-shadow,border-color] duration-300 ease-out-expo " +
  "hover:border-brand-500 hover:shadow-depth-2 motion-safe:hover:-translate-y-1 " +
  "focus-visible:border-brand-500 focus-visible:shadow-depth-2 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700";

/**
 * A section index with its own heading, for the foot of a child page.
 *
 * Every designed page under About ends with the same thing — a heading and
 * the rest of the section — and five copies of that heading's markup is five
 * places for its type scale to drift. It renders nothing when the section has
 * no other children, so the heading can never appear over an empty grid.
 */
export function SectionFooter({
  section,
  exclude,
  title,
}: {
  section: `/${string}`;
  exclude?: `/${string}`;
  /** Written for the reader who has just finished this page. */
  title: string;
}) {
  const all = PRIMARY_NAV.find((s) => s.href === section)?.children ?? [];
  if (all.filter((child) => child.href !== exclude).length === 0) return null;

  return (
    <>
      <h2 className="font-display text-xl font-semibold tracking-tight text-ink-950">
        {title}
      </h2>
      <div className="mt-5">
        <SectionIndex section={section} {...(exclude ? { exclude } : {})} />
      </div>
    </>
  );
}

export function SectionIndex({
  section,
  exclude,
}: {
  section: `/${string}`;
  /**
   * A route to leave out — the page doing the rendering.
   *
   * On the six landing pages this is never needed, because a section's landing
   * page is not among its own children. It is needed the moment a *child* page
   * shows its siblings, which is what the designed shell does at the foot of
   * `/about/history`: without it the page offers a card back to itself, which
   * is the same trap the breadcrumb avoids by not linking its last crumb.
   */
  exclude?: `/${string}`;
}) {
  const all = PRIMARY_NAV.find((s) => s.href === section)?.children ?? [];
  const children = exclude ? all.filter((child) => child.href !== exclude) : all;
  if (children.length === 0) return null;

  return (
    <nav aria-label="In this section">
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {children.map((child) => (
          <li key={child.href}>
            <Link href={child.href} className={CARD}>
              <span className="flex items-start justify-between gap-4">
                <span className="font-display text-lg font-semibold text-ink-950">
                  {child.label}
                </span>
                <ArrowRight
                  aria-hidden
                  className="mt-1 h-4 w-4 shrink-0 text-brand-600 transition-transform duration-300 ease-out-expo motion-safe:group-hover:translate-x-1"
                />
              </span>
              {/* Not every nav entry carries one, and an invented sentence is
                  worse than a shorter card. */}
              {child.description ? (
                <span className="mt-2 text-[0.9375rem] leading-relaxed text-ink-700">
                  {child.description}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
