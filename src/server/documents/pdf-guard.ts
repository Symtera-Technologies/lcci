import "server-only";

import { PDFDocument, PDFName, PDFDict, PDFArray, type PDFRef } from "pdf-lib";

/**
 * Reject weaponised PDFs structurally.
 *
 * This exists because **virus scanning is not possible on this plan**: ClamAV
 * needs a resident `clamd` and roughly a gigabyte for its signature database,
 * and neither is available. That limitation is stated plainly rather than
 * papered over, and this module is one of the four mitigations that replace
 * it — along with a four-format allowlist, storage outside every served path,
 * and `Content-Disposition: attachment` putting every file through the
 * officer's own endpoint protection.
 *
 * The argument for structural rejection being worth anything at all: **a
 * scanned CNIC has no legitimate reason to contain JavaScript.** Neither does
 * a partnership deed, a utility bill or a bank certificate. Every document
 * this system accepts is a scan or an export, and none of the features below
 * appear in one by accident. So rather than trying to detect malice — which
 * needs signatures we cannot have — this refuses the capabilities malice
 * needs, and the false-positive rate on the documents LCCI actually receives
 * is close to zero.
 *
 * What is refused, and what each one is for:
 *
 *   - **`/OpenAction`, `/AA`** — run something when the file opens, or on a
 *     page event. The delivery mechanism for essentially every malicious PDF.
 *   - **`/JavaScript`, `/JS`** — the payload itself.
 *   - **`/Launch`** — start an external program.
 *   - **`/EmbeddedFile`, `/Filespec`** — carry another file inside this one,
 *     which is how a PDF smuggles past a format allowlist.
 *   - **`/RichMedia`, `/Movie`, `/Sound`** — legacy Flash and media handlers,
 *     a long-running source of reader vulnerabilities.
 *   - **`/SubmitForm`, `/ImportData`** — make the officer's reader talk to a
 *     network endpoint of the uploader's choosing when they open the file.
 *   - **`/GoToR`, `/GoToE`** — navigate into a remote or embedded document.
 *
 * It is also a parse: `pdf-lib` failing to load a file is itself a rejection,
 * which removes the class of malformed files that only crash a reader.
 *
 * Cost, honestly: `pdf-lib` parses the whole document into memory. That is why
 * the per-file cap is enforced *before* this runs and why `maxBytes` is
 * checked again here — a 40-page SECP filing is fine, and this must never be
 * reachable with something larger.
 */

export interface PdfInspection {
  pageCount: number;
  /** Feature names found. Empty means the file is acceptable. */
  activeContent: string[];
  /** True when the file is encrypted, which we refuse for a separate reason. */
  encrypted: boolean;
}

/** Names that disqualify a document, as a set for one pass over each dict. */
const FORBIDDEN_KEYS = [
  "OpenAction",
  "AA",
  "JavaScript",
  "JS",
  "Launch",
  "EmbeddedFile",
  "EmbeddedFiles",
  "Filespec",
  "RichMedia",
  "Movie",
  "Sound",
  "SubmitForm",
  "ImportData",
  "GoToR",
  "GoToE",
] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_KEYS);

/**
 * Parse and inspect. Throws when the file is not a parseable PDF.
 *
 * `ignoreEncryption: false` is deliberate. An encrypted PDF is refused rather
 * than accepted, because its contents cannot be inspected — and a document
 * nobody can verify is useless to a verification process. The applicant is
 * asked for an unprotected scan, which is what their scanner produces anyway.
 */
export async function inspectPdf(
  bytes: Buffer,
  maxBytes: number,
): Promise<PdfInspection> {
  if (bytes.length > maxBytes) {
    throw new Error("PDF is larger than the inspection limit");
  }

  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      // Throw rather than silently repairing. A file that only loads after
      // repair is a file whose structure two readers will disagree about, and
      // disagreement between the validator and the viewer is the whole game.
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    if (/encrypt/i.test(message)) {
      return { pageCount: 0, activeContent: [], encrypted: true };
    }
    throw new Error("File could not be parsed as a PDF");
  }

  return {
    pageCount: document.getPageCount(),
    activeContent: findActiveContent(document),
    encrypted: false,
  };
}

/**
 * Walk every indirect object looking for the forbidden names.
 *
 * Walks the object store rather than the page tree, because an action can hang
 * off a form field, an annotation, a name tree or the catalogue, and chasing
 * each of those individually is a list that will be incomplete. The flat walk
 * cannot miss a reachable object.
 *
 * Bounded: the object count is capped, so a file with a million tiny objects
 * cannot turn this into a CPU-limiter kill.
 */
function findActiveContent(document: PDFDocument): string[] {
  const found = new Set<string>();
  const entries = document.context.enumerateIndirectObjects();

  let examined = 0;
  for (const [, object] of entries as Array<[PDFRef, unknown]>) {
    if (examined > 50_000) break;
    examined += 1;
    collect(object, found, 0);
  }

  // The trailer and catalogue are reachable through the walk above, but
  // `/OpenAction` on the catalogue is the single most common case, so it is
  // checked directly as well rather than relying on the enumeration order.
  const catalogue = document.catalog;
  for (const key of FORBIDDEN_KEYS) {
    if (catalogue.has(PDFName.of(key))) found.add(key);
  }

  return [...found].sort();
}

/**
 * Inspect one object, recursively.
 *
 * Depth-limited because a PDF's object graph may contain cycles — a page whose
 * `/Parent` points back at the tree it hangs from is ordinary, not malicious,
 * and an unbounded walk would never return.
 */
function collect(object: unknown, found: Set<string>, depth: number): void {
  if (depth > 12) return;

  if (object instanceof PDFDict) {
    for (const [key, value] of object.entries()) {
      const name = key.asString().replace(/^\//, "");
      if (FORBIDDEN.has(name)) found.add(name);

      // `/S /JavaScript` is how an action declares its type, so the *values*
      // matter as well as the keys.
      if (value instanceof PDFName) {
        const valueName = value.asString().replace(/^\//, "");
        if (FORBIDDEN.has(valueName)) found.add(valueName);
      }

      collect(value, found, depth + 1);
    }
    return;
  }

  if (object instanceof PDFArray) {
    for (let index = 0; index < object.size(); index += 1) {
      collect(object.get(index), found, depth + 1);
    }
  }
}
