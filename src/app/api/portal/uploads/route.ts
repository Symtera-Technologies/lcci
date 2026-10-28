import { headers } from "next/headers";
import { env } from "@/server/env";
import { clientIp, requireActor } from "@/server/auth/dal";
import { UnauthenticatedError } from "@/server/actor";
import { consume } from "@/server/rate-limit";
import { log, logError } from "@/server/log";
import { t } from "@/server/i18n";
import { ingestDocument, failureMessage } from "@/server/documents/ingest";
import { authorizeUpload } from "@/membership/uploads";
import { MAX_FILE_BYTES } from "@/server/documents/limits";
import type { DocumentSubjectKind } from "@/db/schema";

/**
 * One file per request, streamed.
 *
 * **Excluded from the proxy matcher, and that exclusion is load-bearing.** A
 * Next 16 proxy file buffers every matched request body in memory, capped at
 * 10 MB, and past the cap it *truncates silently and lets the request
 * continue* — a warning in a log nobody reads and a document that is quietly
 * not the document the applicant uploaded. Routing uploads through the proxy
 * would therefore mean silent data corruption on exactly the files that matter
 * most. `src/proxy.ts` excludes this path in its matcher and in
 * `PROXY_EXCLUDED_PREFIXES`, and `tests/proxy.test.ts` asserts it.
 *
 * Because the proxy does not run here, this route does its own origin check
 * and its own authentication rather than inheriting either.
 *
 * The metadata travels in headers rather than in a multipart body, because
 * `await request.formData()` buffers the whole upload and defeats the point.
 * They are read as data: the filename is cleaned for display and never used as
 * a path, and the declared content type is only ever compared against the
 * magic-byte sniff.
 */

export const dynamic = "force-dynamic";

/** Uploads are streamed, so the response is small and quick. */
export const maxDuration = 60;

interface UploadHeaders {
  documentTypeCode: string;
  filename: string | null;
  applicationId: number | null;
  subjectKind: DocumentSubjectKind;
  subjectId: number | null;
}

const SUBJECT_KINDS: readonly DocumentSubjectKind[] = [
  "company",
  "representative",
  "director",
  "endorser",
  "payment",
];

export async function POST(request: Request): Promise<Response> {
  const headerList = await headers();

  // Route handlers get no CSRF protection from Next, unlike server actions, so
  // the check is explicit. Present *and* equal: Next's own server-action check
  // lets a request with no `Origin` through with only a warning, and that is
  // precisely the hole a form posted from a non-browser client walks through.
  const origin = headerList.get("origin");
  if (origin !== env.siteOrigin) {
    return json({ ok: false, error: t("error.unverifiedRequest") }, 403);
  }

  let actor;
  try {
    actor = await requireActor();
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      // 401 and never a redirect. This is called by `fetch` from the wizard,
      // and a 302 to a sign-in page would arrive as an opaque failure with the
      // applicant's file already uploaded and discarded.
      return json({ ok: false, error: t("auth.session.ended") }, 401);
    }
    throw error;
  }

  const limit = await consume("uploadSession", `user:${actor.userId}`);
  if (!limit.allowed) {
    return json(
      { ok: false, error: t("auth.code.tooMany"), retryAfter: limit.retryAfterSeconds },
      429,
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
  }

  const meta = readHeaders(headerList);
  if (!meta) {
    return json({ ok: false, error: t("error.unverifiedRequest") }, 400);
  }

  if (!request.body) {
    return json({ ok: false, error: t("upload.wrongType") }, 400);
  }

  // Before a single byte is read. Everything downstream treats the application
  // id as established fact, and until this call existed it was whatever the
  // client put in a header — so an applicant could attach a document to
  // somebody else's application. The gate also decides what this upload
  // replaces, which is not the client's business either.
  const permitted = await authorizeUpload(actor, {
    applicationId: meta.applicationId,
    documentTypeCode: meta.documentTypeCode,
    subjectKind: meta.subjectKind,
    subjectId: meta.subjectId,
  });

  if (!permitted.ok) {
    log.info("upload refused", {
      userId: actor.userId,
      documentType: meta.documentTypeCode,
      reason: permitted.reason,
    });
    // 403 rather than 404 even for `not_found`: the body carries the same
    // "could not be found" wording whichever it was, so the status does not
    // need to carry the distinction and a 403 is the honest description of
    // what happened to a well-formed request.
    return json({ ok: false, error: permitted.message, reason: permitted.reason }, 403);
  }

  const declaredLength = parseLength(headerList.get("content-length"));

  try {
    const result = await ingestDocument(actor, {
      body: request.body,
      declaredLength,
      declaredType: headerList.get("content-type"),
      filename: meta.filename,
      documentTypeCode: meta.documentTypeCode,
      applicationId: meta.applicationId,
      subjectKind: meta.subjectKind,
      subjectId: meta.subjectId,
      supersedesDocumentId: permitted.supersedes,
    });

    if (!result.ok) {
      log.info("upload rejected", {
        userId: actor.userId,
        documentType: meta.documentTypeCode,
        reason: result.failure.reason,
      });
      // 422 rather than 400: the request was well-formed and the file was not
      // acceptable, and the wizard shows the message against the field.
      return json(
        { ok: false, error: failureMessage(result.failure), reason: result.failure.reason },
        422,
      );
    }

    return json({ ok: true, document: result.document }, 201);
  } catch (error) {
    logError("upload failed", error, {
      route: "/api/portal/uploads",
      userId: actor.userId,
      ipHash: clientIp(headerList) ?? null,
    });
    return json(
      { ok: false, error: t("error.unexpected", { reference: actor.requestId }) },
      500,
    );
  }
}

/**
 * Read and validate the metadata headers.
 *
 * Returns null on anything unexpected rather than coercing. These values
 * choose a document type and an application, so a malformed one is a bug in
 * the client or an attempt, and neither should be guessed at.
 */
function readHeaders(headerList: Headers): UploadHeaders | null {
  const documentTypeCode = headerList.get("x-document-type")?.trim() ?? "";
  if (!/^[a-z0-9_]{2,40}$/.test(documentTypeCode)) return null;

  const subjectKind = headerList.get("x-subject-kind")?.trim() ?? "";
  if (!SUBJECT_KINDS.includes(subjectKind as DocumentSubjectKind)) return null;

  const applicationId = parseId(headerList.get("x-application-id"));
  if (applicationId === undefined) return null;

  const subjectId = parseId(headerList.get("x-subject-id"));
  if (subjectId === undefined) return null;

  return {
    documentTypeCode,
    // Percent-encoded by the client, because a header is Latin-1 and a
    // Pakistani firm's filename is frequently not. Decoding failure is not
    // fatal: the name is a display value, and losing it costs the officer a
    // small convenience rather than the upload.
    filename: decodeFilename(headerList.get("x-filename")),
    applicationId,
    subjectKind: subjectKind as DocumentSubjectKind,
    subjectId,
  };
}

function decodeFilename(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 255);
  } catch {
    return null;
  }
}

/** `undefined` means malformed; `null` means absent, which is allowed. */
function parseId(raw: string | null): number | null | undefined {
  if (raw === null || raw.trim() === "") return null;
  if (!/^\d{1,15}$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseLength(raw: string | null): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= 0 && value <= MAX_FILE_BYTES * 4 ? value : MAX_FILE_BYTES * 4;
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      ...extra,
    },
  });
}
