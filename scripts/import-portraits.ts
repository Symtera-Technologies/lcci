/**
 * Pull the chamber's portrait photographs off lcci.com.pk.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/import-portraits.ts \
 *     [--out public/people] [--manifest legacy-import/portraits.json] [--delay 700]
 *
 * ## What it takes, and from where
 *
 * `presidents.php` is a roster: for each former president an `<img>` and an
 * `<h3>` with the name, inside the same repeated wrapper. `about.php?id=19`,
 * `?id=21` and `?id=22` are the current President, Senior Vice President and
 * Vice President, one portrait each. Between them that is every photograph of
 * a named person the old site publishes.
 *
 * The pairing is the whole job. The imported page bodies went through
 * `sanitiseBody`, which drops `<img>` — deliberately, because an image with no
 * alt text is how an undescribed photograph reaches a page — so the bodies
 * cannot say which face belongs to which name. The raw HTML can, and this
 * reads it for that and nothing else.
 *
 * ## Why the pictures are resized here
 *
 * `next.config.ts` sets `images.unoptimized`, so whatever lands in `public/`
 * is what a visitor downloads, byte for byte. The source portraits are 190 KB
 * to 680 KB each and there are 60-odd of them: shipped as they are, the former
 * presidents page would be a 12 MB download. `sharp` runs here, at import
 * time, which is the one place the project permits it — never at runtime, for
 * the memory reason `next.config.ts` sets out at length.
 *
 * Resized with `fit: "inside"`, so nothing is cropped. A face can sit anywhere
 * in these frames and a server-side crop to a fixed aspect would behead some
 * of them with nobody watching; the page puts the image in a fixed box with
 * `object-cover` instead, which is a crop that can be changed later by editing
 * CSS rather than by re-importing.
 *
 * ## Alt text names the person, and that is a considered reversal
 *
 * `scripts/prepare-photos.mjs` carries a note saying alt text for LCCI
 * photographs must not name individuals. That is right for the hero collage:
 * the source images carried "..." as their alt, so who is in them is nobody's
 * assertion. Here the name is published beside the face on the chamber's own
 * page. The pairing is LCCI's statement about its own office-bearers, and
 * repeating it is reporting the source rather than guessing at it.
 *
 * Everything downloaded is untrusted. Nothing is executed; the HTML is read as
 * text, and each image is re-encoded by `sharp` rather than copied, so a file
 * pretending to be a JPEG fails here instead of reaching `public/`.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import sharp, { type OutputInfo } from "sharp";
import { slugify } from "@/content/fields";

const ORIGIN = "https://lcci.com.pk";
const USER_AGENT =
  "LCCI-rebuild-migration/1.0 (portrait migration for the lcci.com.pk rebuild)";

/**
 * The roster page, and the three office-bearers' own pages.
 *
 * `role` is what the chamber calls the post on that page, used as written.
 * The roster's own entries carry their year instead, which the page already
 * prints, so they get no role here.
 */
const SOURCES = [
  { path: "/presidents.php", roster: true, role: null },
  { path: "/about.php?id=19", roster: false, role: "President" },
  { path: "/about.php?id=21", roster: false, role: "Senior Vice President" },
  { path: "/about.php?id=22", roster: false, role: "Vice President" },
] as const;

/** Longest edge of a stored portrait. */
const MAX_WIDTH = 480;
const MAX_HEIGHT = 600;
const QUALITY = 78;

/** A page's own logo and spacer images, which are not people. */
const NOT_A_PERSON = /^images\/|^assets\/images\/|logo|icon|banner|spacer/i;

interface Portrait {
  /** As the chamber writes it, including its own spacing and punctuation. */
  name: string;
  /** `Year 2023-24` on the roster, where the page gives one. */
  term: string | null;
  role: string | null;
  /** Where it came from, for provenance. */
  source: string;
  sourceImage: string;
  /** Where it landed, as the site will reference it. */
  src: string;
  width: number;
  height: number;
  bytesBefore: number;
  bytesAfter: number;
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.text();
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Entities to characters, for a name that will be stored as text. */
function decode(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function text(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every (image, name, term) on a page.
 *
 * Each roster entry is an `<img>` followed by an `<h3>` before the next
 * `<img>`, so the page is split on images and each slice searched for the
 * heading that belongs to it. Crude, and right for this markup: the wrapper
 * `<div>`s are not nested consistently enough to walk, and the one thing that
 * never varies is that the face comes before the name.
 */
function pairs(html: string): { image: string; name: string; term: string | null }[] {
  const out: { image: string; name: string; term: string | null }[] = [];

  for (const match of html.matchAll(
    /<img[^>]*\bsrc=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<img[^>]*\bsrc=["']|$)/gi,
  )) {
    const image = (match[1] ?? "").trim();
    const rest = match[2] ?? "";
    if (NOT_A_PERSON.test(image)) continue;

    /**
     * The first heading after the face that actually says something.
     *
     * Any level, and not the first heading found. The roster puts the name in
     * an `<h3>`; the three office-bearers' pages put it in an `<h2>` and
     * follow the photograph with an `<h3>` containing nothing but `&nbsp;`,
     * used as a spacer. Matching `<h3>` alone found that spacer, read an empty
     * name and silently dropped all three of the current office-bearers — the
     * failure looked exactly like "those pages have no photographs".
     */
    let name = "";
    for (const found of rest.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
      const candidate = text(found[2] ?? "");
      if (candidate !== "" && candidate.length <= 90) {
        name = candidate;
        break;
      }
    }
    if (name === "") continue;

    const year = /Year\s*([0-9]{4}(?:\s*[-–]\s*[0-9]{2,4})?)/i.exec(rest);
    out.push({ image, name, term: year ? `Year ${year[1]?.replace(/\s+/g, "")}` : null });
  }

  return out;
}

async function main(): Promise<number> {
  const outDir = arg("out", join("public", "people"));
  const manifestPath = arg("manifest", join("legacy-import", "portraits.json"));
  const delay = Number(arg("delay", "700"));

  mkdirSync(outDir, { recursive: true });

  const portraits: Portrait[] = [];
  /** Keyed by slug, so the same face under two years is stored once. */
  const seen = new Map<string, Portrait>();
  const skipped: string[] = [];

  for (const source of SOURCES) {
    const url = `${ORIGIN}${source.path}`;
    process.stdout.write(`${url}\n`);
    const html = await fetchText(url);
    await sleep(delay);

    const found = pairs(html);
    for (const entry of found) {
      const slug = slugify(entry.name);
      if (slug === "") {
        skipped.push(`${entry.name} (no usable slug)`);
        continue;
      }

      const existing = seen.get(slug);
      if (existing) {
        // The roster lists Tariq Sayeed Saigol twice, for two consecutive
        // years, with the same photograph. One portrait, and the page's own
        // prose still prints both years.
        if (!existing.role && source.role) existing.role = source.role;
        continue;
      }

      const imageUrl = entry.image.startsWith("http")
        ? entry.image
        : `${ORIGIN}/${entry.image.replace(/^\//, "")}`;

      /**
       * Already downloaded, so leave the chamber's server alone.
       *
       * The same politeness the press crawler has, and for the same reason:
       * this gets re-run whenever the pairing is corrected, and re-fetching
       * sixty photographs to fix one regex is load on somebody else's host for
       * nothing. Dimensions come back off the file, so the manifest it writes
       * is the same either way. Delete `public/people/` to force a re-fetch.
       */
      const outFile = join(outDir, `${slug}.jpg`);
      if (existsSync(outFile)) {
        const meta = await sharp(outFile).metadata();
        const portrait: Portrait = {
          name: entry.name,
          term: entry.term,
          role: source.role,
          source: url,
          sourceImage: imageUrl,
          src: `/${outDir.replace(/\\/g, "/").replace(/^public\//, "")}/${slug}.jpg`,
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          bytesBefore: 0,
          bytesAfter: statSync(outFile).size,
        };
        seen.set(slug, portrait);
        portraits.push(portrait);
        process.stdout.write(`  ${slug.padEnd(32)} on disk\n`);
        continue;
      }

      let before: Buffer;
      try {
        before = await fetchBytes(imageUrl);
      } catch (error) {
        skipped.push(`${entry.name}: ${error instanceof Error ? error.message : error}`);
        continue;
      }
      await sleep(delay);

      /**
       * `failOn: "none"` because some of these files are truncated.
       *
       * At least one portrait on the old site ends mid-scan — "Corrupt JPEG
       * data: premature end of data segment" — and sharp's default is to
       * refuse anything that raises a warning. Refusing is right for a file an
       * applicant uploaded; here the alternative to a slightly short image is
       * no photograph of that person at all, and the damage is visible in the
       * output rather than silent. It relaxes libvips' tolerance for malformed
       * data, nothing else: the bytes are still decoded and re-encoded, never
       * executed, and a file that is not an image at all still throws below.
       */
      let data: Buffer;
      let info: OutputInfo;
      try {
        ({ data, info } = await sharp(before, { failOn: "none" })
          .rotate()
          .resize({
            width: MAX_WIDTH,
            height: MAX_HEIGHT,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
          .toBuffer({ resolveWithObject: true }));
      } catch (error) {
        // One unreadable file must not cost the other sixty. It is recorded in
        // the manifest, so "we have no picture of this person" is a line
        // somebody can read rather than a gap nobody notices.
        skipped.push(
          `${entry.name}: ${imageUrl} did not decode — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const file = `${slug}.jpg`;
      writeFileSync(join(outDir, file), data);

      const portrait: Portrait = {
        name: entry.name,
        term: entry.term,
        role: source.role,
        source: url,
        sourceImage: imageUrl,
        src: `/${outDir.replace(/\\/g, "/").replace(/^public\//, "")}/${file}`,
        width: info.width,
        height: info.height,
        bytesBefore: before.byteLength,
        bytesAfter: data.byteLength,
      };

      seen.set(slug, portrait);
      portraits.push(portrait);
      process.stdout.write(
        `  ${slug.padEnd(32)} ${info.width}x${info.height}  ` +
          `${(before.byteLength / 1024).toFixed(0)}KB -> ${(data.byteLength / 1024).toFixed(0)}KB\n`,
      );
    }
  }

  portraits.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        note:
          "Portraits lifted from lcci.com.pk. The pairing of face to name is " +
          "the old site's own, read out of the raw HTML; see " +
          "scripts/import-portraits.ts. Regenerate rather than edit.",
        sources: SOURCES.map((s) => `${ORIGIN}${s.path}`),
        portraits,
        skipped,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const before = portraits.reduce((n, p) => n + p.bytesBefore, 0);
  const after = portraits.reduce((n, p) => n + p.bytesAfter, 0);
  process.stdout.write(
    `\n${portraits.length} portraits, ${(before / 1024 / 1024).toFixed(1)}MB -> ` +
      `${(after / 1024 / 1024).toFixed(1)}MB\n`,
  );
  for (const note of skipped) process.stdout.write(`  skipped ${note}\n`);

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
