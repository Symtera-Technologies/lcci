import { Prose } from "./prose";

/**
 * A body that is somebody writing to the reader, set as a letter.
 *
 * One page needs this today — the President's message on `/about/leadership` —
 * and it is the clearest case of why the plain prose column was not enough.
 * The words are a letter: a salutation, five paragraphs in the first person, a
 * name and a post at the foot. Rendered as ordinary page prose they read as a
 * paste, and nothing on the page says the voice changed.
 *
 * So: a rule down the left in brand green, the measure pulled in from 68 to
 * 62 characters, and the opening line set one step larger. That is the whole
 * treatment. No portrait inside it and no quotation marks — the portrait is a
 * content row rendered beside this by the route, and a letter is not a quote.
 *
 * ## Why this is a component and not a class on the route
 *
 * `CmsPage` chooses how a body is laid out (`body="prose" | "editorial" |
 * "letter"`), so every route opts in the same way and the choice is visible in
 * one place per page. The alternative — a route wrapping `CmsPage`'s children
 * in its own markup — is not available, because the body comes from the CMS
 * read that `CmsPage` does.
 *
 * ## It changes no words
 *
 * It wraps and styles; it does not parse, reorder or insert. So unlike
 * `EditorialBody` there is nothing here for `scripts/verify-migrated-text.ts`
 * to catch, and an editor who rewrites the message into something that is not
 * a letter gets prose in a slightly narrower column rather than a mangled
 * page.
 */
export function LetterBody({ html }: { html: string }) {
  return (
    <div className="border-l-2 border-brand-300 pl-5 sm:pl-8">
      <Prose
        html={html}
        className={
          // 62ch rather than the body default: a letter is read as a voice and
          // a shorter line is what makes it sound like one.
          "max-w-[62ch] [&>p:first-of-type]:text-lg [&>p:first-of-type]:text-ink-800"
        }
      />
    </div>
  );
}
