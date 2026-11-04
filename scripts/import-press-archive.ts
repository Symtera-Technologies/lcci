/**
 * Lift every crawled press release off the legacy template into this CMS's shape.
 *
 * The sibling of `import-legacy-page.ts`, sharing its container slicer and its
 * sanitiser call through `legacy-html.ts`, and differing in two ways that are
 * specific to `press.php`.
 *
 * **The template prints its own label.** Every press page opens with
 * `<h2>Press Release</h2>` and then the actual headline in an `<h3>`. The `h2`
 * is chrome — it says the same thing on all ~600 pages — so it is dropped, and
 * the `h3` becomes `content_items.title_en`. `liftHeading` would have taken the
 * `h2` and left the headline in the body, which is how a first pass produced
 * six hundred releases all titled "Press Release".
 *
 * **The subhead moves into `summary`.** Most releases follow the headline with
 * a bolded sentence naming who said what — `<p><strong>LCCI President … Calls
 * for Business-Friendly Environment</strong></p>`. That is a standfirst, and
 * `content_press_releases.summary` is where this schema keeps one, so it is
 * lifted out of the body rather than copied: the detail route renders
 * `summary` above the body already, and leaving it in place would print it
 * twice.
 *
 * ## What it refuses to invent
 *
 * **There is no date on these pages.** Not in the markup, not in a
 * `Last-Modified` header — the old site runs PHP 5.4 and generates them
 * dynamically — and there is no index page carrying one.
 *
 * Nor can the id stand in for one. `press.php?id=1` was "LCCI's website
 * Revamped" when the Wayback Machine captured it in 2014 and is a 2025 release
 * today, so archived captures date a *different* release than the id now
 * serves; and the ids are not a clean sequence in any case, since 1–4 and
 * 601–602 duplicate content that also sits at 881–894.
 *
 * So no date is written. `legacyId` is recorded as provenance — it is what a
 * later dated export from LCCI's own press table joins onto, and what the 301
 * map is built from — and dating the archive is a separate step. A
 * plausible-looking date under a real headline is worse than no date: it is
 * unfalsifiable once it ships.
 *
 * Topics and spokesperson are left empty for the same reason. Both are
 * editorial judgements, and neither is on the page.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/import-press-archive.ts \
 *     --raw-dir <dir> --manifest <file.json> --out-dir legacy-import/press
 *
 * The input is untrusted downloaded HTML. Nothing in it is executed; it is
 * read as text, sliced, sanitised and counted.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bodyToText } from "@/content/sanitise";
import {
  allMatches,
  dropScriptsAndStyles,
  HREF,
  IMG_SRC,
  misdecodedRuns,
  outsideContainer,
  repairMisdecodedText,
  sanitiseTwice,
  sliceContainer,
} from "./legacy-html";

/** The template's own label, and the headline that follows it. */
const LABEL_AND_HEADLINE =
  /<h2\b[^>]*>\s*Press Release\s*<\/h2>\s*<h3\b[^>]*>([\s\S]*?)<\/h3>/i;

/**
 * A bolded lead paragraph, if the release opens with one.
 *
 * Anchored at the start of what is left after the headline is removed, so a
 * `<strong>` further down the body — a quoted figure, an emphasised phrase —
 * is not mistaken for a standfirst.
 */
const LEAD_SUBHEAD = /^\s*<p\b[^>]*>\s*<strong\b[^>]*>([\s\S]*?)<\/strong>\s*<\/p>/i;

/** `summary` is `varchar(700)`. */
const SUMMARY_MAX = 700;

interface PressManifest {
  items: { id: number; url: string; headline: string | null; file: string | null }[];
}

interface Imported {
  source: string;
  legacyId: number;
  /** The `h3` headline, as text. */
  headline: string;
  /** The bolded lead, where the release had one. */
  summary: string;
  /** How `summary` was arrived at — read in the run's own report. */
  summaryFrom: "subhead" | "first-paragraph";
  body: string | null;
  report: {
    textCharsBefore: number;
    textCharsAfter: number;
    textCharsLost: number;
    /** Runs of double-encoded text repaired; see `repairMisdecodedText`. */
    misdecodedRunsRepaired: number;
    images: string[];
    links: string[];
    documents: string[];
    reach: ReturnType<typeof outsideContainer>;
  };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

/**
 * Cut a summary down to the column without cutting a word in half.
 *
 * Only ever shortens, never rewrites: the result is a prefix of the text the
 * page carried. An ellipsis marks that it is a prefix, because a sentence
 * stopping mid-clause with no mark reads as a typo rather than as a truncation.
 */
function fitSummary(text: string): string {
  if (text.length <= SUMMARY_MAX) return text;

  const cut = text.slice(0, SUMMARY_MAX - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > SUMMARY_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * The first paragraph with words in it, for a release with no bolded lead.
 *
 * The *first* paragraph is not good enough: two releases open with `<p> </p>`,
 * a spacer the legacy editor left behind, and taking it produced an empty
 * summary on a column the index renders under every headline.
 */
function firstParagraph(html: string): string {
  for (const match of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = bodyToText(match[1] ?? "").trim();
    if (text !== "") return text;
  }
  return "";
}

function importOne(raw: string, legacyId: number, source: string): Imported | null {
  const sliced = dropScriptsAndStyles(sliceContainer(raw));

  // Before anything reads the text, so the headline, the summary and the body
  // all come out of one repaired string rather than three separately-repaired
  // ones. Counted first, because the repair is reported per release.
  const repairs = misdecodedRuns(sliced);
  const container = repairs > 0 ? repairMisdecodedText(sliced) : sliced;

  const headlineMatch = LABEL_AND_HEADLINE.exec(container);
  if (!headlineMatch) return null;

  const headline = bodyToText(headlineMatch[1] ?? "").trim();
  if (headline === "") return null;

  // Split rather than reassemble-then-search. The container opens with the
  // template's own wrapper divs *above* the label, so a `^`-anchored search
  // over the whole remainder never matches the lead paragraph — which is how
  // the first run reported every one of 406 releases as having no bolded lead
  // while leaving all 406 subheads in the body, to print a second time under
  // the standfirst.
  const wrappers = container.slice(0, headlineMatch.index);
  const tail = container.slice(headlineMatch.index + headlineMatch[0].length);

  const subhead = LEAD_SUBHEAD.exec(tail);
  const subheadText = subhead ? bodyToText(subhead[1] ?? "").trim() : "";

  // A lead longer than the column is left in the body and copied, truncated,
  // into `summary`. Lifting it would mean the overflow existed nowhere — a
  // silent content loss, which is exactly what `textCharsLost` is supposed to
  // make impossible.
  const liftable = subhead !== null && subheadText.length <= SUMMARY_MAX;
  const rest =
    wrappers +
    (liftable && subhead ? tail.slice(subhead.index + subhead[0].length) : tail);

  // A release with no bolded lead still needs a summary, because the column is
  // NOT NULL and the index renders it under every headline. The first
  // paragraph is the nearest thing the page itself offers, and taking a prefix
  // of it is mechanical — nothing is composed.
  const images = allMatches(rest, IMG_SRC);
  const links = allMatches(rest, HREF);
  const body = sanitiseTwice(rest);

  // Read off the *sanitised* body, not the raw fragment. The legacy editor
  // wrote plenty of these releases as `<div>`s rather than `<p>`s, and it is
  // `sanitiseBody` that maps a div to a paragraph — so on those pages the raw
  // fragment has no `<p>` at all and the fallback came back empty. One release
  // is a single 2,984-character block that this got wrong.
  const summarySource = subheadText !== "" ? subheadText : firstParagraph(body ?? "");
  const summaryFrom = subheadText !== "" ? "subhead" : "first-paragraph";

  const before = bodyToText(rest).length;
  const after = body ? bodyToText(body).length : 0;

  return {
    source,
    legacyId,
    headline,
    summary: fitSummary(summarySource),
    summaryFrom,
    body,
    report: {
      textCharsBefore: before,
      textCharsAfter: after,
      textCharsLost: before - after,
      misdecodedRunsRepaired: repairs,
      images,
      links: [...new Set(links)],
      documents: [
        ...new Set(links.filter((h) => /\.(pdf|docx?|xlsx?|pptx?|zip)(\?|$)/i.test(h))),
      ],
      reach: outsideContainer(raw, container),
    },
  };
}

function main(): void {
  const rawDir = arg("raw-dir", "");
  const manifestPath = arg("manifest", "");
  const outDir = arg("out-dir", join("legacy-import", "press"));

  if (!rawDir || !manifestPath) {
    console.error(
      "usage: import-press-archive.ts --raw-dir <dir> --manifest <file.json> " +
        "[--out-dir legacy-import/press]",
    );
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PressManifest;
  const real = manifest.items.filter((item) => item.file !== null);

  let written = 0;
  let skipped = 0;
  let lost = 0;
  let fromParagraph = 0;
  let repaired = 0;
  const repairedIds: number[] = [];
  const withImages: number[] = [];
  const withDocuments: number[] = [];

  for (const item of real) {
    const raw = readFileSync(join(rawDir, item.file as string), "utf8");

    let imported: Imported | null;
    try {
      imported = importOne(raw, item.id, item.url);
    } catch (error) {
      console.log(`  !! id=${item.id} — ${(error as Error).message}`);
      skipped += 1;
      continue;
    }

    if (!imported) {
      console.log(`  -- id=${item.id} — no headline in the container`);
      skipped += 1;
      continue;
    }

    writeFileSync(
      join(outDir, `press.php-id-${item.id}.json`),
      `${JSON.stringify(imported, null, 2)}\n`,
      "utf8",
    );

    written += 1;
    lost += imported.report.textCharsLost;
    if (imported.summaryFrom === "first-paragraph") fromParagraph += 1;
    if (imported.report.misdecodedRunsRepaired > 0) {
      repaired += imported.report.misdecodedRunsRepaired;
      repairedIds.push(item.id);
    }
    if (imported.report.images.length > 0) withImages.push(item.id);
    if (imported.report.documents.length > 0) withDocuments.push(item.id);
  }

  console.log("");
  console.log(`written     ${written} releases to ${outDir}`);
  console.log(`skipped     ${skipped}`);
  console.log(`text lost   ${lost} chars across all of them`);
  console.log(
    `summary     ${written - fromParagraph} from the release's own bolded lead, ` +
      `${fromParagraph} from its first paragraph`,
  );
  console.log(
    `images      ${withImages.length} releases link one` +
      (withImages.length > 0 ? ` (ids ${withImages.slice(0, 12).join(", ")}…)` : ""),
  );
  console.log(
    `documents   ${withDocuments.length} releases link one` +
      (withDocuments.length > 0 ? ` (ids ${withDocuments.slice(0, 12).join(", ")})` : ""),
  );
  console.log(
    `encoding    ${repaired} run(s) of double-encoded text repaired in ` +
      `${repairedIds.length} release(s)` +
      (repairedIds.length > 0 ? ` (ids ${repairedIds.join(", ")})` : ""),
  );
  console.log("");
  console.log("No dates: the pages carry none. `legacyId` is the only ordering.");
}

main();
