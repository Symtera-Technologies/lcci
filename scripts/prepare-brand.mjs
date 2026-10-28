/**
 * Derives a reversed (white) LCCI logo from the official artwork.
 *
 * The supplied logo is dark green line art. The wordmark sits on transparency,
 * but the crest sits on an opaque white rectangle — so masking by the alpha
 * channel fills the crest as a solid white block. The mask is therefore built
 * from luminance instead: dark ink becomes opaque white, the white ground
 * becomes transparent, and the ramp between keeps the anti-aliased edges.
 *
 * A CSS `invert()` filter was the other option and is worse: it would turn the
 * green crest magenta rather than white.
 *
 * Run: node scripts/prepare-brand.mjs
 */

import path from "node:path";
import sharp from "sharp";

const DIR = path.join(process.cwd(), "public", "brand");
const SRC = path.join(DIR, "lcci-logo.png");
const OUT = path.join(DIR, "lcci-logo-reversed.png");

/** Luminance at or below this is treated as fully-inked. */
const INK = 185;

const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const { width, height, channels } = info;
const mask = Buffer.alloc(width * height);

for (let p = 0; p < width * height; p++) {
  const i = p * channels;
  const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const origAlpha = data[i + 3] / 255;

  // 1 where the artwork is inked, 0 on the white ground, ramped between.
  const inked = lum <= INK ? 1 : Math.max(0, (255 - lum) / (255 - INK));

  mask[p] = Math.round(255 * inked * origAlpha);
}

await sharp({
  create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
})
  .joinChannel(mask, { raw: { width, height, channels: 1 } })
  .png()
  .toFile(OUT);

console.log(`${path.basename(SRC)} ${width}x${height} -> ${path.basename(OUT)}`);

/* -------------------------------------------------------------------------- */
/* App icon                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The crest alone becomes the browser-tab icon — the full lockup is 3.6:1 and
 * would be illegible at 32px. Next.js picks up src/app/icon.png automatically.
 */
const ICON = path.join(process.cwd(), "src", "app", "icon.png");

/**
 * Finds the gutter between the crest and the wordmark by looking for the first
 * run of blank columns. Measured rather than hardcoded so replacing the logo
 * file does not silently slice the artwork.
 */
function crestWidth() {
  const coverage = [];
  for (let x = 0; x < width; x++) {
    let n = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * channels;
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (data[i + 3] > 40 && lum < INK) n++;
    }
    coverage.push(n);
  }

  const GUTTER = 6;
  for (let x = Math.floor(width * 0.1); x < width - GUTTER; x++) {
    if (coverage.slice(x, x + GUTTER).every((v) => v === 0)) return x;
  }
  return height; // fall back to a square crop
}

const crest = await sharp(SRC)
  .extract({ left: 0, top: 0, width: crestWidth(), height })
  .resize(160, 160, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
  .toBuffer();

await sharp({
  create: { width: 180, height: 180, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
})
  .composite([{ input: crest, top: 10, left: 10 }])
  .png()
  .toFile(ICON);

console.log(`${path.basename(SRC)} crest -> src/app/icon.png`);
