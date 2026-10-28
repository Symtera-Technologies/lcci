import "server-only";

import type { Queryable } from "@/db/client";
import type { ApplicationState, DocumentSubjectKind } from "@/db/schema";

/**
 * What a deficiency unlocks, and nothing else.
 *
 * Split out of `deficiency.ts` so that `applications.ts` can ask "may this
 * field be written" without importing the module that raises deficiencies —
 * which imports `moveState` from `applications.ts` and would make the two
 * mutually dependent. ES modules tolerate that cycle at runtime as long as
 * nothing is read during initialisation, which is exactly the kind of accident
 * that works until a bundler hoists differently.
 *
 * So: reads and pure predicates here, transitions there. The three callers of
 * the predicates — the upload route, the wizard's field gate, and the
 * applicant's own view of what is outstanding — all want this file and none of
 * them wants to be able to raise anything.
 */


export interface UnlockedDocument {
  readonly itemId: number;
  readonly documentTypeCode: string | null;
  readonly subjectKind: DocumentSubjectKind | null;
  readonly subjectId: number | null;
  readonly instruction: string;
  readonly checklistItemCode: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedDocumentId: string | null;
}

export interface UnlockedField {
  readonly itemId: number;
  readonly fieldName: string;
  readonly instruction: string;
}

export interface OpenDeficiency {
  readonly id: number;
  readonly round: number;
  readonly summary: string | null;
  readonly respondBy: string | null;
  readonly raisedAt: Date;
  /** The pause stretch to close on resume. Named, never "the latest". */
  readonly slaPauseId: number | null;
  readonly documents: readonly UnlockedDocument[];
  readonly fields: readonly UnlockedField[];
  /** Items that are neither a document nor a field — an instruction to read. */
  readonly other: readonly { readonly itemId: number; readonly instruction: string }[];
}

/**
 * The open deficiency, or null.
 *
 * Called on the applicant's own path — the wizard's field gate and the upload
 * route's gate — so it takes no actor and performs no permission check: the
 * caller has already established whose application this is, and a second
 * ownership check here would be a different query answering the same question.
 */
export async function loadOpenDeficiency(
  db: Queryable,
  applicationId: number,
): Promise<OpenDeficiency | null> {
  const deficiency = await db
    .selectFrom("application_deficiencies")
    .select(["id", "round", "summary", "respond_by", "raised_at", "sla_pause_id"])
    .where("application_id", "=", applicationId)
    .where("state", "=", "open")
    .orderBy("round", "desc")
    .executeTakeFirst();

  if (!deficiency) return null;

  const items = await db
    .selectFrom("deficiency_items")
    .select([
      "id",
      "kind",
      "document_type_code",
      "subject_kind",
      "subject_id",
      "field_name",
      "checklist_item_code",
      "instruction",
      "resolved_at",
      "resolved_document_id",
    ])
    .where("deficiency_id", "=", Number(deficiency.id))
    .orderBy("id", "asc")
    .execute();

  return {
    id: Number(deficiency.id),
    round: Number(deficiency.round),
    summary: deficiency.summary,
    respondBy: deficiency.respond_by,
    raisedAt: new Date(deficiency.raised_at),
    slaPauseId:
      deficiency.sla_pause_id === null ? null : Number(deficiency.sla_pause_id),
    documents: items
      .filter((item) => item.kind === "document")
      .map((item) => ({
        itemId: Number(item.id),
        documentTypeCode: item.document_type_code,
        subjectKind: item.subject_kind,
        subjectId: item.subject_id === null ? null : Number(item.subject_id),
        instruction: item.instruction,
        checklistItemCode: item.checklist_item_code,
        resolvedAt: item.resolved_at === null ? null : new Date(item.resolved_at),
        resolvedDocumentId: item.resolved_document_id,
      })),
    fields: items
      .filter((item) => item.kind === "field" && item.field_name !== null)
      .map((item) => ({
        itemId: Number(item.id),
        fieldName: item.field_name as string,
        instruction: item.instruction,
      })),
    other: items
      .filter((item) => item.kind === "other")
      .map((item) => ({ itemId: Number(item.id), instruction: item.instruction })),
  };
}

/**
 * Whether this document may be uploaded against this application right now.
 *
 * The rule in one function, because three callers need the same answer: the
 * upload route, the wizard's document step, and the applicant's own view of
 * what is outstanding.
 *
 * A DRAFT is wide open — nothing has been promised to anyone yet. An
 * AWAITING_APPLICANT application admits only the types the open deficiency
 * named, matched on the subject too: one partner's illegible CNIC reopens that
 * partner's CNIC, not the whole board's. Everything else is closed, including
 * UNDER_VERIFICATION — an officer reading a document while the applicant
 * replaces it underneath them is the failure this prevents.
 */
export function mayUpload(
  state: ApplicationState,
  deficiency: OpenDeficiency | null,
  target: {
    readonly documentTypeCode: string;
    readonly subjectKind: DocumentSubjectKind;
    readonly subjectId: number | null;
  },
): boolean {
  if (state === "DRAFT") return true;
  if (state !== "AWAITING_APPLICANT" || deficiency === null) return false;

  return deficiency.documents.some((item) => {
    if (item.documentTypeCode !== target.documentTypeCode) return false;
    // A deficiency item that names no subject covers every subject of that
    // type — "CNIC of all partners is illegible" is one item, not five.
    if (item.subjectKind === null) return true;
    if (item.subjectKind !== target.subjectKind) return false;
    return item.subjectId === null || item.subjectId === target.subjectId;
  });
}

/** Whether this form field may be edited right now, by the same rule. */
export function mayEditField(
  state: ApplicationState,
  deficiency: OpenDeficiency | null,
  fieldName: string,
): boolean {
  if (state === "DRAFT") return true;
  if (state !== "AWAITING_APPLICANT" || deficiency === null) return false;
  return deficiency.fields.some((item) => item.fieldName === fieldName);
}

