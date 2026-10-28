/**
 * One-time asset preparation for the photographs pulled from lcci.com.pk.
 *
 * The source JPEGs carry a decorative dark-green double border baked into the
 * pixels. Masking it in CSS would still ship the pixels and would break the
 * moment a crop changed, so it is detected and removed here instead.
 *
 * Run: node scripts/prepare-photos.mjs
 * Input:  assets/photos-src/agm-*.jpg  (originals, as downloaded — not served)
 * Output: public/photos/hero-*.jpg     (cropped, resized, re-encoded)
 *
 * The originals live outside public/ on purpose: they are 2.2MB that no visitor
 * should ever download, and shared cPanel has no CDN in front of it by default.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const SRC_DIR = path.join(process.cwd(), "assets", "photos-src");
const OUT_DIR = path.join(process.cwd(), "public", "photos");

/** True when a pixel looks like the green frame: green-dominant and dark. */
function isFrame(r, g, b) {
  return g > r && g > b && r + g + b < 330;
}

/**
 * Walks in from each edge until a line is no longer mostly frame-coloured.
 * Returns the content box.
 */
function contentBox(data, width, height, channels) {
  const at = (x, y) => {
    const i = (y * width + x) * channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  const rowIsFrame = (y) => {
    let n = 0;
    for (let x = 0; x < width; x += 4) if (isFrame(...at(x, y))) n++;
    return n / Math.ceil(width / 4) > 0.6;
  };

  const colIsFrame = (x) => {
    let n = 0;
    for (let y = 0; y < height; y += 4) if (isFrame(...at(x, y))) n++;
    return n / Math.ceil(height / 4) > 0.6;
  };

  let top = 0;
  while (top < height / 4 && rowIsFrame(top)) top++;
  let bottom = height - 1;
  while (bottom > (height * 3) / 4 && rowIsFrame(bottom)) bottom--;
  let left = 0;
  while (left < width / 4 && colIsFrame(left)) left++;
  let right = width - 1;
  while (right > (width * 3) / 4 && colIsFrame(right)) right--;

  // Safety margin against the border's anti-aliased edge, which otherwise
  // leaves a green hairline on some of the source images.
  const pad = 5;
  return {
    left: left + pad,
    top: top + pad,
    width: right - left - pad * 2,
    height: bottom - top - pad * 2,
  };
}

const files = (await readdir(SRC_DIR))
  .filter((f) => /^agm-\d+\.jpg$/.test(f))
  .sort();

for (const file of files) {
  const src = path.join(SRC_DIR, file);
  const { data, info } = await sharp(src)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const box = contentBox(data, info.width, info.height, info.channels);
  const out = path.join(OUT_DIR, file.replace(/^agm-/, "hero-"));

  await sharp(src)
    .extract(box)
    .resize({ width: 1100, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(out);

  console.log(
    `${file}  ${info.width}x${info.height}  ->  ${path.basename(out)}  ` +
      `crop ${box.width}x${box.height} @ ${box.left},${box.top}`,
  );
}
