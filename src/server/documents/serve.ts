import "server-only";

import { getDb } from "@/db/client";
import type { ActorContext } from "@/server/actor";
import { unpackSealed, unwrapDataKey } from "@/server/crypto";
import { logError } from "@/server/log";
import {
  decryptRange,
  parseHeader,
  plaintextLength,
  HEADER_BYTES,
  type CipherHeader,
} from "@/server/documents/cipher";
import { getDocumentStore } from "@/server/documents/store";
import { MIME_BY_FORMAT } from "@/server/documents/sniff";

/**
 * Authorising and reading a stored document.
 *
 * Separate from the route so the authorisation decision is testable and so
 * there is exactly one of it. The route cannot bypass this, which is the
 * point: a second read path that "just needs the bytes" is how a document
 * endpoint loses its access control.
 */

export interface DocumentForServing {
  id: string;
  mimeType: string;
  byteSize: number;
  plaintextBytes: number;
  storageKey: string;
  documentTypeCode: string;
  header: CipherHeader;
  dataKey: Buffer;
}

export type AuthorizeOutcome =
  | { ok: true; document: DocumentForServing }
  /**
   * One failure value for both "forbidden" and "does not exist", because the
   * route must answer 404 to both. Returning 403 for a real document and 404
   * for an absent one turns the endpoint into an existence oracle: a UUID
   * space is not guessable, but a leaked or logged id would otherwise be
   * confirmable, and confirming that a document exists for an application is
   * itself disclosure.
   */
  | { ok: false; reason: "not-found" | "forbidden" };

/**
 * May this actor read this document?
 *
 * The rules, in the order they are cheapest to evaluate:
 *
 * **Staff with the permission.** `documents.read` for the general case, and
 * `documents.read_financial` for `subject_kind = 'payment'` — the cashier must
 * compare the pay order against the bank account-maintenance certificate,
 * because that comparison *is* the anti-fraud control, but a cashier has no
 * business in a director's CNIC.
 *
 * **The uploader.** An applicant can always read back what they uploaded.
 *
 * Everything else is denied, including by default. Two branches are
 * deliberately absent until the tables they need exist: a co-director of the
 * applicant company reading a document a colleague uploaded (Track A2, via
 * `company_users`), and a proposer holding a live endorsement token reading
 * the *endorsement-visible subset* — a proposer endorses a company, not an
 * identity file, and must never see every director's CNIC. Adding them here
 * before those tables exist would mean writing a check nothing can test.
 */
export async function authorizeDocument(
  actor: ActorContext,
  documentId: string,
): Promise<AuthorizeOutcome> {
  if (!isUuid(documentId)) return { ok: false, reason: "not-found" };

  const row = await getDb()
    .selectFrom("documents")
    .select([
      "id",
      "mime_type",
      "byte_size",
      "storage_key",
      "document_type_code",
      "subject_kind",
      "encrypted_data_key",
      "uploaded_by",
      "deleted_at",
    ])
    .where("id", "=", documentId)
    .executeTakeFirst();

  // A soft-deleted document is gone as far as serving is concerned. The row
  // survives so the audit trail and the document manifest still resolve.
  if (!row || row.deleted_at !== null) return { ok: false, reason: "not-found" };

  const permitted = isPermitted(actor, row.subject_kind, row.uploaded_by);
  if (!permitted) return { ok: false, reason: "forbidden" };

  // Only the registered media types are ever emitted, keyed on the format
  // sniffed at upload. A `Content-Type` that could come from the stored row
  // unchecked would let a row edited in phpMyAdmin choose a response header.
  const mimeType = Object.values(MIME_BY_FORMAT).includes(row.mime_type)
    ? row.mime_type
    : "application/octet-stream";

  const store = getDocumentStore();

  try {
    if (!row.encrypted_data_key) {
      throw new Error("Document row has no wrapped data key");
    }

    const dataKey = unwrapDataKey(
      unpackSealed(row.encrypted_data_key),
      `documents.data_key:${row.id}`,
    );

    const header = parseHeader(await store.readAt(row.storage_key, 0, HEADER_BYTES));

    // The stored size is read from the store rather than trusted from the row:
    // the geometry depends on it, and a row and a file that disagree must
    // resolve in favour of the file.
    const info = await store.stat(row.storage_key);
    if (!info) return { ok: false, reason: "not-found" };

    return {
      ok: true,
      document: {
        id: row.id,
        mimeType,
        byteSize: info.bytes,
        plaintextBytes: plaintextLength(info.bytes, header.chunkSize),
        storageKey: row.storage_key,
        documentTypeCode: row.document_type_code,
        header,
        dataKey,
      },
    };
  } catch (error) {
    // A missing file, an unwrappable key or a corrupt header. Logged, because
    // every one of these means something is wrong with the store rather than
    // with the request, and answered as 404 so the caller learns nothing about
    // which.
    logError("document could not be opened", error, { documentId: row.id });
    return { ok: false, reason: "not-found" };
  }
}

function isPermitted(
  actor: ActorContext,
  subjectKind: string,
  uploadedBy: number | null,
): boolean {
  if (actor.userType === "staff") {
    if (subjectKind === "payment") {
      return (
        actor.permissions.has("documents.read_financial") ||
        actor.permissions.has("documents.read")
      );
    }
    return actor.permissions.has("documents.read");
  }

  return uploadedBy !== null && uploadedBy === actor.userId;
}

/* -------------------------------------------------------------------------- */
/* Ranges                                                                     */
/* -------------------------------------------------------------------------- */

export type RangeOutcome =
  | { kind: "full"; start: number; end: number }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" }
  /** Multiple ranges, or a syntax we do not implement: serve the whole thing. */
  | { kind: "ignored"; start: number; end: number };

/**
 * Parse a `Range` header against a known length.
 *
 * Single ranges only. Multipart ranges are legal and nothing that matters here
 * sends them — pdf.js and the native PDF viewers request one range at a time —
 * and `multipart/byteranges` would be a second response encoding to get right
 * for no gain. An unsupported form is answered with the whole document, which
 * every client handles, rather than with an error.
 *
 * Ranges are the reason the cipher is chunked at all. Without `Accept-Ranges`,
 * rendering page one of a 40-page SECP filing means transferring the whole
 * file, and on a Pakistani mobile connection that is the difference between a
 * usable review queue and an unusable one.
 */
export function parseRange(header: string | null, totalBytes: number): RangeOutcome {
  const whole = { start: 0, end: Math.max(0, totalBytes - 1) };

  if (!header) return { kind: "full", ...whole };
  if (totalBytes === 0) return { kind: "full", ...whole };

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "ignored", ...whole };

  const [, rawStart, rawEnd] = match;

  // `bytes=-500` means the last 500 bytes, which is how a PDF viewer fetches
  // the cross-reference table at the end of the file — the first thing it
  // needs, before any page.
  if (rawStart === "") {
    if (rawEnd === "") return { kind: "ignored", ...whole };
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, totalBytes - suffix);
    return { kind: "partial", start, end: totalBytes - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0) return { kind: "unsatisfiable" };
  if (start >= totalBytes) return { kind: "unsatisfiable" };

  if (rawEnd === "") return { kind: "partial", start, end: totalBytes - 1 };

  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return { kind: "unsatisfiable" };

  return { kind: "partial", start, end: Math.min(end, totalBytes - 1) };
}

/**
 * Read and decrypt a byte range.
 *
 * Reads only the chunks the range overlaps, so a 1 KB range out of a 6 MB scan
 * costs one 64 KB chunk.
 */
export async function readDocumentRange(
  document: DocumentForServing,
  start: number,
  end: number,
): Promise<Buffer> {
  const store = getDocumentStore();
  return decryptRange(
    document.dataKey,
    document.header,
    document.id,
    document.byteSize,
    start,
    end,
    (offset, length) => store.readAt(document.storageKey, offset, length),
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
