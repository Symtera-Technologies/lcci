import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  ApplicationState,
  ChecklistItemOutcome,
  ChecklistOutcome,
  ChecklistPolarity,
  ChecklistState,
  ChecklistSystemVerdict,
} from "@/db/schema";
import { ConcurrencyError, ForbiddenError, requirePermission, type ActorContext } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { moveState, recordTransition } from "@/membership/applications";
import {
  checklistOutcome,
  disagreements,
  failedItems,
  markFor,
  outcomeFor,
  suggestNotApplicable,
  systemOpinion,
  type ChecklistFacts,
  type ItemDocumentTypes,
} from "@/membership/checklist";
import { canTransition, type TransitionActorView } from "@/membership/workflow";
import { gatherFacts } from "@/membership/submit";

/**
 * Verification: the thirteen items, as a round the officer signs.
 *
 * Three rules govern everything in this file, and all three come from the fact
 * that page 5 of the form is a controlled document with a staff signature on
 * it.
 *
 * **A round is opened, decided, and then frozen.** There is no edit path. An
 * officer who changes their mind opens round N+1, which supersedes the one
 * before it, and an auditor reading the application sees both judgements in
 * order. `completeChecklist` is therefore a one-way door, guarded on
 * `state = 'in_progress'` and decided by the affected-row count.
 *
 * **The polarity conversion happens once.** In `checklist.ts`, which is pure
 * and tested. Nothing here re-derives what a tick means.
 *
 * **The machine advises and the officer decides, and the record keeps both.**
 * Every item stores the system's verdict beside the officer's outcome, so
 * "somebody passed an item the system said was failing" is a query rather
 * than an archaeology exercise.
 */

/* -------------------------------------------------------------------------- */
/* Facts                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the machine needs to form its opinions.
 *
 * Reads the application's **frozen** document matrix, not the live one in
 * `document_requirements`. The office's matrix will change; an application
 * already in flight has to be judged against the list it was told to satisfy,
 * or a policy edit retroactively turns a complete application deficient and
 * the officer is shown a failure the applicant could not have avoided.
 */
export async function gatherChecklistFacts(
  db: Queryable,
  applicationId: number,
): Promise<ChecklistFacts> {
  const [facts, matrix, counts, certificate] = await Promise.all([
    gatherFacts(db, applicationId),
    db
      .selectFrom("application_required_documents")
      .select(["document_type_code", "cardinality", "required_count"])
      .where("application_id", "=", applicationId)
      .execute(),
    sql<{ document_type_code: string; n: number }>`
      SELECT document_type_code, COUNT(*) AS n
        FROM documents
       WHERE application_id = ${applicationId}
         AND deleted_at IS NULL
         AND review_state <> 'superseded'
       GROUP BY document_type_code
    `.execute(db),
    // The age control on the bank account-maintenance certificate: the form
    // says "not older than three months", and `max_age_days` carries that as
    // reference data rather than as a constant here, because three months is
    // chamber policy. The newest live certificate is the one that counts — a
    // re-upload answering a deficiency supersedes its predecessor, so the
    // superseded one's age is not a reason to fail the round.
    sql<{ issued_on: string | null; max_age_days: number | null }>`
      SELECT d.issued_on, t.max_age_days
        FROM documents d
        JOIN document_types t ON t.code = d.document_type_code
       WHERE d.application_id = ${applicationId}
         AND d.document_type_code = 'bank_certificate'
         AND d.deleted_at IS NULL
         AND d.review_state <> 'superseded'
       ORDER BY d.uploaded_at DESC
       LIMIT 1
    `.execute(db),
  ]);

  const supplied = new Map(counts.rows.map((row) => [row.document_type_code, Number(row.n)]));
  const row = certificate.rows[0];

  let ageDays: number | null = null;
  if (row?.issued_on) {
    const issued = Date.parse(`${String(row.issued_on).slice(0, 10)}T00:00:00Z`);
    if (!Number.isNaN(issued)) {
      ageDays = Math.floor((Date.now() - issued) / 86_400_000);
    }
  }

  return {
    formComplete: facts.formComplete,
    documents: matrix.map((item) => ({
      documentTypeCode: item.document_type_code,
      required: item.cardinality !== "optional",
      requiredCount: Number(item.required_count),
      suppliedCount: supplied.get(item.document_type_code) ?? 0,
    })),
    hasProposer: facts.hasProposer,
    hasSeconder: facts.hasSeconder,
    endorsersInGoodStanding: facts.endorsersInGoodStanding,
    bankCertificateAgeDays: ageDays,
    bankCertificateMaxAgeDays: row?.max_age_days === null || row?.max_age_days === undefined
      ? null
      : Number(row.max_age_days),
  };
}

/* -------------------------------------------------------------------------- */
/* Definitions                                                                */
/* -------------------------------------------------------------------------- */

export interface ChecklistDefinition {
  readonly id: number;
  readonly code: string;
  readonly ordinal: number;
  readonly labelEn: string;
  readonly polarity: ChecklistPolarity;
  readonly requiresDocumentView: boolean;
  readonly noteRequiredOnFail: boolean;
  readonly documentTypeCodes: readonly string[];
}

/**
 * The item set for one form revision.
 *
 * Keyed by revision, so a 2026 application keeps the thirteen items as they
 * were worded when its officer read them. The application carries the revision
 * it was submitted against; a draft that has none yet falls back to the latest,
 * which is the only sensible answer for an application that has not been
 * frozen to a revision at all.
 */
export async function loadDefinitions(
  db: Queryable,
  formRevisionId: number | null,
): Promise<readonly ChecklistDefinition[]> {
  const revision =
    formRevisionId ??
    (
      await db
        .selectFrom("form_revisions")
        .select(["id"])
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow()
    ).id;

  const [rows, links] = await Promise.all([
    db
      .selectFrom("checklist_item_definitions")
      .select([
        "id",
        "code",
        "ordinal",
        "label_en",
        "polarity",
        "requires_document_view",
        "note_required_on_fail",
      ])
      .where("form_revision_id", "=", revision)
      .where("active", "=", 1)
      .orderBy("ordinal", "asc")
      .execute(),
    db
      .selectFrom("checklist_item_document_types")
      .innerJoin(
        "checklist_item_definitions",
        "checklist_item_definitions.id",
        "checklist_item_document_types.definition_id",
      )
      .select([
        "checklist_item_definitions.code as code",
        "checklist_item_document_types.document_type_code as document_type_code",
      ])
      .where("checklist_item_definitions.form_revision_id", "=", revision)
      .execute(),
  ]);

  const byCode = new Map<string, string[]>();
  for (const link of links) {
    (byCode.get(link.code) ?? byCode.set(link.code, []).get(link.code)!).push(
      link.document_type_code,
    );
  }

  return rows.map((row) => ({
    id: Number(row.id),
    code: row.code,
    ordinal: Number(row.ordinal),
    labelEn: row.label_en,
    polarity: row.polarity,
    requiresDocumentView: Number(row.requires_document_view) === 1,
    noteRequiredOnFail: Number(row.note_required_on_fail) === 1,
    documentTypeCodes: (byCode.get(row.code) ?? []).slice().sort(),
  }));
}

function documentTypeMap(
  definitions: readonly ChecklistDefinition[],
): ItemDocumentTypes {
  return new Map(definitions.map((item) => [item.code, item.documentTypeCodes]));
}

/* -------------------------------------------------------------------------- */
/* The view the screen renders                                                */
/* -------------------------------------------------------------------------- */

export interface ChecklistCandidateDocument {
  readonly id: string;
  readonly documentTypeCode: string;
  readonly typeLabel: string;
  readonly label: string;
  /** Whose document it is — "B. Partner", or null for a company document. */
  readonly subjectLabel: string | null;
  readonly mimeType: string;
  /** Whether the browser can render it; everything else downloads. */
  readonly viewable: boolean;
  /** Whether this officer has opened it, from `document_access_log`. */
  readonly viewed: boolean;
}

/** The four formats the ingester accepts; everything else downloads. */
const VIEWABLE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ChecklistItemView {
  readonly code: string;
  readonly ordinal: number;
  readonly labelEn: string;
  readonly polarity: ChecklistPolarity;
  /** Null until the officer has decided it. */
  readonly outcome: ChecklistItemOutcome | null;
  readonly marked: boolean;
  readonly note: string | null;
  readonly systemVerdict: ChecklistSystemVerdict;
  readonly systemBecause: string | null;
  readonly suggestNotApplicable: boolean;
  readonly requiresDocumentView: boolean;
  readonly noteRequiredOnFail: boolean;
  readonly candidateDocuments: readonly ChecklistCandidateDocument[];
  readonly linkedDocumentIds: readonly string[];
  readonly decidedAt: Date | null;
}

export interface ChecklistRoundView {
  readonly id: number;
  readonly round: number;
  readonly state: ChecklistState;
  readonly outcome: ChecklistOutcome | null;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly completedByName: string | null;
  readonly completedByRole: string | null;
  readonly items: readonly ChecklistItemView[];
}

export interface VerificationView {
  readonly applicationId: number;
  readonly publicRef: string | null;
  readonly firmName: string | null;
  readonly state: ApplicationState;
  readonly version: number;
  /** The open round, or null when none is open. */
  readonly current: ChecklistRoundView | null;
  /** Completed and superseded rounds, newest first. */
  readonly history: readonly ChecklistRoundView[];
  readonly facts: ChecklistFacts;
  /** Whether this actor could open a round right now, and why not. */
  readonly canStart: boolean;
  readonly startBlockedBecause: readonly string[];
  /** Items still undecided in the open round. */
  readonly undecidedCodes: readonly string[];
}

/**
 * Everything the checklist screen needs, in one load.
 *
 * Separate from `loadForReview` rather than folded into it, because the review
 * screen is read by anyone with `application.read` — a cashier included — and
 * the checklist is the verifier's working surface. Keeping them apart means the
 * cashier's page object never contains an officer's half-finished findings.
 */
export async function loadVerification(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<VerificationView | null> {
  requirePermission(actor, "application.read");

  const application = await db
    .selectFrom("applications")
    .leftJoin("application_company", "application_company.application_id", "applications.id")
    .select([
      "applications.id as id",
      "applications.public_ref as public_ref",
      "applications.state as state",
      "applications.version as version",
      "applications.form_revision_id as form_revision_id",
      "application_company.firm_name as firm_name",
    ])
    .where("applications.id", "=", applicationId)
    .executeTakeFirst();

  if (!application) return null;

  const [definitions, facts, rounds] = await Promise.all([
    loadDefinitions(db, application.form_revision_id),
    gatherChecklistFacts(db, applicationId),
    db
      .selectFrom("verification_checklists")
      .leftJoin("users", "users.id", "verification_checklists.completed_by")
      .select([
        "verification_checklists.id as id",
        "verification_checklists.round as round",
        "verification_checklists.state as state",
        "verification_checklists.outcome as outcome",
        "verification_checklists.started_at as started_at",
        "verification_checklists.completed_at as completed_at",
        "verification_checklists.completed_by_role_code as completed_by_role_code",
        "users.full_name as completed_by_name",
      ])
      .where("verification_checklists.application_id", "=", applicationId)
      .orderBy("verification_checklists.round", "desc")
      .execute(),
  ]);

  const checklistIds = rounds.map((round) => Number(round.id));

  const [items, links, candidates, views] = await Promise.all([
    checklistIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("verification_checklist_items")
          .select([
            "id",
            "checklist_id",
            "item_code",
            "ordinal",
            "label_en",
            "polarity",
            "marked",
            "outcome",
            "note",
            "system_verdict",
            "decided_at",
          ])
          .where("checklist_id", "in", checklistIds)
          .execute(),
    checklistIds.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom("verification_item_documents")
          .innerJoin(
            "verification_checklist_items",
            "verification_checklist_items.id",
            "verification_item_documents.checklist_item_id",
          )
          .select([
            "verification_item_documents.checklist_item_id as checklist_item_id",
            "verification_item_documents.document_id as document_id",
          ])
          .where("verification_checklist_items.checklist_id", "in", checklistIds)
          .execute(),
    // The documents an item could possibly be about. Live only: a superseded
    // scan is not what the officer is being asked to judge.
    db
      .selectFrom("documents")
      .leftJoin("application_directors", "application_directors.id", "documents.subject_id")
      .leftJoin("document_types", "document_types.code", "documents.document_type_code")
      .select([
        "documents.id as id",
        "documents.document_type_code as document_type_code",
        "documents.original_filename as original_filename",
        "documents.mime_type as mime_type",
        "documents.subject_kind as subject_kind",
        "documents.subject_id as subject_id",
        "document_types.label_en as type_label",
        "application_directors.full_name as director_name",
        "application_directors.position as director_position",
      ])
      .where("documents.application_id", "=", applicationId)
      .where("documents.deleted_at", "is", null)
      .where("documents.review_state", "!=", "superseded")
      .orderBy("documents.uploaded_at", "asc")
      .execute(),
    // Which of them this officer has actually opened. Item 3 is completable
    // only against a document that appears here, which is the whole reason
    // `document_access_log` is written on every fetch.
    actor.userId === null
      ? Promise.resolve({ rows: [] as { document_id: string }[] })
      : sql<{ document_id: string }>`
          SELECT DISTINCT l.document_id
            FROM document_access_log l
            JOIN documents d ON d.id = l.document_id
           WHERE d.application_id = ${applicationId}
             AND l.user_id = ${actor.userId}
             AND l.outcome = 'served'
        `.execute(db),
  ]);

  const viewed = new Set(views.rows.map((row) => row.document_id));

  const linksByItem = new Map<number, string[]>();
  for (const link of links) {
    const key = Number(link.checklist_item_id);
    (linksByItem.get(key) ?? linksByItem.set(key, []).get(key)!).push(link.document_id);
  }

  const typeMap = documentTypeMap(definitions);

  const candidatesByType = new Map<string, ChecklistCandidateDocument[]>();
  for (const document of candidates) {
    const subjectLabel =
      document.subject_kind === "director"
        ? (document.director_name ??
          (document.director_position === null
            ? null
            : `Director ${Number(document.director_position) + 1}`))
        : null;

    const entry: ChecklistCandidateDocument = {
      id: document.id,
      documentTypeCode: document.document_type_code,
      typeLabel: document.type_label ?? document.document_type_code,
      label: document.original_filename,
      subjectLabel,
      mimeType: document.mime_type,
      viewable: VIEWABLE_TYPES.has(document.mime_type),
      viewed: viewed.has(document.id),
    };

    const list = candidatesByType.get(document.document_type_code);
    if (list) list.push(entry);
    else candidatesByType.set(document.document_type_code, [entry]);
  }

  function roundView(round: (typeof rounds)[number]): ChecklistRoundView {
    const recorded = new Map(
      items
        .filter((item) => Number(item.checklist_id) === Number(round.id))
        .map((item) => [item.item_code, item]),
    );

    return {
      id: Number(round.id),
      round: Number(round.round),
      state: round.state,
      outcome: round.outcome,
      startedAt: new Date(round.started_at),
      completedAt: round.completed_at === null ? null : new Date(round.completed_at),
      completedByName: round.completed_by_name ?? null,
      completedByRole: round.completed_by_role_code ?? null,
      items: definitions.map((definition) => {
        const item = recorded.get(definition.code);
        const opinion = systemOpinion(definition.code, facts, typeMap);

        // A decided item keeps the words, polarity and verdict it was decided
        // under; only an undecided one borrows them from the definitions.
        const polarity = item?.polarity ?? definition.polarity;
        const outcome = item?.outcome ?? null;

        return {
          code: definition.code,
          ordinal: Number(item?.ordinal ?? definition.ordinal),
          labelEn: item?.label_en ?? definition.labelEn,
          polarity,
          outcome,
          marked: outcome === null ? false : markFor(polarity, outcome),
          note: item?.note ?? null,
          systemVerdict: item?.system_verdict ?? opinion.verdict,
          systemBecause: opinion.because,
          suggestNotApplicable:
            outcome === null && suggestNotApplicable(definition.code, facts, typeMap),
          requiresDocumentView: definition.requiresDocumentView,
          noteRequiredOnFail: definition.noteRequiredOnFail,
          candidateDocuments: definition.documentTypeCodes.flatMap(
            (code) => candidatesByType.get(code) ?? [],
          ),
          linkedDocumentIds: item ? (linksByItem.get(Number(item.id)) ?? []) : [],
          decidedAt: item?.decided_at === undefined || item === undefined
            ? null
            : new Date(item.decided_at),
        };
      }),
    };
  }

  const all = rounds.map(roundView);
  const current = all.find((round) => round.state === "in_progress") ?? null;

  const state = application.state as ApplicationState;
  const actorView = toActorView(actor);
  const startDecision = canTransition(
    { ...(await gatherFacts(db, applicationId)), state },
    state === "SUBMITTED" ? "begin_verification" : "mark_verified",
    actorView,
  );

  return {
    applicationId: Number(application.id),
    publicRef: application.public_ref,
    firmName: application.firm_name,
    state,
    version: Number(application.version),
    current,
    history: all.filter((round) => round.state !== "in_progress"),
    facts,
    canStart: current === null && state === "SUBMITTED" && startDecision.allowed,
    startBlockedBecause:
      state === "SUBMITTED"
        ? startDecision.missingPermission
          ? ["You do not hold the permission to verify applications."]
          : startDecision.reasons
        : [],
    undecidedCodes:
      current === null
        ? []
        : current.items.filter((item) => item.outcome === null).map((item) => item.code),
  };
}

function toActorView(actor: ActorContext): TransitionActorView {
  return {
    userId: actor.userId,
    isStaff: actor.userType === "staff",
    isSystem: actor.userId === null,
    permissions: actor.permissions,
  };
}

/* -------------------------------------------------------------------------- */
/* Opening a round                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Open the next round, inside the caller's transaction.
 *
 * The round number comes from `MAX(round) + 1` under the unique key, not from a
 * counter: two officers opening round 2 at the same instant both compute 2, and
 * one of them gets a duplicate-key error. That error is the correct outcome and
 * is translated by the callers into "somebody else has already started this
 * round" rather than being prevented by a lock nobody would otherwise need.
 */
async function openRound(
  tx: Queryable,
  actor: ActorContext,
  applicationId: number,
  formRevisionId: number | null,
): Promise<{ checklistId: number; round: number }> {
  const previous = await tx
    .selectFrom("verification_checklists")
    .select(["id", "round", "state"])
    .where("application_id", "=", applicationId)
    .orderBy("round", "desc")
    .executeTakeFirst();

  if (previous?.state === "in_progress") {
    return { checklistId: Number(previous.id), round: Number(previous.round) };
  }

  // Everything before the new round is history. Done before the insert, so a
  // crash between the two leaves the old round standing rather than leaving
  // two rounds claiming to be current.
  await tx
    .updateTable("verification_checklists")
    .set({ state: "superseded" })
    .where("application_id", "=", applicationId)
    .where("state", "=", "completed")
    .execute();

  const revision =
    formRevisionId ??
    (
      await tx
        .selectFrom("form_revisions")
        .select(["id"])
        .orderBy("id", "desc")
        .executeTakeFirstOrThrow()
    ).id;

  const round = Number(previous?.round ?? 0) + 1;

  const inserted = await tx
    .insertInto("verification_checklists")
    .values({
      application_id: applicationId,
      round,
      form_revision_id: revision,
      state: "in_progress",
      started_by: actor.userId,
      started_at: new Date(),
      request_id: actor.requestId,
    })
    .executeTakeFirst();

  return { checklistId: Number(inserted.insertId), round };
}

export interface BeginVerificationResult {
  readonly checklistId: number;
  readonly round: number;
}

/**
 * Pick the application up: SUBMITTED → UNDER_VERIFICATION, and open round 1.
 *
 * Deliberately unguarded beyond the permission, because verification is how
 * deficiencies are found. A guard requiring the application to be sound before
 * it can be examined would be a loop with no entrance.
 */
export async function beginVerification(
  actor: ActorContext,
  applicationId: number,
): Promise<BeginVerificationResult> {
  requirePermission(actor, "application.verify");

  return transaction(async (tx) => {
    const application = await tx
      .selectFrom("applications")
      .select(["id", "state", "version", "form_revision_id"])
      .where("id", "=", applicationId)
      .executeTakeFirst();

    if (!application) {
      throw new ForbiddenError(null, "That application could not be found.");
    }

    const state = application.state as ApplicationState;
    const facts = await gatherFacts(tx, applicationId);
    const decision = canTransition({ ...facts, state }, "begin_verification", toActorView(actor));

    if (!decision.allowed) {
      throw new ForbiddenError(
        decision.missingPermission,
        decision.reasons[0] ??
          "This application cannot be taken up for verification from its current state.",
      );
    }

    await moveState(tx, {
      applicationId,
      fromState: state,
      fromVersion: Number(application.version),
      toState: "UNDER_VERIFICATION",
      // Picking it up claims it, if nobody else has. Not a version bump of its
      // own: see the note in assignment.ts about why assignment must not make
      // a colleague's in-flight work fail with "this has changed, reload".
      set: actor.userId === null ? {} : { assigned_to: actor.userId },
    });

    await recordTransition(tx, actor, {
      applicationId,
      fromState: state,
      toState: "UNDER_VERIFICATION",
      transitionCode: "begin_verification",
    });

    const opened = await openRound(tx, actor, applicationId, application.form_revision_id);

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.verification_started",
        summary: `Verification round ${opened.round} opened.`,
        after: { round: opened.round, checklistId: opened.checklistId },
      },
      tx,
    );

    return opened;
  });
}

/* -------------------------------------------------------------------------- */
/* Deciding one item                                                          */
/* -------------------------------------------------------------------------- */

export interface SaveItemInput {
  readonly itemCode: string;
  readonly marked: boolean;
  readonly notApplicable: boolean;
  readonly note: string | null;
  readonly documentIds: readonly string[];
}

export interface SaveChecklistInput {
  readonly applicationId: number;
  readonly items: readonly SaveItemInput[];
}

export type ItemRefusal = "note_required" | "unknown_item" | "not_viewed";

export interface SaveChecklistResult {
  readonly ok: boolean;
  /** Set when there is no open round to save into. */
  readonly noOpenRound: boolean;
  /** Items that could not be recorded, with what to tell the officer. */
  readonly refusals: readonly {
    readonly itemCode: string;
    readonly ordinal: number;
    readonly reason: ItemRefusal;
    readonly message: string;
  }[];
  readonly savedCount: number;
}

/**
 * Record the officer's decisions on the open round, all of them, at once.
 *
 * Bulk rather than one call per item, and the reason is the host rather than
 * taste: each item needs the definition set and the machine's facts before it
 * can be decided, and thirteen separate transactions doing that is roughly a
 * hundred and fifty queries against a pool of three connections — which on
 * shared cPanel is a self-inflicted stall every time somebody saves a
 * checklist. Loaded once, applied thirteen times.
 *
 * Refusals are per item and are values rather than exceptions, because each
 * one is something the officer fixes on the page. The acceptable items still
 * save: somebody who wrote twelve notes and forgot the thirteenth should not
 * lose twelve.
 *
 * The polarity comes from the **definition**, never from the form. A screen
 * that posted the polarity alongside the tick would be one tampered request
 * away from recording "signatures do not match with CNIC" as a pass.
 */
export async function saveChecklist(
  actor: ActorContext,
  input: SaveChecklistInput,
): Promise<SaveChecklistResult> {
  requirePermission(actor, "application.verify");

  return transaction(async (tx) => {
    const checklist = await tx
      .selectFrom("verification_checklists")
      .select(["id", "round", "form_revision_id"])
      .where("application_id", "=", input.applicationId)
      .where("state", "=", "in_progress")
      .executeTakeFirst();

    if (!checklist) {
      return { ok: false, noOpenRound: true, refusals: [], savedCount: 0 };
    }

    const definitions = await loadDefinitions(tx, checklist.form_revision_id);
    const byCode = new Map(definitions.map((item) => [item.code, item]));
    const facts = await gatherChecklistFacts(tx, input.applicationId);
    const typeMap = documentTypeMap(definitions);

    // Which documents on this application are live, and which types this
    // officer has actually opened. Both answered once for the whole save.
    const live = new Set(
      (
        await tx
          .selectFrom("documents")
          .select(["id"])
          .where("application_id", "=", input.applicationId)
          .where("deleted_at", "is", null)
          .where("review_state", "!=", "superseded")
          .execute()
      ).map((row) => row.id),
    );

    const viewedTypes = new Set(
      actor.userId === null
        ? []
        : (
            await sql<{ document_type_code: string }>`
              SELECT DISTINCT d.document_type_code
                FROM document_access_log l
                JOIN documents d ON d.id = l.document_id
               WHERE d.application_id = ${input.applicationId}
                 AND l.user_id = ${actor.userId}
                 AND l.outcome = 'served'
            `.execute(tx)
          ).rows.map((row) => row.document_type_code),
    );

    const refusals: {
      itemCode: string;
      ordinal: number;
      reason: ItemRefusal;
      message: string;
    }[] = [];
    const now = new Date();
    let savedCount = 0;

    for (const posted of input.items) {
      const definition = byCode.get(posted.itemCode);

      if (!definition) {
        refusals.push({
          itemCode: posted.itemCode,
          ordinal: 0,
          reason: "unknown_item",
          message: "That checklist item is not part of this form revision.",
        });
        continue;
      }

      const outcome = outcomeFor(definition.polarity, {
        marked: posted.marked,
        notApplicable: posted.notApplicable,
      });

      const note = posted.note === null ? null : posted.note.trim() || null;

      if (outcome === "fail" && definition.noteRequiredOnFail && note === null) {
        refusals.push({
          itemCode: definition.code,
          ordinal: definition.ordinal,
          reason: "note_required",
          message:
            "Say what is wrong. This sentence is what the applicant is sent, " +
            `and “item ${definition.ordinal} failed” is not something ` +
            "they can act on.",
        });
        continue;
      }

      if (
        definition.requiresDocumentView &&
        outcome !== "not_applicable" &&
        !definition.documentTypeCodes.some((code) => viewedTypes.has(code))
      ) {
        refusals.push({
          itemCode: definition.code,
          ordinal: definition.ordinal,
          reason: "not_viewed",
          message:
            "Open the scan before deciding this item. A record saying an " +
            "identity document is legible, written by somebody who never " +
            "opened it, is worse than no record at all.",
        });
        continue;
      }

      const opinion = systemOpinion(definition.code, facts, typeMap);

      await tx
        .insertInto("verification_checklist_items")
        .values({
          checklist_id: Number(checklist.id),
          item_code: definition.code,
          ordinal: definition.ordinal,
          label_en: definition.labelEn,
          polarity: definition.polarity,
          marked: posted.marked ? 1 : 0,
          outcome,
          note,
          system_verdict: opinion.verdict,
          decided_by: actor.userId,
          decided_at: now,
        })
        .onDuplicateKeyUpdate({
          marked: posted.marked ? 1 : 0,
          outcome,
          note,
          system_verdict: opinion.verdict,
          decided_by: actor.userId,
          decided_at: now,
          // The wording and polarity are deliberately *not* refreshed: an item
          // already decided keeps the sentence its officer read, even after
          // the definition has been reworded under a later revision.
        })
        .execute();

      const itemRow = await tx
        .selectFrom("verification_checklist_items")
        .select(["id"])
        .where("checklist_id", "=", Number(checklist.id))
        .where("item_code", "=", definition.code)
        .executeTakeFirstOrThrow();

      // The documents named must still be live on this application. Filtered
      // rather than refused: a page left open while a scan was superseded is
      // an ordinary race, and dropping the stale link beats making the officer
      // re-enter twelve other items.
      const allowed = posted.documentIds.filter((id) => live.has(id));

      await tx
        .deleteFrom("verification_item_documents")
        .where("checklist_item_id", "=", Number(itemRow.id))
        .execute();

      if (allowed.length > 0) {
        await tx
          .insertInto("verification_item_documents")
          .values(
            allowed.map((documentId) => ({
              checklist_item_id: Number(itemRow.id),
              document_id: documentId,
            })),
          )
          .execute();
      }

      savedCount += 1;
    }

    // No audit event here, on purpose. One event per *completed* round carries
    // all thirteen items, and a round is immutable once completed — so
    // per-save events would be hash-chained noise describing a working surface
    // nobody audits, written while the officer is still thinking. The round's
    // own completion event is the record.
    return {
      ok: refusals.length === 0,
      noOpenRound: false,
      refusals,
      savedCount,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Completing the round                                                       */
/* -------------------------------------------------------------------------- */

export interface CompleteChecklistResult {
  readonly ok: boolean;
  readonly outcome: ChecklistOutcome | null;
  readonly undecided: readonly number[];
  readonly message: string | null;
}

/**
 * Sign the round off. One way, no edits afterwards.
 *
 * Every active item must be decided first: an untouched item on a defect row
 * would otherwise read as "no defect found" by omission, and the record would
 * assert a judgement nobody made. The guard is on `state = 'in_progress'` in
 * the UPDATE and is decided by the affected-row count, so two officers
 * completing the same round produce one completion and one "already completed".
 *
 * The outcome is computed here and frozen. It is not recomputed on read,
 * because the items carry the polarity they were decided under and a later
 * revision correcting a polarity must not restate a past officer's conclusion.
 */
export async function completeChecklist(
  actor: ActorContext,
  applicationId: number,
): Promise<CompleteChecklistResult> {
  requirePermission(actor, "application.verify");

  return transaction(async (tx) => {
    const checklist = await tx
      .selectFrom("verification_checklists")
      .select(["id", "round", "form_revision_id"])
      .where("application_id", "=", applicationId)
      .where("state", "=", "in_progress")
      .executeTakeFirst();

    if (!checklist) {
      return {
        ok: false,
        outcome: null,
        undecided: [],
        message:
          "There is no open verification round. Reload the page — this round may already be signed off.",
      };
    }

    const definitions = await loadDefinitions(tx, checklist.form_revision_id);

    const items = await tx
      .selectFrom("verification_checklist_items")
      .select(["item_code", "ordinal", "label_en", "polarity", "marked", "outcome", "note", "system_verdict"])
      .where("checklist_id", "=", Number(checklist.id))
      .execute();

    const decided = new Set(items.map((item) => item.item_code));
    const undecided = definitions
      .filter((definition) => !decided.has(definition.code))
      .map((definition) => definition.ordinal);

    if (undecided.length > 0) {
      return {
        ok: false,
        outcome: null,
        undecided,
        message:
          undecided.length === 1
            ? `Item ${undecided[0]} has not been decided.`
            : `${undecided.length} items have not been decided: ${undecided.join(", ")}.`,
      };
    }

    const outcome = checklistOutcome(items);

    const completed = await tx
      .updateTable("verification_checklists")
      .set({
        state: "completed",
        outcome,
        completed_by: actor.userId,
        completed_at: new Date(),
        completed_by_role_code: actor.roleCode,
      })
      .where("id", "=", Number(checklist.id))
      .where("state", "=", "in_progress")
      .executeTakeFirst();

    if (Number(completed.numUpdatedRows) !== 1) {
      throw new ConcurrencyError("This verification round");
    }

    const normalised = items.map((item) => ({
      code: item.item_code,
      ordinal: Number(item.ordinal),
      label: item.label_en,
      polarity: item.polarity,
      marked: Number(item.marked) === 1,
      outcome: item.outcome,
      note: item.note,
      systemVerdict: item.system_verdict,
    }));

    // One event per completion, carrying every item in full.
    //
    // The whole round in one row because that is the unit the officer signed,
    // and because the two derived arrays are the point: `failed` is what the
    // applicant will be told, and `disagreed` is a machine verdict somebody
    // overrode, which is the most audit-relevant fact on the page.
    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.verification_completed",
        summary: `Verification round ${Number(checklist.round)} completed: ${outcome}.`,
        after: {
          round: Number(checklist.round),
          outcome,
          items: normalised
            .slice()
            .sort((a, b) => a.ordinal - b.ordinal),
          failed: failedItems(normalised).map((item) => item.ordinal),
          disagreed: disagreements(normalised).map((item) => ({
            ordinal: item.ordinal,
            officer: item.outcome,
            system: item.systemVerdict,
          })),
        },
        formRevisionId: Number(checklist.form_revision_id),
      },
      tx,
    );

    return { ok: true, outcome, undecided: [], message: null };
  });
}

/* -------------------------------------------------------------------------- */
/* Leaving verification                                                       */
/* -------------------------------------------------------------------------- */

export type MarkVerifiedResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasons: readonly string[] };

/**
 * UNDER_VERIFICATION → VERIFIED.
 *
 * Guarded by the machine on `checklist_complete` *and* `checklist_clear`,
 * which are different conditions for the reason this whole module exists: a
 * round can be signed off and still record a defect.
 */
export async function markVerified(
  actor: ActorContext,
  applicationId: number,
): Promise<MarkVerifiedResult> {
  requirePermission(actor, "application.verify");

  return transaction(async (tx) => {
    const application = await tx
      .selectFrom("applications")
      .select(["id", "state", "version"])
      .where("id", "=", applicationId)
      .executeTakeFirst();

    if (!application) {
      throw new ForbiddenError(null, "That application could not be found.");
    }

    const state = application.state as ApplicationState;
    const facts = await gatherFacts(tx, applicationId);
    const decision = canTransition({ ...facts, state }, "mark_verified", toActorView(actor));

    if (!decision.allowed) {
      return {
        ok: false,
        reasons: decision.missingPermission
          ? ["You do not hold the permission to verify applications."]
          : decision.reasons.length > 0
            ? decision.reasons
            : ["This application cannot be marked verified from its current state."],
      } as const;
    }

    await moveState(tx, {
      applicationId,
      fromState: state,
      fromVersion: Number(application.version),
      toState: "VERIFIED",
    });

    await recordTransition(tx, actor, {
      applicationId,
      fromState: state,
      toState: "VERIFIED",
      transitionCode: "mark_verified",
    });

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.verified",
        summary: "Documents and particulars verified; awaiting the fee and approval.",
      },
      tx,
    );

    return { ok: true } as const;
  });
}
