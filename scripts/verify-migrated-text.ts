/**
 * Prove that every word migrated off lcci.com.pk reached the built site.
 *
 * The import reports `textCharsLost: 0` and the seed is generated rather than
 * typed, so in principle nothing can go missing. In practice there are five
 * more steps between the legacy HTML and a visitor's screen — a second
 * sanitiser pass, a MySQL string literal, a migration, `getPage`, and
 * `dangerouslySetInnerHTML` — and a mistake in any of them loses text without
 * raising anything. The import's own numbers cannot see past the import.
 *
 * So this checks the two ends against each other and ignores everything
 * between: every run of **six consecutive words** from each source page must
 * appear in the prerendered HTML of the route that page was mapped to. Six
 * because it is long enough that a run is unique to its sentence and short
 * enough that one reordered paragraph does not report the whole page as lost.
 *
 * It reads the same `SECTIONS` table the seed generator reads, so there is no
 * second list of pairings to keep in step — a mapping added there is checked
 * here on the next run, and a mapping removed stops being checked.
 *
 *   npm run build            # the pages must be prerendered first
 *   npm run verify:migration
 *
 * Or, against a different import or build directory:
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/verify-migrated-text.ts \
 *     <json-dir> [.next/server/app]
 *
 * Exits non-zero on the first page with a missing run, naming it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS, type Mapping } from "./legacy-sections";

interface Imported {
  source: string;
  heading: string | null;
  body: string | null;
}

/**
 * Plain words, as a reader would see them.
 *
 * Tags go, entities are decoded, and `&nbsp;` and the replacement character
 * both become spaces: the legacy pages are littered with Windows-1252 bytes
 * that arrive as U+FFFD, and a run that straddles one would otherwise be
 * reported missing on both sides of a comparison that actually agrees.
 */
/**
 * Zero-width characters, and the two entities that spell the first of them.
 *
 * The legacy minutes page carries forty-two zero-width spaces, each alone in
 * its own paragraph between two lists. They are invisible, they are not words,
 * and treating one as a word makes a "run of six words" that is five words and
 * a piece of editor debris — which then has to survive into the built page for
 * this check to pass, holding the design hostage to a character nobody can see.
 *
 * Removed rather than turned into a space, so that one sitting inside a word
 * joins its halves instead of splitting it. `src/content/editorial.ts` drops
 * them on the render side with the same character class, which is what keeps
 * the two sides of this comparison in agreement.
 */
const INVISIBLE = /[​‌‍﻿]|&#8203;|&#x200b;/gi;

function words(markup: string): string[] {
  return decode(markup.replace(/<[^>]*>/g, " ").replace(INVISIBLE, ""))
    .replace(/[ �]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    // Both spellings of an apostrophe. The hex one is React's: a heading
    // rendered as a text node comes out as `President&#x27;s`, where the same
    // words inside a `dangerouslySetInnerHTML` body keep the raw character. So
    // a page gained three "missing" runs of six words purely by having its
    // heading moved out of the prose and into a component — which is a
    // difference in escaping and not in anything the chamber wrote.
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    // Last, or an `&amp;lt;` in the source decodes twice.
    .replace(/&amp;/g, "&");
}

/** The prerendered HTML for a route, however Next chose to write it. */
function builtHtml(buildDir: string, path: string): string {
  const route = path.replace(/^\//, "");
  for (const candidate of [
    join(buildDir, `${route}.html`),
    join(buildDir, route, "index.html"),
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }

  throw new Error(
    `no prerendered HTML for ${path}. Run \`npm run build\` first — this ` +
      "verifies the built site, not the database.",
  );
}

function checkMapping(
  jsonDir: string,
  buildDir: string,
  mapping: Mapping,
): { runs: number; missing: string[] } {
  // Normalised once per route rather than once per source, because
  // `/trade/exhibitions` carries three legacy pages and `/about/secretariat`
  // three departments.
  const page = words(builtHtml(buildDir, mapping.path)).join(" ");

  let runs = 0;
  const missing: string[] = [];

  for (const source of mapping.sources) {
    const meta = JSON.parse(
      readFileSync(join(jsonDir, source.file), "utf8"),
    ) as Imported;

    const w = words(`${meta.heading ?? ""} ${meta.body ?? ""}`);
    for (let i = 0; i + 6 <= w.length; i += 1) {
      const run = w.slice(i, i + 6).join(" ");
      runs += 1;
      if (!page.includes(run)) missing.push(`${source.file}: ${run}`);
    }
  }

  return { runs, missing };
}

function main(): void {
  const [jsonDir = "legacy-import", buildDir = join(".next", "server", "app")] =
    process.argv.slice(2);

  let totalRuns = 0;
  let totalMissing = 0;

  for (const [name, section] of Object.entries(SECTIONS)) {
    for (const mapping of section.mappings) {
      // `contact.php`'s body is a contact *form* laid out as a table of
      // labels, dropped on import for the reason `Source.dropTables`
      // explains. Its words are deliberately not on the new page.
      if (mapping.sources.some((s) => s.dropTables)) {
        console.log(`  skip  ${mapping.path}  (a table was dropped on import)`);
        continue;
      }

      const { runs, missing } = checkMapping(jsonDir, buildDir, mapping);
      totalRuns += runs;
      totalMissing += missing.length;

      const verdict = missing.length === 0 ? "ok" : `${missing.length} MISSING`;
      console.log(
        `  ${verdict.padStart(12)}  ${mapping.path.padEnd(38)} ${runs} runs  [${name}]`,
      );
      for (const m of missing.slice(0, 5)) console.log(`                  ${m}`);
    }
  }

  console.log("");
  console.log(`${totalRuns} runs of six words checked, ${totalMissing} missing`);
  process.exit(totalMissing === 0 ? 0 : 1);
}

main();
