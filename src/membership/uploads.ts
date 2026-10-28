import "server-only";

import { getDb } from "@/db/client";
import type { Queryable } from "@/db/client";
import type { ApplicationState, DocumentSubjectKind } from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { loadOpenDeficiency, mayUpload } from "@/membership/unlock";

/**
 * Whether this file may be attached to this application, by this person, now.
 *
 * One gate, called by the upload route before a single byte is read, because
 * everything downstream of it treats `applicationId` as established fact. Until
 * this existed the route took that id from a request header and passed it
 * straight to the ingester, which meant any signed-in applicant could attach a
 * document to anybody else's application — and, with `x-supersedes`, could
 * point a replacement at a document on a form that was not theirs.
 *
 * Four questions, in this order, because they are not equally safe to answer:
 *
 *   1. Is this application yours? A wrong answer here is the authorisation
 *      failure, so it is first and its refusal is indistinguishable from "no
 *      such application" — the same wording the wizard uses everywhere else,
 *      so a response cannot be used to discover which ids exist.
 *   2. Does this application accept uploads at all? A DRAFT does; an
 *      AWAITING_APPLICANT one accepts only what its open deficiency named;
 *      everything else refuses. UNDER_VERIFICATION refusing matters most: an
 *      officer reading a scan while the applicant replaces it underneath them
 *      is the race this closes.
 *   3. Is the subject part of this application? A director id belonging to
 *      another firm would otherwise file a CNIC under a stranger's name.
 *   4. What is being replaced? Derived here rather than trusted from the
 *      client, so a replacement always supersedes the document it actually
 *      replaces.
 */

export type UploadRefusal =
  | "not_found"
  | "locked"
  | "not_unlocked"
  | "wrong_subject"
  | "unknown_type";

export type UploadDecision =
  | {
      readonly ok: true;
      /** The live document this upload replaces, if any. */
      readonly supersedes: string | null;
      readonly state: ApplicationState;
    }
  | { readonly ok: false; readonly reason: UploadRefusal; readonly message: string };

export interface UploadTarget {
  readonly applicationId: number | null;
  readonly documentTypeCode: string;
  readonly subjectKind: DocumentSubjectKind;
  readonly subjectId: number | null;
}

export async function authorizeUpload(
  actor: ActorContext,
  target: UploadTarget,
  db: Queryable = getDb(),
): Promise<UploadDecision> {
  const notFound = {
    ok: false,
    reason: "not_found",
    message: "That application could not be found.",
  } as const;

  if (target.applicationId === null || actor.userId === null) return notFound;

  const application = await db
    .selectFrom("applications")
    .select(["id", "state", "created_by"])
    .where("id", "=", target.applicationId)
    .executeTakeFirst();

  // Ownership, not a staff permission. Staff uploading over the counter on an
  // applicant's behalf is a real need and is not built: it would have to
  // record who filed the document and on whose instruction, and a silent
  // widening of this check is not that feature.
  if (!application || Number(application.created_by) !== actor.userId) return notFound;

  const state = application.state as ApplicationState;

  const type = await db
    .selectFrom("document_types")
    .select(["code", "subject_kind", "allows_multiple"])
    .where("code", "=", target.documentTypeCode)
    .where("active", "=", 1)
    .executeTakeFirst();

  if (!type) {
    return {
      ok: false,
      reason: "unknown_type",
      message: "That is not a document the Chamber asks for.",
    } as const;
  }

  const deficiency =
    state === "AWAITING_APPLICANT"
      ? await loadOpenDeficiency(db, target.applicationId)
      : null;

  if (!mayUpload(state, deficiency, target)) {
    // Two different refusals, because they call for two different actions. A
    // locked application needs no further upload at all; an unlocked one with
    // the wrong document type means the applicant is answering an item that
    // was not raised, and saying so is more useful than "not allowed".
    return state === "AWAITING_APPLICANT"
      ? ({
          ok: false,
          reason: "not_unlocked",
          message:
            "That document is not one of the items the Chamber asked you to " +
            "attend to. Check the list on your application.",
        } as const)
      : ({
          ok: false,
          reason: "locked",
          message: "This application is with the Chamber and no longer accepts uploads.",
        } as const);
  }

  if (target.subjectKind === "director") {
    if (target.subjectId === null) {
      return {
        ok: false,
        reason: "wrong_subject",
        message: "Say which director or partner this document belongs to.",
      } as const;
    }

    const director = await db
      .selectFrom("application_directors")
      .select(["id"])
      .where("id", "=", target.subjectId)
      .where("application_id", "=", target.applicationId)
      .executeTakeFirst();

    if (!director) return notFound;
  }

  // What this upload replaces.
  //
  // Derived, never taken from the client. The route used to read an
  // `x-supersedes` header and the wizard never sent one, so nothing was ever
  // superseded and a corrected scan simply became a second live document —
  // which `checkCompleteness` counted, and which left the officer looking at
  // two versions of one CNIC with nothing saying which was current.
  //
  // The newest live document of the same type and subject is the one being
  // replaced. Two exceptions, in opposite directions:
  //
  //   A type that `allows_multiple` is additive in a DRAFT. Two pay orders is
  //   the normal shape of an application carrying the ITD surcharge, and
  //   superseding there would silently discard the applicant's first
  //   instrument.
  //
  //   While answering a deficiency, replacement is always the intent: the
  //   officer named that document, so a file arriving against it replaces it
  //   whatever the type allows.
  if (state === "DRAFT" && Number(type.allows_multiple) === 1) {
    return { ok: true, supersedes: null, state } as const;
  }

  let query = db
    .selectFrom("documents")
    .select(["id"])
    .where("application_id", "=", target.applicationId)
    .where("document_type_code", "=", target.documentTypeCode)
    .where("deleted_at", "is", null)
    .where("review_state", "!=", "superseded")
    .orderBy("uploaded_at", "desc")
    .limit(1);

  query =
    target.subjectId === null
      ? query.where("subject_id", "is", null)
      : query.where("subject_id", "=", target.subjectId);

  const predecessor = await query.executeTakeFirst();

  return {
    ok: true,
    supersedes: predecessor?.id ?? null,
    state,
  } as const;
}
