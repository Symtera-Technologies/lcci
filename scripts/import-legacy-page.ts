/**
 * Lift the body of a page off the legacy site into the shape this CMS stores.
 *
 * The rebuild keeps lcci.com.pk's words. That is a content-migration job, and
 * the only safe way to do it is mechanically: a person retyping forty pages
 * will introduce changes, and a model paraphrasing them will introduce worse
 * ones. So this reads a saved copy of a legacy page, cuts out the one container
 * the old template puts its content in, and runs it through **the application's
 * own `sanitiseBody`** — the same function the admin's save handler calls.
 *
 * That last point is the design. The invariant `src/components/site/prose.tsx`
 * depends on is that every byte in a `body_*` column came out of
 * `sanitiseBody`; a bespoke converter here that produced *almost* the same
 * allowlist would quietly break it, and the failure would be an injection, not
 * a layout bug. Running the real sanitiser means an imported body is
 * indistinguishable from one an editor pasted in, by construction.
 *
 * ## What it reports, and why that matters more than what it writes
 *
 * The legacy markup carries things this schema deliberately cannot hold, and
 * silently dropping them is how a migration loses content without anybody
 * noticing. So every one is counted and printed:
 *
 *   * **Images.** `<img>` is not on the allowlist, because alt text is NOT
 *     NULL on `media_assets` and a body that can carry an image is how an
 *     undescribed photograph reaches the site. Every `src` is listed, so the
 *     photographs on a page — a president's portrait, a scanned notification —
 *     are visibly outstanding rather than gone.
 *   * **Links.** Every href is listed, because they point into the legacy URL
 *     space (`about.php?id=5`) and have to be repointed at the new routes.
 *     `href` survives sanitising, so an unrepointed link would ship.
 *   * **Documents.** A `.pdf` or `.doc` link is a file that still lives on the
 *     old host and has to be moved, not just relinked.
 *   * **Characters lost.** The text length before and after, so a container
 *     that was cut in the wrong place shows up as a number rather than as a
 *     missing paragraph somebody spots in six months.
 *
 * It writes JSON, not SQL, and on purpose: the output is reviewed against the
 * live page before a single row is seeded.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/import-legacy-page.ts \
 *     <saved-page.html> <out.json> [--url <source-url>]
 *
 * The input is an untrusted downloaded file. Nothing in it is executed; it is
 * read as text, sliced, sanitised and counted.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { bodyToText } from "@/content/sanitise";
import {
  allMatches,
  dropScriptsAndStyles,
  HREF,
  IMG_SRC,
  liftHeading,
  outsideContainer,
  sanitiseTwice,
  sliceContainer,
} from "./legacy-html";

function main(): void {
  const [input, output] = process.argv.slice(2);
  const urlFlag = process.argv.indexOf("--url");
  const sourceUrl = urlFlag === -1 ? null : (process.argv[urlFlag + 1] ?? null);

  if (!input || !output) {
    console.error(
      "usage: import-legacy-page.ts <saved-page.html> <out.json> [--url <source-url>]",
    );
    process.exit(2);
  }

  const raw = readFileSync(input, "utf8");
  const container = dropScriptsAndStyles(sliceContainer(raw));
  const { heading, rest } = liftHeading(container);

  const images = allMatches(rest, IMG_SRC);
  const links = allMatches(rest, HREF);
  const documents = links.filter((href) => /\.(pdf|docx?|xlsx?|pptx?|zip)(\?|$)/i.test(href));
  const reach = outsideContainer(raw, container);

  const body = sanitiseTwice(rest);

  // Compared as text, so the difference is content lost and not markup
  // removed — removing markup is the whole point and must not read as a
  // warning.
  const before = bodyToText(rest).length;
  const after = body ? bodyToText(body).length : 0;

  const result = {
    source: sourceUrl ?? input,
    heading,
    body,
    report: {
      textCharsBefore: before,
      textCharsAfter: after,
      textCharsLost: before - after,
      images,
      links: [...new Set(links)],
      documents: [...new Set(documents)],
      reach,
    },
  };

  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`${sourceUrl ?? input}`);
  console.log(`  heading   ${heading ?? "(none — the template printed no h2)"}`);
  console.log(`  text      ${after} chars kept, ${before - after} lost`);
  console.log(`  images    ${images.length}${images.length ? ` → ${images.join(", ")}` : ""}`);
  console.log(`  links     ${new Set(links).size}`);
  if (documents.length > 0) {
    console.log(`  documents ${documents.join(", ")}`);
  }

  // Read comparatively against a page known to be pure prose, not as a
  // threshold: the chrome's share is a constant and a fixed cut-off would
  // either fire on every page or on none.
  console.log(
    `  outside   ${reach.textCharsOutsideContainer} chars of text, ` +
      `${reach.imagesInPage - reach.imagesInContainer} images, ` +
      `${reach.emailsInPage - reach.emailsInContainer} emails`,
  );
  console.log(`  written   ${output}`);
}

main();
