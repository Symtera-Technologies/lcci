import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECTIONS } from "./legacy-sections";
import { assignSlugs, dedupe, legacyKey, type LegacyRelease } from "./legacy-urls";

/**
 * Generate the launch 301 table.
 *
 * ## Why this is the first thing a cutover needs
 *
 * lcci.com.pk has been at its addresses for years. Every inbound link from a
 * newspaper, every bookmark, every result Google holds, and every link inside
 * the chamber's own PDFs points at a `.php` URL with a query string. The new
 * site serves none of those addresses, so without this table the day the DNS
 * changes is the day roughly a thousand URLs start answering 404 — and the
 * press archive, which is the bulk of the chamber's search footprint, is ~900
 * of them.
 *
 * A 404 does not merely lose that visit. Google drops the URL, and the ranking
 * it accumulated goes with it rather than moving to the page that now holds
 * the same words. A 301 moves it.
 *
 * ## Where the mapping comes from
 *
 * Nothing here is typed by hand. Two sources, both already in the repository:
 *
 *   - **Interior pages** from `SECTIONS` in `./legacy-sections`, which already
 *     records which legacy URLs each new route was built from, plus the
 *     `source` field inside each imported JSON — the URL the page was actually
 *     fetched from — and any `aliases` beside it. This is the same map the
 *     importer used to rewrite links *inside* the migrated bodies, so a page's
 *     internal links and the 301 for the page itself cannot disagree.
 *   - **Press releases** by reproducing `generate-press-seed.ts`'s own
 *     pipeline from `./legacy-urls`: the same read order, the same `dedupe`,
 *     the same `assignSlugs`. That is why those three moved into a shared
 *     module. The reproduction is not taken on trust —
 *     `tests/legacy-redirects.test.ts` checks every slug this emits against
 *     the `INSERT` list in migration 0037.
 *
 * The 8 legacy ids that are duplicates of another id get a redirect too, to
 * the release that was kept. They are live URLs today; that they were
 * de-duplicated on the way in is not the visitor's problem.
 *
 * ## What it deliberately does not cover
 *
 * `directory.php` and `directory2.php` are in `HAND_WRITTEN` below, pointing
 * at the directory page, because the member data behind them was never
 * crawled. Legacy asset paths (`PDF_Files/…`, `pdfs/…`, `dues.pdf`) are *not*
 * here: a 301 can only point at a file that exists, and those files are still
 * on the old host. They belong in this table the moment they are copied over,
 * and until then redirecting them would turn a working link on the old server
 * into a 404 on the new one.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/generate-redirect-map.ts
 */

const IMPORT_DIR = "legacy-import";
const PRESS_DIR = join(IMPORT_DIR, "press");
const OUT = join("src", "content", "legacy-redirects.ts");
const PRESS_BASE = "/news/press-releases";

/**
 * Legacy URLs with no imported page, whose destination is a judgement.
 *
 * Short on purpose. Everything that can be derived is derived; this is for the
 * handful where the old site had something the new one answers differently.
 */
const HAND_WRITTEN: Record<string, string> = {
  // The old front door. Both spellings of it.
  "index.php": "/",
  "index.html": "/",
  // Never crawled — the member data behind them is LCCI's to export — but they
  // are in the legacy main menu, so they have inbound links. The directory
  // page is the honest destination: it is where a directory will live.
  "directory.php": "/membership/directory",
  "directory2.php": "/membership/directory",

  /* ------------------------------------------------------------------------
     Imported, mapped to no route — so `SECTIONS` cannot supply a destination.

     **A redirect is not the same as placing the content**, and these are the
     first kind without the second. Each one goes to the page that now serves
     the same subject, so an inbound link lands somewhere truthful instead of
     on a 404; what the legacy page actually said is still listed as
     outstanding in docs/LEGACY-MIGRATION.md and in the client spreadsheet.
     Closing a 404 and closing a content gap are separate jobs and this only
     does the first.
     ------------------------------------------------------------------------ */

  // The President's, Senior VP's and VP's own pages, and the Executive
  // Committee roster. Held back because the legacy pages publish personal
  // mobile numbers and private email addresses, which is LCCI's call to
  // republish — see LEGACY-MIGRATION.md. The leadership page exists and
  // carries the President's message.
  "about.php?id=19": "/about/leadership",
  "about.php?id=21": "/about/leadership",
  "about.php?id=22": "/about/leadership",
  "excomm.php": "/about/leadership",

  // Two photo galleries, 42 images, no prose at all on the legacy pages. The
  // images are still on the old host.
  "about.php?id=137": "/news/galleries",
  "about.php?id=142": "/news/galleries",

  // Image- and video-only legacy pages whose subject has a route.
  "business.php?id=149": "/news/videos",
  "business.php?id=92": "/trade/delegations",
  "services.php?id=79": "/services",
  "members.php?id=85": "/resources/member-websites",

  // The Research & Development Department's own page — 2,525 characters that
  // are still unplaced. `/about/secretariat` is where the chamber's
  // departments and their contacts live, which is the nearest truthful
  // destination until the prose has a home.
  "services.php?id=95": "/about/secretariat",
};

interface ImportedPage {
  source: string;
}

/** Every legacy URL an interior page was built from, and where it went. */
function pageRedirects(): Map<string, string> {
  const map = new Map<string, string>();
  const available = new Set(
    readdirSync(IMPORT_DIR).filter((f) => f.endsWith(".json")),
  );

  for (const section of Object.values(SECTIONS)) {
    for (const mapping of section.mappings) {
      for (const source of mapping.sources) {
        if (!available.has(source.file)) continue;

        const meta = JSON.parse(
          readFileSync(join(IMPORT_DIR, source.file), "utf8"),
        ) as ImportedPage;

        for (const url of [meta.source, ...(source.aliases ?? [])]) {
          const key = legacyKey(url);
          if (key !== null) map.set(key, mapping.path);
        }
      }
    }
  }

  return map;
}

/** Every `press.php?id=N`, including the de-duplicated ids. */
function pressRedirects(): Map<string, string> {
  const map = new Map<string, string>();

  const crawled = readdirSync(PRESS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(PRESS_DIR, f), "utf8")) as LegacyRelease)
    // By legacy id, exactly as generate-press-seed.ts sorts them. `assignSlugs`
    // is order-dependent where two headlines collide, so a different order
    // here would hand some releases a different address than 0037 gave them.
    .sort((a, b) => a.legacyId - b.legacyId);

  const groups = dedupe(crawled);
  const slugs = assignSlugs(groups.map((g) => g.kept));

  for (const group of groups) {
    const slug = slugs.get(group.kept.legacyId);
    if (!slug) continue;

    for (const id of [group.kept.legacyId, ...group.aliases]) {
      map.set(`press.php?id=${id}`, `${PRESS_BASE}/${slug}`);
    }
  }

  return map;
}

function main(): void {
  const pages = pageRedirects();
  const press = pressRedirects();

  const all = new Map<string, string>([
    ...Object.entries(HAND_WRITTEN),
    ...pages,
    ...press,
  ]);

  // Sorted, so the file regenerates identically and a diff shows what changed
  // rather than what moved.
  const entries = [...all.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const lines = [
    "/**",
    " * The launch 301 table: every legacy lcci.com.pk address and where it now goes.",
    " *",
    " * GENERATED — do not edit. Run:",
    " *",
    " *   npx tsx --tsconfig tsconfig.scripts.json scripts/generate-redirect-map.ts",
    " *",
    " * The keys are a legacy URL's path and query with no leading slash, which is",
    " * how `legacyKey` in scripts/legacy-urls.ts normalises the four ways the old",
    " * site wrote each of its own links. `src/proxy.ts` looks requests up here and",
    " * answers 308. See scripts/generate-redirect-map.ts for where each entry came",
    " * from and what is deliberately absent.",
    " *",
    ` * ${entries.length} redirects: ${pages.size} interior pages, ${press.size} press releases,`,
    ` * ${Object.keys(HAND_WRITTEN).length} hand-written.`,
    " */",
    "export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {",
    ...entries.map(([from, to]) => `  ${JSON.stringify(from)}: ${JSON.stringify(to)},`),
    "};",
    "",
  ];

  writeFileSync(OUT, lines.join("\n"), "utf8");

  console.log(`pages      ${pages.size}`);
  console.log(`press      ${press.size}`);
  console.log(`hand       ${Object.keys(HAND_WRITTEN).length}`);
  console.log(`total      ${entries.length}`);
  console.log(`written    ${OUT}`);
}

main();
