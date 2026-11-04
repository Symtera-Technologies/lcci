import { parseRoster, type RosterPerson, type RosterSection } from "@/content/roster";
import { portraitKey } from "@/content/fields";
import { getPortraits, portraitsByName } from "@/content/repository";
import type { Portrait } from "@/content/types";
import { PortraitPlaceholder, PortraitThumb } from "./portraits";
import { Prose } from "./prose";

/**
 * A page whose body is a list of people, rendered as one — with faces.
 *
 * `/about/past-leadership` is the page this is for: sixty former presidents
 * and a hundred and seventeen former vice presidents, all of it migrated off
 * `presidents.php` and none of it reorderable, because
 * `scripts/verify-migrated-text.ts` holds every run of six consecutive words
 * from the legacy page to the built page.
 *
 * So the words stay exactly as they are and only their *arrangement* changes:
 * a name becomes a heading, the year beside it, the firm under it, the contact
 * line under that, and the chamber's own photograph of that person beside the
 * whole thing. See `src/content/roster.ts` for the parse, and for the
 * word-for-word check that makes rearranging safe.
 *
 * ## Where the photographs come from
 *
 * Not from the body. `sanitiseBody` drops `<img>` on write, so no image
 * survived the import — which is the rule working, not a gap. The portraits
 * are `content_portraits` rows keyed by the person's name, and this looks up
 * each name the page is already printing. Sixty of sixty match today; a name
 * with no match gets its initial in the same frame, because thirty broken
 * silhouettes would read as thirty broken images.
 */

/** The small type above a name: the year the old site prints. */
function Term({ children }: { children: string }) {
  return (
    <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-brand-700">
      {children}
    </span>
  );
}

function PersonCard({
  person,
  portrait,
}: {
  person: RosterPerson;
  portrait: Portrait | undefined;
}) {
  return (
    <article className="flex h-full gap-4 rounded-xl border border-brand-300 bg-white p-4 shadow-card sm:gap-5 sm:p-5">
      {portrait ? (
        <PortraitThumb portrait={portrait} />
      ) : (
        <PortraitPlaceholder name={person.name} />
      )}

      {/* The order of these five is the stored body's order, and it is not a
          free choice. The year was set above the name in the first draft of
          this card, as an eyebrow, which reads well and reorders two words of
          the chamber's text — `npm run verify:migration` failed on 352 runs of
          six words, every one of them spanning a name and the year beside it.
          Name, note, year, firm, contact line: that is the source's sequence
          and it is what the design has to work with. */}
      <div className="min-w-0 flex-1">
        <h3 className="font-display text-[1.0625rem] leading-snug font-semibold text-ink-950">
          {person.name}
        </h3>

        {/* "Late", which the old site writes as a heading of its own. Set as
            the aside it is, and still in the document after the name, which is
            where the migrated text has it. */}
        {person.notes.length > 0 ? (
          <p className="mt-0.5 text-[0.8125rem] text-ink-500">{person.notes.join(" · ")}</p>
        ) : null}

        {person.term ? (
          <p className="mt-1">
            <Term>{person.term}</Term>
          </p>
        ) : null}

        {person.firm ? (
          <p className="mt-2 text-[0.9375rem] leading-snug font-medium text-ink-800">
            {person.firm}
          </p>
        ) : null}

        {/* The address, telephone, fax, mobile and email as one run-together
            line, because that is how it is stored and the words cannot be
            re-spaced without changing them. `break-words` so an unbroken
            40-character email does not widen the card on a phone. */}
        {person.detail ? (
          <p className="mt-1 text-[0.8125rem] leading-relaxed break-words text-ink-600">
            {person.detail}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/** A section of people, as a grid of cards. */
function People({
  heading,
  people,
  portraits,
}: {
  heading: string | null;
  people: readonly RosterPerson[];
  portraits: Map<string, Portrait>;
}) {
  return (
    <>
      {heading ? <SectionHeading>{heading}</SectionHeading> : null}

      <ul className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {people.map((person, index) => (
          // The name is not unique — one man served two consecutive terms and
          // appears twice — so the index is part of the key. It is stable
          // because the order is the stored body's order.
          <li key={`${person.name}-${index}`}>
            <PersonCard person={person} portrait={portraits.get(portraitKey(person.name))} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * A section of terms and names, as a table.
 *
 * A real `<table>` and not a styled grid: two columns of a hundred rows, one
 * of which is a year, is tabular data, and a screen reader announcing "Year,
 * 1987, Name, Mir Salahuddin" is worth more here than any layout freedom.
 * The column headings are the old site's own — it set them in bold inside the
 * first paragraph — so they are rendered as headings rather than invented.
 */
function Pairs({
  heading,
  columns,
  pairs,
}: {
  heading: string | null;
  columns: readonly [string, string] | null;
  pairs: readonly { term: string; name: string }[];
}) {
  return (
    <>
      {heading ? <SectionHeading>{heading}</SectionHeading> : null}

      <div className="mt-6 max-w-2xl overflow-hidden rounded-xl ring-1 ring-inset ring-stone-200">
        <table className="w-full border-collapse text-left text-[0.9375rem]">
          {columns ? (
            <thead>
              <tr className="bg-stone-50">
                <th
                  scope="col"
                  className="w-28 border-b border-stone-200 px-4 py-2.5 text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink-600"
                >
                  {columns[0]}
                </th>
                <th
                  scope="col"
                  className="border-b border-stone-200 px-4 py-2.5 text-[0.75rem] font-semibold uppercase tracking-[0.1em] text-ink-600"
                >
                  {columns[1]}
                </th>
              </tr>
            </thead>
          ) : null}

          <tbody>
            {pairs.map((pair, index) => (
              <tr key={`${pair.term}-${pair.name}-${index}`} className="even:bg-stone-50/60">
                <th
                  scope="row"
                  className="border-t border-stone-200/80 px-4 py-2.5 align-top font-medium whitespace-nowrap text-ink-900"
                >
                  {pair.term}
                </th>
                <td className="border-t border-stone-200/80 px-4 py-2.5 align-top text-ink-800">
                  {pair.name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <h2 className="font-display text-xl font-semibold tracking-tight text-ink-950 sm:text-2xl">
      {children}
    </h2>
  );
}

export async function RosterBody({ html }: { html: string }) {
  const sections = parseRoster(html);

  // The same contract as `EditorialBody`: a body this does not recognise — or
  // one an editor has rewritten into a shape it does not recognise — renders
  // as the ordinary prose it always did.
  if (!sections) return <Prose html={html} />;

  return <RosterSections sections={sections} portraits={portraitsByName(await getPortraits())} />;
}

/**
 * The markup, separated from the database read.
 *
 * Only so that a test can render it. The word order inside a card is not a
 * free design choice — it is the chamber's text, under the six-word rule — and
 * the first version of this file got it wrong in a way that only `npm run
 * build` could catch, half an hour later, after prerendering every page. A
 * component with no `await` in it can be rendered by `renderToStaticMarkup` in
 * milliseconds and checked word for word. See `tests/roster-render.test.ts`.
 */
export function RosterSections({
  sections,
  portraits,
}: {
  sections: readonly RosterSection[];
  portraits: Map<string, Portrait>;
}) {
  return (
    <div className="space-y-14">
      {sections.map((section, index) => (
        <section key={section.heading ?? index}>{render(section, portraits)}</section>
      ))}
    </div>
  );
}

function render(section: RosterSection, portraits: Map<string, Portrait>) {
  switch (section.kind) {
    case "people":
      return (
        <People heading={section.heading} people={section.people} portraits={portraits} />
      );
    case "pairs":
      return (
        <Pairs heading={section.heading} columns={section.columns} pairs={section.pairs} />
      );
    case "prose":
      return (
        <>
          {section.heading ? <SectionHeading>{section.heading}</SectionHeading> : null}
          <Prose html={section.html} className="mt-4" />
        </>
      );
  }
}
