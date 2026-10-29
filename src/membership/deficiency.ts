import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  ApplicationState,
  DeficiencyItemKind,
  DocumentSubjectKind,
} from "@/db/schema";
import { ForbiddenError, requirePermission, type ActorContext } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { moveState, recordTransition } from "@/membership/applications";
import { applicantContact } from "@/membership/notify";
import { checkCompleteness } from "@/membership/submit";
import { gatherFacts } from "@/membership/submit";
import { writeSubmissionSnapshot } from "@/membership/snapshot";
import { nthWorkingDayAfter, pauseSlaClock, resumeSlaClock } from "@/membership/sla";
import { loadOpenDeficiency, type OpenDeficiency } from "@/membership/unlock";
import { canTransition, type TransitionActorView } from "@/membership/workflow";
import { enqueue } from "@/server/mail/outbox";

export {
  loadOpenDeficiency,
  mayEditField,
  mayUpload,
  type OpenDeficiency,
  type UnlockedDocument,
  type UnlockedField,
} from "@/membership/unlock";

/**
 * The deficiency round: returning an application for more information.
 *
 * This is the one place in the system where the applicant gets write access to
 * a submitted application, and the design question is entirely about how much.
 * The answer is **exactly what the officer named, and nothing else.**
 *
 * The reason is not tidiness. Between submission and a decision the
 * application is the thing an officer's thirteen-item checklist refers to; if
 * answering a deficiency about one illegible CNIC also reopened the turnover
 * field, a completed round could come to describe a form that no longer
 * exists, and the officer would have signed for figures they never saw. So the
 * deficiency's items are simultaneously three things — the email the applicant
 * receives, the edit permission they are granted, and the list checked off on
 * their return — and they are one set of rows rather than three
 * representations somebody has to keep in step.
 *
 * The SLA clock pauses for the whole round, because the chamber's promise is
 * forty, fifteen or three working days *of its own time*. An application
 * waiting eleven working days on an applicant has not consumed eleven of the
 * chamber's forty, and the report has to be able to say so when a member
 * complains about a missed Executive promise.
 */

/**
 * How long an applicant gets, in working days, unless the officer says
 * otherwise.
 *
 * A constant with a name rather than a literal in a form default, because it
 * is chamber policy and belongs in `membership_year_policy`-style reference
 * data the moment LCCI states a figure. Fifteen working days is three calendar
 * weeks, which is the shortest window that does not assume the applicant's
 * bank can produce a fresh certificate on demand.
 */
export const DEFICIENCY_RESPONSE_WORKING_DAYS = 15;

function toActorView(actor: ActorContext): TransitionActorView {
  return {
    userId: actor.userId,
    isStaff: actor.userType === "staff",
    isSystem: actor.userId === null,
    permissions: actor.permissions,
  };
}

/* -------------------------------------------------------------------------- */
/* Raising one                                                                */
/* -------------------------------------------------------------------------- */

export interface DeficiencyItemInput {
  readonly kind: DeficiencyItemKind;
  readonly documentTypeCode?: string | null;
  readonly subjectKind?: DocumentSubjectKind | null;
  readonly subjectId?: number | null;
  readonly fieldName?: string | null;
  readonly checklistItemCode?: string | null;
  readonly instruction: string;
}

export interface RaiseDeficiencyInput {
  readonly applicationId: number;
  readonly summary?: string | null;
  readonly items: readonly DeficiencyItemInput[];
  /** Overrides `DEFICIENCY_RESPONSE_WORKING_DAYS` where the officer sets one. */
  readonly respondByWorkingDays?: number;
}

export type RaiseDeficiencyResult =
  | {
      readonly ok: true;
      readonly deficiencyId: number;
      readonly round: number;
      readonly respondBy: string | null;
      readonly itemCount: number;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "no_items"
        | "already_open"
        | "round_in_progress"
        | "wrong_state"
        | "no_recipient";
      readonly message: string;
    };

/**
 * UNDER_VERIFICATION → AWAITING_APPLICANT, with the list the applicant gets.
 *
 * Refuses while a verification round is still open, which is deliberate and is
 * the one piece of sequencing this module imposes. The deficiency list is what
 * a signed round *concluded*; raising one mid-round would produce an email
 * derived from findings the officer had not yet stood behind, and would leave a
 * round that can never be honestly completed — its items would describe
 * documents the applicant has since replaced.
 */
export async function raiseDeficiency(
  actor: ActorContext,
  input: RaiseDeficiencyInput,
): Promise<RaiseDeficiencyResult> {
  requirePermission(actor, "application.raise_deficiency");

  const items = input.items.filter((item) => item.instruction.trim() !== "");

  if (items.length === 0) {
    return {
      ok: false,
      reason: "no_items",
      message:
        "Name at least one thing the applicant has to do. A return with no " +
        "items is an email telling somebody their application is wrong " +
        "without saying how.",
    };
  }

  return transaction(async (tx) => {
    const application = await tx
      .selectFrom("applications")
      .leftJoin("application_company", "application_company.application_id", "applications.id")
      .select([
        "applications.id as id",
        "applications.state as state",
        "applications.version as version",
        "applications.public_ref as public_ref",
        "applications.form_revision_id as form_revision_id",
        "application_company.firm_name as firm_name",
        "application_company.email as email",
      ])
      .where("applications.id", "=", input.applicationId)
      .executeTakeFirst();

    if (!application) {
      throw new ForbiddenError(null, "That application could not be found.");
    }

    const state = application.state as ApplicationState;
    const facts = await gatherFacts(tx, input.applicationId);
    const decision = canTransition({ ...facts, state }, "raise_deficiency", toActorView(actor));

    if (!decision.allowed) {
      return {
        ok: false,
        reason: "wrong_state",
        message: decision.missingPermission
          ? "You do not hold the permission to return an application for more information."
          : (decision.reasons[0] ??
            "An application can only be returned for more information while it is under verification."),
      } as const;
    }

    const open = await tx
      .selectFrom("application_deficiencies")
      .select(["id", "round"])
      .where("application_id", "=", input.applicationId)
      .where("state", "=", "open")
      .executeTakeFirst();

    if (open) {
      return {
        ok: false,
        reason: "already_open",
        message: `Round ${Number(open.round)} is already open with this applicant. Reload the page.`,
      } as const;
    }

    const inProgress = await tx
      .selectFrom("verification_checklists")
      .select(["id", "round"])
      .where("application_id", "=", input.applicationId)
      .where("state", "=", "in_progress")
      .executeTakeFirst();

    if (inProgress) {
      return {
        ok: false,
        reason: "round_in_progress",
        message:
          `Sign verification round ${Number(inProgress.round)} off first. The ` +
          `deficiency list is what the round concluded, so it has to be ` +
          `concluded before it is sent.`,
      } as const;
    }

    const signed = await tx
      .selectFrom("verification_checklists")
      .select(["id", "round"])
      .where("application_id", "=", input.applicationId)
      .where("state", "in", ["completed", "superseded"])
      .orderBy("round", "desc")
      .executeTakeFirst();

    const previous = await tx
      .selectFrom("application_deficiencies")
      .select(["round"])
      .where("application_id", "=", input.applicationId)
      .orderBy("round", "desc")
      .executeTakeFirst();

    const round = Number(previous?.round ?? 0) + 1;

    const workingDays = Math.max(
      1,
      Math.min(60, input.respondByWorkingDays ?? DEFICIENCY_RESPONSE_WORKING_DAYS),
    );
    const today = new Date().toISOString().slice(0, 10);
    const respondBy = await nthWorkingDayAfter(tx, today, workingDays);

    const now = new Date();

    // The clock stops before the state moves, so a reader of the clock can
    // never see a paused application that is still UNDER_VERIFICATION or an
    // AWAITING_APPLICANT one whose clock is still running.
    const pauseId = await pauseSlaClock(tx, {
      applicationId: input.applicationId,
      reason: "awaiting_applicant",
      note: `Deficiency round ${round}`,
      at: now,
    });

    const inserted = await tx
      .insertInto("application_deficiencies")
      .values({
        application_id: input.applicationId,
        round,
        checklist_id: signed ? Number(signed.id) : null,
        state: "open",
        summary: input.summary?.trim() || null,
        raised_by: actor.userId,
        raised_at: now,
        respond_by: respondBy,
        sla_pause_id: pauseId,
        request_id: actor.requestId,
      })
      .executeTakeFirst();

    const deficiencyId = Number(inserted.insertId);

    await tx
      .insertInto("deficiency_items")
      .values(
        items.map((item) => ({
          deficiency_id: deficiencyId,
          kind: item.kind,
          document_type_code: item.kind === "document" ? (item.documentTypeCode ?? null) : null,
          subject_kind: item.kind === "document" ? (item.subjectKind ?? null) : null,
          subject_id: item.kind === "document" ? (item.subjectId ?? null) : null,
          field_name: item.kind === "field" ? (item.fieldName ?? null) : null,
          checklist_item_code: item.checklistItemCode ?? null,
          instruction: item.instruction.trim().slice(0, 600),
        })),
      )
      .execute();

    await moveState(tx, {
      applicationId: input.applicationId,
      fromState: state,
      fromVersion: Number(application.version),
      toState: "AWAITING_APPLICANT",
    });

    await recordTransition(tx, actor, {
      applicationId: input.applicationId,
      fromState: state,
      toState: "AWAITING_APPLICANT",
      transitionCode: "raise_deficiency",
      reason: input.summary?.trim().slice(0, 500) || `Deficiency round ${round}`,
    });

    // Queued inside the transaction, so an email promising a return that
    // rolled back cannot exist, and neither can a returned application whose
    // applicant was never told.
    //
    // The address comes from `applicantContact` and not from the row selected
    // above, which carried only `application_company.email`. Where the form
    // gives no address that fell through to no message at all — and an
    // applicant who is not told what is missing has fifteen working days to
    // answer a list they never received, after which a closure job nobody has
    // built yet would close their file.
    const contact = await applicantContact(tx, input.applicationId);
    if (contact?.email) {
      await enqueue(
        {
          to: contact.email,
          template: "application-deficiency",
          payload: {
            reference: contact.reference,
            firmName: contact.firmName,
            summary: input.summary?.trim() || null,
            respondBy,
            items: items.map((item) => item.instruction.trim()),
          },
          entityType: "application",
          entityId: input.applicationId,
        },
        tx,
      );
    }

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: input.applicationId,
        action: "application.deficiency_raised",
        summary: `Returned to the applicant: ${items.length} item(s), answer by ${respondBy}.`,
        after: {
          round,
          respondBy,
          checklistId: signed ? Number(signed.id) : null,
          slaPauseId: pauseId,
          notified: contact?.email !== null && contact?.email !== undefined,
          items: items.map((item) => ({
            kind: item.kind,
            documentTypeCode: item.documentTypeCode ?? null,
            subjectKind: item.subjectKind ?? null,
            subjectId: item.subjectId ?? null,
            fieldName: item.fieldName ?? null,
            checklistItemCode: item.checklistItemCode ?? null,
            instruction: item.instruction.trim(),
          })),
        },
        formRevisionId: application.form_revision_id,
      },
      tx,
    );

    return {
      ok: true,
      deficiencyId,
      round,
      respondBy,
      itemCount: items.length,
    } as const;
  });
}

/* -------------------------------------------------------------------------- */
/* Answering it                                                              */
/* -------------------------------------------------------------------------- */

export type RespondResult =
  | {
      readonly ok: true;
      readonly round: number;
      readonly snapshotRound: number;
      readonly checklistRound: number;
      readonly dueDate: string | null;
      readonly pausedWorkingDays: number;
    }
  | {
      readonly ok: false;
      readonly reason: "wrong_state" | "nothing_open" | "outstanding";
      readonly message: string;
      readonly outstanding: readonly string[];
    };

/**
 * AWAITING_APPLICANT → UNDER_VERIFICATION, once the applicant says they are
 * done.
 *
 * Four things happen that have to happen together. Every document item is
 * matched to the re-upload that answered it. A new submission snapshot round is
 * written, so the immutable record holds what the application looked like on
 * each return rather than only at first submission. A fresh checklist round is
 * opened, because the previous one judged documents that have since been
 * replaced. And the clock resumes, with the deadline moved out by exactly the
 * working days the applicant held it.
 *
 * It refuses while a named document is still outstanding. That is not
 * paternalism: the alternative is an application cycling back into the queue
 * unchanged, an officer re-reading the same illegible scan, and a second
 * deficiency round that costs the applicant another fifteen working days.
 */
export async function recordApplicantResponse(
  actor: ActorContext,
  applicationId: number,
): Promise<RespondResult> {
  if (actor.userId === null) {
    throw new ForbiddenError(null, "Sign in to continue your application.");
  }

  return transaction(async (tx) => {
    const application = await tx
      .selectFrom("applications")
      .select(["id", "state", "version", "created_by", "form_revision_id"])
      .where("id", "=", applicationId)
      .executeTakeFirst();

    // The same message for "not yours" and "does not exist", as everywhere
    // else on the applicant's path: a different one for each would confirm
    // which application ids exist.
    if (!application || Number(application.created_by) !== actor.userId) {
      throw new ForbiddenError(null, "That application could not be found.");
    }

    const state = application.state as ApplicationState;
    const deficiency = await loadOpenDeficiency(tx, applicationId);

    if (!deficiency) {
      return {
        ok: false,
        reason: "nothing_open",
        message: "There is nothing outstanding on this application.",
        outstanding: [],
      } as const;
    }

    const facts = await gatherFacts(tx, applicationId);
    const decision = canTransition({ ...facts, state }, "applicant_responded", toActorView(actor));

    if (!decision.allowed) {
      return {
        ok: false,
        reason: "wrong_state",
        message:
          decision.reasons[0] ??
          "This application is not waiting on you at the moment.",
        outstanding: [],
      } as const;
    }

    // Which re-upload answered which item. "Uploaded since the deficiency was
    // raised" rather than "exists": the document that failed verification is
    // still on the application, so presence alone would mark every item
    // answered the instant it was raised.
    const replacements = await tx
      .selectFrom("documents")
      .select(["id", "document_type_code", "subject_kind", "subject_id", "uploaded_at"])
      .where("application_id", "=", applicationId)
      .where("deleted_at", "is", null)
      .where("review_state", "!=", "superseded")
      .where("uploaded_at", ">=", deficiency.raisedAt)
      .orderBy("uploaded_at", "desc")
      .execute();

    const matched = new Map<number, string>();
    const outstanding: string[] = [];

    for (const item of deficiency.documents) {
      if (item.resolvedDocumentId !== null) continue;

      const answer = replacements.find((document) => {
        if (document.document_type_code !== item.documentTypeCode) return false;
        if (item.subjectKind === null) return true;
        if (document.subject_kind !== item.subjectKind) return false;
        return item.subjectId === null || Number(document.subject_id) === item.subjectId;
      });

      if (answer) matched.set(item.itemId, answer.id);
      else outstanding.push(item.instruction);
    }

    if (outstanding.length > 0) {
      return {
        ok: false,
        reason: "outstanding",
        message:
          outstanding.length === 1
            ? "One item still needs a document."
            : `${outstanding.length} items still need a document.`,
        outstanding,
      } as const;
    }

    const now = new Date();

    for (const [itemId, documentId] of matched) {
      await tx
        .updateTable("deficiency_items")
        .set({ resolved_at: now, resolved_document_id: documentId })
        .where("id", "=", itemId)
        .where("resolved_at", "is", null)
        .execute();
    }

    // Field and instruction items carry no mechanical proof, so they are
    // resolved by the applicant's declaration that they are done. Recorded
    // rather than left null, so the officer sees the applicant asserting each
    // one — and scoped away from documents, every one of which was matched to
    // a replacement above or the transition would already have refused.
    await tx
      .updateTable("deficiency_items")
      .set({ resolved_at: now })
      .where("deficiency_id", "=", deficiency.id)
      .where("kind", "!=", "document")
      .where("resolved_at", "is", null)
      .execute();

    const answered = await tx
      .updateTable("application_deficiencies")
      .set({ state: "answered", answered_at: now })
      .where("id", "=", deficiency.id)
      .where("state", "=", "open")
      .executeTakeFirst();

    if (Number(answered.numUpdatedRows) !== 1) {
      return {
        ok: false,
        reason: "nothing_open",
        message: "This round has already been answered. Reload the page.",
        outstanding: [],
      } as const;
    }

    const resumed = await resumeSlaClock(tx, {
      applicationId,
      pauseId: deficiency.slaPauseId,
      at: now,
    });

    await moveState(tx, {
      applicationId,
      fromState: state,
      fromVersion: Number(application.version),
      toState: "UNDER_VERIFICATION",
    });

    await recordTransition(tx, actor, {
      applicationId,
      fromState: state,
      toState: "UNDER_VERIFICATION",
      transitionCode: "applicant_responded",
      reason: `Answered deficiency round ${deficiency.round}`,
    });

    const revision =
      application.form_revision_id ??
      (
        await tx
          .selectFrom("form_revisions")
          .select(["id"])
          .orderBy("id", "desc")
          .executeTakeFirstOrThrow()
      ).id;

    const snapshot = await writeSubmissionSnapshot(tx, {
      applicationId,
      formRevisionId: revision,
      createdBy: actor.userId,
      requestId: actor.requestId,
    });

    const checklistRound = await openNextChecklistRound(tx, actor, applicationId, revision);

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.deficiency_answered",
        summary:
          `Deficiency round ${deficiency.round} answered; verification round ` +
          `${checklistRound} opened and the clock resumed.`,
        after: {
          deficiencyRound: deficiency.round,
          snapshotRound: snapshot.round,
          snapshotSha256: snapshot.sha256,
          checklistRound,
          resumedWorkingDaysCost: resumed.costWorkingDays,
          dueDate: resumed.dueDate,
          resolved: [...matched.entries()].map(([itemId, documentId]) => ({
            itemId,
            documentId,
          })),
        },
        formRevisionId: revision,
      },
      tx,
    );

    return {
      ok: true,
      round: deficiency.round,
      snapshotRound: snapshot.round,
      checklistRound,
      dueDate: resumed.dueDate,
      pausedWorkingDays: resumed.costWorkingDays,
    } as const;
  });
}

/**
 * Open the round that will judge the replacements.
 *
 * A copy of `verification.ts`'s own round opener rather than an import, and
 * deliberately so: importing it would make `deficiency.ts` and
 * `verification.ts` mutually dependent, since verification already needs this
 * module's unlock rules. Thirty lines of duplication is the cheaper of the two
 * costs, and the unique key on (application_id, round) is what actually keeps
 * the two implementations honest — a disagreement produces a duplicate-key
 * error rather than two live rounds.
 */
async function openNextChecklistRound(
  tx: Queryable,
  actor: ActorContext,
  applicationId: number,
  formRevisionId: number,
): Promise<number> {
  const previous = await tx
    .selectFrom("verification_checklists")
    .select(["round"])
    .where("application_id", "=", applicationId)
    .orderBy("round", "desc")
    .executeTakeFirst();

  await tx
    .updateTable("verification_checklists")
    .set({ state: "superseded" })
    .where("application_id", "=", applicationId)
    .where("state", "=", "completed")
    .execute();

  const round = Number(previous?.round ?? 0) + 1;

  await tx
    .insertInto("verification_checklists")
    .values({
      application_id: applicationId,
      round,
      form_revision_id: formRevisionId,
      state: "in_progress",
      // Started by the applicant's return rather than by an officer: nobody
      // has picked it up yet, and recording the applicant as the starter of a
      // staff checklist would be a lie in the audit trail.
      started_by: null,
      started_at: new Date(),
      request_id: actor.requestId,
    })
    .execute();

  return round;
}

/* -------------------------------------------------------------------------- */
/* What the applicant still owes, for their own screen                        */
/* -------------------------------------------------------------------------- */

export interface OutstandingItem {
  readonly itemId: number;
  readonly instruction: string;
  readonly kind: DeficiencyItemKind;
  readonly documentTypeCode: string | null;
  readonly subjectKind: DocumentSubjectKind | null;
  readonly subjectId: number | null;
  readonly fieldName: string | null;
  readonly answered: boolean;
}

/**
 * The deficiency list as the applicant sees it, with each item's progress.
 *
 * Progress is computed from the documents actually on the application rather
 * than from a flag, so a re-upload shows as answered the moment it lands — no
 * save step, no stale tick, nothing for the applicant to wonder about while
 * their bank certificate sits in a queue.
 */
export async function outstandingFor(
  db: Queryable,
  applicationId: number,
): Promise<{ deficiency: OpenDeficiency; items: readonly OutstandingItem[] } | null> {
  const deficiency = await loadOpenDeficiency(db, applicationId);
  if (!deficiency) return null;

  const replacements = await db
    .selectFrom("documents")
    .select(["id", "document_type_code", "subject_kind", "subject_id"])
    .where("application_id", "=", applicationId)
    .where("deleted_at", "is", null)
    .where("review_state", "!=", "superseded")
    .where("uploaded_at", ">=", deficiency.raisedAt)
    .execute();

  const documents: OutstandingItem[] = deficiency.documents.map((item) => ({
    itemId: item.itemId,
    instruction: item.instruction,
    kind: "document" as const,
    documentTypeCode: item.documentTypeCode,
    subjectKind: item.subjectKind,
    subjectId: item.subjectId,
    fieldName: null,
    answered:
      item.resolvedDocumentId !== null ||
      replacements.some((document) => {
        if (document.document_type_code !== item.documentTypeCode) return false;
        if (item.subjectKind === null) return true;
        if (document.subject_kind !== item.subjectKind) return false;
        return item.subjectId === null || Number(document.subject_id) === item.subjectId;
      }),
  }));

  const fields: OutstandingItem[] = deficiency.fields.map((item) => ({
    itemId: item.itemId,
    instruction: item.instruction,
    kind: "field" as const,
    documentTypeCode: null,
    subjectKind: null,
    subjectId: null,
    fieldName: item.fieldName,
    // A field correction cannot be detected: the applicant may legitimately
    // conclude the figure was right as filed. Shown as something to confirm
    // rather than something to tick off.
    answered: false,
  }));

  const other: OutstandingItem[] = deficiency.other.map((item) => ({
    itemId: item.itemId,
    instruction: item.instruction,
    kind: "other" as const,
    documentTypeCode: null,
    subjectKind: null,
    subjectId: null,
    fieldName: null,
    answered: false,
  }));

  return { deficiency, items: [...documents, ...fields, ...other] };
}

/** Whether the applicant's own completeness check would also pass. */
export async function documentsStillComplete(
  db: Queryable,
  applicationId: number,
): Promise<boolean> {
  const report = await checkCompleteness(db, applicationId);
  return report.documentsComplete;
}

/** Count of applications waiting on an applicant, for the dashboard. */
export async function openDeficiencyCount(db: Queryable = getDb()): Promise<number> {
  const rows = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM application_deficiencies WHERE state = 'open'
  `.execute(db);
  return Number(rows.rows[0]?.n ?? 0);
}
