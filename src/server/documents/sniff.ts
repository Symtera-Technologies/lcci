/**
 * What a file actually is, read from its bytes.
 *
 * The filename, its extension and the browser's `Content-Type` are all
 * attacker-supplied labels. They are recorded as *claims* and they decide
 * nothing. Only this module decides what a stored document is, and what it
 * decides is what the serve route later puts in `Content-Type`.
 *
 * Four formats, and the list is short on purpose. Every additional format is
 * another parser's attack surface in a process that also holds the database
 * credentials. **No SVG** — it is an XML document that executes script, and no
 * amount of `Content-Disposition` makes accepting one into a document store a
 * good idea. **No HEIC**, despite every iPhone producing it, because serving it
 * usefully would need conversion, conversion means `sharp`, and `sharp` on a
 * 300 dpi A4 scan allocates around 215 MB in the decoder and takes the whole
 * site down with it — triggered by an applicant, from a public form.
 *
 * No dependency: the whole thing is about a hundred lines of byte comparisons,
 * and the alternative (`file-type`, a transitive dependency tree) would be a
 * supply-chain surface for something a `switch` statement does.
 *
 * Dimensions come from the header only, never from a pixel decode, for the
 * same memory reason. They matter because the form asks for a 35 × 45 mm
 * studio photograph and checklist item 9 is an officer confirming it — a
 * 60 × 80 pixel thumbnail renamed to `photo.jpg` should be refused at upload
 * rather than discovered during verification.
 */

export type DocumentFormat = "pdf" | "jpeg" | "png" | "webp";

export interface SniffResult {
  format: DocumentFormat;
  /** The media type the serve route is allowed to send for this format. */
  mimeType: string;
  /** Pixel dimensions, where the header gives them cheaply. Null for PDF. */
  width: number | null;
  height: number | null;
}

/**
 * The only media types this application will ever emit for a document.
 *
 * A hardcoded map keyed on the *sniffed* format, so the value in a response
 * header can never have come from the request. That is the property that makes
 * `Content-Type` trustworthy.
 */
export const MIME_BY_FORMAT: Record<DocumentFormat, string> = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/** Media types a client may claim, mapped to the format they must sniff as. */
export const ACCEPTED_DECLARED_TYPES: Record<string, DocumentFormat> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Extension for the stored filename, taken from the sniff, never the upload. */
export const EXTENSION_BY_FORMAT: Record<DocumentFormat, string> = {
  pdf: "pdf",
  jpeg: "jpg",
  png: "png",
  webp: "webp",
};

/**
 * Bytes needed to decide. A JPEG's dimensions can sit well past the start
 * because of EXIF thumbnails and colour profiles, so the window is generous;
 * everything else decides in the first thirty.
 */
export const SNIFF_BYTES = 64 * 1024;

/**
 * Identify a file from its leading bytes, or return null.
 *
 * Null means "not one of the four", which the caller turns into a rejection.
 * It never guesses: a file that is nearly a PNG is not a PNG.
 */
export function sniff(head: Buffer): SniffResult | null {
  if (isPdf(head)) {
    return { format: "pdf", mimeType: MIME_BY_FORMAT.pdf, width: null, height: null };
  }

  if (isPng(head)) {
    const size = pngSize(head);
    return { format: "png", mimeType: MIME_BY_FORMAT.png, ...size };
  }

  if (isJpeg(head)) {
    const size = jpegSize(head);
    return { format: "jpeg", mimeType: MIME_BY_FORMAT.jpeg, ...size };
  }

  if (isWebp(head)) {
    const size = webpSize(head);
    return { format: "webp", mimeType: MIME_BY_FORMAT.webp, ...size };
  }

  return null;
}

/**
 * Does the sniffed format match what the client said it was uploading?
 *
 * A mismatch is a rejection *and* an audit event. Most of the time it is
 * somebody who renamed a file, but it is also exactly what a deliberate
 * attempt looks like, and the two are indistinguishable from here — so the
 * applicant gets a neutral message and the security log gets the detail.
 */
export function declaredTypeAgrees(
  declared: string | null,
  sniffed: DocumentFormat,
): boolean {
  if (!declared) return false;
  const normalised = declared.split(";")[0].trim().toLowerCase();
  return ACCEPTED_DECLARED_TYPES[normalised] === sniffed;
}

/* -------------------------------------------------------------------------- */
/* Magic bytes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `%PDF-` at offset zero.
 *
 * The specification permits leading junk and many readers tolerate it, which
 * is precisely why this does not: a file that is a PDF only after 300 bytes of
 * something else is a polyglot, and a polyglot's whole purpose is to be read
 * as one thing by the validator and another by the viewer.
 */
function isPdf(head: Buffer): boolean {
  return head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-";
}

function isPng(head: Buffer): boolean {
  return (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  );
}

function isJpeg(head: Buffer): boolean {
  return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

function isWebp(head: Buffer): boolean {
  return (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

/* -------------------------------------------------------------------------- */
/* Dimensions, from headers only                                             */
/* -------------------------------------------------------------------------- */

interface Size {
  width: number | null;
  height: number | null;
}

const NO_SIZE: Size = { width: null, height: null };

/** PNG puts IHDR first, always, so width and height are at fixed offsets. */
function pngSize(head: Buffer): Size {
  if (head.length < 24) return NO_SIZE;
  if (head.subarray(12, 16).toString("latin1") !== "IHDR") return NO_SIZE;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/**
 * Walk JPEG segments to the first frame header.
 *
 * Bounded three ways, because this is a loop over attacker-controlled lengths:
 * it never reads past the buffer, it rejects a segment length below the two
 * bytes the length field itself occupies (which would otherwise not advance
 * and spin forever), and it gives up after a fixed number of segments.
 */
function jpegSize(head: Buffer): Size {
  let offset = 2;
  let segments = 0;

  while (offset + 4 <= head.length && segments < 128) {
    if (head[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = head[offset + 1];

    // Padding, and the standalone markers that carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }

    const length = head.readUInt16BE(offset + 2);
    if (length < 2) return NO_SIZE;

    // SOF0, SOF1, SOF2 and the rest of the frame headers, excluding DHT
    // (0xc4), JPG (0xc8) and DAC (0xcc), which share the range.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

    if (isFrameHeader) {
      if (offset + 9 > head.length) return NO_SIZE;
      return {
        height: head.readUInt16BE(offset + 5),
        width: head.readUInt16BE(offset + 7),
      };
    }

    // Start of scan: the entropy-coded data begins and there are no more
    // headers worth walking.
    if (marker === 0xda) return NO_SIZE;

    offset += 2 + length;
    segments += 1;
  }

  return NO_SIZE;
}

/** Three WebP variants, each storing its size differently. */
function webpSize(head: Buffer): Size {
  if (head.length < 30) return NO_SIZE;

  const chunk = head.subarray(12, 16).toString("latin1");

  // Lossy: VP8 bitstream, 14-bit dimensions after the 3-byte frame tag and
  // the 3-byte start code.
  if (chunk === "VP8 ") {
    if (head.length < 30) return NO_SIZE;
    return {
      width: head.readUInt16LE(26) & 0x3fff,
      height: head.readUInt16LE(28) & 0x3fff,
    };
  }

  // Lossless: 14-bit dimensions minus one, packed across four bytes.
  if (chunk === "VP8L") {
    const bits = head.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  // Extended: canvas size as 24-bit values minus one.
  if (chunk === "VP8X") {
    return {
      width: (head.readUIntLE(24, 3) & 0xffffff) + 1,
      height: (head.readUIntLE(27, 3) & 0xffffff) + 1,
    };
  }

  return NO_SIZE;
}
