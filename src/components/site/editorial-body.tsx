import { ArrowUpRight, FileText } from "lucide-react";
import { cn } from "@/lib/cn";
import { Prose } from "./prose";
import {
  parseEditorial,
  type ContactEntry,
  type Definition,
  type EditorialBlock,
  type EditorialSection,
  type ResourceLink,
} from "@/content/editorial";

/**
 * A CMS body laid out as sections, with plain prose as the fallback.
 *
 * `src/content/editorial.ts` carries the reasoning for why a body is read as
 * sections at all and what the migration verifier forbids. This file is the
 * other half: what each recognised shape looks like.
 *
 * Three rules hold it together.
 *
 * **It adds no words.** Every ordinal on the numbered grid is drawn by the
 * `step-ordinal` CSS counter, because a `01.` written into the markup would
 * sit between two words of somebody's sentence and break the six-word run that
 * spans them. The dash in `Respect – Treating all well…` is rendered for the
 * same reason, styled as the divider it already is rather than deleted.
 *
 * **The cards do not move.** The chamber's card treatment — a green hairline
 * at rest, a lift and a tilt on hover — belongs to cards that are links, and
 * every grid that uses it on the homepage is a grid of links. These cards are
 * text. They keep the hairline, which is the part that makes a grid read as
 * LCCI's, and drop the motion, which would promise a destination that is not
 * there. See `src/components/ui/card.ts`.
 *
 * **It degrades to `<Prose>`.** An editor who rewrites one of these pages in
 * the admin and produces a shape this does not recognise gets an ordinary,
 * correct page. Nothing here is required for the content to be readable.
 */

export function EditorialBody({ html }: { html: string }) {
  const sections = parseEditorial(html);
  if (!sections) return <Prose html={html} />;

  return (
    <div className="max-w-none">
      {sections.map((section, i) => (
        <Section key={i} section={section} first={i === 0} />
      ))}
    </div>
  );
}

function Section({ section, first }: { section: EditorialSection; first: boolean }) {
  const { heading, blocks } = section;

  /**
   * A heading with nothing under it is a label for what follows, not a section
   * of its own — `/about/history` opens with `<h2>Vision &amp; Mission</h2>`
   * and then goes straight into `<h3>Our Vision</h3>`. Set as an eyebrow it
   * reads as the page's subject; set as an `h2` with no body it reads as a
   * section whose content failed to load.
   *
   * It stays an `h2` in the markup. The outline is what a screen reader
   * navigates by and it is correct; only its size changes.
   */
  if (blocks.length === 0 && heading) {
    return (
      <h2 className="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-brand-700">
        {heading.text}
      </h2>
    );
  }

  const Tag = heading ? (`h${heading.level}` as "h2" | "h3" | "h4") : null;

  return (
    <section className={first ? "mt-6" : "mt-14"}>
      {Tag && heading ? (
        <div className="flex items-center gap-4">
          <Tag className="font-display text-xl font-semibold tracking-tight text-ink-950 sm:text-2xl">
            {heading.text}
          </Tag>
          {/* Carries the eye across to the right margin, which is what stops a
              three-word heading from looking stranded above a wide grid. */}
          <span aria-hidden className="h-px flex-1 bg-stone-200" />
        </div>
      ) : null}

      <div className={Tag ? "mt-5" : undefined}>
        {blocks.map((block, i) => (
          <Block key={i} block={block} level={heading?.level ?? 2} />
        ))}
      </div>
    </section>
  );
}

function Block({ block, level }: { block: EditorialBlock; level: 2 | 3 | 4 }) {
  switch (block.kind) {
    case "statement":
      return <Statement text={block.text} />;
    case "statements":
      return <Statements items={block.items} />;
    case "definitions":
      return <Definitions items={block.items} />;
    case "documents":
      return <Documents items={block.items} />;
    case "links":
      return (
        <Links
          items={block.items}
          level={level}
          {...(block.caption ? { caption: block.caption } : {})}
        />
      );
    case "contacts":
      return <Contacts items={block.items} level={level} />;
    case "facts":
      return <Facts items={block.items} />;
    case "label":
      return <Label text={block.text} level={level} />;
    case "prose":
      return <Prose html={block.html} className="mt-4" />;
  }
}

/**
 * The heading level a block's own headings take.
 *
 * One below the section's, capped at `h4` — which is where the sanitiser's
 * allowlist stops, and below which a screen reader's outline stops being
 * useful anyway. The point is that the outline stays monotonic: a directory
 * card's name under an `h3` section is an `h4`, and the same card under a
 * body with no headings at all is an `h3`.
 */
function under(level: 2 | 3 | 4): "h3" | "h4" {
  return level === 2 ? "h3" : "h4";
}

/**
 * One short claim, set to be read as the page's own position.
 *
 * Deliberately not a `<blockquote>`. A vision statement is the chamber
 * speaking, not the chamber quoting, and marking it up as a quotation would
 * tell a screen reader that somebody else said it.
 */
function Statement({ text }: { text: string }) {
  return (
    // Capped at the panel rather than at the paragraph inside it. Letting the
    // panel run the full container and holding the text to a measure leaves a
    // third of a tinted box empty, which reads as a layout that broke.
    <figure className="relative max-w-3xl overflow-hidden rounded-xl bg-stone-50 p-7 ring-1 ring-inset ring-stone-200 sm:p-9">
      <span
        aria-hidden
        className="absolute inset-y-0 start-0 w-1 bg-gradient-to-b from-brand-500 to-brand-700"
      />
      <p className="font-display text-xl leading-snug tracking-tight text-ink-950 sm:text-[1.625rem]">
        {text}
      </p>
    </figure>
  );
}

/**
 * Claims of equal weight, as a numbered grid.
 *
 * An `<ol>` because they are enumerated and the order is the chamber's, and
 * two columns rather than three: these are sentences, and a 32-character
 * measure turns a sentence into a column of fragments. The last card in an odd
 * run is left at half width rather than stretched, so the grid keeps one
 * rhythm.
 */
function Statements({ items }: { items: readonly string[] }) {
  return (
    <ol className="step-list grid grid-cols-1 gap-4 sm:grid-cols-2">
      {items.map((text, i) => (
        <li
          key={i}
          className="step-ordinal relative rounded-xl border border-brand-300 bg-white p-6 pt-12 shadow-card"
        >
          <p className="text-[0.9375rem] leading-relaxed text-ink-800">{text}</p>
        </li>
      ))}
    </ol>
  );
}

/** Whether an href leaves this site, by the same test `<Prose>` uses. */
function isOutbound(href: string | undefined): boolean {
  return href !== undefined && /^(https?:)?\/\//i.test(href);
}

/**
 * Files the page links to, as rows.
 *
 * Rows and not cards: `/about/minutes` has thirty-nine of these and every one
 * of them is the same kind of thing with a different date, so a grid of
 * thirty-nine identical tiles is harder to scan than a list. They share a
 * single bordered panel with hairline separators, which is also what makes the
 * whole set read as one archive rather than as thirty-nine lists of one — what
 * the markup literally is.
 *
 * `target="_blank"` and `rel` on the outbound ones, for the reason
 * `withSafeOutboundLinks` gives in `prose.tsx`: the sanitiser strips both on
 * write because they are the renderer's to set, and these hrefs all point at
 * PDFs still sitting on the legacy host.
 *
 * The icon is decorative — the label says what the thing is — so it is
 * `aria-hidden`, and nothing about the row's meaning depends on it.
 */
function Documents({ items }: { items: readonly ResourceLink[] }) {
  return (
    <ul className="divide-y divide-stone-200 overflow-hidden rounded-xl ring-1 ring-inset ring-stone-200">
      {items.map((item, i) => (
        <li key={`${item.href}-${i}`}>
          <a
            href={item.href}
            {...(isOutbound(item.href)
              ? { target: "_blank", rel: "noopener noreferrer" }
              : {})}
            className="group flex items-center gap-3.5 px-4 py-3.5 transition-colors hover:bg-stone-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-700 sm:px-5"
          >
            <FileText
              aria-hidden
              className="h-4.5 w-4.5 shrink-0 text-brand-600 transition-colors group-hover:text-brand-800"
            />
            <span className="text-[0.9375rem] leading-snug text-ink-800 underline decoration-stone-300 decoration-from-font underline-offset-4 group-hover:text-ink-950 group-hover:decoration-brand-500">
              {item.label}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Named things and what they mean, as a grid of cards.
 *
 * The term becomes the card's heading at `h4` — these sit under an `h3`, so
 * that is the next level down and the document outline stays honest. The dash
 * the source wrote between the term and its meaning is kept and set as a short
 * green rule-like glyph: it is a word in the verifier's sequence, and it was
 * always the divider, so drawing it as one is reading the source rather than
 * overriding it.
 */
function Definitions({ items }: { items: readonly Definition[] }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item, i) => (
        <li
          key={i}
          className="flex flex-col rounded-xl border border-brand-300 bg-white p-6 shadow-card"
        >
          <h4 className="font-display text-lg font-semibold tracking-tight text-ink-950">
            {item.term}
          </h4>
          <span
            className="mt-2 font-display text-2xl leading-none text-brand-500"
            // Not `aria-hidden`: it is part of the sentence the source wrote,
            // and a reader who hears "Respect — treating all well" is hearing
            // the page as published.
          >
            {item.dash}
          </span>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-700">{item.meaning}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * A bolded phrase the source used as a sub-heading, set as one.
 *
 * `<p><strong>Internet Facility:</strong></p>` is how every legacy page wrote
 * a heading it did not make a heading, and there are dozens of them across
 * Services, Resources and Trade. Rendered as prose they are a bold line in a
 * column of paragraphs, indistinguishable from a bolded sentence; rendered as
 * a real heading they give those pages the outline they always had in
 * somebody's mind and never had in their markup.
 *
 * It becomes an actual heading element and not a styled paragraph, because the
 * thing being fixed is navigability as much as it is weight — a screen reader
 * jumping by heading should land on these.
 */
function Label({ text, level }: { text: string; level: 2 | 3 | 4 }) {
  // Written out rather than built from a template string. A tag name computed
  // during render is a component created during render as far as React's lint
  // rule is concerned, and two branches are cheaper than an exception to it.
  const props = {
    className:
      "mt-10 font-display text-[1.0625rem] font-semibold tracking-tight text-ink-950 first:mt-0",
    children: text,
  };
  return under(level) === "h3" ? <h3 {...props} /> : <h4 {...props} />;
}

/**
 * Websites, as a directory to scan across.
 *
 * Two columns, not the single column `Documents` uses, and the difference is
 * the content rather than the taste: thirty bank websites are a set somebody
 * scans for one name, where thirty-nine PDFs of minutes are an archive
 * somebody reads down by date. A hundred embassy names in one column is four
 * screens of scrolling to find Japan.
 *
 * The note — `(HBL)`, or the address spelled out in the second column of the
 * airline table — is set under the label rather than beside it. It is often
 * the longest part of the row, and inline it would push half the names onto a
 * second line and destroy the column.
 */
function Links({
  items,
  caption,
  level,
}: {
  items: readonly ResourceLink[];
  caption?: string;
  level: 2 | 3 | 4;
}) {
  return (
    <>
      {caption ? <Label text={caption} level={level} /> : null}

      <ul className="mt-4 grid grid-cols-1 gap-px overflow-hidden rounded-xl bg-stone-200 ring-1 ring-stone-200 sm:grid-cols-2">
        {items.map((item, i) => {
          const body = (
            <>
              <ArrowUpRight
                aria-hidden
                className={cn(
                  "mt-0.5 h-4 w-4 shrink-0 transition-colors",
                  item.href ? "text-stone-400 group-hover:text-brand-700" : "text-stone-300",
                )}
              />
              <span className="min-w-0">
                <span
                  className={cn(
                    "block text-[0.9375rem] leading-snug",
                    item.href
                      ? "text-ink-800 underline decoration-stone-300 decoration-from-font underline-offset-4 group-hover:text-ink-950 group-hover:decoration-brand-500"
                      : "text-ink-600",
                  )}
                >
                  {item.label}
                </span>
                {item.note ? (
                  <span className="mt-0.5 block text-[0.8125rem] leading-snug break-words text-ink-500">
                    {item.note}
                  </span>
                ) : null}
              </span>
            </>
          );

          const shared = "flex h-full items-start gap-2.5 px-4 py-3 sm:px-5";

          return (
            <li key={`${item.href ?? item.label}-${i}`} className="bg-white">
              {/* An entry whose link was never finished is a `<span>` and not
                  an `<a href>` — a dead anchor takes a tab stop and announces
                  itself as a link that goes nowhere, which is worse than
                  plain text saying the chamber has no address for this one. */}
              {item.href ? (
                <a
                  href={item.href}
                  {...(isOutbound(item.href)
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                  className={cn(
                    shared,
                    "group transition-colors hover:bg-brand-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-700",
                  )}
                >
                  {body}
                </a>
              ) : (
                <span className={shared}>{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * Organisations with their addresses, as a directory of cards.
 *
 * The name is lifted out of the entry and set as a heading; everything else
 * goes through `<Prose>` exactly as it was stored. That second half is the
 * important one — these entries are addresses, telephone numbers, faxes,
 * emails and websites in forty different orders, and any attempt to parse the
 * lines into fields would be wrong on the first entry that wrote "Tel" where
 * the one above wrote "Phone".
 *
 * `prose-tight` because the stored markup is one paragraph of `<br />`-broken
 * lines and the default paragraph rhythm sets them too far apart to read as an
 * address block.
 */
function Contacts({
  items,
  level,
}: {
  items: readonly ContactEntry[];
  level: 2 | 3 | 4;
}) {
  const heading = (name: string) => {
    const props = {
      className: "font-display text-[1.0625rem] leading-snug font-semibold text-ink-950",
      children: name,
    };
    return under(level) === "h3" ? <h3 {...props} /> : <h4 {...props} />;
  };

  return (
    <ul className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      {items.map((item, i) => (
        <li
          key={`${item.name}-${i}`}
          className="flex h-full flex-col rounded-xl border border-brand-300 bg-white p-5 shadow-card"
        >
          {heading(item.name)}
          <Prose html={item.html} className="prose-tight mt-2" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Short plain items, in columns.
 *
 * The marker is a green dot drawn by CSS and not a bullet character, for the
 * same reason the numbered grid's ordinals are: anything written into the
 * markup between two items is a word in the sequence
 * `scripts/verify-migrated-text.ts` checks, and these items sit directly
 * beside each other in the source.
 */
function Facts({ items }: { items: readonly string[] }) {
  return (
    <ul className="mt-4 grid grid-cols-1 gap-x-8 gap-y-px sm:grid-cols-2 lg:grid-cols-3">
      {items.map((text, i) => (
        <li
          key={`${text}-${i}`}
          className="flex items-start gap-2.5 border-b border-stone-200/80 py-2.5 text-[0.9375rem] leading-snug text-ink-800"
        >
          <span aria-hidden className="mt-[0.4375rem] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
          <span className="min-w-0 break-words">{text}</span>
        </li>
      ))}
    </ul>
  );
}
