/**
 * Walk the press archive on lcci.com.pk and save every release it still holds.
 *
 * `crawl-legacy.ts` deliberately refuses to expand `press.php`: each press
 * page links to others, so following them fills any crawl budget with news and
 * leaves the static pages uncollected. Its comment says the archive "wants a
 * dedicated pass that reads the archive index in order". This is that pass,
 * and the first thing it found is that **there is no index to read**.
 *
 * ## What the old site actually exposes
 *
 * `press.php` with no `id` renders the template with an empty headline, so
 * there is no list page, no pagination and no `sitemap.xml`. The only way in
 * is the numeric `id`. So the archive is enumerated rather than crawled:
 * `id=1` upward until the ids run out, which they do at 895.
 *
 * The old homepage's "latest" band links 895 down to 889, so the highest ids
 * are the most recent — but the range is **not** a clean chronology, and
 * nothing here assumes it is. Low ids have been reused: ids 1–4 and 601–602
 * serve content that also appears at 881–894.
 *
 * **The range is sparse.** `id=5` and `id=100` render the template with an
 * empty `<h3>` — a deleted or never-used row — while 1–4, 300, 500, 700, 850
 * and 889–895 are real releases. Every id is therefore recorded with whether
 * it held anything, because "we fetched 895 ids and 612 were real" is a fact
 * the import needs to state, and a gap list is how a later re-run proves the
 * archive has not changed under it.
 *
 * ## It is somebody's production server
 *
 * Same rules as `crawl-legacy.ts`, and they matter more here because this is
 * ~900 requests rather than ~150: one request at a time, never concurrent, a
 * delay between each, and a `User-Agent` that says what it is so whoever reads
 * the access log can tell it from a scraper. The whole run takes about a
 * quarter of an hour and nothing about it is urgent.
 *
 * It is also **resumable**: an id whose file is already on disk is skipped, so
 * a run killed half way through costs nothing and a re-run is not a re-crawl.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/crawl-press-archive.ts \
 *     --out-dir <dir> --manifest <file.json> [--from 1] [--to 895] [--delay 900]
 *
 * Everything it downloads is untrusted. Nothing is executed; pages are saved
 * as text and only the headline is read out of them, to print progress.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = "https://lcci.com.pk";
const USER_AGENT =
  "LCCI-rebuild-migration/1.0 (content inventory for the lcci.com.pk rebuild)";

/**
 * The headline, as the legacy template prints it.
 *
 * `<h2>Press Release</h2>` is the template's own label and is constant on
 * every one of these pages; the release's actual headline is the `<h3>` that
 * follows it. Anchoring on that pair rather than on "the first h3" matters
 * because the page chrome has an `<h3 class="about_header_lbl">` above the
 * content container.
 */
const HEADLINE = /<h2>\s*Press Release\s*<\/h2>\s*<h3[^>]*>([\s\S]*?)<\/h3>/i;

function headlineOf(html: string): string | null {
  const match = HEADLINE.exec(html);
  if (!match) return null;

  const text = (match[1] ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return text === "" ? null : text;
}

interface PressRecord {
  id: number;
  url: string;
  status: number;
  bytes: number;
  /** Null when the template rendered with an empty headline: no such release. */
  headline: string | null;
  /** Saved filename, or null when there was nothing worth saving. */
  file: string | null;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const outDir = arg("out-dir", "");
  const manifestPath = arg("manifest", "");
  const from = Number(arg("from", "1"));
  const to = Number(arg("to", "895"));
  const delay = Number(arg("delay", "900"));

  if (!outDir || !manifestPath) {
    console.error(
      "usage: crawl-press-archive.ts --out-dir <dir> --manifest <file.json> " +
        "[--from 1] [--to 895] [--delay 900]",
    );
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });

  // A manifest from an earlier run is merged rather than replaced, so a
  // resumed crawl ends with one complete record of the range and not just of
  // the part this process happened to fetch.
  const records = new Map<number, PressRecord>();
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      items?: PressRecord[];
    };
    for (const item of previous.items ?? []) records.set(item.id, item);
  }

  let fetched = 0;
  let skipped = 0;

  for (let id = from; id <= to; id += 1) {
    const file = `press.php-id-${id}.html`;
    const path = join(outDir, file);

    // Resume: a saved page is a fetched page. The manifest entry is kept too,
    // so this does not re-read the file merely to recount it.
    if (existsSync(path) && records.has(id)) {
      skipped += 1;
      continue;
    }

    const url = `${ORIGIN}/press.php?id=${id}`;

    let response: Response;
    try {
      response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
    } catch (error) {
      console.log(`  !! id=${id} — ${(error as Error).message}`);
      await sleep(delay);
      continue;
    }

    const html = await response.text();
    const headline = headlineOf(html);

    // Only real releases are kept. An empty id renders the full ~29 KB
    // template around an empty headline; saving 280 copies of the chrome would
    // add a few megabytes to the repository and tell the importer nothing.
    if (headline !== null) {
      writeFileSync(path, html, "utf8");
    }

    records.set(id, {
      id,
      url,
      status: response.status,
      bytes: html.length,
      headline,
      file: headline === null ? null : file,
    });

    fetched += 1;
    const live = [...records.values()].filter((r) => r.headline !== null).length;
    console.log(
      `  id=${String(id).padStart(3)} ${response.status} ` +
        `${String(html.length).padStart(6)}b  [${live} real]  ` +
        `${headline ?? "(empty — no such release)"}`,
    );

    // Written as we go, so a killed run leaves a usable manifest.
    if (fetched % 25 === 0) writeManifest();

    await sleep(delay);
  }

  writeManifest();

  const items = [...records.values()].sort((a, b) => a.id - b.id);
  const real = items.filter((r) => r.headline !== null);
  const gaps = items.filter((r) => r.headline === null).map((r) => r.id);

  console.log("");
  console.log(`fetched   ${fetched} ids this run, ${skipped} already on disk`);
  console.log(`real      ${real.length} press releases`);
  console.log(`empty     ${gaps.length} ids render the template with no headline`);
  console.log(`manifest  ${manifestPath}`);

  function writeManifest(): void {
    const items = [...records.values()].sort((a, b) => a.id - b.id);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          origin: ORIGIN,
          range: { from, to },
          crawledAt: new Date().toISOString(),
          counts: {
            ids: items.length,
            real: items.filter((r) => r.headline !== null).length,
            empty: items.filter((r) => r.headline === null).length,
          },
          items,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

void main();
