/**
 * Turn imported legacy pages into a seed migration, without retyping a word.
 *
 * `import-legacy-page.ts` produces one JSON file per page on lcci.com.pk,
 * holding the heading and the sanitised body. This maps those files onto the
 * routes of the rebuilt site and emits the SQL. Running the two scripts back to
 * back means the text in the database is byte-identical to the text the
 * sanitiser returned, which is in turn byte-identical in its *words* to the
 * live site — proven on every import by `textCharsLost: 0`.
 *
 * Generating the SQL rather than writing it is the point. Forty pages pasted
 * into a migration by hand is forty chances to drop a sentence, and the error
 * would be invisible: nothing downstream knows what the body was supposed to
 * say.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/generate-page-seed.ts \
 *     <section> <json-dir> <out.sql>
 *
 * `<section>` is a key of `SECTIONS` below — `about`, `resources`. One
 * migration per section, because a section is the unit LCCI reviews and the
 * unit a mistake is contained to.
 *
 * ## Why every legacy heading becomes an `h2`
 *
 * The rebuilt IA is not the old one, so several legacy pages land on a single
 * route: `/about/secretariat` carries what `services.php?id=9` and
 * `about.php?id=95` each said, and `/about/past-leadership` carries three
 * pages' rosters. Each one keeps its own heading, demoted to `h2` under the
 * route's `h1` — so nothing is lost and nothing is silently merged into one
 * undifferentiated block. On a single-source page it costs one extra heading,
 * which is a small price for one rule instead of two.
 *
 * `title_en` is **not** overwritten. The route's title comes from the typed IA
 * and is what the header, the footer sitemap and the section index already
 * call the page; a legacy page title replacing it would make the navigation
 * disagree with the page it leads to.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { navEntry } from "@/components/site/nav-data";
import { pageSlug } from "@/content/page-slug";
import { sanitiseBody } from "@/content/sanitise";
import { SECTIONS, routesOf, type Section, type Source } from "./legacy-sections";

interface Imported {
  source: string;
  heading: string | null;
  body: string | null;
  report: {
    textCharsAfter: number;
    images: string[];
    links: string[];
    documents: string[];
  };
}


/** MySQL string literal. Backslash is an escape character by default. */
function sql(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * A MySQL `LIKE` pattern matching this literal text anywhere.
 *
 * Backslash is `LIKE`'s escape character and `%` and `_` are its wildcards, so
 * all three are escaped here -- and then the whole pattern goes through
 * `sql()`, which escapes those backslashes again for the string literal.
 */
function likeContains(value: string): string {
  return sql(`%${value.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* -------------------------------------------------------------------------- */
/* Rewriting the links inside a migrated body                                 */
/* -------------------------------------------------------------------------- */

/**
 * An href's legacy identity, or null if it does not have one.
 *
 * The old site writes the same page four ways — `about.php?id=101`,
 * `/about.php?id=101`, `http://lcci.com.pk/about.php?id=101` and the `www.`
 * form — and all four appear in the markup, sometimes on one page. They are
 * normalised to the bare path-and-query so one map entry covers all of them.
 *
 * Returns null for a fragment, a `mailto:`/`tel:`, or a link to another host:
 * those are left exactly as they are.
 */
function legacyKey(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  if (/^(mailto|tel|javascript|data):/i.test(trimmed)) return null;

  const onThisHost = /^https?:\/\/(?:www\.)?lcci\.com\.pk(?:\/|$)(.*)$/i.exec(trimmed);
  if (onThisHost) return (onThisHost[1] ?? "").replace(/^\/+/, "");

  // Any other absolute or protocol-relative URL is somebody else's site.
  if (/^(?:https?:)?\/\//i.test(trimmed)) return null;

  return trimmed.replace(/^\/+/, "");
}

/**
 * Every legacy URL this migration knows a new address for.
 *
 * Built from the imported JSON's own `source` field — the URL the page was
 * actually fetched from — plus any `aliases`, so the map cannot drift from
 * what was imported. It is the same mapping the launch's 301 table needs, and
 * deriving both from one place is the point.
 */
function legacyRouteMap(dir: string, available: Set<string>): Map<string, string> {
  const map = new Map<string, string>();

  for (const section of Object.values(SECTIONS)) {
    for (const mapping of section.mappings) {
      for (const source of mapping.sources) {
        if (!available.has(source.file)) continue;
        const meta = JSON.parse(
          readFileSync(join(dir, source.file), "utf8"),
        ) as Imported;

        for (const url of [meta.source, ...(source.aliases ?? [])]) {
          const key = legacyKey(url);
          if (key !== null) map.set(key, mapping.path);
        }
      }
    }
  }

  return map;
}

/**
 * Point the links inside a migrated body at the new site.
 *
 * **This changes no words.** A legacy body's own index of links — and
 * `about.php?id=96` is largely nothing else — is written in legacy URLs, and
 * copying them verbatim would publish a page whose every internal link either
 * 404s or walks the visitor back onto the old host. The link *text* is
 * untouched; only its destination is moved to the address that now serves the
 * same material, by exactly the mapping the 301 table will use.
 *
 * External links are left alone, including the ones that are broken on the
 * live site today (`docs/LEGACY-MIGRATION.md` lists them). Repairing somebody
 * else's URL would be a guess, and a guess is a change.
 */
function rewriteLinks(
  html: string,
  map: Map<string, string>,
): { html: string; rewritten: number; schemeAdded: string[]; unresolved: string[] } {
  let rewritten = 0;
  const schemeAdded: string[] = [];
  const unresolved: string[] = [];

  const out = html.replace(/(<a\b[^>]*\bhref=")([^"]*)(")/gi, (whole, open, href, close) => {
    const key = legacyKey(href as string);
    if (key === null) return whole;

    const target = map.get(key);
    if (target !== undefined) {
      rewritten += 1;
      return `${open}${target}${close}`;
    }

    const repaired = withMissingScheme(key);
    if (repaired !== null) {
      schemeAdded.push(`${href as string} -> ${repaired}`);
      return `${open}${repaired}${close}`;
    }

    unresolved.push(href as string);
    return whole;
  });

  return {
    html: out,
    rewritten,
    schemeAdded: [...new Set(schemeAdded)],
    unresolved: [...new Set(unresolved)],
  };
}

/**
 * Put the scheme back on an href that was written as a bare hostname.
 *
 * Eight links on the live site are broken this way and have been for years —
 * `href="www.bdhcpk.org/"`, `href="pakuschamber.com/"` — because a browser
 * resolves a scheme-less href against the current page, so every visitor who
 * clicks one lands on `lcci.com.pk/www.bdhcpk.org/`. They are broken *now*,
 * for everybody, and `docs/LEGACY-MIGRATION.md` records each one.
 *
 * This is the one repair made here, and it is a mechanical one rather than a
 * guess: the only way to read `www.bdhcpk.org/` is as a hostname, so the
 * scheme the author left off is supplied. The chamber's own host becomes a
 * site-relative link instead, since `https://lcci.com.pk/` is this site.
 *
 * Returns null for anything that is not unmistakably a bare hostname — a
 * relative path like `pdfs/1-MoU-Foreign-Chambers.pdf` or
 * `member_web/.../index.htm` is left alone and reported, because those are
 * files and pages on the old host and what they need is a route or a
 * redirect, not a scheme.
 */
function withMissingScheme(key: string): string | null {
  if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]|$)/i.test(key)) return null;

  const host = key.split(/[/?#]/)[0] ?? "";
  if (host.replace(/^www\./i, "").toLowerCase() === "lcci.com.pk") {
    const rest = key.slice(host.length).replace(/^\/+/, "");
    return rest === "" ? "/" : null;
  }

  return `https://${key}`;
}

function bodyOf(
  dir: string,
  source: Source,
  map: Map<string, string>,
): {
  html: string;
  meta: Imported;
  rewritten: number;
  schemeAdded: string[];
  unresolved: string[];
} {
  const meta = JSON.parse(readFileSync(join(dir, source.file), "utf8")) as Imported;

  let html = meta.body ?? "";
  if (source.dropTables) {
    html = html.replace(/<table\b[\s\S]*?<\/table>/gi, "");
  }

  const links = rewriteLinks(html, map);
  // Re-sanitised after the rewrite, so what lands in the database is still
  // literally the output of the function the admin's save handler calls --
  // which is what `prose.tsx` relies on when it renders these bodies with
  // `dangerouslySetInnerHTML`. `sanitiseBody` is idempotent, so on a body with
  // no links to rewrite this is a no-op that costs a parse.
  html = sanitiseBody(links.html) ?? "";

  // The heading the legacy template printed, kept as an `h2`. Escaped, because
  // it came out of `bodyToText` as plain text — "Vision & Mission" has to
  // become "Vision &amp; Mission" to be valid markup.
  const heading = meta.heading ? `<h2>${escapeHtmlText(meta.heading)}</h2>` : "";

  return {
    html: `${heading}${html}`.trim(),
    meta,
    rewritten: links.rewritten,
    schemeAdded: links.schemeAdded,
    unresolved: links.unresolved,
  };
}


/**
 * `INSERT IGNORE` for every row in the section, empty and in draft.
 *
 * `INSERT IGNORE` rather than a conditional insert, so a section whose rows an
 * earlier migration already created — About's eight came from 0025 — is a
 * no-op here rather than a special case, and a page added to a section later
 * gets its row from a regenerated seed without disturbing the rest.
 */
function createRows(name: string, section: Section): string[] {
  const routes = routesOf(section);
  const slugs = routes.map(pageSlug);

  const lines = [
    `-- The ${name} section's rows.`,
    "--",
    "-- Created here rather than in a migration of their own, and created",
    "-- empty, for the reason 0025 sets out at length: the slug a route reads",
    "-- is derived mechanically from its path, so a row under any other slug",
    "-- renders a page that looks finished and is permanently blank. Both the",
    "-- slug below and the one the route asks for come from `pageSlug`, and",
    "-- both titles come from `navEntry`, so neither can drift from the other.",
    "--",
    "-- `draft` with no body, so running this file's first statement changes",
    "-- nothing a visitor sees. The `UPDATE`s below fill the bodies in and",
    "-- publish only the rows they filled.",
    "",
    "INSERT IGNORE INTO content_items",
    "  (content_type, slug, title_en, status, published_at, department_code,",
    "   review_by, sort_order, updated_at)",
    "VALUES",
  ];

  const values = routes.map((path, i) => {
    const { title } = navEntry(path);
    const reviewBy = section.reviewBy ? sql(section.reviewBy) : "NULL";
    return (
      `  ('page', ${sql(pageSlug(path))}, ${sql(title)}, 'draft', NULL, ` +
      `${sql(section.department)}, ${reviewBy}, ${(i + 1) * 10}, ` +
      `'2026-10-01 05:00:00.000')`
    );
  });

  lines.push(values.join(",\n"), ";", "");

  // `content_pages` is 1:1 and the editor's save writes to it by
  // `content_item_id`, so the satellite row has to exist before there is
  // anything to put in it. Every column on it is nullable to allow exactly
  // this.
  lines.push(
    "INSERT IGNORE INTO content_pages",
    "  (content_item_id, standfirst_en, standfirst_ur, body_en, body_ur,",
    "   hero_image_id)",
    "SELECT ci.id, NULL, NULL, NULL, NULL, NULL",
    "  FROM content_items ci",
    " WHERE ci.content_type = 'page'",
    `   AND ci.slug IN (${slugs.map(sql).join(", ")});`,
    "",
  );

  return lines;
}

function main(): void {
  const [name, dir, output] = process.argv.slice(2);
  if (!name || !dir || !output) {
    console.error("usage: generate-page-seed.ts <section> <json-dir> <out.sql>");
    console.error(`sections: ${Object.keys(SECTIONS).join(", ")}`);
    process.exit(2);
  }

  const section = SECTIONS[name];
  if (!section) {
    console.error(
      `unknown section "${name}". sections: ${Object.keys(SECTIONS).join(", ")}`,
    );
    process.exit(2);
  }

  const available = new Set(readdirSync(dir).filter((f) => f.endsWith(".json")));
  const routeMap = legacyRouteMap(dir, available);
  const lines: string[] = [];

  // Not placed by *any* section, not merely by this one — so the line at the
  // end of the file reads as "still has no home on the new site" rather than
  // "belongs to a different migration".
  const unplaced = new Set(available);
  for (const s of Object.values(SECTIONS)) {
    for (const m of s.mappings) for (const src of m.sources) unplaced.delete(src.file);
  }

  if (section.mappings.length === 0) {
    lines.push(
      `-- The ${name} section's rows, with no content in them.`,
      "--",
      "-- GENERATED by scripts/generate-page-seed.ts. Nothing on lcci.com.pk",
      "-- maps onto these pages, so there is nothing to migrate into them --",
      "-- only rows to create, so that an editor can find the pages in the",
      "-- admin and write them.",
      "",
    );
  } else {
    lines.push(
      `-- The ${name} section's content, migrated from lcci.com.pk.`,
      "--",
      "-- GENERATED by scripts/generate-page-seed.ts from the JSON that",
      "-- scripts/import-legacy-page.ts produced. Do not edit by hand: re-import",
      "-- the page and regenerate, so the text in this file is always text a",
      "-- machine lifted off the live site rather than text somebody retyped.",
      "--",
      "-- Every body below went through `sanitiseBody` -- the same function the",
      "-- admin's save handler calls -- so these rows are indistinguishable from",
      "-- rows an editor pasted in, which is what `src/components/site/prose.tsx`",
      "-- relies on when it renders them with `dangerouslySetInnerHTML`.",
      "--",
      "-- The bodies arrive by `UPDATE`, guarded on `body_en IS NULL`, so this",
      "-- can never overwrite the chamber's own correction with a scrape of the",
      "-- old site -- which is what makes the file safe to re-run and safe to",
      "-- regenerate.",
      "--",
      "-- The one thing not copied verbatim is a link's destination. Where a",
      "-- body links to a legacy page that now lives at a new address, the href",
      "-- is rewritten to that address, by the same mapping the launch's 301",
      "-- table uses. The link text is untouched, and a link to another site is",
      "-- left exactly as it is -- including the ones that are broken on",
      "-- lcci.com.pk today, which docs/LEGACY-MIGRATION.md lists rather than",
      "-- guesses at.",
      "",
    );
  }

  lines.push(...createRows(name, section));

  for (const mapping of section.mappings) {
    const slug = pageSlug(mapping.path);
    const parts: string[] = [];
    const images: string[] = [];
    const documents: string[] = [];
    const sources: string[] = [];
    const unresolved: string[] = [];
    const schemeAdded: string[] = [];
    let rewrittenLinks = 0;

    for (const source of mapping.sources) {
      if (!available.has(source.file)) {
        throw new Error(
          `${source.file} is not in ${dir}. Import it first, or correct SECTIONS — ` +
            "a missing source would otherwise seed a page with part of its content.",
        );
      }
      const imported = bodyOf(dir, source, routeMap);
      parts.push(imported.html);
      images.push(...imported.meta.report.images);
      documents.push(...imported.meta.report.documents);
      unresolved.push(...imported.unresolved);
      schemeAdded.push(...imported.schemeAdded);
      rewrittenLinks += imported.rewritten;
      sources.push(
        `${imported.meta.source} (${imported.meta.report.textCharsAfter} chars)`,
      );
    }

    const body = parts.filter(Boolean).join("\n");

    lines.push(`-- ${slug}  (${mapping.path})`);
    for (const source of sources) lines.push(`--   from ${source}`);
    if (images.length > 0) {
      lines.push(
        `--   ${images.length} image(s) on the source page are NOT migrated:`,
        "--   <img> is not on the sanitiser's allowlist, because alt text is NOT",
        "--   NULL on media_assets and a body that can carry an image is how an",
        "--   undescribed photograph reaches the site. They are outstanding:",
      );
      for (const src of [...new Set(images)].slice(0, 8)) lines.push(`--     ${src}`);
      if (new Set(images).size > 8) {
        lines.push(`--     ... and ${new Set(images).size - 8} more`);
      }
    }
    if (documents.length > 0) {
      lines.push(
        `--   ${new Set(documents).size} document(s) still hosted on the old server`,
        "--   and linked absolutely. They have to be moved before the old host goes.",
      );
    }
    if (rewrittenLinks > 0) {
      lines.push(`--   ${rewrittenLinks} link(s) repointed at their new address`);
    }
    if (schemeAdded.length > 0) {
      lines.push(
        `--   ${new Set(schemeAdded).size} link(s) are broken on lcci.com.pk today, written as a`,
        "--   bare hostname with no scheme, and have the scheme put back:",
      );
      for (const r of [...new Set(schemeAdded)].sort()) lines.push(`--     ${r}`);
    }
    if (unresolved.length > 0) {
      lines.push(
        `--   ${new Set(unresolved).size} link(s) to the old site that this`,
        "--   migration has no new address for, left as written. Each one needs",
        "--   either a route or a redirect before the old host is switched off:",
      );
      for (const href of [...new Set(unresolved)].sort()) lines.push(`--     ${href}`);
    }

    if (mapping.append) {
      // The marker is the leading heading of what is being appended. It is
      // there by construction -- `bodyOf` puts the legacy page's own heading
      // at the front of every body -- so a second run finds it and the
      // statement affects no rows.
      const marker = /^<h2>[\s\S]*?<\/h2>/.exec(body)?.[0];
      if (marker === undefined) {
        throw new Error(
          `${mapping.path} is marked append but its body has no leading <h2> ` +
            "to recognise it by, so the statement would not be idempotent.",
        );
      }

      lines.push(
        "UPDATE content_pages p",
        "  JOIN content_items ci ON ci.id = p.content_item_id",
        // `'\\n'` and not a real newline: MySQL reads the escape, and the
        // generated SQL stays one statement per line to read in a diff.
        `   SET p.body_en = CONCAT(p.body_en, '\\n', ${sql(body)})`,
        ` WHERE ci.content_type = 'page'`,
        `   AND ci.slug = ${sql(slug)}`,
        "   AND p.body_en IS NOT NULL",
        `   AND p.body_en NOT LIKE ${likeContains(marker)};`,
        "",
      );
    } else {
      lines.push(
        "UPDATE content_pages p",
        "  JOIN content_items ci ON ci.id = p.content_item_id",
        `   SET p.body_en = ${sql(body)}`,
        ` WHERE ci.content_type = 'page'`,
        `   AND ci.slug = ${sql(slug)}`,
        "   AND p.body_en IS NULL;",
        "",
      );
    }

    lines.push(
      "UPDATE content_items",
      "   SET status = 'published', published_at = '2026-10-01 05:00:00.000'",
      ` WHERE content_type = 'page' AND slug = ${sql(slug)}`,
      "   AND status = 'draft'",
      "   AND EXISTS (",
      "     SELECT 1 FROM content_pages p",
      "      WHERE p.content_item_id = content_items.id AND p.body_en IS NOT NULL",
      "   );",
      "",
    );
  }

  writeFileSync(output, `${lines.join("\n")}\n`, "utf8");
  console.log(`wrote ${output}`);
  console.log(`  ${routesOf(section).length} rows ensured`);
  console.log(`  ${section.mappings.length} bodies filled`);
  if (unplaced.size > 0) {
    // Printed, not written into the migration. A seed file whose comments
    // changed every time an unrelated section was mapped could not be
    // regenerated byte-for-byte, and its checksum is in `schema_migrations`.
    console.log(`  still placed by no section (${unplaced.size}):`);
    for (const f of [...unplaced].sort()) console.log(`    ${f}`);
  }
}

main();
