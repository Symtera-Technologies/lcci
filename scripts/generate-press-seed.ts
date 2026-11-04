/**
 * Turn the imported press archive into a seed migration.
 *
 * Reads `legacy-import/press/*.json` — what `import-press-archive.ts` lifted
 * off the old site — and writes one forward-only `.sql` file. Run it again and
 * the output must be byte-identical: the migration runner checksums applied
 * files and refuses an edited one, so a generator whose output drifts turns
 * every later run into a failed migration.
 *
 * ## The archive arrives as drafts, and that is not timidity
 *
 * `press.php` prints no date. Not in the markup, not in a `Last-Modified`
 * header, and there is no index page carrying one; nor can the id stand in for
 * one, since low ids have been reused. See the header of
 * `import-press-archive.ts`.
 *
 * `liveItems()` requires `status = 'published' AND published_at <= NOW()`, so a
 * row with no date cannot be live whatever its status, and inventing one would
 * print a false date under a real headline — on a page whose whole purpose is
 * to be the chamber's record of what it said and when. So every row is seeded
 * `status = 'draft'`, `published_at = NULL`: the archive lands in the admin
 * where staff can read, search and date it, and reaches the public newsroom
 * when LCCI supplies the dates.
 *
 * Dating them later needs no schema change and no re-import. `legacyId` is in
 * the provenance JSON beside the slug, and slugs are unique per content type,
 * so a dated export of LCCI's own press table becomes one `UPDATE … JOIN`.
 *
 * ## Collisions with the seeded fixtures are filled in, not duplicated
 *
 * Migration 0017 seeded seven press releases by hand, with summaries and
 * dates but **no bodies**, and at least one of them is a real release that is
 * also in this archive — `press.php?id=3` is "Speaker Punjab Assembly Assures
 * LCCI of Support", whose slug 0017 already uses. Inserting it again would
 * publish the same release twice at two addresses.
 *
 * So the generator reads 0017's own press slugs and, where this archive
 * slugifies onto one of them, emits an `UPDATE … WHERE body_en IS NULL`
 * instead of an insert: the dated fixture keeps its date and gains the body it
 * never had. That is also why the file reads the migration rather than taking
 * a list of slugs as an argument — a hand-maintained list would go stale the
 * first time anyone seeds another release.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/generate-press-seed.ts \
 *     legacy-import/press migrations/0036_seed_press_archive.sql
 *
 * The output is a few megabytes: too large to paste into phpMyAdmin's SQL box,
 * so import it as a file or run it over SSH.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { slugify } from "@/content/fields";

interface Imported {
  source: string;
  legacyId: number;
  headline: string;
  summary: string;
  summaryFrom: "subhead" | "first-paragraph";
  body: string | null;
}

/** MySQL string literal. Backslash is an escape character by default. */
function sql(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** `title_en` is `varchar(300)`; nothing on the old site comes close. */
const TITLE_MAX = 300;

/**
 * Press slugs an *earlier* migration already seeded.
 *
 * Parsed out of the migrations rather than listed here, so this cannot drift
 * from what is actually in the database.
 *
 * `before` is the file being written, and only migrations ordering ahead of it
 * are read. Without that, the second run reads the output of the first — so
 * every release is "already seeded", the inserts all become no-op `UPDATE`s,
 * and the file is different from the one the runner has already checksummed.
 * The migrations are forward-only, so "earlier in the sequence" is the correct
 * rule and not just a guard against self-reference.
 */
function slugsAlreadySeeded(migrationsDir: string, before: string): Set<string> {
  const slugs = new Set<string>();

  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith(".sql")) continue;
    if (file >= before) continue;
    const text = readFileSync(join(migrationsDir, file), "utf8");
    for (const match of text.matchAll(/\(\s*'press_release'\s*,\s*'([a-z0-9-]+)'/g)) {
      if (match[1]) slugs.add(match[1]);
    }
  }

  return slugs;
}

/**
 * The same release served at more than one legacy id becomes one row.
 *
 * Eight releases in this archive are published at two ids with byte-identical
 * headlines and bodies — ids 3 and 891 are the same release, as are 309 and
 * 310, and six more pairs. The old site simply has them twice. Seeding both
 * would publish one release at two addresses, which is a duplicate a search
 * engine has to choose between and a reader has no way to tell apart.
 *
 * Identity is the headline and the body together, so this merges only exact
 * repeats. Twelve groups *share a headline*, and four of those differ in the
 * body — ids 1 and 886 are both "Government, LCCI to Work Together for
 * Industrial Growth" at 4,343 and 3,677 characters. Those stay as separate
 * rows, because deciding that the shorter one is a worse copy of the longer is
 * an editorial judgement and this script does not make those.
 *
 * The surviving row keeps the lowest id, which is arbitrary between exact
 * copies and is recorded so that the redirect map can send every legacy URL
 * in the group to the one address that survived.
 */
function dedupe(items: Imported[]): { kept: Imported; aliases: number[] }[] {
  const groups = new Map<string, Imported[]>();

  for (const item of items) {
    const key = createHash("sha256")
      .update(`${item.headline}\u0000${item.body ?? ""}`)
      .digest("hex");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return [...groups.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) => a.legacyId - b.legacyId);
      return {
        kept: sorted[0] as Imported,
        aliases: sorted.slice(1).map((i) => i.legacyId),
      };
    })
    .sort((a, b) => a.kept.legacyId - b.kept.legacyId);
}

/**
 * One slug per release, unique within the archive.
 *
 * `slugify` is the application's own — the same suggestion the admin's editor
 * would make from the headline — so these addresses are the ones an editor
 * would have chosen. Two releases can share a headline (the chamber reissues
 * one, or a page was duplicated), and the slug is the public address, so a
 * collision inside the archive is disambiguated with the legacy id rather than
 * silently dropping a release.
 */
function assignSlugs(items: Imported[]): Map<number, string> {
  const taken = new Set<string>();
  const slugs = new Map<number, string>();

  for (const item of items) {
    const base = slugify(item.headline) || `press-${item.legacyId}`;
    let slug = base;

    if (taken.has(slug)) {
      const suffix = `-${item.legacyId}`;
      slug = `${base.slice(0, 160 - suffix.length)}${suffix}`;
    }

    taken.add(slug);
    slugs.set(item.legacyId, slug);
  }

  return slugs;
}

function main(): void {
  const [inDir, outPath] = process.argv.slice(2);
  const migrationsDir = join("migrations");

  if (!inDir || !outPath) {
    console.error(
      "usage: generate-press-seed.ts <legacy-import/press> <out.sql>",
    );
    process.exit(2);
  }

  const crawled = readdirSync(inDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(inDir, f), "utf8")) as Imported)
    // By legacy id, so the file is in a stable order and regenerates
    // byte-identically. Not a chronology: see the header.
    .sort((a, b) => a.legacyId - b.legacyId);

  if (crawled.length === 0) {
    console.error(`no .json files in ${inDir} — run import-press-archive.ts first`);
    process.exit(1);
  }

  const groups = dedupe(crawled);
  const items = groups.map((g) => g.kept);
  const aliasesOf = new Map(groups.map((g) => [g.kept.legacyId, g.aliases]));

  const existing = slugsAlreadySeeded(migrationsDir, basename(outPath));
  const slugs = assignSlugs(items);

  const fresh = items.filter((i) => !existing.has(slugs.get(i.legacyId) as string));
  const collided = items.filter((i) => existing.has(slugs.get(i.legacyId) as string));

  // The old site stores headlines in a column that cuts them at 55
  // characters. Counted rather than asserted, so the migration states the real
  // number and a later archive that has been fixed reports a smaller one.
  const truncated = items.filter((i) => i.headline.length >= 54).length;
  const midWord = items.filter(
    (i) => i.headline.length >= 54 && /[a-z]$/.test(i.headline),
  ).length;

  const out: string[] = [];

  out.push(
    "-- The press archive from lcci.com.pk.",
    "--",
    `-- ${items.length} press releases from ${crawled.length} legacy ids, lifted off press.php?id=N by`,
    "-- scripts/import-press-archive.ts and written here by",
    "-- scripts/generate-press-seed.ts. Regenerating must produce this file",
    "-- byte for byte; the runner checksums it.",
    "--",
    "-- EVERY ROW IS A DRAFT WITH NO DATE, and deliberately. The legacy pages",
    "-- carry no publication date in the markup, in the response headers or on",
    "-- an index page. Nor can the id stand in for one: low ids have been",
    "-- reused, and an archived capture of press.php?id=1 is a different",
    "-- release from the one that id serves now.",
    "--",
    "-- liveItems() needs published_at <= NOW(), so",
    "-- these are invisible to visitors until LCCI supplies the dates. Dating",
    "-- them is one UPDATE joined on the slug: legacyId sits beside the slug in",
    "-- legacy-import/press/.",
    "--",
    "-- Topics and spokesperson are empty for the same reason: both are",
    "-- editorial judgements and neither is on the page.",
    "--",
    "-- HEADLINES ARE TRUNCATED AT 55 CHARACTERS ON THE OLD SITE, which is a",
    "-- limit in LCCI's own data and not in this import: no headline anywhere in",
    `-- the archive is longer, ${truncated} of them stop at 54 or 55 characters, and`,
    `-- ${midWord} of those stop mid-word ("... re-imposition of Gas Infrastructure`,
    '-- Develop"). The full wording is not recoverable from the page, and',
    "-- reconstructing it from the body would be writing a headline rather than",
    "-- migrating one, so these are seeded as they stand for an editor to finish.",
    "--",
    `-- ${crawled.length - items.length} legacy ids are exact duplicates of another id and are not`,
    "-- seeded twice; the comment above each insert names them, because every one",
    "-- of those URLs still needs a 301 to the address that survived.",
    "--",
    `-- ${fresh.length} new rows; ${collided.length} fill in the body of a release an`,
    "-- earlier migration already seeded with a date but no body.",
    "",
  );

  // Chunked rather than one statement: a single VALUES list of several hundred
  // rows is a large packet, and `max_allowed_packet` is 16 MB on plenty of
  // shared hosts.
  const COLUMNS =
    "(content_type, slug, title_en, title_ur, status, published_at, " +
    "department_code, review_by, sort_order)";

  for (let i = 0; i < fresh.length; i += 100) {
    const chunk = fresh.slice(i, i + 100);
    out.push(`INSERT IGNORE INTO content_items ${COLUMNS}`, "VALUES");
    out.push(
      chunk
        .map((item, n) => {
          const slug = slugs.get(item.legacyId) as string;
          const title = item.headline.slice(0, TITLE_MAX);
          return (
            `  ('press_release', ${sql(slug)}, ${sql(title)}, NULL, 'draft', ` +
            `NULL, 'info', NULL, ${item.legacyId})${n === chunk.length - 1 ? ";" : ","}`
          );
        })
        .join("\n"),
    );
    out.push("");
  }

  for (const item of fresh) {
    const slug = slugs.get(item.legacyId) as string;
    const aliases = aliasesOf.get(item.legacyId) ?? [];
    out.push(
      `-- ${item.source}` +
        (aliases.length > 0
          ? `  (also at id=${aliases.join(", id=")} — identical, redirect both here)`
          : ""),
      "INSERT IGNORE INTO content_press_releases " +
        "(content_item_id, summary, body_en, body_ur, hero_image_id, spokesperson)",
      `SELECT ci.id, ${sql(item.summary)}, ${item.body === null ? "NULL" : sql(item.body)}, NULL, NULL, NULL`,
      "  FROM content_items ci",
      ` WHERE ci.content_type = 'press_release' AND ci.slug = ${sql(slug)};`,
      "",
    );
  }

  for (const item of collided) {
    const slug = slugs.get(item.legacyId) as string;
    out.push(
      `-- ${item.source} is the release already seeded as '${slug}'.`,
      "-- Its date and summary are kept; only the body it never had is filled.",
      "UPDATE content_press_releases p",
      "  JOIN content_items i ON i.id = p.content_item_id",
      `   SET p.body_en = ${item.body === null ? "NULL" : sql(item.body)}`,
      ` WHERE i.content_type = 'press_release'`,
      `   AND i.slug = ${sql(slug)}`,
      "   AND p.body_en IS NULL;",
      "",
    );
  }

  writeFileSync(outPath, `${out.join("\n").replace(/\n+$/, "")}\n`, "utf8");

  const fromParagraph = items.filter((i) => i.summaryFrom === "first-paragraph").length;
  const noBody = items.filter((i) => i.body === null).length;

  console.log(`legacy ids ${crawled.length}`);
  console.log(
    `releases   ${items.length} after merging ${crawled.length - items.length} exact duplicates`,
  );
  for (const group of groups.filter((g) => g.aliases.length > 0)) {
    console.log(
      `             id=${group.kept.legacyId} absorbs id=${group.aliases.join(", id=")}`,
    );
  }
  console.log(`inserted   ${fresh.length} new draft rows`);
  console.log(`filled in  ${collided.length} already-seeded release(s)`);
  for (const item of collided) {
    console.log(`             ${slugs.get(item.legacyId)}  ← ${item.source}`);
  }
  console.log(
    `summary    ${items.length - fromParagraph} from a bolded lead, ` +
      `${fromParagraph} from the first paragraph`,
  );
  if (noBody > 0) console.log(`no body    ${noBody} release(s) sanitised to nothing`);
  console.log(`written    ${outPath}`);
}

main();
