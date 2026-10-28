/**
 * Poster frames for the video section.
 *
 * The videos live on the chamber's own YouTube channel, but the posters are
 * served from here on purpose: the player is a facade, and the whole point of a
 * facade is that nothing is requested from Google until a visitor actually asks
 * to watch. Hotlinking i.ytimg.com would make that request on page load and
 * hand every visitor's IP to a third party for a video they never played.
 *
 * Orientation is declared per video rather than detected. YouTube pads a Short's
 * thumbnail out to 16:9 with a blurred copy of itself, so the file is landscape
 * even though the video is not — there is nothing in the pixels that reliably
 * says "this is a 9:16 video in a 16:9 box", and cover-cropping the padded frame
 * to 16:9 keeps the blurred bars and crops the subject's head off.
 *
 * Run: node scripts/prepare-video-posters.mjs <staging-dir>
 * Input:  <staging-dir>/poster-<videoId>.jpg   (as downloaded from i.ytimg.com)
 * Output: public/video/<videoId>.jpg
 */

import path from "node:path";
import sharp from "sharp";

/** videoId -> aspect, matching how the video itself was shot. */
const ORIENTATION = {
  XtwEvI2MKbs: "landscape",
  "6APbt99cBUk": "landscape",
  "4e9d47hJWjk": "portrait",
  VdiYxCuBwW0: "portrait",
  J3ug1aLXu_w: "portrait",
};

const SIZE = {
  landscape: { width: 960, height: 540 },
  portrait: { width: 480, height: 854 },
};

const SRC_DIR = process.argv[2];
if (!SRC_DIR) {
  console.error("usage: node scripts/prepare-video-posters.mjs <staging-dir>");
  process.exit(1);
}
const OUT_DIR = path.join(process.cwd(), "public", "video");

for (const [id, orientation] of Object.entries(ORIENTATION)) {
  const src = path.join(SRC_DIR, `poster-${id}.jpg`);
  const out = path.join(OUT_DIR, `${id}.jpg`);
  const image = sharp(src);
  const { width, height } = await image.metadata();

  // For a Short, the real frame is the centre column of the padded thumbnail:
  // everything either side is the blurred fill. Take that column first, then
  // resize, so the subject keeps its framing.
  let pipeline = image;
  if (orientation === "portrait") {
    const contentWidth = Math.round((height * 9) / 16);
    pipeline = pipeline.extract({
      left: Math.round((width - contentWidth) / 2),
      top: 0,
      width: contentWidth,
      height,
    });
  }

  await pipeline
    .resize({ ...SIZE[orientation], fit: "cover", position: "centre" })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(out);

  console.log(`poster-${id}.jpg  ${width}x${height} ${orientation}  ->  video/${id}.jpg`);
}
