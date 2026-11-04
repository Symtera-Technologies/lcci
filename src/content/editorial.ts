/**
 * Read a sanitised CMS body as *sections*, so a page can be laid out rather
 * than poured out.
 *
 * ## The problem this solves
 *
 * Every interior page's prose came off lcci.com.pk unchanged, and the old site
 * wrote everything as a flat run of paragraphs. `/about/history` is the clear
 * case: a vision statement, five mission commitments and five named values,
 * all of them `<p>` siblings under three `<h3>`s. Rendered as prose that is
 * eleven indistinguishable paragraphs — correct, and it reads like a document
 * someone pasted rather than a page someone designed.
 *
 * The words cannot change: `scripts/verify-migrated-text.ts` asserts that
 * every run of six consecutive words from the legacy page appears in the built
 * HTML. So the only thing available is *presentation* — recognise the shape
 * the paragraphs already have and give each shape a layout.
 *
 * ## What that constraint rules out, and it is not obvious
 *
 * The verifier compares word sequences, so **no new text may be inserted
 * between existing words.** A visible "01." before each mission statement
 * would break the run that spans the paragraph boundary before it, and the
 * dash in `Respect – Treating all well…` is itself a word in that sequence and
 * cannot be dropped. Ordinals are therefore drawn by a CSS counter (see
 * `step-ordinal` in `globals.css`) and the dash is kept and styled as the
 * divider it already is. This is why the renderer may only *regroup* text, and
 * why these functions return the original strings untouched.
 *
 * ## Why parsing is safe here
 *
 * The same reason `withSafeOutboundLinks` in `prose.tsx` is allowed a regex:
 * this is not arbitrary HTML. It went through `sanitize-html` on write, so
 * every tag is from a 20-tag allowlist, attributes are quoted, and there are
 * no comments, no CDATA and no unclosed tags. A body that does not tokenise
 * cleanly is not forced — `parseEditorial` returns `null` and the caller
 * renders plain `<Prose>`.
 *
 * ## Why it never guesses
 *
 * A classification is only applied when the whole section matches it, and the
 * fallback at every level is prose. An editor who rewrites this page in the
 * admin and produces something that no longer matches gets a correct ordinary
 * page, not a mangled one. That is the only acceptable failure mode for a
 * layout inferred from content somebody else controls.
 */

/** Block-level tags the sanitiser can emit at the top level of a body. */
const BLOCK =
  "h2|h3|h4|p|ul|ol|blockquote|table|figure|hr|pre|div|section";

const HEADING_RE = /^<(h2|h3|h4)\b[^>]*>([\s\S]*)<\/\1>$/i;
const PARAGRAPH_RE = /^<p\b[^>]*>([\s\S]*)<\/p>$/i;

/**
 * `<strong>Respect</strong> – Treating all well…`
 *
 * An en dash, em dash or hyphen, because the legacy pages use all three and an
 * editor will type whichever their keyboard offers. The dash is captured
 * rather than discarded: it is a word in the verifier's sequence, and it is
 * also the divider the design draws, so it is handed back to be rendered.
 */
const DEFINITION_RE =
  /^<strong\b[^>]*>([^<]+)<\/strong>\s*([–—-])\s*([\s\S]+)$/i;

/** No inline markup at all — safe to render as a text node. */
const PLAIN = /^[^<>]*$/;

/**
 * Invisible characters that are not words.
 *
 * Zero-width space, zero-width non-joiner and joiner, and the byte-order
 * mark. The legacy minutes page carries forty-two zero-width spaces, each in a
 * paragraph of its own between two lists \u2014 debris from whatever editor typed
 * it. They are removed rather than turned into spaces, so that one sitting
 * inside a word joins its halves rather than splitting it in two.
 *
 * `scripts/verify-migrated-text.ts` ignores them for the same reason and with
 * the same character class: a zero-width space is not one of the chamber's
 * words, and counting it as one makes a run of six "words" that is really five
 * and a piece of editor debris.
 */
const INVISIBLE = /[\u200b\u200c\u200d\ufeff]/g;

/**
 * Whether a fragment of markup contributes no words at all.
 *
 * Replaces a regex that tested for `&nbsp;` and whitespace by name. That test
 * was right about the three spacer shapes `/about/history` uses and wrong
 * about the one `/about/minutes` uses \u2014 `<p><strong>&#8203;</strong></p>` \u2014
 * which has a tag in it and so matched nothing. Asking "does this render any
 * words" instead of "is this one of the spacers I know" is both shorter and
 * the actual question.
 */
function wordless(markup: string): boolean {
  return (
    decodeText(markup.replace(/<[^>]*>/g, " "))
      .replace(INVISIBLE, "")
      .replace(/[\u00a0\ufffd]/g, " ")
      .trim() === ""
  );
}

/**
 * Longest a paragraph may be and still be laid out as a card or a statement.
 *
 * Above this it is a paragraph of argument rather than a claim, and a grid of
 * three long paragraphs is harder to read than three paragraphs. 240 covers
 * every mission and value statement on `/about/history` (the longest is 193)
 * with room for a wordier one, and excludes the narrative paragraphs on
 * `/about/secretariat`, which start at about 400.
 */
const CARDABLE = 240;

/**
 * As long as a lone paragraph may be and still be set large.
 *
 * Lower than `CARDABLE` because a statement is set at around 26px: 240
 * characters in a card is four comfortable lines, and 240 characters at
 * display size is a wall. The vision statement on `/about/history`, which is
 * what this exists for, is 131.
 */
const STATEMENT_MAX = 200;

/**
 * What a paragraph has to be before it is set as a claim.
 *
 * `/trade/exhibitions` is what this is for. Under its "Participation Fee"
 * heading are two paragraphs, "Rs. 500,000" and "Last Date: 23rd October,
 * 2026" — short, plain and side by side, which was the whole of the old test.
 * They came out as a numbered grid reading **01** Rs. 500,000, **02** Last
 * Date, which asserts an enumeration the chamber never wrote and makes a fee
 * and a deadline look like two steps of a procedure.
 *
 * A claim is a sentence: at least six words, ending the way a sentence ends.
 * Every one of the six vision and mission paragraphs on `/about/history` —
 * the layout this feature was built for — clears both by a wide margin, and
 * the fee and the date clear neither. Three before a run is a grid, because
 * two paragraphs side by side are two paragraphs.
 */
const SENTENCE_END = /[.!?][)"'’”]?$/;
const STATEMENT_MIN_WORDS = 6;
const STATEMENTS_MIN = 3;

function isClaim(text: string): boolean {
  return SENTENCE_END.test(text) && words(text).length >= STATEMENT_MIN_WORDS;
}

export interface Heading {
  readonly level: 2 | 3 | 4;
  /** Plain text. A heading carrying a link disqualifies the whole body. */
  readonly text: string;
}

/**
 * Somewhere the page sends you: a file to download, a bank's website, a
 * ministry's directory row.
 *
 * One type for both, because the parse is the same — a row whose content is a
 * link — and only the *destination* differs. Which it is, is decided from the
 * href by `isFile`, so a list of PDFs is laid out as an archive and a list of
 * websites as a directory without either having to be marked up differently
 * by whoever typed it in 2014.
 */
export interface ResourceLink {
  /**
   * Absent when the source wrote an anchor with no address.
   *
   * `<a>Khaleej Time</a>` is the seventh of seven items on
   * `/resources/newspapers-international` — somebody started a link and never
   * finished it, or the sanitiser refused the scheme on write. The first
   * version of this parser declined the whole list over it, which meant one
   * unfinished entry cost the other six their layout. The row renders as
   * plain text instead, which is what the old page did with it too: it is not
   * a link, and saying so is more use than pretending the list is not a list.
   */
  readonly href?: string;
  readonly label: string;
  /**
   * Whatever the source wrote beside the link in the same row.
   *
   * `<a>Habib Bank Limited</a> (HBL)` on the banks page, and the second column
   * of the airline and ministry tables, which spells the address out. It is
   * **kept and rendered**: those are words in the sequence
   * `scripts/verify-migrated-text.ts` checks, and dropping one would break
   * every six-word run that spans the row.
   */
  readonly note?: string;
}

/** One organisation in a directory: a name, then its address block. */
export interface ContactEntry {
  readonly name: string;
  /**
   * The rest of the entry, as the source wrote it.
   *
   * Markup rather than parsed fields, deliberately. These are addresses,
   * telephone numbers, faxes, a website and an email, broken with `<br />` in
   * forty different orders across three pages, and a parser that guessed which
   * line was the fax would be wrong on the first page that did it differently.
   * `<Prose>` renders it, which also means the link safety and the typography
   * are the ones the rest of the site already uses.
   */
  readonly html: string;
}

/** A term and what it means, from `<strong>Term</strong> – meaning`. */
export interface Definition {
  readonly term: string;
  /** The dash as written. Rendered, because the verifier counts it. */
  readonly dash: string;
  readonly meaning: string;
}

export type EditorialBlock =
  /** One short claim, set large. A vision, a promise, a single finding. */
  | { readonly kind: "statement"; readonly text: string }
  /** Several short claims of equal weight. Laid out as a numbered grid. */
  | { readonly kind: "statements"; readonly items: readonly string[] }
  /** Several `Term – meaning` pairs. Laid out as a grid of named cards. */
  | { readonly kind: "definitions"; readonly items: readonly Definition[] }
  /**
   * Links to files, from lists whose every item is one link and nothing else.
   *
   * Consecutive lists merge into one block, which is the whole reason this
   * kind exists: `/about/minutes` is thirty-nine `<ul>`s of one `<li>` each,
   * separated by paragraphs holding a zero-width space, and rendered as
   * written that is thirty-nine lists of one bullet.
   */
  | { readonly kind: "documents"; readonly items: readonly ResourceLink[] }
  /**
   * Links to other websites, as a directory.
   *
   * The same parse as `documents` and a different layout, chosen from the
   * href: thirty bank websites are a set to scan across, where thirty-nine
   * PDFs of meeting minutes are an archive to read down. See `isFile`.
   */
  | {
      readonly kind: "links";
      readonly items: readonly ResourceLink[];
      /** A heading row the source put inside the table, kept in its place. */
      readonly caption?: string;
    }
  /** Organisations with their addresses, as a directory of cards. */
  | { readonly kind: "contacts"; readonly items: readonly ContactEntry[] }
  /**
   * Short plain items — a list of names, a list of telephone numbers.
   *
   * Set in columns rather than as one tall bulleted column: seventeen
   * government departments at three words each is a shape, and a bullet list
   * of them is a quarter of the screen used and three quarters wasted.
   */
  | { readonly kind: "facts"; readonly items: readonly string[] }
  /**
   * A paragraph that is only a bolded phrase, which is how the legacy site
   * wrote every sub-heading it did not make a real heading.
   */
  | { readonly kind: "label"; readonly text: string }
  /** Anything else, rendered as ordinary prose from its original HTML. */
  | { readonly kind: "prose"; readonly html: string };

export interface EditorialSection {
  /** `null` for content before the body's first heading. */
  readonly heading: Heading | null;
  /** Empty when a heading introduces the section below it and nothing else. */
  readonly blocks: readonly EditorialBlock[];
}

/**
 * Split a body into its top-level blocks, or `null` if anything is left over.
 *
 * A scanner rather than a global regex, because a block may contain another of
 * the same name: `/about/secretariat` has a `<ul>` with a nested `<ul>` inside
 * one of its items, and a non-greedy pattern closes the outer list at the
 * inner list's `</ul>`. The first version of this used that pattern and
 * noticed — it compares what it consumed against the whole body and returns
 * `null` on any remainder — so the page fell back to prose rather than
 * rendering a truncated list. Correct, and a layout we could have.
 *
 * So the closing tag is found by counting depth: each `<ul` inside raises it
 * and each `</ul>` lowers it. Which is only safe because this is not arbitrary
 * HTML — it went through `sanitize-html` on write, so there are no comments,
 * no CDATA, no unclosed tags and no `<` left loose in text.
 *
 * Anything other than whitespace between two blocks still returns `null`. The
 * past-leadership page is nothing but such text (`src/content/roster.ts`
 * handles that one), and a body we have not understood must not be
 * restructured on a guess.
 */
function topLevelBlocks(html: string): string[] | null {
  const blocks: string[] = [];
  const open = new RegExp(`^<(${BLOCK})\\b[^>]*>`, "i");
  const voidTag = /^<hr\b[^>]*>/i;

  let cursor = 0;

  while (cursor < html.length) {
    // Whitespace between blocks is the template's, not the author's.
    const rest = html.slice(cursor);
    const space = /^\s+/.exec(rest);
    if (space) {
      cursor += space[0].length;
      continue;
    }

    const selfClosing = voidTag.exec(rest);
    if (selfClosing) {
      blocks.push(selfClosing[0]);
      cursor += selfClosing[0].length;
      continue;
    }

    const start = open.exec(rest);
    if (!start) return null;

    const tag = (start[1] ?? "").toLowerCase();
    const end = closingIndex(html, cursor + start[0].length, tag);
    if (end === null) return null;

    blocks.push(html.slice(cursor, end));
    cursor = end;
  }

  return blocks.length > 0 ? blocks : null;
}

/**
 * Where the block opened at `from` ends, counting nested tags of the same name.
 *
 * Returns the index just past the matching close tag, or `null` if the body
 * runs out first — which on sanitised markup means this function has
 * misunderstood something, and the caller declines the whole layout.
 */
function closingIndex(html: string, from: number, tag: string): number | null {
  const step = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
  step.lastIndex = from;

  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = step.exec(html)) !== null) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }

  return null;
}

function asHeading(block: string): Heading | null {
  const match = HEADING_RE.exec(block.trim());
  if (!match) return null;

  const inner = match[2] ?? "";
  // `<h3><strong>Our Mission</strong></h3>` is how the legacy editor bolded a
  // heading, and the emphasis is redundant once the heading is styled as one.
  // Anything richer than that — a link, an image — is a heading we would be
  // flattening, so the whole body goes to prose instead.
  const markup = inner.replace(/<\/?strong\b[^>]*>|<\/?em\b[^>]*>/gi, "").trim();
  if (!PLAIN.test(markup)) return null;

  // Emptiness is judged *after* decoding, which the first version did not do:
  // `<h2>&nbsp;</h2>` on `/trade/exhibitions` is six characters of markup and
  // no words, so it passed the test and rendered as a heading with nothing in
  // it, sitting between two real ones.
  const text = plainText(markup);
  if (text === "") return null;

  return { level: Number(match[1]?.[1]) as 2 | 3 | 4, text };
}

/** The inner HTML of a paragraph, or `null` if the block is not one. */
function asParagraph(block: string): string | null {
  const match = PARAGRAPH_RE.exec(block.trim());
  return match ? (match[1] ?? "") : null;
}

const LIST_RE = /^<(ul|ol)\b[^>]*>([\s\S]*)<\/\1>$/i;
const LIST_ITEM_RE = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const HREF_RE = /\bhref="([^"]*)"/i;

/**
 * Tags that carry no meaning once the design sets the type itself.
 *
 * The legacy editor wrapped the same link in `<h3><strong><a>` on one page,
 * `<strong><a>` on the next and `<a>` on a third — three spellings of "this
 * is a link in a list". Stripping them is what lets one parse recognise all
 * three, and it loses nothing: the words are untouched, and a row of links
 * gets its weight from the layout rather than from a `<strong>` somebody typed.
 */
const WRAPPER_RE = /<\/?(?:h[234]|strong|em|b|i|u|span)\b[^>]*>/gi;
const BR_RE = /<br\s*\/?>/gi;
const LIST_WRAPPER_RE = /<\/?(?:ul|ol|li)\b[^>]*>/gi;

/** One link and whatever the source wrote after it. */
const LINK_THEN_TEXT_RE = /^<a\b([^>]*)>([^<]*)<\/a>([\s\S]*)$/i;

/** A paragraph that is nothing but a bolded phrase. */
const LABEL_RE = /^<strong\b[^>]*>([\s\S]*)<\/strong>$/i;

/** Emphasis that is not `<strong>`, which `LABEL_RE` needs left in place. */
const EMPHASIS_RE = /<\/?(?:em|b|i|u|span)\b[^>]*>/gi;

/**
 * Longest a directory entry's name may be.
 *
 * The longest real one is "Shaikh Zayed Federal Postgraduate Medical Institute"
 * at 51. The guard is for the fallback that reads a name off the first line of
 * a paragraph: without it, any paragraph with a line break in it could become
 * an "entry" whose name is a sentence.
 */
const NAME_MAX = 120;

/**
 * As long as a plain list item may be and still be set in columns.
 *
 * "Punjab Employee Social Security Institution. (PESSI)" is 51 and the longest
 * on `/membership/why-join`; "Pakistan Tourism Dev. Corp: 042-36363946-9" is
 * 42 and among the longest on the helpline page. Above this a list item is a
 * sentence, and sentences in three columns are a wall.
 */
const FACT_MAX = 90;

/** How many plain items it takes before columns beat a bulleted list. */
const FACTS_MIN = 3;

/**
 * Text as a reader sees it: entities decoded, debris and runs of space gone.
 *
 * The replacement character goes to a space rather than being deleted. The
 * legacy pages are full of Windows-1252 bytes that arrived as U+FFFD, the
 * verifier turns each into a space when it reads the source, and anything
 * else here would put the two sides of that comparison out of step.
 */
function plainText(value: string): string {
  return decodeText(value)
    .replace(INVISIBLE, "")
    .replace(/�/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether an href points at a file to download rather than a site to visit. */
function isFile(href: string): boolean {
  return /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|csv|txt)(?:[?#]|$)/i.test(href);
}

/**
 * One row's worth of markup as a link, or `null`.
 *
 * Accepts a link wrapped in any of the meaningless tags above, with optional
 * plain text after it — which is the note. It refuses a row with a *second*
 * tag after the link, because that is a row carrying its own sentence or its
 * own second link (`/resources/member-websites` has both), and flattening one
 * into a label and a note would be a guess about which part is which.
 */
function asResourceLink(markup: string): ResourceLink | null {
  const flat = markup.replace(BR_RE, " ").replace(WRAPPER_RE, "").trim();

  const link = LINK_THEN_TEXT_RE.exec(flat);
  if (!link) return null;

  const label = plainText(link[2] ?? "");
  if (label === "") return null;

  const rest = link[3] ?? "";
  if (!PLAIN.test(rest)) return null;

  // The sanitiser strips `href` from anything it does not like, so a missing
  // one means the link was already broken when it was saved. See `href`.
  const href = HREF_RE.exec(link[1] ?? "")?.[1];
  const note = plainText(rest);

  return {
    ...(href ? { href } : {}),
    label,
    ...(note === "" ? {} : { note }),
  };
}

/** A list whose every item is a single link, as links. `null` otherwise. */
function asLinkList(block: string): ResourceLink[] | null {
  const list = LIST_RE.exec(block.trim());
  if (!list) return null;

  const items: ResourceLink[] = [];
  let count = 0;

  for (const item of (list[2] ?? "").matchAll(LIST_ITEM_RE)) {
    count += 1;
    const link = asResourceLink(item[1] ?? "");
    if (!link) return null;
    items.push(link);
  }

  // A list the regex found no items in is not a list this understood.
  if (count === 0 || items.length !== count) return null;

  return items;
}

/** A list whose every item is short, plain and unlinked. `null` otherwise. */
function asFactList(block: string): string[] | null {
  const list = LIST_RE.exec(block.trim());
  if (!list) return null;

  const items: string[] = [];
  let count = 0;

  for (const item of (list[2] ?? "").matchAll(LIST_ITEM_RE)) {
    count += 1;

    const flat = (item[1] ?? "").replace(BR_RE, " ").replace(WRAPPER_RE, "");
    if (!PLAIN.test(flat)) return null;

    const text = plainText(flat);
    if (text === "" || text.length > FACT_MAX) return null;
    items.push(text);
  }

  if (count === 0 || items.length !== count || items.length < FACTS_MIN) return null;

  return items;
}

/* -------------------------------------------------------------------------- */
/* Directories laid out as tables                                             */
/* -------------------------------------------------------------------------- */

/**
 * Three of the Resources pages are a two-column table of name and address,
 * typed inside two or three nested tables because that is what the 2014 editor
 * produced when somebody pasted from a word processor.
 *
 * Rendered as written they are a table inside a table inside a table, each
 * cell holding a bulleted list of exactly one item. The words are a directory;
 * the markup is an accident. So the rows are flattened to links — and because
 * flattening is the one operation that could lose a cell nobody noticed, the
 * whole thing is checked word for word against the table it came from and
 * declined on any difference. Same property as `parseRoster`, same reason.
 */
type TableEntry =
  | { readonly kind: "caption"; readonly text: string }
  | { readonly kind: "link"; readonly link: ResourceLink };

/** Words, as both the verifier and this file count them. */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** The words a fragment of markup renders, in order. */
function textWords(markup: string): string[] {
  return words(plainText(markup.replace(/<[^>]*>/g, " ")));
}

function sameWords(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((word, index) => after[index] === word);
}

/**
 * The inner HTML of each `<tag>` at the top level of `html`.
 *
 * Depth-counted through `closingIndex`, which is the whole point: a `<tr>`
 * holding a nested table holds that table's rows too, so the first `</tr>`
 * after it is usually not its own.
 */
function childElements(html: string, tag: string): string[] {
  const open = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const close = new RegExp(`</${tag}\\s*>$`, "i");
  const out: string[] = [];
  let cursor = 0;

  for (;;) {
    open.lastIndex = cursor;
    const start = open.exec(html);
    if (!start) return out;

    const from = start.index + start[0].length;
    const end = closingIndex(html, from, tag);
    if (end === null) return out;

    out.push(html.slice(from, end).replace(close, ""));
    cursor = end;
  }
}

/**
 * A table that is only a box drawn around something else, unwrapped.
 *
 * `/trade/humanitarian-appeals` is eighteen tables deep in places, because
 * each appeal is an email somebody pasted in and the mail client wrote the
 * letter inside a table, inside a table, inside a table. None of them is
 * tabular: every one has a single row with a single cell. Rendered as written
 * the page is a set of nested boxes with a paragraph at the bottom.
 *
 * Only a table with exactly one row and one cell that carry any words is
 * unwrapped, so a fee schedule or a tariff keeps its table. What comes out is
 * re-read as blocks and goes back through the same loop, which is what lets
 * eighteen of these peel off one at a time.
 */
function unwrapWrapperTable(block: string): string[] | null {
  const rows = childElements(block, "tr").filter((row) => !wordless(row));
  if (rows.length === 0) return null;

  const out: string[] = [];

  for (const row of rows) {
    const cells = childElements(row, "td").filter((cell) => !wordless(cell));
    // Two cells with words in them is a table with columns, and a column is
    // a relationship between two values that unwrapping would destroy. The
    // fee schedules on `/services/training` and the advertisement tariff on
    // `/about/secretariat` are kept by exactly this line.
    if (cells.length !== 1) return null;

    // `null` when the cell holds something this cannot read as blocks — bare
    // text, say — in which case the table stays exactly as it was.
    const inner = topLevelBlocks(cells[0] ?? "");
    if (!inner) return null;
    out.push(...inner);
  }

  return out;
}

/** Walk a table's rows, descending into nested tables. `false` to decline. */
function tableEntries(html: string, out: TableEntry[]): boolean {
  const open = /<tr\b[^>]*>/gi;
  let cursor = 0;

  for (;;) {
    open.lastIndex = cursor;
    const start = open.exec(html);
    if (!start) return true;

    const from = start.index + start[0].length;
    // Depth-counted, because a row holding a nested table holds that table's
    // rows too, and the first `</tr>` after this one may be one of theirs.
    const end = closingIndex(html, from, "tr");
    if (end === null) return false;

    if (!rowEntries(html.slice(from, end).replace(/<\/tr\s*>$/i, ""), out)) return false;
    cursor = end;
  }
}

function rowEntries(row: string, out: TableEntry[]): boolean {
  if (/<table\b/i.test(row)) return tableEntries(row, out);

  const cells: string[] = [];
  for (const cell of row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)) {
    // A cell holding a non-breaking space is a spacer, not a column.
    if (!wordless(cell[1] ?? "")) cells.push(cell[1] ?? "");
  }

  // A row of nothing but spacers. The tables all start with one.
  if (cells.length === 0) return true;

  if (cells.length === 1) {
    const flat = (cells[0] ?? "")
      .replace(BR_RE, " ")
      .replace(WRAPPER_RE, "")
      .replace(LIST_WRAPPER_RE, "");
    if (!PLAIN.test(flat)) return false;
    out.push({ kind: "caption", text: plainText(flat) });
    return true;
  }

  if (cells.length !== 2) return false;

  const link = asResourceLink((cells[0] ?? "").replace(LIST_WRAPPER_RE, ""));
  if (!link) return false;

  // The second column is the address spelled out — on the airlines page as a
  // link to the same place, on the ministries page as plain text. Either way
  // it is words, so it becomes the row's note rather than being dropped.
  const note = plainText((cells[1] ?? "").replace(/<[^>]*>/g, " "));
  if (note === "") return false;

  out.push({
    kind: "link",
    link: { ...link, note: link.note ? `${link.note} ${note}` : note },
  });
  return true;
}

function asLinkTable(block: string): { caption?: string; items: ResourceLink[] } | null {
  if (!/^<table\b/i.test(block.trim())) return null;

  const entries: TableEntry[] = [];
  if (!tableEntries(block, entries)) return null;

  const items = entries.flatMap((entry) => (entry.kind === "link" ? [entry.link] : []));
  if (items.length < 2) return null;

  // A caption is a heading the source put inside the table, so it may only
  // come before the rows. One after them is a footnote or a second section,
  // and either way this has not understood the table.
  const captions = entries.flatMap((entry) => (entry.kind === "caption" ? [entry.text] : []));
  const firstLink = entries.findIndex((entry) => entry.kind === "link");
  if (captions.length > 1) return null;
  if (entries.slice(firstLink).some((entry) => entry.kind === "caption")) return null;

  const caption = captions[0];
  const after = [
    ...(caption ? words(caption) : []),
    ...items.flatMap((item) => [...words(item.label), ...(item.note ? words(item.note) : [])]),
  ];
  if (!sameWords(textWords(block), after)) return null;

  return caption === undefined ? { items } : { caption, items };
}

/* -------------------------------------------------------------------------- */
/* Directories laid out as named entries                                      */
/* -------------------------------------------------------------------------- */

/**
 * `<p><strong>Name</strong></p>` and then the address, repeated.
 *
 * Four pages are written this way — the hospital lists, the federal
 * departments, the ministries — separated by `<hr />` at the top level, or
 * wrapped one per `<li>`. Both forms are the same entry and get the same card.
 *
 * What this fixes is not the structure but the *weight*: on
 * `/resources/hospitals-lahore` every line of every entry is inside a
 * `<strong>`, so the page is 485 words of bold text with horizontal rules
 * between them. Reading the name as a heading and the rest as ordinary prose
 * puts the emphasis back where a reader can use it, and changes no words.
 */
function contactEntryFrom(group: readonly string[]): ContactEntry | null {
  const blocks = group.filter((block) => !wordless(block));
  const [first, ...rest] = blocks;
  if (first === undefined) return null;

  const inner = asParagraph(first);
  if (inner === null) return null;

  // The ordinary shape: the name alone in a bolded paragraph, the address in
  // the paragraphs after it. `<em>` and friends are stripped first because one
  // of the twenty-four hospitals is `<em><strong>…</strong></em>`, which is
  // the same entry typed by somebody who hit both buttons.
  const bold = LABEL_RE.exec(inner.replace(EMPHASIS_RE, "").trim());
  if (bold && PLAIN.test(bold[1] ?? "") && rest.length > 0) {
    const name = plainText(bold[1] ?? "");
    if (name !== "" && name.length <= NAME_MAX) return { name, html: rest.join("\n") };
  }

  // The other shape: the whole entry in one paragraph, the name on the first
  // line and the address after a `<br />`. Three of the twenty-four hospitals
  // and several of the federal departments are written this way, and without
  // this they break the run and send the rest of the page back to prose.
  //
  // Every wrapper tag goes before the split, which is what keeps the two
  // halves balanced: `<strong>Name<br />Address</strong>` cut at the break
  // would otherwise leave an opening tag in the head and its close in the
  // tail. Nothing but anchors survives, and those are inside one half or the
  // other.
  const flat = inner.replace(WRAPPER_RE, "");
  const split = /<br\s*\/?>/i.exec(flat);
  if (!split) return null;

  const head = flat.slice(0, split.index);
  if (!PLAIN.test(head)) return null;

  const name = plainText(head);
  if (name === "" || name.length > NAME_MAX) return null;

  const tail = flat.slice(split.index + split[0].length);
  const html = [wordless(tail) ? "" : `<p>${tail}</p>`, ...rest]
    .filter((part) => part !== "")
    .join("\n");
  if (html === "") return null;

  return { name, html };
}

/** A list whose every item is one named entry. */
function asContactList(block: string): ContactEntry[] | null {
  const list = LIST_RE.exec(block.trim());
  if (!list) return null;

  const entries: ContactEntry[] = [];
  let count = 0;

  for (const item of (list[2] ?? "").matchAll(LIST_ITEM_RE)) {
    count += 1;
    const inner = topLevelBlocks(item[1] ?? "");
    if (!inner) return null;
    const entry = contactEntryFrom(inner);
    if (!entry) return null;
    entries.push(entry);
  }

  if (count === 0 || entries.length !== count || entries.length < 2) return null;

  return entries;
}

function isRule(block: string): boolean {
  return /^<hr\b/i.test(block.trim());
}

/**
 * A run of named entries separated by horizontal rules, starting at `start`.
 *
 * Returns where the run ends as well as what is in it, so the caller can skip
 * past what was consumed. A group that does not parse as an entry ends the run
 * and is left where it is — including the rule in front of it, which then
 * renders as the divider it was. Two entries minimum: one `<hr />` between two
 * paragraphs is a page break, not a directory.
 */
function takeContacts(
  blocks: readonly string[],
  start: number,
): { entries: ContactEntry[]; next: number } | null {
  const entries: ContactEntry[] = [];
  let cursor = start;
  let consumed = start;

  for (;;) {
    const group: string[] = [];
    while (cursor < blocks.length) {
      const block = blocks[cursor] ?? "";
      if (isRule(block) || asHeading(block)) break;
      group.push(block);
      cursor += 1;
    }

    const entry = contactEntryFrom(group);
    if (!entry) break;

    entries.push(entry);
    consumed = cursor;

    if (cursor < blocks.length && isRule(blocks[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    break;
  }

  return entries.length >= 2 ? { entries, next: consumed } : null;
}

/**
 * Entities back to characters, for text that will be rendered as a text node
 * rather than as HTML.
 *
 * Only the five the sanitiser encodes. A numeric entity is left alone: it
 * cannot appear from the write path, and decoding an unknown entity wrongly
 * would put a character on the page that nobody typed.
 */
function decodeText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    // Last, or `&amp;lt;` decodes twice.
    .replace(/&amp;/g, "&");
}

/**
 * Decide what a run of consecutive paragraphs is.
 *
 * All or nothing per run: one paragraph that does not fit the pattern sends the
 * whole run to prose, because a grid of four cards and one loose paragraph
 * underneath is worse than five paragraphs.
 */
function classify(paragraphs: readonly string[], originals: readonly string[]): EditorialBlock {
  const prose = (): EditorialBlock => ({ kind: "prose", html: originals.join("\n") });

  if (paragraphs.length === 0) return prose();

  const definitions: Definition[] = [];
  for (const inner of paragraphs) {
    const match = DEFINITION_RE.exec(inner.trim());
    if (!match) break;
    const [, term = "", dash = "", meaning = ""] = match;
    if (!PLAIN.test(meaning) || meaning.length > CARDABLE) break;
    definitions.push({
      term: decodeText(term.trim()),
      dash,
      meaning: decodeText(meaning.trim()),
    });
  }
  if (definitions.length === paragraphs.length && definitions.length >= 2) {
    return { kind: "definitions", items: definitions };
  }

  const plain = paragraphs.map((inner) => inner.trim()).filter((inner) => PLAIN.test(inner));
  if (plain.length !== paragraphs.length) return prose();

  const texts = plain.map(decodeText);

  if (texts.length === 1) {
    const only = texts[0] ?? "";
    return only.length <= STATEMENT_MAX && isClaim(only)
      ? { kind: "statement", text: only }
      : prose();
  }

  if (
    texts.length >= STATEMENTS_MIN &&
    texts.every((text) => text.length <= CARDABLE && isClaim(text))
  ) {
    return { kind: "statements", items: texts };
  }

  return prose();
}

/**
 * Read a sanitised body as sections, or `null` to render it as plain prose.
 *
 * `null` is returned for a body that does not tokenise, and for one that turns
 * out to be ordinary prose throughout — in that case there is nothing for a
 * section layout to add, and `<Prose>` is both simpler and already correct.
 */
export function parseEditorial(html: string): EditorialSection[] | null {
  const parsed = topLevelBlocks(html);
  if (!parsed) return null;

  // Mutable, so that `unwrapWrapperTable` can splice a box's contents in
  // where the box was and let the loop read them as ordinary blocks.
  const blocks = [...parsed];

  const sections: EditorialSection[] = [];
  let heading: Heading | null = null;
  let run: string[] = [];
  let runOriginals: string[] = [];
  let pending: string[] = [];
  let links: ResourceLink[] = [];

  const current: EditorialBlock[] = [];

  /**
   * Close every open buffer but one, in document order.
   *
   * Three buffers accumulate at once — a run of paragraphs, a run of
   * unrecognised markup, and a run of document lists — and only one of them
   * can be open at a time without the blocks coming out in the wrong order.
   * So appending to any of them closes the other two first. At most one holds
   * anything when this is called, which is what makes the order it flushes in
   * irrelevant.
   */
  const flushExcept = (keep: "run" | "pending" | "links" | "none") => {
    if (keep !== "run" && run.length > 0) {
      current.push(classify(run, runOriginals));
      run = [];
      runOriginals = [];
    }
    if (keep !== "pending" && pending.length > 0) {
      current.push({ kind: "prose", html: pending.join("\n") });
      pending = [];
    }
    if (keep !== "links" && links.length > 0) {
      // An archive to read down or a directory to scan across, decided from
      // where the links point rather than from how they were marked up.
      current.push(
        links.every((link) => link.href !== undefined && isFile(link.href))
          ? { kind: "documents", items: links }
          : { kind: "links", items: links },
      );
      links = [];
    }
  };

  const closeSection = () => {
    flushExcept("none");
    if (heading !== null || current.length > 0) {
      sections.push({ heading, blocks: [...current] });
    }
    current.length = 0;
  };

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] ?? "";

    // A table that is only a box drawn around something else is replaced by
    // what is inside it, and the loop reads that instead. Eighteen of them
    // nest on `/trade/humanitarian-appeals`, and they peel one per pass.
    if (/^<table\b/i.test(block)) {
      const unwrapped = unwrapWrapperTable(block);
      if (unwrapped) {
        blocks.splice(index, 1, ...unwrapped);
        index -= 1;
        continue;
      }
    }

    // Anything with no words in it is editor debris, and dropping it loses
    // nothing a reader or the verifier can see. `<h2>&nbsp;</h2>` on the
    // exhibitions page rendered as an empty heading between two real ones and
    // — worse — closed the section above it; the appeals page carries two
    // tables of nothing but empty cells, left over from the mail clients the
    // appeals were pasted out of.
    //
    // A horizontal rule is the exception, because a rule has no words by
    // definition and is the only thing here that means something without
    // them: it is what separates one directory entry from the next.
    if (!isRule(block) && wordless(block)) continue;

    const nextHeading = asHeading(block);
    if (nextHeading) {
      closeSection();
      heading = nextHeading;
      continue;
    }

    // Before anything else, because a directory's first entry is an ordinary
    // bolded paragraph and only the rules after it say what it is.
    const contacts = takeContacts(blocks, index);
    if (contacts) {
      flushExcept("none");
      current.push({ kind: "contacts", items: contacts.entries });
      index = contacts.next - 1;
      continue;
    }

    const inner = asParagraph(block);
    if (inner === null) {
      const list = asLinkList(block);
      if (list) {
        flushExcept("links");
        links.push(...list);
        continue;
      }

      const entries = asContactList(block);
      if (entries) {
        flushExcept("none");
        current.push({ kind: "contacts", items: entries });
        continue;
      }

      const facts = asFactList(block);
      if (facts) {
        flushExcept("none");
        current.push({ kind: "facts", items: facts });
        continue;
      }

      const table = asLinkTable(block);
      if (table) {
        flushExcept("none");
        current.push({ kind: "links", ...table });
        continue;
      }

      // Not a paragraph and none of the shapes above — a table of fees, a
      // rule, a list with sentences in it. It keeps its own markup and breaks
      // the runs around it.
      flushExcept("pending");
      pending.push(block);
      continue;
    }

    // A spacer paragraph contributes no words, so dropping it loses nothing a
    // reader or the verifier can see, and keeping it would split a run of
    // statements into two grids — or, on the minutes page, thirty-nine
    // document lists of one item each.
    if (wordless(inner)) continue;

    const bold = LABEL_RE.exec(inner.trim());
    if (bold && PLAIN.test(bold[1] ?? "")) {
      const text = plainText(bold[1] ?? "");
      if (text !== "") {
        flushExcept("none");
        current.push({ kind: "label", text });
        continue;
      }
    }

    flushExcept("run");
    run.push(inner);
    runOriginals.push(block);
  }

  closeSection();

  if (sections.length === 0) return null;

  /**
   * A lone paragraph is only set large when it is a peer of a grid.
   *
   * This is the one place the parser could plausibly have guessed wrong, and
   * it did on the first run: "The following banks operate in Lahore." is a
   * short plain paragraph under a heading, and nothing about its *text* says
   * whether it is a vision statement or a line introducing the list below it.
   * Length, position and tone are all the same.
   *
   * So the question is answered from the body around it rather than from the
   * paragraph. A `statement` survives only in a body that already has a
   * numbered run or a grid of named cards somewhere in it — on
   * `/about/history` the vision sits beside the mission's five commitments and
   * the five values, and reads as the first of three equals. In a body that is
   * otherwise prose, there is nothing for it to be a peer of, and it is a
   * paragraph.
   */
  const hasGrid = sections.some((section) =>
    section.blocks.some(
      (block) => block.kind === "statements" || block.kind === "definitions",
    ),
  );
  const laidOut: EditorialSection[] = hasGrid
    ? sections
    : sections.map((section) => ({
        heading: section.heading,
        blocks: section.blocks.map((block) =>
          block.kind === "statement"
            ? // Back to the markup it came from, so prose styles it as the
              // paragraph it is.
              ({ kind: "prose", html: `<p>${escapeText(block.text)}</p>` } as const)
            : block,
        ),
      }));

  // Nothing but prose means nothing to lay out. Say so, rather than wrapping
  // `<Prose>` in a section shell that changes only the margins.
  const everythingIsProse = laidOut.every(
    (section) =>
      section.heading === null && section.blocks.every((block) => block.kind === "prose"),
  );
  if (everythingIsProse) return null;

  return laidOut;
}

/**
 * The inverse of `decodeText`, for text being put back into markup.
 *
 * Used on one path only: a `statement` demoted to prose because the body
 * around it turned out to have no grid. The text was decoded to be rendered as
 * a text node, so it has to be re-encoded before it goes back through
 * `dangerouslySetInnerHTML` — otherwise an ampersand in somebody's sentence
 * becomes the start of an entity. `&` first, or the escapes escape each other.
 */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\u00a0/g, "&nbsp;");
}

/**
 * The words a parsed body will render, in order.
 *
 * Exists for the test that holds the whole feature honest: this sequence must
 * equal the sequence `scripts/verify-migrated-text.ts` reads out of the source
 * page, or the layout has silently eaten or reordered somebody's words. Having
 * it here rather than in the test means the rule is stated next to the code it
 * constrains.
 */
export function editorialWords(sections: readonly EditorialSection[]): string[] {
  const out: string[] = [];
  const push = (text: string) => {
    for (const word of text.split(/\s+/)) if (word) out.push(word);
  };

  for (const section of sections) {
    if (section.heading) push(section.heading.text);
    for (const block of section.blocks) {
      switch (block.kind) {
        case "statement":
          push(block.text);
          break;
        case "statements":
          for (const item of block.items) push(item);
          break;
        case "definitions":
          for (const item of block.items) {
            push(item.term);
            push(item.dash);
            push(item.meaning);
          }
          break;
        case "documents":
        case "links":
          // The label and the note. An `href` is inside a tag, so the
          // verifier's normalisation never saw it as words in the first place
          // — but the text beside the link is words, and it is rendered.
          if (block.kind === "links" && block.caption) push(block.caption);
          for (const item of block.items) {
            push(item.label);
            if (item.note) push(item.note);
          }
          break;
        case "contacts":
          for (const item of block.items) {
            push(item.name);
            push(decodeText(item.html.replace(/<[^>]*>/g, " ")));
          }
          break;
        case "facts":
          for (const item of block.items) push(item);
          break;
        case "label":
          push(block.text);
          break;
        case "prose":
          push(decodeText(block.html.replace(/<[^>]*>/g, " ")));
          break;
      }
    }
  }

  return out;
}
