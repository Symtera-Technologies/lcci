import sanitizeHtml from "sanitize-html";

/**
 * Editor HTML, cleaned on the way in.
 *
 * **On write, not on render.** The stored bytes are the sanitised bytes, so a
 * render path that forgets to call this cannot produce an unsanitised page,
 * and the value in the audit log is the value the public saw. Sanitising at
 * render is one forgotten call away from an injection, and leaves the database
 * holding markup nobody has inspected.
 *
 * This is what makes the public CSP's `'unsafe-inline'` tolerable. That
 * directive is the honest cost of keeping the site statically generated — the
 * App Router emits per-page inline bootstraps — and the mitigation is that the
 * site has no injection sink. A rich-text body is the only place on a public
 * page where markup supplied by a person reaches the browser, so this function
 * is that claim's entire implementation. It is not a tidying pass.
 *
 * **An allowlist, never a denylist.** The library defaults to allowing a
 * reasonable set; this narrows it further to the tags the chamber's press
 * releases actually use. Anything unlisted has its tags removed and its text
 * kept, so a paste from Word loses its `<o:p>` and `<span style>` wrappers and
 * keeps the sentence. `<script>`, `<style>`, `<iframe>`, `<object>` and
 * `<form>` are dropped **with their contents**, because the text inside a
 * script tag is code and surfacing it in a paragraph would be worse than
 * dropping it.
 *
 * `sanitize-html` is pure JavaScript (an `htmlparser2` pipeline), which is why
 * it is here rather than a DOM-based cleaner: this project builds off-box for
 * a different architecture and ships to shared cPanel, so a native binary is a
 * deployment failure waiting to happen.
 */

/**
 * The tags an LCCI press release is allowed to contain.
 *
 * Headings start at `h2`: the page supplies the `h1`, and a body that can
 * introduce a second one breaks the document outline for every screen reader
 * that navigates by heading. No `<img>` either — editorial images go through
 * `media_assets`, where alt text is NOT NULL and cannot be skipped, and an
 * `<img>` pasted into the body is exactly how an undescribed photograph gets
 * onto the site.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "u",
  "s",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "a",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "sup",
  "sub",
  "hr",
] as const;

/**
 * Tags whose *contents* go too.
 *
 * The library's default already drops `script` and `style` this way; `iframe`,
 * `object`, `embed`, `form`, `input`, `button`, `textarea` and `select` are
 * added because a chamber press release has no legitimate reason to carry an
 * embed or a form, and a form posting to somewhere else on a page a member
 * trusts is a phishing page with LCCI's letterhead on it.
 */
const DROPPED_WITH_CONTENT = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "noscript",
] as const;

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  allowedAttributes: {
    // `href` only, and no `target` or `rel` from the editor: those are the
    // renderer's to set, so every external link gets `rel="noopener"` whether
    // or not whoever pasted it knew to ask.
    a: ["href"],
    // Column spans are genuine table semantics and nothing else is, so no
    // `style`, `class`, `width` or `bgcolor` — the design system owns how a
    // table looks, and an editor pasting a Word table must not be able to
    // import its colours onto the site.
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
  },
  // `http` and `https` and nothing else. `mailto` is deliberately absent: a
  // published address is scraped within days, and the chamber's contact routes
  // are its own pages. `javascript:` and `data:` are excluded by being
  // unlisted, which is the point of the allowlist.
  allowedSchemes: ["http", "https"],
  allowedSchemesAppliedToAttributes: ["href"],
  // A relative link is an internal one and must keep working.
  allowProtocolRelative: false,
  /**
   * The three tags every editor and every paste produces, mapped rather than
   * dropped.
   *
   * A `contenteditable` surface emits `<b>`, `<i>` and `<div>` — which ones
   * depends on the browser — and a paste from Word brings all three. Without
   * this they are unlisted, so the tags come off and the text stays: bold
   * silently stops being bold, and paragraph breaks silently become one run of
   * prose. Mapping them keeps the editor's intent and still leaves the stored
   * markup inside the allowlist, which is the property that matters.
   *
   * `<div>` becomes `<p>` and not nothing, because a div per paragraph is what
   * a browser produces when a line is typed without a paragraph separator set.
   */
  transformTags: {
    b: "strong",
    i: "em",
    div: "p",
  },
  nonTextTags: [...DROPPED_WITH_CONTENT],
  // Comments can carry conditional markup and leak drafting notes into the
  // page source, where "not for publication" has a way of being read.
  allowedClasses: {},
  parseStyleAttributes: false,
  disallowedTagsMode: "discard",
};

/**
 * Sanitise an editor-supplied HTML body.
 *
 * Returns `null` for anything that is empty once cleaned, so a body somebody
 * cleared — or one that consisted entirely of a pasted `<script>` — is stored
 * as NULL rather than as `"<p></p>"`, which the renderer would otherwise print
 * as a blank paragraph with margins.
 */
export function sanitiseBody(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  const cleaned = sanitizeHtml(raw, OPTIONS).trim();
  if (cleaned === "") return null;

  // `<p>&nbsp;</p>` and friends survive the sanitiser because they are
  // perfectly valid markup; they are still an empty body, and an editor who
  // selected-all and deleted usually leaves one behind.
  const text = sanitizeHtml(cleaned, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;| /g, " ")
    .trim();
  if (text === "") return null;

  return cleaned;
}

/**
 * Block boundaries, which become a space before the tags come off.
 *
 * Stripping tags without this turns `<h2>Energy</h2><p>The chamber…</p>` into
 * `EnergyThe chamber…` — one word that is in no dictionary, in the summary,
 * in the search index and in any length check. Only block-level tags are
 * listed: doing the same to inline tags would break `un<em>believable</em>`
 * into two words, which is the same defect pointing the other way.
 */
const BLOCK_BOUNDARY =
  /<\/?(?:p|br|div|h[1-6]|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|hr)\b[^>]*>/gi;

/**
 * The three entities that survive tag-stripping.
 *
 * `sanitize-html` decodes everything on the way in — `&pound;`, `&mdash;`,
 * `&eacute;` and `&nbsp;` all come back as their characters — and then
 * re-escapes exactly `&`, `<` and `>` on the way out, because its output is
 * normally HTML. Here the output is text, so those three have to come back.
 *
 * One pass over a map rather than three sequential replaces: replacing
 * `&amp;` first would turn a literal `&amp;amp;` into `&amp;` and then a later
 * pass would decode it again, so an editor who wrote about "the &amp; symbol"
 * would find it had quietly become "the & symbol". A single pass never
 * re-scans what it just wrote.
 */
const SURVIVING_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
};

/**
 * The plain text of a body, for summaries, search and length checks.
 *
 * This is the reading length rather than the markup length — which is what a
 * "this body is too long" message has to be counting, or it tells an editor
 * their 400-word release is over a limit because of the tags around it.
 */
export function bodyToText(html: string | null | undefined): string {
  if (!html) return "";

  const spaced = html.replace(BLOCK_BOUNDARY, " ");
  const stripped = sanitizeHtml(spaced, { allowedTags: [], allowedAttributes: {} });

  return stripped
    .replace(/&(?:amp|lt|gt);/g, (entity) => SURVIVING_ENTITIES[entity] ?? entity)
    // U+00A0 is a space for reading purposes, and is what `&nbsp;` decodes to.
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
