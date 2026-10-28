/**
 * Filenames, in and out.
 *
 * Two separate problems, and conflating them is how both go wrong.
 *
 * **Inbound**, the original filename is *data*. It is recorded in a column so
 * an officer can see what the applicant called the file, and it never touches
 * the filesystem — the stored name is `{uuid}.{extension-from-the-sniff}`, so
 * path traversal, reserved Windows device names, overlong names, null bytes
 * and Unicode homoglyph tricks are all simply not in play. Sanitising a name
 * well enough to use as a path is a problem nobody here needs to solve.
 *
 * **Outbound**, the filename reaches a `Content-Disposition` header, and that
 * is where the real risk lives: a filename containing CRLF splits the response
 * and lets the uploader inject headers of their own. `42201-1234567-8.jpg` is
 * also, note, *itself the PII* — a CNIC in a header that proxies and logs will
 * record — which is the second reason the served name is derived rather than
 * echoed.
 */

/** The column is VARCHAR(255); longer than this is not a real filename. */
const MAX_STORED_LENGTH = 200;

/**
 * Clean an uploaded filename for storage as a display value.
 *
 * Not for use as a path. Strips control characters (including the CRLF that
 * matters), drops any directory component the browser included, collapses
 * whitespace, and truncates. Returns null when nothing usable survives, which
 * the caller renders as "unnamed file" rather than storing an empty string.
 */
export function cleanUploadedName(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const withoutPath = raw.split(/[/\\]/).pop() ?? "";

  const cleaned = withoutPath
    // C0 and C1 control characters, and the Unicode line separators. CR and LF
    // are the ones that matter, and the rest have no business in a name shown
    // in an admin table.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "")
    // Bidirectional overrides, which can make `cnic.jpg.exe` render as
    // `cnic.exe.jpg` in the officer's browser.
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned === "" || cleaned === "." || cleaned === "..") return null;

  return cleaned.slice(0, MAX_STORED_LENGTH);
}

/**
 * The filename a download is offered under.
 *
 * Built from the document's own identity rather than from what the applicant
 * called it, for the PII reason above: a document called
 * `42201-1234567-8-cnic.jpg` would put a CNIC into a response header, into
 * every proxy log between here and the officer, and into their Downloads
 * folder listing.
 *
 * ASCII, no spaces, no quotes, so it needs no escaping and cannot be
 * misparsed by an older client.
 */
export function downloadName(
  documentType: string,
  reference: string,
  extension: string,
): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);

  const parts = [slug(documentType), slug(reference)].filter((part) => part !== "");
  const base = parts.length > 0 ? parts.join("-") : "document";

  return `${base}.${slug(extension) || "bin"}`;
}

/**
 * A `Content-Disposition` header value.
 *
 * Always `attachment` by default, and that is not a formality — it is what
 * neutralises anything that slipped past validation. A file served as an
 * attachment is downloaded rather than rendered, so even a successful upload
 * of something hostile does not execute in the officer's session. The inline
 * viewer is a separate route with its own sandboxing CSP, and it is used only
 * for the formats that have one.
 *
 * Both parameter forms are emitted: the bare `filename` for clients that never
 * implemented RFC 5987, and `filename*` with the UTF-8 encoding for the ones
 * that did. The ASCII form is sanitised rather than trusted, because this
 * function must be safe even if a future caller passes it something it did not
 * build itself.
 */
export function contentDisposition(
  filename: string,
  disposition: "attachment" | "inline" = "attachment",
): string {
  const ascii = filename
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/["\\]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .slice(0, 120);

  const safeAscii = ascii.trim() === "" ? "document" : ascii;

  // encodeURIComponent leaves !'()* alone, and RFC 5987's attr-char set
  // excludes them, so they are percent-encoded by hand.
  const encoded = encodeURIComponent(filename).replace(
    /['()!*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${disposition}; filename="${safeAscii}"; filename*=UTF-8''${encoded}`;
}
