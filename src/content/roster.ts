/**
 * Read a page whose body is a *list of people* as records, so it can be laid
 * out as one.
 *
 * ## The page this exists for
 *
 * `/about/past-leadership` is 17,000 characters of the worst markup on the old
 * site. Sixty-one former presidents, each written as an `<h3>` holding a name,
 * then the year as a **bare text node between tags**, then a `<p>` whose first
 * `<strong>` is the firm and whose remainder is a run-together line of
 * address, telephone, fax, mobile and email. Then two more sections in a
 * different shape again: a year and a name in one paragraph, separated by
 * non-breaking spaces, under a `<strong>Year Name</strong>` pseudo-header.
 *
 * Rendered as prose it is a wall. The words cannot change —
 * `scripts/verify-migrated-text.ts` holds every run of six consecutive words
 * from the legacy page to the built page — so the only move available is to
 * recognise the records that are already there and set them as records.
 *
 * It is also the page where the chamber's sixty-two portrait photographs
 * belong, and a face cannot be put beside a name that is buried in a
 * paragraph. Parsing is what makes `content_portraits` reachable from here.
 *
 * ## The safety property, which is checked rather than argued
 *
 * A parser over somebody else's markup that *rearranges* text can lose a word
 * or reorder two, and nothing about the page would look wrong. So
 * `parseRoster` ends by reading the words back out of its own result and
 * comparing them, in order, with the words of the HTML it was given. They must
 * be identical. If they are not, it returns `null` and the caller renders
 * ordinary prose.
 *
 * That makes the guarantee structural: no regex here has to be *right* for the
 * page to be correct, only right often enough to be worth having. And it is
 * the same word normalisation the build's verifier uses, so a parse this
 * accepts cannot fail that check.
 *
 * ## Why not `editorial.ts`
 *
 * That module reads a body of *paragraphs* as sections and classifies runs of
 * them. This body does not tokenise into top-level blocks at all — the loose
 * "Year 2024-25" text nodes mean `topLevelBlocks` returns null on it, which is
 * exactly the refusal it was built to make. Two parsers, each declining what
 * it does not understand, is the arrangement that keeps either one from
 * guessing.
 */

/** A heading, a paragraph, or a bare text node, in document order. */
type Token =
  | { readonly kind: "heading"; readonly level: 2 | 3 | 4; readonly text: string }
  | { readonly kind: "paragraph"; readonly html: string }
  | { readonly kind: "text"; readonly text: string };

const TOKEN_RE = /<(h2|h3|h4|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;

/** `<strong>M/s Nasir &amp; Sons</strong>` at the head of a paragraph. */
const LEAD_STRONG_RE = /^\s*<strong\b[^>]*>([\s\S]*?)<\/strong>([\s\S]*)$/i;

/** Two or more spaces: how the old site put a year and a name in one line. */
const COLUMN_GAP = /\s{2,}/;

/** No inline markup, so the text can be rendered as a text node. */
const PLAIN = /^[^<>]*$/;

/**
 * A person, as one of these pages writes them.
 *
 * Every field but the name is optional because every field but the name is
 * missing from somebody: thirty entries have no year, several have no firm,
 * and the ones marked "Late" have nothing but a name and that word.
 */
export interface RosterPerson {
  readonly name: string;
  /** Further headings under the name. In practice the single word "Late". */
  readonly notes: readonly string[];
  /** The year as written, "Year 2024-25". Not parsed into dates. */
  readonly term?: string;
  /** The firm, from the paragraph's leading `<strong>`. */
  readonly firm?: string;
  /** Whatever followed it: address, telephone, fax, mobile, email. */
  readonly detail?: string;
}

/** A year and a name, from a `<p>2025-26   Mr Tanveer Ahmed Sheikh</p>`. */
export interface RosterPair {
  readonly term: string;
  readonly name: string;
}

export type RosterSection =
  /** A list of people with photographs, firms and contact lines. */
  | {
      readonly kind: "people";
      readonly heading: string | null;
      readonly people: readonly RosterPerson[];
    }
  /** A two-column list of terms and names, with its own column headings. */
  | {
      readonly kind: "pairs";
      readonly heading: string | null;
      readonly columns: readonly [string, string] | null;
      readonly pairs: readonly RosterPair[];
    }
  /** Anything this does not recognise, rendered from its original markup. */
  | {
      readonly kind: "prose";
      readonly heading: string | null;
      readonly html: string;
    };

/* -------------------------------------------------------------------------- */
/* Words                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Entities back to characters: the five the sanitiser writes, and `&nbsp;`.
 *
 * Identical to `decodeText` in `editorial.ts` and deliberately duplicated
 * rather than shared: both are small, and the alternative is a third module
 * that exists only so two parsers can agree on something they already agree
 * on. A numeric entity is left alone, because the write path cannot produce
 * one and decoding an unknown entity wrongly puts a character on the page that
 * nobody typed.
 */
function decodeText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Last, or `&amp;lt;` decodes twice.
    .replace(/&amp;/g, "&");
}

/**
 * The words of a fragment of markup, in order.
 *
 * The same normalisation `scripts/verify-migrated-text.ts` applies: tags
 * become spaces, entities are decoded, and non-breaking and replacement
 * characters are spaces. Which is the point — a parse that passes the
 * comparison below cannot fail the build's own check.
 */
function words(value: string): string[] {
  const text = decodeText(value.replace(/<[^>]*>/g, " "))
    .replace(/[ �]/g, " ");
  return text.split(/\s+/).filter((word) => word !== "");
}

/** The words a parsed roster will render, in order. */
export function rosterWords(sections: readonly RosterSection[]): string[] {
  const out: string[] = [];
  const push = (value: string | undefined) => {
    if (value === undefined) return;
    for (const word of words(value)) out.push(word);
  };

  for (const section of sections) {
    push(section.heading ?? undefined);

    switch (section.kind) {
      case "people":
        for (const person of section.people) {
          push(person.name);
          for (const note of person.notes) push(note);
          push(person.term);
          push(person.firm);
          push(person.detail);
        }
        break;
      case "pairs":
        if (section.columns) {
          push(section.columns[0]);
          push(section.columns[1]);
        }
        for (const pair of section.pairs) {
          push(pair.term);
          push(pair.name);
        }
        break;
      case "prose":
        push(section.html);
        break;
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Split a body into headings, paragraphs and the loose text between them.
 *
 * Unlike `editorial.ts`'s `topLevelBlocks` this does not require the whole
 * body to be inside a block, because on this page it is not: the year is a
 * bare text node. Whatever falls between two tags is kept as a `text` token,
 * so nothing is dropped here — and the word comparison at the end is what
 * proves it.
 */
function tokenise(html: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  const loose = (value: string) => {
    const text = value.replace(/<[^>]*>/g, " ");
    if (words(text).length > 0) tokens.push({ kind: "text", text: text.trim() });
  };

  for (const match of html.matchAll(TOKEN_RE)) {
    loose(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const tag = (match[1] ?? "").toLowerCase();
    const inner = match[2] ?? "";

    if (tag === "p") {
      tokens.push({ kind: "paragraph", html: inner });
      continue;
    }

    // `<h3><strong>Name</strong></h3>` is how the legacy editor bolded a
    // heading; the emphasis is redundant once it is styled as one. Anything
    // richer — a link, an image — would be flattened, so it stays as a
    // paragraph-shaped token and the section it is in falls back to prose.
    const text = inner.replace(/<\/?(?:strong|em|b|i)\b[^>]*>/gi, "").trim();
    if (!PLAIN.test(text)) {
      tokens.push({ kind: "paragraph", html: inner });
      continue;
    }

    tokens.push({
      kind: "heading",
      level: Number(tag[1]) as 2 | 3 | 4,
      text: decodeText(text).replace(/\s+/g, " ").trim(),
    });
  }

  loose(html.slice(cursor));
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

/** One paragraph split into a firm and the contact line after it. */
function splitFirm(inner: string): { firm?: string; detail?: string } | null {
  const match = LEAD_STRONG_RE.exec(inner);

  if (!match) {
    const text = inner.trim();
    if (!PLAIN.test(text)) return null;
    const detail = decodeText(text).trim();
    return detail === "" ? {} : { detail };
  }

  const [, firmHtml = "", rest = ""] = match;
  if (!PLAIN.test(firmHtml) || !PLAIN.test(rest)) return null;

  const firm = decodeText(firmHtml).replace(/\s+/g, " ").trim();
  const detail = decodeText(rest).trim();

  return {
    ...(firm === "" ? {} : { firm }),
    ...(detail === "" ? {} : { detail }),
  };
}

/** How many words a token contributes. Zero for the template's spacers. */
function tokenWords(token: Token): number {
  return token.kind === "paragraph" ? words(token.html).length : words(token.text).length;
}

/**
 * A section's tokens as a list of people, or `null` if they are not one.
 *
 * A person starts at a heading. Everything after it belongs to that person
 * until the next heading that is not a note — and a note is told from a name
 * by position: the second heading in a row, with no text between them, is not
 * somebody else's name. That is how `<h3>Dr. A. Waheed</h3><h3>Late</h3>`
 * reads, and the only reading available, because the old site marks a death by
 * adding a heading rather than by saying so.
 */
function asPeople(tokens: readonly Token[]): RosterPerson[] | null {
  interface Draft {
    name: string;
    notes: string[];
    term?: string;
    firm?: string;
    detail?: string;
  }

  const people: Draft[] = [];
  let current: Draft | null = null;
  // Whether the last token was a heading, which is what makes the next
  // heading a note rather than a new person.
  let afterHeading = false;

  for (const token of tokens) {
    if (token.kind === "heading") {
      if (token.text === "") {
        // The legacy template's spacer: `<h3>&nbsp;</h3>`. It contributes no
        // words, so dropping it is invisible to a reader and to the verifier —
        // and keeping it would end the current person for no reason.
        continue;
      }
      if (current && afterHeading) {
        current.notes.push(token.text);
        // One note only. The next heading is the next person's name, not a
        // second note on this one — the old site marks a death by adding
        // exactly one `<h3>Late</h3>`, and treating every heading after the
        // first as a note swallowed a third of the roster.
        afterHeading = false;
        continue;
      }
      current = { name: token.text, notes: [] };
      people.push(current);
      afterHeading = true;
      continue;
    }

    afterHeading = false;

    if (!current) {
      // The legacy template opens each of these sections with a pair of empty
      // paragraphs. They carry no words, so skipping them is invisible to a
      // reader and to the verifier. Anything with words in it before the first
      // name is not part of anybody, and the section is not a list of people.
      if (tokenWords(token) === 0) continue;
      return null;
    }

    if (token.kind === "text") {
      // A second loose run would overwrite the first and lose its words.
      if (current.term !== undefined) return null;
      current.term = token.text.replace(/\s+/g, " ").trim();
      continue;
    }

    const parts = splitFirm(token.html);
    if (!parts) return null;
    if (parts.firm !== undefined) {
      if (current.firm !== undefined) return null;
      current.firm = parts.firm;
    }
    if (parts.detail !== undefined) {
      if (current.detail !== undefined) return null;
      current.detail = parts.detail;
    }
  }

  // Two is the fewest that is a list rather than a paragraph with a heading.
  if (people.length < 2) return null;

  return people.map((draft) => ({
    name: draft.name,
    notes: draft.notes,
    ...(draft.term === undefined ? {} : { term: draft.term }),
    ...(draft.firm === undefined ? {} : { firm: draft.firm }),
    ...(draft.detail === undefined ? {} : { detail: draft.detail }),
  }));
}

/**
 * A section's tokens as a two-column list, or `null` if they are not one.
 *
 * Every paragraph must split on a run of two or more spaces, which after
 * `&nbsp;` decoding is what the old site used as a column gap. All or nothing:
 * one row that does not split sends the section to prose, because a table with
 * a stray full-width row in it is worse than a list of lines.
 */
function asPairs(
  tokens: readonly Token[],
): { columns: readonly [string, string] | null; pairs: RosterPair[] } | null {
  const pairs: RosterPair[] = [];
  let columns: readonly [string, string] | null = null;
  let seenRow = false;

  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "paragraph") return null;

    const bolded = LEAD_STRONG_RE.exec(token.html);
    // A fully bolded first paragraph is the column header — "Year  Name" — and
    // it is a header by position, not by its words.
    const isHeader = index === 0 && bolded !== null && (bolded[2] ?? "").trim() === "";
    const inner = isHeader ? (bolded?.[1] ?? "") : token.html;

    const text = inner.trim();
    if (!PLAIN.test(text)) return null;

    const value = decodeText(text).replace(/[ �]/g, " ");
    if (words(value).length === 0) continue;

    // The FIRST run of two or more spaces, not every run: one row reads
    // "1969    Mr.A.Majid Mufti  (Late)", and splitting on all of them gives
    // three cells and sends fifty-seven good rows to prose for the sake of
    // one. Everything after the first gap is the name, with its own spacing
    // normalised.
    const trimmed = value.trim();
    const gap = trimmed.search(COLUMN_GAP);
    if (gap <= 0) return null;

    const first = trimmed.slice(0, gap).trim();
    const second = trimmed.slice(gap).trim().replace(/\s+/g, " ");
    if (first === "" || second === "") return null;

    if (isHeader) {
      columns = [first, second];
      continue;
    }

    pairs.push({ term: first, name: second });
    seenRow = true;
  }

  if (!seenRow || pairs.length < 2) return null;
  return { columns, pairs };
}

/* -------------------------------------------------------------------------- */

/**
 * Read a body as a roster, or `null` to render it as plain prose.
 *
 * `null` means one of three things, and all three are the same answer: the
 * body has no top-level headings to divide it, no section is recognisable as a
 * list of people or of pairs, or — the one that matters — the words of the
 * result do not match the words of the input.
 */
export function parseRoster(html: string): RosterSection[] | null {
  const tokens = tokenise(html);
  if (tokens.length === 0) return null;

  // Sections are divided by the highest heading level present, so a page that
  // uses `<h3>` per person and `<h2>` per section divides on `<h2>`, and one
  // that uses `<h2>` per person is not accidentally split into sixty-one
  // sections of one.
  const headingLevels = tokens
    .filter((token): token is Extract<Token, { kind: "heading" }> => token.kind === "heading")
    .map((token) => token.level);
  if (headingLevels.length === 0) return null;
  const divider = Math.min(...headingLevels);

  const groups: { heading: string | null; tokens: Token[] }[] = [];
  let group: { heading: string | null; tokens: Token[] } = { heading: null, tokens: [] };

  for (const token of tokens) {
    if (token.kind === "heading" && token.level === divider && token.text !== "") {
      if (group.heading !== null || group.tokens.length > 0) groups.push(group);
      group = { heading: token.text, tokens: [] };
      continue;
    }
    group.tokens.push(token);
  }
  groups.push(group);

  const sections: RosterSection[] = groups.map(({ heading, tokens: own }) => {
    const people = asPeople(own);
    if (people) return { kind: "people", heading, people };

    const pairs = asPairs(own);
    if (pairs) return { kind: "pairs", heading, columns: pairs.columns, pairs: pairs.pairs };

    return { kind: "prose", heading, html: proseOf(own) };
  });

  // Nothing recognised means nothing to lay out, and wrapping `<Prose>` in a
  // shell that changes only the margins is not worth a second code path.
  if (!sections.some((section) => section.kind !== "prose")) return null;

  const before = words(html);
  const after = rosterWords(sections);
  if (before.length !== after.length) return null;
  for (const [index, word] of before.entries()) {
    if (after[index] !== word) return null;
  }

  return sections;
}

/**
 * Tokens back to markup, for a section that was not recognised.
 *
 * Rebuilt rather than sliced out of the original, because the slice would
 * carry the loose text nodes with no element around them and `<Prose>` would
 * render them unstyled against the page. A text node becomes a paragraph,
 * which is what the old site meant by it.
 */
function proseOf(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.kind) {
        case "heading":
          return `<h${token.level}>${escapeText(token.text)}</h${token.level}>`;
        case "paragraph":
          return `<p>${token.html}</p>`;
        case "text":
          return `<p>${escapeText(token.text)}</p>`;
      }
    })
    .join("\n");
}

/** The inverse of `decodeText`, for text going back into markup. */
function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
