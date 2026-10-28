import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { retryOnDeadlock, sql } from "@/db/client";
import type { DocumentSubjectKind } from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { newDataKey, packSealed, wrapDataKey } from "@/server/crypto";
import { log } from "@/server/log";
import { tryWriteAudit } from "@/server/audit";
import {
  createEncryptor,
  createHeader,
  decryptRange,
  parseHeader,
  plaintextLength,
  HEADER_BYTES,
} from "@/server/documents/cipher";
import { getDocumentStore, keyFor } from "@/server/documents/store";
import { cleanUploadedName } from "@/server/documents/filename";
import {
  MAX_APPLICATION_BYTES,
  MAX_APPLICATION_FILES,
  MAX_FILE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_PDF_PAGES,
  MIN_IMAGE_EDGE,
  formatBytes,
} from "@/server/documents/limits";
import { inspectPdf } from "@/server/documents/pdf-guard";
import {
  EXTENSION_BY_FORMAT,
  SNIFF_BYTES,
  declaredTypeAgrees,
  sniff,
  type SniffResult,
} from "@/server/documents/sniff";
import { t, type MessageKey } from "@/server/i18n";

/**
 * Taking an uploaded document in.
 *
 * The order of operations here is the security design, so it is worth stating
 * before the code: **stream to quarantine, then decide, then publish.** The
 * bytes are written to a quarantine key under their own encryption while being
 * counted and hashed; only once the file has been sniffed, structurally
 * inspected and found to agree with what the client claimed does the row get
 * written. Nothing is ever validated *after* becoming a document.
 *
 * Two things this is not, and the reasons matter:
 *
 * **Not a server action.** `serverActions.bodySizeLimit` is global. Raising it
 * to 12 MB would turn *every* action in the application — including the public
 * newsletter subscribe — into a 12 MB memory sink reachable without
 * authentication, because actions buffer the entire body before the handler
 * runs. So the limit stays at its 1 MB default as a property of the whole app,
 * and files travel through a route handler instead. The action that submits a
 * wizard step carries document ids, never bytes.
 *
 * **Not `await request.formData()`.** That buffers everything and defeats the
 * point entirely. The filename and declared type arrive in headers, as data,
 * and the body is the raw file.
 *
 * Memory is bounded at one chunk plus the sniff window regardless of file
 * size, which is the only acceptable shape: a 300 dpi A4 JPEG decoded or
 * buffered in a Passenger worker on a plan that already OOMs during
 * `next build` is a site-wide outage, triggered by an applicant, from a public
 * form.
 */

export interface IngestInput {
  body: ReadableStream<Uint8Array>;
  /** `Content-Length`, if the client sent one. Advisory only. */
  declaredLength: number | null;
  declaredType: string | null;
  filename: string | null;
  documentTypeCode: string;
  applicationId: number | null;
  subjectKind: DocumentSubjectKind;
  subjectId: number | null;
  supersedesDocumentId?: string | null;
}

export type IngestFailure =
  | { reason: "too-large"; messageKey: MessageKey; values: Record<string, string> }
  | { reason: "wrong-type"; messageKey: MessageKey }
  | { reason: "content-mismatch"; messageKey: MessageKey }
  | { reason: "active-content"; messageKey: MessageKey }
  | { reason: "quota"; messageKey: MessageKey; values: Record<string, string> }
  | { reason: "unreadable"; messageKey: MessageKey };

export interface IngestSuccess {
  documentId: string;
  byteSize: number;
  mimeType: string;
  pageCount: number | null;
  width: number | null;
  height: number | null;
}

export type IngestResult =
  | { ok: true; document: IngestSuccess }
  | { ok: false; failure: IngestFailure };

/**
 * A Transform that counts bytes, hashes them, and keeps the first window.
 *
 * All three passes in one, over a stream that is read once. The byte counter
 * destroys the stream past the cap rather than waiting for it to end, because
 * `Content-Length` is attacker-supplied: a request claiming 2 MB and sending
 * 2 GB must stop at the cap, not after the disk fills.
 */
function createInspector(maxBytes: number) {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let headBytes = 0;
  let total = 0;
  let exceeded = false;

  const stream = new Transform({
    transform(piece: Buffer, _encoding, callback: TransformCallback) {
      total += piece.length;

      if (total > maxBytes) {
        exceeded = true;
        // An Error here propagates through `pipeline`, which destroys every
        // stream in the chain — including the write to disk.
        callback(new Error("UPLOAD_TOO_LARGE"));
        return;
      }

      hash.update(piece);

      if (headBytes < SNIFF_BYTES) {
        const wanted = Math.min(piece.length, SNIFF_BYTES - headBytes);
        head.push(Buffer.from(piece.subarray(0, wanted)));
        headBytes += wanted;
      }

      callback(null, piece);
    },
  });

  return {
    stream,
    get exceeded() {
      return exceeded;
    },
    get total() {
      return total;
    },
    head: () => Buffer.concat(head),
    digest: () => hash.digest("hex"),
  };
}

/**
 * Store a document, or say why not.
 *
 * Errors are values, not exceptions: every failure here is something an
 * applicant did and needs to be told about in their own language, and an
 * exception would end up as a generic 500 with the real reason in a log file
 * the applicant cannot read.
 */
export async function ingestDocument(
  actor: ActorContext,
  input: IngestInput,
): Promise<IngestResult> {
  // `Content-Length` is a claim, and refusing early on it saves transferring
  // eight megabytes to reject them. The real enforcement is the byte counter,
  // because a client can lie here or omit the header entirely.
  if (input.declaredLength !== null && input.declaredLength > MAX_FILE_BYTES) {
    return tooLarge(input.declaredLength);
  }

  const documentId = randomUUID();
  const store = getDocumentStore();

  // Per-document data key, wrapped under the master key with this row's id as
  // AAD — so a wrapped key lifted from one row cannot be used on another.
  const dataKey = newDataKey();
  const wrapped = wrapDataKey(dataKey, `documents.data_key:${documentId}`);

  const inspector = createInspector(MAX_FILE_BYTES);
  const header = createHeader();
  const encryptor = createEncryptor(dataKey, documentId, header);

  // Quarantine, not the final key. Nothing lands at a key the serve route
  // would resolve until the row exists and every check has passed.
  const quarantineKey = keyFor(documentId, "tmp");

  let stored: { bytes: number };
  try {
    const sink = new PassThrough();
    const written = store.write(quarantineKey, sink);
    // `request.body` is a DOM ReadableStream and `fromWeb` wants the
    // node:stream/web one. They are the same object at runtime; only the two
    // type declarations disagree.
    const web = input.body as unknown as NodeWebReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(web), inspector.stream, encryptor, sink);
    stored = await written;
  } catch (error) {
    await store.delete(quarantineKey);

    if (inspector.exceeded) return tooLarge(inspector.total);

    log.warn("upload stream failed", {
      documentId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return fail({ reason: "unreadable", messageKey: "upload.contentMismatch" });
  }

  const head = inspector.head();
  const sniffed = sniff(head);

  if (!sniffed) {
    await store.delete(quarantineKey);
    return fail({ reason: "wrong-type", messageKey: "upload.wrongType" });
  }

  // A declared type that disagrees with the bytes is usually a renamed file
  // and is also exactly what a deliberate attempt looks like. The applicant
  // gets a neutral message; the audit log gets the detail, because the
  // difference is not visible from here and the pattern over time is.
  if (!declaredTypeAgrees(input.declaredType, sniffed.format)) {
    await store.delete(quarantineKey);
    await tryWriteAudit(actor, {
      entityType: "document",
      entityId: documentId,
      action: "document.type_mismatch",
      summary: "An upload's contents did not match the type the client declared.",
      context: {
        declared: input.declaredType,
        sniffed: sniffed.format,
        documentTypeCode: input.documentTypeCode,
      },
    });
    return fail({ reason: "content-mismatch", messageKey: "upload.contentMismatch" });
  }

  const shape = await checkShape(sniffed, dataKey, documentId, store, quarantineKey, stored.bytes);
  if (!shape.ok) {
    await store.delete(quarantineKey);
    if (shape.activeContent) {
      await tryWriteAudit(actor, {
        entityType: "document",
        entityId: documentId,
        action: "document.active_content_rejected",
        summary: "A PDF carrying active content was refused at upload.",
        context: { features: shape.activeContent, documentTypeCode: input.documentTypeCode },
      });
    }
    return fail(shape.failure);
  }

  const finalKey = keyFor(documentId, EXTENSION_BY_FORMAT[sniffed.format]);

  try {
    // Retried on deadlock: the cap's `FOR UPDATE` contends with the
    // applicant's own parallel uploads, and a victim must be re-run rather
    // than reported to them as a failed upload.
    const result = await retryOnDeadlock(async (tx) => {
      // The aggregate cap, inside the transaction and with FOR UPDATE. The
      // wizard uploads one file per request as each is selected, so parallel
      // uploads are the normal case rather than an edge one — and two requests
      // that each read a total under the cap would both be allowed.
      if (input.applicationId !== null) {
        const existing = await sql<{ files: number; bytes: string | number | null }>`
          SELECT COUNT(*) AS files, COALESCE(SUM(byte_size), 0) AS bytes
            FROM documents
           WHERE application_id = ${input.applicationId}
             AND deleted_at IS NULL
           FOR UPDATE
        `.execute(tx);

        const row = existing.rows[0];
        const files = Number(row?.files ?? 0);
        const bytes = Number(row?.bytes ?? 0);

        if (files + 1 > MAX_APPLICATION_FILES || bytes + stored.bytes > MAX_APPLICATION_BYTES) {
          return { quota: true } as const;
        }
      }

      await tx
        .insertInto("documents")
        .values({
          id: documentId,
          application_id: input.applicationId,
          membership_id: null,
          document_type_code: input.documentTypeCode,
          subject_kind: input.subjectKind,
          subject_id: input.subjectId,
          original_filename: cleanUploadedName(input.filename) ?? "unnamed file",
          storage_key: finalKey,
          mime_type: sniffed.mimeType,
          byte_size: stored.bytes,
          sha256: inspector.digest(),
          pixel_width: sniffed.width,
          pixel_height: sniffed.height,
          page_count: shape.pageCount,
          issued_on: null,
          cipher_version: header.version,
          encrypted_data_key: packSealed(wrapped),
          supersedes_document_id: input.supersedesDocumentId ?? null,
          uploaded_by: actor.userId,
          uploaded_at: new Date(),
        })
        .execute();

      // Retire the predecessor in the same transaction.
      //
      // The pointer on its own was not enough: `supersedes_document_id` said
      // which document this replaced, while the old row stayed `uploaded` and
      // therefore still counted as a live document everywhere that matters —
      // `checkCompleteness`, the queue's document count, the officer's
      // viewer. A corrected CNIC became a *second* CNIC, and nothing on the
      // screen said which one was current.
      //
      // Guarded on the predecessor still being live and on it belonging to
      // the same application, so a stale or crafted id retires nothing. The
      // affected-row count is not checked, deliberately: two replacements
      // racing should both succeed, and the second finding the row already
      // superseded is the correct outcome rather than an error.
      if (input.supersedesDocumentId) {
        await tx
          .updateTable("documents")
          .set({ review_state: "superseded" })
          .where("id", "=", input.supersedesDocumentId)
          .where("application_id", "=", input.applicationId)
          .where("review_state", "!=", "superseded")
          .where("deleted_at", "is", null)
          .execute();
      }

      return { quota: false } as const;
    });

    if (result.quota) {
      await store.delete(quarantineKey);
      return fail({
        reason: "quota",
        messageKey: "upload.quota",
        values: {
          max: formatBytes(MAX_APPLICATION_BYTES),
          files: String(MAX_APPLICATION_FILES),
        },
      });
    }
  } catch (error) {
    await store.delete(quarantineKey);
    throw error;
  }

  // Publish last. If this fails the row points at a key that does not exist,
  // which reads as a missing document — loud, and recoverable by re-upload.
  // The reverse order would leave bytes at a serveable key with no row and no
  // retention policy attached to them, which is the worse failure.
  await promote(store, quarantineKey, finalKey);

  log.info("document stored", {
    documentId,
    documentType: input.documentTypeCode,
    byteSize: stored.bytes,
    mimeType: sniffed.mimeType,
    pageCount: shape.pageCount ?? null,
  });

  return {
    ok: true,
    document: {
      documentId,
      byteSize: stored.bytes,
      mimeType: sniffed.mimeType,
      pageCount: shape.pageCount,
      width: sniffed.width,
      height: sniffed.height,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Structural checks                                                          */
/* -------------------------------------------------------------------------- */

type ShapeResult =
  | { ok: true; pageCount: number | null; activeContent?: undefined }
  | { ok: false; failure: IngestFailure; activeContent?: string[] };

/**
 * Check what the format itself promises: dimensions for images, structure for
 * PDFs.
 *
 * The PDF branch reads the file back and decrypts it, which is the one place
 * in this module that holds a whole document in memory. It is bounded by
 * `MAX_FILE_BYTES` having already been enforced, and it is unavoidable:
 * `pdf-lib` parses a complete document, and refusing weaponised PDFs
 * structurally is the mitigation that stands in for the virus scanner this
 * host cannot run.
 */
async function checkShape(
  sniffed: SniffResult,
  dataKey: Buffer,
  documentId: string,
  store: ReturnType<typeof getDocumentStore>,
  key: string,
  storedBytes: number,
): Promise<ShapeResult> {
  if (sniffed.format !== "pdf") {
    const { width, height } = sniffed;

    // Null means the header did not say, which is not a rejection: a
    // progressive JPEG with an unusual segment order is still a valid scan.
    if (width !== null && height !== null) {
      const shortEdge = Math.min(width, height);
      const longEdge = Math.max(width, height);

      if (shortEdge < MIN_IMAGE_EDGE || longEdge > MAX_IMAGE_EDGE) {
        return {
          ok: false,
          failure: { reason: "unreadable", messageKey: "upload.tooSmall" },
        };
      }
    }

    return { ok: true, pageCount: null };
  }

  const header = parseHeader(await store.readAt(key, 0, HEADER_BYTES));
  const total = plaintextLength(storedBytes, header.chunkSize);

  const bytes = await decryptRange(
    dataKey,
    header,
    documentId,
    storedBytes,
    0,
    total - 1,
    (offset, length) => store.readAt(key, offset, length),
  );

  let inspection;
  try {
    inspection = await inspectPdf(bytes, MAX_FILE_BYTES);
  } catch {
    return {
      ok: false,
      failure: { reason: "content-mismatch", messageKey: "upload.contentMismatch" },
    };
  }

  if (inspection.encrypted) {
    return {
      ok: false,
      failure: { reason: "unreadable", messageKey: "upload.pdfEncrypted" },
    };
  }

  if (inspection.activeContent.length > 0) {
    return {
      ok: false,
      failure: { reason: "active-content", messageKey: "upload.pdfActiveContent" },
      activeContent: inspection.activeContent,
    };
  }

  if (inspection.pageCount > MAX_PDF_PAGES) {
    return {
      ok: false,
      failure: {
        reason: "too-large",
        messageKey: "upload.tooManyPages",
        values: { max: String(MAX_PDF_PAGES) },
      },
    };
  }

  return { ok: true, pageCount: inspection.pageCount };
}

/**
 * Move the quarantined bytes to the key the serve route resolves.
 *
 * Implemented as a ranged copy rather than a rename, because the interface has
 * no rename and must not grow one: an object store has no cheap rename either,
 * so adding it would be designing to the local filesystem and discovering the
 * mistake during the migration this adapter exists to make easy.
 */
async function promote(
  store: ReturnType<typeof getDocumentStore>,
  from: string,
  to: string,
): Promise<void> {
  const info = await store.stat(from);
  if (!info) throw new Error("Quarantined document disappeared before promotion");

  const CHUNK = 256 * 1024;
  let offset = 0;

  const source = new Readable({
    async read() {
      try {
        if (offset >= info.bytes) {
          this.push(null);
          return;
        }
        const length = Math.min(CHUNK, info.bytes - offset);
        const piece = await store.readAt(from, offset, length);
        offset += piece.length;
        this.push(piece);
      } catch (error) {
        this.destroy(error as Error);
      }
    },
  });

  await store.write(to, source);
  await store.delete(from);
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

function fail(failure: IngestFailure): IngestResult {
  return { ok: false, failure };
}

function tooLarge(bytes: number): IngestResult {
  return fail({
    reason: "too-large",
    messageKey: "upload.tooLarge",
    values: { size: formatBytes(bytes), max: formatBytes(MAX_FILE_BYTES) },
  });
}

/** Render a failure for the applicant, in their language. */
export function failureMessage(failure: IngestFailure, locale?: "en" | "ur"): string {
  const values = "values" in failure ? failure.values : undefined;
  return t(failure.messageKey, values, locale);
}
