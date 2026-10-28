import { after } from "next/server";
import { headers } from "next/headers";
import { getDb } from "@/db/client";
import { UnauthenticatedError, type ActorContext } from "@/server/actor";
import { clientIp, requireActor } from "@/server/auth/dal";
import { hashIp } from "@/server/crypto";
import { consume } from "@/server/rate-limit";
import { logError } from "@/server/log";
import { contentDisposition, downloadName } from "@/server/documents/filename";
import {
  authorizeDocument,
  parseRange,
  readDocumentRange,
} from "@/server/documents/serve";

/**
 * Serve one stored document to someone entitled to read it.
 *
 * **Excluded from the proxy matcher**, like the upload route, so neither the
 * request nor the response passes through a body buffer. It therefore does its
 * own authentication.
 *
 * The response headers are the security design as much as the authorisation
 * check is:
 *
 * **`Content-Disposition: attachment` by default**, and that is what
 * neutralises anything that slipped past upload validation — an attachment is
 * downloaded, not rendered, so it cannot execute in the officer's session.
 *
 * **`?inline=1` is the staff viewer**, and it is the one place that default is
 * relaxed. The review screen has to show the document beside the form it is
 * being checked against; an officer who must download twelve files to verify
 * one application will stop checking them properly, which defeats the control
 * the thirteen-item checklist exists to implement. It is confined as tightly
 * as it can be: staff only, never an applicant, `frame-ancestors 'self'` so
 * only our own pages may embed it, and `nosniff` and the allowlisted
 * `Content-Type` still stand.
 *
 * The residual risk is a renderer bug in the browser's own PDF viewer, and the
 * trade is made with that said out loud: upload already refuses PDFs
 * carrying `OpenAction`, `AA`, `Names/JavaScript`, `Launch`, `EmbeddedFile` or
 * `RichMedia` structurally, so what reaches the viewer is a document whose
 * active content has been removed — and the alternative, the officer
 * downloading it and opening it in the same browser, exposes the same viewer
 * with less of our CSP around it.
 *
 * **`Content-Type` from a hardcoded allowlist**, keyed on the format sniffed
 * at upload. Nothing a client sent, and nothing a database row could be edited
 * to contain, reaches this header.
 *
 * **`Cache-Control: private, no-store` with `Vary: Cookie`, and deliberately
 * no `ETag` or `Last-Modified`.** The secretariat shares machines; a CNIC in a
 * browser's disk cache outlives the session that fetched it. No validator is
 * sent either, because a validator is a stable identifier for content that is
 * supposed to be inaccessible.
 *
 * **404 for forbidden as well as absent**, because 403-on-real and
 * 404-on-fake is an existence oracle.
 *
 * **401, never a redirect, when there is no session.** This route is the `src`
 * of an `<img>` and the target of pdf.js range requests; a 302 to a sign-in
 * page arrives there as a baffling failure rather than as a prompt.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const headerList = await headers();

  let actor: ActorContext;
  try {
    actor = await requireActor();
  } catch (error) {
    if (error instanceof UnauthenticatedError) return unauthenticated();
    throw error;
  }

  // Per session rather than per IP: the limit exists so a compromised staff
  // session cannot quietly enumerate and exfiltrate the document store, and a
  // shared secretariat NAT makes an IP bucket useless for that.
  const limit = await consume("documentFetchSession", `user:${actor.userId}`);
  if (!limit.allowed) {
    return new Response("Too many requests", {
      status: 429,
      headers: {
        "Retry-After": String(limit.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    });
  }

  const { id } = await params;
  const rawRange = request.headers.get("range");

  // Staff only. An applicant can still read their own documents, as an
  // attachment; what they cannot do is ask for a rendering context, because
  // the one thing an attacker with an uploaded file wants is for it to be
  // interpreted rather than saved.
  const wantsInline =
    new URL(request.url).searchParams.get("inline") === "1" &&
    actor.userType === "staff";

  try {
    const outcome = await authorizeDocument(actor, id);

    if (!outcome.ok) {
      // Logged for a real document the actor may not read, so "who tried to
      // look at my CNIC" has an answer as well as "who looked at it".
      if (outcome.reason === "forbidden") {
        recordAccess(actor, id, "denied", headerList, rawRange);
      }
      return notFound();
    }

    const document = outcome.document;
    const range = parseRange(rawRange, document.plaintextBytes);

    if (range.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${document.plaintextBytes}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
        },
      });
    }

    const bytes = await readDocumentRange(document, range.start, range.end);

    recordAccess(actor, document.id, "served", headerList, rawRange);

    const partial = range.kind === "partial";
    const filename = downloadName(
      document.documentTypeCode,
      document.id.slice(0, 8),
      extensionFor(document.mimeType),
    );

    return new Response(new Uint8Array(bytes), {
      status: partial ? 206 : 200,
      headers: {
        "Content-Type": document.mimeType,
        "Content-Length": String(bytes.length),
        "Content-Disposition": contentDisposition(
          filename,
          wantsInline ? "inline" : "attachment",
        ),
        ...(partial
          ? {
              "Content-Range": `bytes ${range.start}-${range.end}/${document.plaintextBytes}`,
            }
          : {}),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
        // Belt and braces with the disposition: even served inline by a
        // misconfigured proxy, this cannot be framed or scripted.
        //
        // The inline variant has to let the browser's own viewer run, so
        // `sandbox` and `default-src 'none'` come off — they would blank a PDF
        // rather than secure it. What stays is the part that matters for an
        // embedded document: only our own pages may frame it, nothing may be
        // fetched from it, and no form in it may post anywhere.
        "Content-Security-Policy": wantsInline
          ? "default-src 'self'; script-src 'none'; object-src 'none'; " +
            "connect-src 'none'; form-action 'none'; frame-ancestors 'self'"
          : "default-src 'none'; img-src 'self'; object-src 'none'; sandbox",
      },
    });
  } catch (error) {
    logError("document could not be served", error, {
      route: "/api/documents/[id]",
      userId: actor.userId,
    });
    return notFound();
  }
}

/**
 * Write the access record after the response.
 *
 * Inside `after()` so the officer is not waiting on an INSERT to see the file,
 * and so a failure to log cannot fail the fetch. The record is the only thing
 * that can ever answer "who looked at my CNIC", which a chamber holding
 * identity documents will eventually be asked; it also lets a checklist item
 * require that the officer actually opened the original before ticking a box.
 */
function recordAccess(
  actor: ActorContext,
  documentId: string,
  outcome: "served" | "denied" | "not_found",
  headerList: Headers,
  rangeHeader: string | null,
): void {
  after(async () => {
    try {
      await getDb()
        .insertInto("document_access_log")
        .values({
          document_id: documentId,
          user_id: actor.userId,
          outcome,
          // The header as sent, truncated. Which bytes were asked for is the
          // difference between "opened page one" and "downloaded the whole
          // CNIC", and that distinction is the point of keeping this at all.
          range_header: rangeHeader ? rangeHeader.slice(0, 190) : null,
          ip_hash: hashIp(clientIp(headerList)),
          request_id: actor.requestId,
        })
        .execute();
    } catch (error) {
      logError("document access could not be logged", error, { documentId });
    }
  });
}

function extensionFor(mimeType: string): string {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "bin";
}

function unauthenticated(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}
