/**
 * Reading the legacy template: cut out the content, count what was lost.
 *
 * Split out of `import-legacy-page.ts` when the press archive needed the same
 * machinery. `press.php` is the same template as every other page on the old
 * site — same container class, same editor artifacts — so the alternative was
 * a second near-copy of the slicer and the sanitiser call, which is exactly
 * how two importers end up disagreeing about what a page said.
 *
 * Everything here reads untrusted downloaded HTML. Nothing in it is executed;
 * it is read as text, sliced, sanitised and counted.
 */

import { sanitiseBody, bodyToText } from "@/content/sanitise";

/**
 * The legacy template's content container.
 *
 * Every page checked — `about.php`, `services.php`, `business.php`,
 * `presidents.php`, `excomm.php`, `contact.php` — wraps its content in
 * `<div class="col-sm-8 about_right ...">`, with the left-hand section menu in
 * a sibling `col-sm-4`. Matching on the class rather than on a position in the
 * document is what makes that hold across the five templates.
 */
export const CONTAINER = /<div\s+class="col-sm-8\s+about_right[^"]*"[^>]*>/i;

/** Cut `html` from the container's opening tag to its matching close. */
export function sliceContainer(html: string): string {
  const open = CONTAINER.exec(html);
  if (!open) {
    throw new Error(
      'no <div class="col-sm-8 about_right…"> in this page. Either the legacy ' +
        "template changed, or this is not a content page — check it in a " +
        "browser before adjusting CONTAINER, because a wrong container silently " +
        "imports the navigation as the body.",
    );
  }

  // Depth counting rather than a greedy or lazy match: the container holds
  // nested divs, so `</div>` is not the end of it and the first one is not
  // either. Self-closing and void tags cannot be `div`, so only `<div` and
  // `</div>` move the depth.
  const start = open.index + open[0].length;
  const tags = /<(\/?)div\b[^>]*>/gi;
  tags.lastIndex = start;

  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html)) !== null) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index);
  }

  throw new Error(
    "the content container is never closed — the saved page is truncated. " +
      "Re-download it and check the byte count.",
  );
}

/**
 * Block-level tags that cannot legally sit inside a `<p>`.
 *
 * The legacy editor emitted `<p><h3>Our Vision</h3>…</p>` — a paragraph
 * wrapping headings and more paragraphs. Browsers repair it by closing the `p`
 * early and leaving the trailing `</p>` as a stray, so it *renders*; it is
 * still wrong in three places that matter. It round-trips through the admin's
 * rich-text surface unpredictably, it makes the stored markup disagree with
 * what the editor is shown, and `prose-site`'s paragraph spacing is applied to
 * an element the browser silently emptied.
 *
 * Removing those wrappers is a markup repair and not a content edit: no word,
 * space or character of text changes, which `textCharsLost` proves on every
 * run.
 *
 * **It has to run after sanitising, and that took a wrong turn to find out.**
 * The legacy markup is actually `<div><h3>…`, and `sanitiseBody` deliberately
 * *maps* `div` to `p` rather than dropping it, so that a paste from a
 * `contenteditable` keeps its paragraph breaks. So the invalid `<p><h3>` is
 * not in the input at all — the sanitiser creates it. Unwrapping beforehand
 * therefore did nothing, silently, and the first generated migration carried
 * the artifact through.
 *
 * Running afterwards raises the question the earlier ordering was there to
 * avoid: the stored bytes must be exactly what `sanitiseBody` returns, because
 * that is the invariant `src/components/site/prose.tsx` renders on. So the
 * output is sanitised a second time. The pass is idempotent on allowlisted
 * markup, and the only thing between the two passes is tag removal, which
 * cannot introduce anything for the second pass to catch — the value stored is
 * still, literally, a value `sanitiseBody` returned.
 */
const BLOCKS = "h2|h3|h4|p|ul|ol|table|blockquote";

export function unwrapParagraphsAroundBlocks(html: string): string {
  return (
    html
      // `<p>` whose first child is a block: the `p` is doing nothing.
      .replace(new RegExp(`<p\\b[^>]*>(\\s*)(?=<(?:${BLOCKS})\\b)`, "gi"), "$1")
      // The matching stray close, which follows a block's own close.
      .replace(new RegExp(`(</(?:${BLOCKS})>\\s*)</p>`, "gi"), "$1")
  );
}

/** Strip what must never reach the sanitiser's text-keeping behaviour. */
export function dropScriptsAndStyles(html: string): string {
  // `sanitiseBody` discards these with their contents already. Doing it here
  // too means the character counts below compare like with like, rather than
  // reporting a stylesheet as content that went missing.
  return html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "");
}

/**
 * Lift the page's own heading out of the body.
 *
 * The legacy template prints the page title as the first `<h2>` inside the
 * content container. Here that belongs in `content_items.title_en`, which the
 * route renders as the `h1` — so leaving it in the body would print the title
 * twice, and dropping it would lose it. Neither is right: it moves.
 */
export function liftHeading(fragment: string): { heading: string | null; rest: string } {
  const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(fragment);
  if (!h2) return { heading: null, rest: fragment };

  const heading = bodyToText(h2[1]).trim();
  if (heading === "") return { heading: null, rest: fragment };

  return {
    heading,
    rest: fragment.slice(0, h2.index) + fragment.slice(h2.index + h2[0].length),
  };
}

export function allMatches(html: string, re: RegExp): string[] {
  return [...html.matchAll(re)].map((m) => m[1]).filter((v): v is string => Boolean(v));
}

export const HREF = /<a\b[^>]*\bhref="([^"]*)"/gi;
export const IMG_SRC = /<img\b[^>]*\bsrc="([^"]*)"/gi;
export const EMAIL = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/**
 * Everything the content container did **not** contain.
 *
 * This exists because the obvious check is not the dangerous one.
 * `textCharsLost` compares the container before and after sanitising, so it
 * catches a tag the allowlist rejected — and says nothing at all about a
 * container that was cut in the wrong place, because both of its numbers come
 * from inside the cut.
 *
 * That is not hypothetical. On `excomm.php` the container holds the President
 * and the other thirteen Executive Committee members are rendered in sibling
 * blocks below it, so the first run of this script reported "81 chars kept, 0
 * lost" for a page listing fourteen people. A migration that loses thirteen
 * office bearers and prints a clean bill of health is worse than no migration.
 *
 * Counting links, images and email addresses inside the container against the
 * same things in the whole document makes that visible as a ratio. The counts
 * are deliberately crude — a page's chrome contributes a fixed ~34 navigation
 * links, so this is read, not asserted on.
 */
export function outsideContainer(wholePage: string, container: string) {
  const bodyOnly = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(wholePage)?.[1] ?? wholePage;
  const page = dropScriptsAndStyles(bodyOnly);

  const count = (html: string, re: RegExp) => new Set(allMatches(html, re)).size;

  return {
    // Text in the document that the container did not cover. The legacy
    // chrome — header, mega-menu, footer — is a constant per template, so this
    // number is read **comparatively**: a prose page like `about.php?id=75`
    // establishes what the chrome costs, and a page reporting far more than
    // that has content the container missed. `excomm.php` is the worked
    // example: ~2,900 against ~1,600 for a page whose container held 81 chars.
    textCharsOutsideContainer: bodyToText(page).length - bodyToText(container).length,
    linksInPage: count(page, HREF),
    linksInContainer: count(container, HREF),
    imagesInPage: count(page, IMG_SRC),
    imagesInContainer: count(container, IMG_SRC),
    emailsInPage: count(page, EMAIL),
    emailsInContainer: count(container, EMAIL),
  };
}

/**
 * Sanitise a sliced fragment into the exact bytes a `body_*` column may hold.
 *
 * Two passes, and the comment on `unwrapParagraphsAroundBlocks` says why: the
 * invalid `<p><h3>` is created by the sanitiser rather than present in the
 * input, so the repair has to run after it, and the value stored must still be
 * one `sanitiseBody` returned.
 */
export function sanitiseTwice(fragment: string): string | null {
  const once = sanitiseBody(fragment);
  return once === null ? null : sanitiseBody(unwrapParagraphsAroundBlocks(once));
}

/** Text length, for the before-and-after the importers report. */
export function textLength(html: string | null): number {
  return html ? bodyToText(html).length : 0;
}

/* -------------------------------------------------------------------------- */
/* Double-encoded text                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Windows-1252's own code points, by the byte they stand for.
 *
 * Only the 0x80-0x9F range, which is where cp1252 differs from Latin-1 and
 * where every character below comes from. Outside that range cp1252 and
 * Latin-1 agree, so a character's code point *is* its byte.
 */
const CP1252: ReadonlyMap<string, number> = new Map([
  ["€", 0x80], ["‚", 0x82], ["ƒ", 0x83], ["„", 0x84],
  ["…", 0x85], ["†", 0x86], ["‡", 0x87], ["ˆ", 0x88],
  ["‰", 0x89], ["Š", 0x8a], ["‹", 0x8b], ["Œ", 0x8c],
  ["Ž", 0x8e], ["‘", 0x91], ["’", 0x92], ["“", 0x93],
  ["”", 0x94], ["•", 0x95], ["–", 0x96], ["—", 0x97],
  ["˜", 0x98], ["™", 0x99], ["š", 0x9a], ["›", 0x9b],
  ["œ", 0x9c], ["ž", 0x9e], ["Ÿ", 0x9f],
]);

/**
 * A run that looks like UTF-8 bytes someone has read as Windows-1252.
 *
 * Every multi-byte UTF-8 sequence starts 0xC2-0xF4, and read as cp1252 those
 * bytes are the accented capitals `Â`, `Ã`, `â` and friends; the continuation
 * bytes land in cp1252's 0x80-0x9F specials or in Latin-1's high range. So a
 * lead character followed by one or two of those is the signature.
 */
const MIS_DECODED =
  /[Â-Åâ-ã](?:[\u0080-ÿ]|[€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]){1,2}/g;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Undo one round of UTF-8-read-as-Windows-1252, where that is what happened.
 *
 * 24 of the 691 press releases on lcci.com.pk are double-encoded: `press.php`
 * declares `<meta charset="utf-8">` and then serves the bytes `C3 A2 E2 82 AC
 * C5 93`, which a browser dutifully renders as `â€œ`. So "LCCI has established
 * â€œExcise & Taxation Help Deskâ€" is genuinely what a visitor sees today,
 * and 22 of the affected releases have it in the headline.
 *
 * **This is a character repair, not a content edit** — the same standing as
 * `unwrapParagraphsAroundBlocks` above. It changes no word, adds and removes
 * nothing, and restores the quotation mark the chamber's own press officer
 * typed. Left alone it would put `â€œ` in 22 headlines and, worse, in the
 * public URL: `lcci-has-established-a-excise-taxation-help-deska`.
 *
 * Deliberately timid. A run is repaired only when every character maps back to
 * a byte and those bytes are **valid UTF-8**, which is what stops it mangling
 * text that merely happens to contain `â`; anything else is returned
 * untouched. Repairs are counted by the callers so each one is reviewable
 * rather than silent, and the whole thing is one call to remove if LCCI would
 * rather the archive reproduce the fault.
 */
export function repairMisdecodedText(text: string): string {
  return text.replace(MIS_DECODED, (run) => {
    const bytes: number[] = [];

    for (const char of run) {
      const byte = CP1252.get(char) ?? (char.codePointAt(0) as number);
      // Above 0xFF the character was never a single cp1252 byte, so this run
      // is not a mis-decode and must be left exactly as it is.
      if (byte > 0xff) return run;
      bytes.push(byte);
    }

    try {
      return UTF8.decode(new Uint8Array(bytes));
    } catch {
      // Not valid UTF-8, so the premise was wrong.
      return run;
    }
  });
}

/** How many runs `repairMisdecodedText` would change in this text. */
export function misdecodedRuns(text: string): number {
  let count = 0;
  for (const match of text.matchAll(MIS_DECODED)) {
    if (repairMisdecodedText(match[0]) !== match[0]) count += 1;
  }
  return count;
}
