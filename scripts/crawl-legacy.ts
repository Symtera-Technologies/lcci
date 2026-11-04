/**
 * Walk lcci.com.pk and write down what is on it.
 *
 * The rebuild needs this twice over. The content migration needs to know what
 * text exists behind each legacy URL, and the launch needs a 301 from every
 * legacy URL to its replacement — ~890 press pages plus the static ones. Both
 * come from one inventory, which is why this runs before the remaining routes
 * are written: mapping forty routes onto guessed content is how the first pass
 * at the About section went wrong.
 *
 * There is no `sitemap.xml` and no `robots.txt` on the old site (both 404), so
 * discovery is by following links. That also means the inventory is exactly
 * the set of pages the old site *links to* — which is the right set, because an
 * unlinked page needs no redirect and has no inbound traffic to preserve.
 *
 * ## It is somebody's production server
 *
 * This is a live site on shared hosting, serving the chamber's members. So:
 * one request at a time, never concurrent; a delay between each; a hard cap on
 * the total; and a `User-Agent` that says what it is, so whoever reads the
 * access log can tell it from a scraper. Defaults are deliberately
 * conservative — the whole run is a few minutes, and nothing about this job is
 * urgent enough to justify load on the chamber's website.
 *
 * ## What it refuses to expand
 *
 * `directory.php` and `directory2.php` are the member directory: twenty
 * thousand businesses, paginated. Following it would mean thousands of
 * requests to collect records that are migrating from the membership database
 * rather than from HTML. The same goes for `about.php?id=19`-style member
 * detail pages reached from the Executive Committee. Those URLs are
 * **recorded** — they still need redirects — and not followed.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/crawl-legacy.ts \
 *     --out-dir <dir> --inventory <file.json> [--max-pages 150] [--delay 800]
 *
 * Everything it downloads is untrusted. Nothing is executed; pages are read as
 * text, and only hrefs and headings are extracted.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORIGIN = "https://lcci.com.pk";
const USER_AGENT =
  "LCCI-rebuild-migration/1.0 (content inventory for the lcci.com.pk rebuild)";

/**
 * Paths recorded but never followed.
 *
 * `directory.php` / `directory2.php` — the member directory, twenty thousand
 * businesses, paginated. Those records migrate from the membership database,
 * not from HTML.
 *
 * `press.php` — the press archive, ~890 items. Each press page links to
 * others, so expanding it would fill any crawl budget with news and leave the
 * static pages uncollected. It is also the wrong tool for the job: press
 * releases have their own content type with a date, topics and a slug, and
 * want a dedicated pass that reads the archive index in order. Their URLs are
 * still recorded here, because every one of them needs a 301.
 *
 * `budgetproposals/` — an Apache directory index of PDFs, not a page.
 */
const DO_NOT_EXPAND = [
  /^\/directory2?\.php/i,
  /^\/press\.php/i,
  /^\/budgetproposals\//i,
];

/** Extensions that are files to move, not pages to parse. */
const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|webp|mp4|mp3)$/i;

interface PageRecord {
  url: string;
  status: number;
  bytes: number;
  /** The legacy template's page heading; empty on the "no such id" shell. */
  heading: string | null;
  /** True when the page has a heading — i.e. it is a real content page. */
  isContent: boolean;
  /** Saved filename, for the importer to read. */
  file: string | null;
  depth: number;
  /** Where this URL was first found. */
  foundOn: string | null;
  expanded: boolean;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A filesystem-safe name for a URL with a query string in it. */
function fileNameFor(url: string): string {
  const path = url.slice(ORIGIN.length) || "/index";
  const safe = path.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe || "index"}.html`;
}

/**
 * Resolve an href against the page it was found on, or null to ignore it.
 *
 * Returns null for anything that is not a page on this host: `#`, a
 * `javascript:` or `mailto:` or `tel:` URL, another origin, or a file. Files
 * and off-site links are recorded by the caller before this point, because the
 * ones hosted on the old server have to move before it is switched off.
 */
function resolveHref(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  if (/^(javascript|mailto|tel|data):/i.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `http://lcci.com.pk/...` appears in the markup alongside https; both are
  // the same page and are normalised to one so neither is fetched twice.
  if (url.hostname.replace(/^www\./, "") !== "lcci.com.pk") return null;

  url.hash = "";
  url.protocol = "https:";
  url.hostname = "lcci.com.pk";
  return url.toString();
}

function headingOf(html: string): string | null {
  const m = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html);
  if (!m) return null;

  const text = m[1]
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text === "" ? null : text;
}

async function main(): Promise<void> {
  const outDir = arg("out-dir", "");
  const inventoryPath = arg("inventory", "");
  const maxPages = Number(arg("max-pages", "150"));
  const delay = Number(arg("delay", "800"));

  if (!outDir || !inventoryPath) {
    console.error(
      "usage: crawl-legacy.ts --out-dir <dir> --inventory <file.json> " +
        "[--max-pages 150] [--delay 800]",
    );
    process.exit(2);
  }

  mkdirSync(outDir, { recursive: true });

  const seen = new Set<string>([`${ORIGIN}/index.php`]);
  const queue: { url: string; depth: number; foundOn: string | null }[] = [
    { url: `${ORIGIN}/index.php`, depth: 0, foundOn: null },
  ];

  const pages: PageRecord[] = [];
  const files = new Map<string, string>();
  const offsite = new Map<string, string>();
  const deadLinks = new Map<string, string>();

  while (queue.length > 0 && pages.length < maxPages) {
    const item = queue.shift();
    if (!item) break;

    const expandable = !DO_NOT_EXPAND.some((re) =>
      re.test(new URL(item.url).pathname),
    );

    let response: Response;
    try {
      response = await fetch(item.url, { headers: { "user-agent": USER_AGENT } });
    } catch (error) {
      console.log(`  !! ${item.url} — ${(error as Error).message}`);
      continue;
    }

    const html = await response.text();
    const heading = headingOf(html);
    const file = fileNameFor(item.url);
    writeFileSync(join(outDir, file), html, "utf8");

    pages.push({
      url: item.url,
      status: response.status,
      bytes: html.length,
      heading,
      // The status matters as much as the heading: the legacy 404 page has
      // `<h2>Not Found</h2>`, so heading-alone counted eight broken links as
      // content pages. They are broken links *on the live site* — hrefs like
      // `www.bdhcpk.org/` with no scheme, which every visitor's browser also
      // resolves against lcci.com.pk — and they belong in the report, not in
      // the migration.
      isContent: response.status === 200 && heading !== null,
      file,
      depth: item.depth,
      foundOn: item.foundOn,
      expanded: expandable,
    });

    console.log(
      `  ${String(pages.length).padStart(3)} ${response.status} ` +
        `${String(html.length).padStart(6)}b  ${heading ?? "(no heading)"}  ${item.url}`,
    );

    if (expandable) {
      for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']*)["']/gi)) {
        const href = (match[1] ?? "").trim();

        // Recorded before resolving, because these are the ones that matter
        // and resolveHref throws them away.
        if (href === "#" || href === "") {
          deadLinks.set(item.url, href);
          continue;
        }
        if (FILE_EXT.test(href.split("?")[0] ?? "")) {
          files.set(new URL(href, item.url).toString(), item.url);
          continue;
        }
        if (/^https?:\/\//i.test(href) && !/lcci\.com\.pk/i.test(href)) {
          offsite.set(href, item.url);
          continue;
        }

        const next = resolveHref(href, item.url);
        if (next === null || seen.has(next)) continue;

        seen.add(next);
        queue.push({ url: next, depth: item.depth + 1, foundOn: item.url });
      }
    }

    await sleep(delay);
  }

  const inventory = {
    crawledAt: new Date().toISOString(),
    origin: ORIGIN,
    stopped: queue.length > 0 ? `cap of ${maxPages} reached, ${queue.length} queued` : "queue empty",
    pages,
    contentPages: pages.filter((p) => p.isContent).length,
    shellPages: pages.filter((p) => !p.isContent).length,
    filesOnOldHost: [...files].map(([url, foundOn]) => ({ url, foundOn })),
    offsiteLinks: [...offsite].map(([url, foundOn]) => ({ url, foundOn })),
    pagesWithDeadLinks: [...new Set(deadLinks.keys())],
  };

  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`pages fetched   ${pages.length}  (${inventory.contentPages} with content, ${inventory.shellPages} shells)`);
  console.log(`files to move   ${inventory.filesOnOldHost.length}`);
  console.log(`offsite links   ${inventory.offsiteLinks.length}`);
  console.log(`stopped because ${inventory.stopped}`);
  console.log(`inventory       ${inventoryPath}`);
}

// Not top-level `await`: these scripts are transformed to CommonJS, where it
// is a build error. The other scripts in this directory are synchronous and
// never hit it.
main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
