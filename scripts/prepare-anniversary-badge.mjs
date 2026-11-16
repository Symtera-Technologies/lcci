/**
 * Derives the footer's anniversary seal from the supplied artwork.
 *
 * The seal is dated art: it reads "103 YEARS" and "1923 — 2026", so it is
 * correct for one year and then wrong. It is deliberately a file rather than
 * something drawn from `yearsSinceFounding()` — the laurel, the ring and the
 * typesetting are a designed mark, not a number in a box — which means
 * **somebody has to replace it each year**, and this script is how.
 *
 * Why it is not simply copied in: the supplied PNG is 1254x1254 and 1.4 MB,
 * and the seal renders at 72 CSS pixels in the footer of every page on the
 * site. Shipping the original would put a megabyte and a half on every
 * request for a mark the size of a postage stamp, which is the kind of thing
 * the Lighthouse target in spec §9 is lost to.
 *
 * 256px square, so it stays sharp on a 3x phone screen at 72px and on a
 * desktop at 88px.
 *
 *   node scripts/prepare-anniversary-badge.mjs <source.png>
 */

import path from "node:path";
import sharp from "sharp";

const SIZE = 256;
const OUT = path.join(process.cwd(), "public", "brand", "anniversary-103.png");

const src = process.argv[2];
if (!src) {
  console.error("usage: node scripts/prepare-anniversary-badge.mjs <source.png>");
  process.exit(1);
}

const meta = await sharp(src).metadata();
console.log(`source   ${meta.width}x${meta.height} ${meta.format}`);

await sharp(src)
  .resize(SIZE, SIZE, {
    fit: "contain",
    // The seal is a circle on transparency and sits on the ink-950 footer
    // panel. A white or black matte here would show as a square behind it.
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  // Palette, which is worth checking rather than assuming when the artwork
  // changes: the current seal is gold on ink, and a metallic gradient is the
  // one thing an indexed PNG can band. At 256px it does not — 34 KB against
  // 99 KB truecolour, and the two are indistinguishable at the 72px this is
  // rendered at. Look at the output if the art is ever redrawn.
  .png({ compressionLevel: 9, palette: true })
  .toFile(OUT);

const after = await sharp(OUT).metadata();
console.log(`written  ${after.width}x${after.height}  ${OUT}`);
