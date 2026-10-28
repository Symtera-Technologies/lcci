/**
 * Size and shape limits for uploaded documents.
 *
 * Separated out because three different places need to agree about them: the
 * upload route enforces them, the wizard's client-side picker pre-checks them
 * so the applicant is told before a slow upload rather than after, and the
 * message catalogue formats them into the error text.
 */

/**
 * 8 MB per file.
 *
 * Generous on purpose. A 300 dpi A4 scan of a CNIC — which is exactly what
 * checklist item 3 asks for, "clear readable CNIC" — is commonly 3 to 6 MB
 * from a flatbed scanner producing JPEG, and a multi-page SECP filing scanned
 * to PDF is larger still. A tighter cap does not make applicants compress
 * their files; it makes them give up and walk a photocopy to the counter,
 * which is the process this is replacing.
 *
 * **Measure the host's real `SecRequestBodyLimit` before trusting this.**
 * ModSecurity belongs to the host and is not tunable from cPanel, and if its
 * limit lands below 8 MB the answer is to chunk the upload at 1 MB rather than
 * to lower this cap — the scan genuinely needs the headroom.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * 24 MB and 20 files per application.
 *
 * The aggregate matters more than the per-file limit, because the per-file
 * limit alone bounds nothing: a Company application legitimately needs a
 * letterhead, every director's CNIC, the company NTN, MoA and AoA, the
 * incorporation certificate, Form 9, a utility bill, a bank certificate and
 * two photographs. Twenty files is comfortably above that and well below what
 * would let one applicant consume the account's disk quota.
 *
 * Enforced inside the same transaction as the insert, with
 * `SELECT SUM(byte_size) ... FOR UPDATE`. Checking it before the insert in a
 * separate statement would let parallel uploads — which the wizard produces by
 * design, one request per file on selection — each see a total under the cap
 * and all succeed.
 */
export const MAX_APPLICATION_BYTES = 24 * 1024 * 1024;
export const MAX_APPLICATION_FILES = 20;

/**
 * The smallest image that can be a real document.
 *
 * The form asks for a 35 × 45 mm studio photograph with a white background,
 * and checklist item 9 is an officer confirming exactly that. At 300 dpi that
 * is roughly 413 × 531 pixels, so 300 on the short edge rejects the thumbnail
 * and the phone screenshot while accepting anything genuinely scanned. The
 * point is to refuse it at upload rather than discover it at verification,
 * three weeks into a paid 15-working-day promise.
 */
export const MIN_IMAGE_EDGE = 300;

/**
 * The largest image dimensions worth accepting.
 *
 * Not a memory guard — nothing here decodes pixels — but a 20,000 pixel wide
 * scan is a scanner misconfiguration, and the officer reviewing it on a laptop
 * will have a worse time than the applicant who re-scans it.
 */
export const MAX_IMAGE_EDGE = 20_000;

/** A PDF longer than this is not a document in this process. */
export const MAX_PDF_PAGES = 60;

/** Human-readable size, for the message catalogue's `{size}` and `{max}`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
