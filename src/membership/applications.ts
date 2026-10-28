import "server-only";

import { getDb, sql, transaction, wonRace } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  ApplicationRow,
  ApplicationState,
  EndorsementMode,
  EndorsementRole,
  MembershipClass,
  PremisesTenure,
  ProcessingTier,
} from "@/db/schema";
import { ConcurrencyError, ForbiddenError, type ActorContext } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { sealField } from "@/membership/sensitive";
import {
  DECLARATION_VERSION,
  ENDORSEMENT_DECLARATION,
  applicantDeclarationText,
} from "@/membership/declaration";
import { applicantCanEdit } from "@/membership/workflow";
import { loadOpenDeficiency } from "@/membership/unlock";
import { autosaveSchema, TYPED_FIELD_PARSERS, type AutosaveInput } from "@/membership/validation";

/**
 * Reading and writing an application in progress.
 *
 * Every exported function takes an `ActorContext` first and scopes its own
 * query. That is the boundary: a server action is a publicly addressable
 * endpoint, so a check in the component that renders the form protects the
 * form and nothing else. Ownership is a SQL predicate here, never a
 * post-fetch filter — a filter has already read the row, and the row leaks
 * through a count, an export or a log line.
 */

/** How long an untouched draft survives before the expiry job takes it. */
export const DRAFT_LIFETIME_DAYS = 90;

/* -------------------------------------------------------------------------- */
/* Creating and loading                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Start a draft, or return the one already open.
 *
 * One live draft per applicant. Without this, an applicant who reloads the
 * "start an application" page three times has three drafts, uploads documents
 * into whichever one they happen to be on, and submits an empty one. The
 * office then has three records for one firm and no way to tell which is meant.
 */
export async function startOrResumeDraft(actor: ActorContext): Promise<number> {
  if (actor.userId === null) {
    throw new ForbiddenError(null, "Sign in to start an application.");
  }
  const userId = actor.userId;

  return transaction(async (tx) => {
    const existing = await tx
      .selectFrom("applications")
      .select("id")
      .where("created_by", "=", userId)
      .where("state", "=", "DRAFT")
      .orderBy("id", "desc")
      .executeTakeFirst();

    if (existing) return existing.id;

    const expiresAt = new Date(Date.now() + DRAFT_LIFETIME_DAYS * 86_400_000);

    const inserted = await tx
      .insertInto("applications")
      .values({ created_by: userId, state: "DRAFT", expires_at: expiresAt })
      .executeTakeFirstOrThrow();

    const applicationId = Number(inserted.insertId);

    // Both satellites are created empty alongside the parent, so every later
    // write is an UPDATE. An upsert on every autosave would work too and would
    // mean the "does the row exist" branch is exercised a thousand times per
    // application instead of once.
    await tx.insertInto("application_company").values({ application_id: applicationId }).execute();
    await tx
      .insertInto("application_authorisation")
      .values({ application_id: applicationId })
      .execute();

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.draft_created",
        summary: "Application draft created.",
      },
      tx,
    );

    return applicationId;
  });
}

/**
 * The application this applicant already has in flight, if any.
 *
 * Needed because `startOrResumeDraft` resumes a `DRAFT` and nothing else, so
 * calling it for an applicant whose form is sitting in the verification queue
 * would hand back a brand-new empty draft — and the applicant would be typing
 * a second application while the Chamber reads their first. That is not a
 * hypothetical: AWAITING_APPLICANT is reached by the deficiency round, and the
 * email that announces it sends the applicant straight back to the site.
 *
 * Terminal states are excluded on purpose. A rejected or withdrawn
 * application is history, and an applicant may apply again; an approved one
 * belongs to the member area, not to the wizard.
 */
export async function inFlightApplicationFor(
  actor: ActorContext,
  db: Queryable = getDb(),
): Promise<{ readonly id: number; readonly state: ApplicationState } | null> {
  if (actor.userId === null) return null;

  const row = await db
    .selectFrom("applications")
    .select(["id", "state"])
    .where("created_by", "=", actor.userId)
    .where("state", "not in", [
      "DRAFT",
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
      "DRAFT_EXPIRED",
      "CLOSED_NO_RESPONSE",
    ])
    .orderBy("id", "desc")
    .executeTakeFirst();

  return row ? { id: Number(row.id), state: row.state as ApplicationState } : null;
}

export interface DraftView {
  readonly application: ApplicationRow;
  readonly company: Record<string, unknown> | null;
  readonly businessTypes: readonly string[];
  readonly directors: readonly Record<string, unknown>[];
  readonly endorsements: readonly Record<string, unknown>[];
  readonly documents: readonly Record<string, unknown>[];
  /** What the applicant typed that could not be stored in its column. */
  readonly scratch: Record<string, string>;
}

/**
 * Load an application the actor is entitled to see.
 *
 * Ownership in the `WHERE` clause. A co-director reaching their company's
 * application through `company_users` is a real requirement and is
 * deliberately not here yet: it needs the company record to exist, which
 * happens at approval, and adding the branch now would mean writing an
 * authorisation path with no data to test it against.
 */
export async function loadDraft(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<DraftView | null> {
  if (actor.userId === null) return null;

  const application = await db
    .selectFrom("applications")
    .selectAll()
    .where("id", "=", applicationId)
    .where("created_by", "=", actor.userId)
    .executeTakeFirst();

  if (!application) return null;

  const [company, businessTypes, directors, endorsements, documents] = await Promise.all([
    db
      .selectFrom("application_company")
      .selectAll()
      .where("application_id", "=", applicationId)
      .executeTakeFirst(),
    db
      .selectFrom("application_business_types")
      .select("business_type_code")
      .where("application_id", "=", applicationId)
      .execute(),
    db
      .selectFrom("application_directors")
      .selectAll()
      .where("application_id", "=", applicationId)
      .orderBy("position", "asc")
      .orderBy("id", "asc")
      .execute(),
    db
      .selectFrom("application_endorsements")
      .selectAll()
      .where("application_id", "=", applicationId)
      .where("state", "!=", "superseded")
      .orderBy("role", "asc")
      .execute(),
    db
      .selectFrom("documents")
      .select([
        "id",
        "document_type_code",
        "subject_kind",
        "subject_id",
        "original_filename",
        "mime_type",
        "byte_size",
        "page_count",
        "review_state",
        "uploaded_at",
      ])
      .where("application_id", "=", applicationId)
      .where("deleted_at", "is", null)
      .orderBy("uploaded_at", "asc")
      .execute(),
  ]);

  return {
    application: application as ApplicationRow,
    company: (company as Record<string, unknown> | undefined) ?? null,
    businessTypes: businessTypes.map((row) => row.business_type_code),
    directors: directors as Record<string, unknown>[],
    endorsements: endorsements as Record<string, unknown>[],
    documents: documents as Record<string, unknown>[],
    scratch: readScratch(application.wizard_scratch),
  };
}

/**
 * Parse the scratch column defensively.
 *
 * It is a JSON column written by this application, so it *should* be an object
 * of strings — but it is also the one column whose whole purpose is holding
 * values that did not fit expectations, and a malformed scratch blob must
 * degrade to "no scratch" rather than failing the page that was going to let
 * the applicant fix it.
 */
export function readScratch(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};

  const parsed = typeof value === "string" ? safeParseJson(value) : value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Autosave                                                                   */
/* -------------------------------------------------------------------------- */

/** Which autosave keys map to which `application_company` column. */
const COMPANY_TEXT_COLUMNS = {
  firmName: "firm_name",
  representativeName: "representative_name",
  representativeBirthplace: "representative_birthplace",
  representativeNationality: "representative_nationality",
  postalAddress: "postal_address",
  officePhone1: "office_phone_1",
  officePhone2: "office_phone_2",
  fax: "fax",
  representativeMobile1: "representative_mobile_1",
  representativeMobile2: "representative_mobile_2",
  businessSector: "business_sector",
  businessSubSector: "business_sub_sector",
  mainCommodity: "main_commodity",
  bankName: "bank_name",
  bankBranch: "bank_branch",
} as const;

/** Autosave keys whose value is encrypted before it is stored. */
const ENCRYPTED_COLUMNS = {
  representativeCnic: { enc: "representative_cnic_enc", hmac: "representative_cnic_hmac" },
  representativePassport: {
    enc: "representative_passport_enc",
    hmac: "representative_passport_hmac",
  },
  ntn: { enc: "ntn_enc", hmac: "ntn_hmac" },
  strn: { enc: "strn_enc", hmac: null },
} as const;

const MEMBERSHIP_CLASS_VALUES = new Set<string>(["corporate", "associate"]);
const TIER_VALUES = new Set<string>(["regular", "urgent", "executive"]);
const TENURE_VALUES = new Set<string>(["owned", "rented"]);

export interface SaveResult {
  readonly saved: true;
  /** Fields held in scratch because they do not yet parse. */
  readonly pending: readonly string[];
}

/**
 * Save whatever the applicant has typed so far.
 *
 * The rule this function exists to implement: a value that parses into its
 * typed column goes there, and a value that does not goes into
 * `wizard_scratch` under the same key — it is never discarded and never
 * rejected. "approx 60m" in the turnover box is not an error, it is a person
 * mid-thought, and an autosave that refused it would throw away the rest of
 * the form along with it.
 *
 * A field that later parses clears its own scratch entry, so the two are never
 * both populated and the form always has one answer for what to show.
 */
export async function saveParticulars(
  actor: ActorContext,
  raw: unknown,
): Promise<SaveResult> {
  const input: AutosaveInput = autosaveSchema.parse(raw);

  return transaction(async (tx) => {
    const editable = await requireEditableDraft(tx, actor, input.applicationId);
    const application = editable.row;
    // Everything below reads from `input`, so the filter goes here and nowhere
    // else: one place where an unlocked-field rule can be got wrong, instead
    // of one per column group.
    const writable = onlyUnlocked(input, editable.unlockedFields);

    const companyUpdate: Record<string, unknown> = {};
    const applicationUpdate: Record<string, unknown> = {};
    const scratch = readScratch(application.wizard_scratch);
    const pending: string[] = [];

    for (const [key, column] of Object.entries(COMPANY_TEXT_COLUMNS)) {
      const value = writable[key as keyof AutosaveInput];
      if (value === undefined) continue;
      companyUpdate[column] = normaliseText(value);
      delete scratch[key];
    }

    // The typed fields: parse, and route by the result.
    for (const [key, parser] of Object.entries(TYPED_FIELD_PARSERS)) {
      const value = writable[key as keyof AutosaveInput];
      if (value === undefined) continue;

      const parsed = parser.safeParse(value);
      const target = TYPED_COLUMN[key as keyof typeof TYPED_COLUMN];

      if (parsed.success && parsed.data !== undefined) {
        if (key === "representativeCnic") {
          const sealed = sealField(
            "application_company",
            input.applicationId,
            "representative_cnic",
            String(parsed.data),
          );
          companyUpdate.representative_cnic_enc = sealed.enc;
          companyUpdate.representative_cnic_hmac = sealed.hmac;
        } else {
          companyUpdate[target] = parsed.data;
        }
        delete scratch[key];
      } else if (String(value).trim() === "") {
        // Cleared on purpose: null the column and forget the scratch.
        companyUpdate[target] = null;
        delete scratch[key];
      } else {
        // Keep the column as it was and hold the raw text. Nulling it here
        // would discard a previously valid value the moment the applicant
        // started editing it.
        scratch[key] = String(value);
        pending.push(key);
      }
    }

    // Encrypted free-text identifiers other than the CNIC, which is handled
    // above because it is also a typed field.
    for (const [key, columns] of Object.entries(ENCRYPTED_COLUMNS)) {
      if (key === "representativeCnic") continue;
      const value = writable[key as keyof AutosaveInput];
      if (value === undefined) continue;

      const text = normaliseText(value);
      if (text === null) {
        companyUpdate[columns.enc] = null;
        if (columns.hmac) companyUpdate[columns.hmac] = null;
        continue;
      }

      const column = key === "ntn" ? "ntn" : key === "strn" ? "strn" : "representative_passport";
      const sealed = sealField("application_company", input.applicationId, column, text);
      companyUpdate[columns.enc] = sealed.enc;
      if (columns.hmac) companyUpdate[columns.hmac] = sealed.hmac;
    }

    if (writable.premisesTenure !== undefined) {
      companyUpdate.premises_tenure = TENURE_VALUES.has(writable.premisesTenure)
        ? (writable.premisesTenure as PremisesTenure)
        : null;
    }
    if (writable.strnRegistered !== undefined) {
      companyUpdate.strn_registered = isChecked(writable.strnRegistered) ? 1 : 0;
    }

    // Class, tier and status live on the parent row, because the queue filters
    // on them and the satellite is not the thing the queue reads.
    if (writable.membershipClass !== undefined) {
      applicationUpdate.membership_class = MEMBERSHIP_CLASS_VALUES.has(writable.membershipClass)
        ? (writable.membershipClass as MembershipClass)
        : null;
    }
    if (writable.processingTier !== undefined) {
      applicationUpdate.processing_tier = TIER_VALUES.has(writable.processingTier)
        ? (writable.processingTier as ProcessingTier)
        : null;
    }
    if (writable.companyStatus !== undefined) {
      const known = await tx
        .selectFrom("company_statuses")
        .select("code")
        .where("code", "=", writable.companyStatus)
        .executeTakeFirst();
      applicationUpdate.company_status_code = known ? known.code : null;
    }
    if (writable.step !== undefined) applicationUpdate.wizard_step = writable.step;

    applicationUpdate.wizard_scratch = JSON.stringify(scratch);
    // Touching a draft pushes its expiry out: ninety days of inactivity, not
    // ninety days of existence.
    applicationUpdate.expires_at = new Date(Date.now() + DRAFT_LIFETIME_DAYS * 86_400_000);

    if (Object.keys(companyUpdate).length > 0) {
      await tx
        .updateTable("application_company")
        .set(companyUpdate)
        .where("application_id", "=", input.applicationId)
        .execute();
    }

    await tx
      .updateTable("applications")
      .set(applicationUpdate)
      .where("id", "=", input.applicationId)
      .execute();

    if (writable.businessTypes !== undefined) {
      await replaceBusinessTypes(tx, input.applicationId, writable.businessTypes);
    }

    return { saved: true as const, pending };
  });
}

/** Which typed column each parser writes to. */
const TYPED_COLUMN = {
  representativeCnic: "representative_cnic_enc",
  representativeDob: "representative_dob",
  email: "email",
  paidUpCapital: "paid_up_capital",
  annualTurnover: "annual_turnover",
  employeeCount: "employee_count",
} as const;

async function replaceBusinessTypes(
  tx: Queryable,
  applicationId: number,
  selected: string | readonly string[],
): Promise<void> {
  const codes = Array.isArray(selected) ? selected : [selected];

  // Validated against the lookup table rather than trusted: these arrive from
  // a form and a value that is not a real business type would otherwise fail
  // the foreign key mid-transaction and lose the whole save.
  const known = await tx
    .selectFrom("business_types")
    .select("code")
    .where("active", "=", 1)
    .execute();
  const allowed = new Set(known.map((row) => row.code));
  const valid = [...new Set(codes.filter((code) => allowed.has(code)))];

  await tx
    .deleteFrom("application_business_types")
    .where("application_id", "=", applicationId)
    .execute();

  if (valid.length === 0) return;

  await tx
    .insertInto("application_business_types")
    .values(valid.map((code) => ({ application_id: applicationId, business_type_code: code })))
    .execute();
}

/* -------------------------------------------------------------------------- */
/* Shared checks                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Load the application for writing, or refuse.
 *
 * Both halves matter. Ownership stops one applicant writing to another's form.
 * The editability check stops an applicant editing an application that is
 * already with the office — which would otherwise let them change the turnover
 * figure after an officer had verified it, and the officer's checklist would
 * then refer to a form that no longer exists.
 */
async function requireEditableDraft(
  tx: Queryable,
  actor: ActorContext,
  applicationId: number,
  options: { readonly draftOnly?: boolean } = {},
): Promise<{
  readonly row: ApplicationRow;
  /**
   * Which form fields may be written. Null means every field, which is a
   * DRAFT; a set means the application is answering a deficiency and only the
   * fields the officer named are open.
   */
  readonly unlockedFields: ReadonlySet<string> | null;
}> {
  if (actor.userId === null) {
    throw new ForbiddenError(null, "Sign in to continue your application.");
  }

  const row = await tx
    .selectFrom("applications")
    .selectAll()
    .where("id", "=", applicationId)
    .where("created_by", "=", actor.userId)
    .executeTakeFirst();

  if (!row) {
    // The same message for "not yours" and "does not exist". A different one
    // for each would confirm which application ids exist.
    throw new ForbiddenError(null, "That application could not be found.");
  }

  const state = row.state as ApplicationState;

  if (state === "DRAFT") {
    return { row: row as ApplicationRow, unlockedFields: null };
  }

  if (!applicantCanEdit(state)) {
    throw new ForbiddenError(
      null,
      "This application is with the Chamber and can no longer be edited.",
    );
  }

  // AWAITING_APPLICANT. The application is back with the applicant, but only
  // for what the officer named.
  //
  // `draftOnly` marks the three writes that have no business happening here at
  // all: the board, the endorsers and the declaration. Changing who the
  // partners are, or who proposed the firm, after an officer has signed a
  // checklist naming those people is not a correction — it is a different
  // application. An officer who genuinely needs that gets
  // `reopen_for_correction`, which is separately permissioned and audited
  // precisely because it undoes a decision.
  if (options.draftOnly) {
    throw new ForbiddenError(
      null,
      "Only the items the Chamber asked you to attend to can be changed. " +
        "Anything else needs the Chamber to reopen the application.",
    );
  }

  const deficiency = await loadOpenDeficiency(tx, applicationId);
  const fields = new Set((deficiency?.fields ?? []).map((item) => item.fieldName));

  if (fields.size === 0) {
    throw new ForbiddenError(
      null,
      "The Chamber has not asked you to change any of your particulars. " +
        "Upload the documents on your list instead.",
    );
  }

  return { row: row as ApplicationRow, unlockedFields: fields };
}

/**
 * Drop everything the applicant is not allowed to write.
 *
 * Silently, and that is the right behaviour rather than a refusal: the wizard
 * posts the whole step, so a form carrying sixty unchanged fields alongside the
 * one unlocked turnover figure is the normal case, not an attack. Refusing it
 * would make the only legitimate submission impossible. What matters is that
 * nothing outside the set reaches a column.
 *
 * `applicationId` survives the filter because it addresses the write rather
 * than being part of it.
 */
function onlyUnlocked<T extends Record<string, unknown>>(
  input: T,
  unlocked: ReadonlySet<string> | null,
): T {
  if (unlocked === null) return input;

  const out: Record<string, unknown> = { applicationId: input.applicationId };
  for (const key of Object.keys(input)) {
    if (unlocked.has(key)) out[key] = input[key];
  }
  return out as T;
}

function normaliseText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned === "" ? null : cleaned;
}

function isChecked(value: unknown): boolean {
  return value === "on" || value === "true" || value === true || value === "1";
}

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Apply a state transition to the row, or report that someone else moved it.
 *
 * The shape every transition uses. `state` and `version` both appear in the
 * `WHERE`, so a caller that loaded the application a moment ago cannot
 * overwrite a decision made in between — it finds zero affected rows and says
 * "reload" instead.
 */
export async function moveState(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    readonly fromState: ApplicationState;
    readonly fromVersion: number;
    readonly toState: ApplicationState;
    readonly set?: Record<string, unknown>;
  },
): Promise<void> {
  const result = await tx
    .updateTable("applications")
    .set({
      ...(params.set ?? {}),
      state: params.toState,
      version: params.fromVersion + 1,
    })
    .where("id", "=", params.applicationId)
    .where("state", "=", params.fromState)
    .where("version", "=", params.fromVersion)
    .executeTakeFirst();

  if (!wonRace({ numUpdatedRows: result.numUpdatedRows })) {
    throw new ConcurrencyError("This application");
  }
}

/** Record the move in the application's own history. */
export async function recordTransition(
  tx: Queryable,
  actor: ActorContext,
  params: {
    readonly applicationId: number;
    readonly fromState: ApplicationState | null;
    readonly toState: ApplicationState;
    readonly transitionCode: string;
    readonly reason?: string | null;
  },
): Promise<void> {
  await tx
    .insertInto("application_state_transitions")
    .values({
      application_id: params.applicationId,
      from_state: params.fromState,
      to_state: params.toState,
      transition_code: params.transitionCode,
      actor_user_id: actor.userId,
      actor_role_code: actor.roleCode,
      reason: params.reason ?? null,
      request_id: actor.requestId,
    })
    .execute();
}

/** Count of live applications in each state, for the admin dashboard. */
export async function stateCounts(db: Queryable = getDb()): Promise<Record<string, number>> {
  const rows = await sql<{ state: string; n: number }>`
    SELECT state, COUNT(*) AS n FROM applications GROUP BY state
  `.execute(db);

  const out: Record<string, number> = {};
  for (const row of rows.rows) out[row.state] = Number(row.n);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Step 2 — the people                                                        */
/* -------------------------------------------------------------------------- */

export interface DirectorInput {
  readonly id?: number | null;
  readonly fullName?: string;
  readonly designation?: string;
  readonly membershipNo?: string;
  readonly cell?: string;
  readonly cnic?: string;
  readonly passport?: string;
  readonly ntn?: string;
  readonly isForeignNational?: unknown;
  readonly attests?: unknown;
}

/**
 * Save the directors or partners.
 *
 * Rows are matched by id and updated in place rather than deleted and
 * reinserted. That is not an optimisation: a document uploaded against a
 * director carries `subject_kind = 'director'` and `subject_id = <that id>`,
 * so recreating the rows would silently orphan every director's CNIC scan —
 * the files would still exist and nothing would point at them. Removing a
 * director who has documents is refused for the same reason, with a message
 * saying what to remove first.
 *
 * Identity numbers are sealed against the row id, so a new director is
 * inserted before their CNIC can be encrypted: the AAD binds the ciphertext to
 * `application_directors:<id>:cnic`, and there is no id until the insert.
 */
export async function saveDirectors(
  actor: ActorContext,
  params: {
    readonly applicationId: number;
    readonly directors: readonly DirectorInput[];
  },
): Promise<SaveResult> {
  return transaction(async (tx) => {
    const application = (
      await requireEditableDraft(tx, actor, params.applicationId, { draftOnly: true })
    ).row;
    const scratch = readScratch(application.wizard_scratch);
    const pending: string[] = [];

    const existing = await tx
      .selectFrom("application_directors")
      .select(["id"])
      .where("application_id", "=", params.applicationId)
      .execute();

    const existingIds = new Set(existing.map((row) => row.id));
    const keptIds = new Set<number>();

    for (const [index, director] of params.directors.entries()) {
      const base = {
        full_name: normaliseText(director.fullName),
        designation: normaliseText(director.designation),
        membership_no: normaliseText(director.membershipNo),
        cell: normaliseText(director.cell),
        position: index,
        is_foreign_national: isChecked(director.isForeignNational) ? 1 : 0,
        attests: isChecked(director.attests) ? 1 : 0,
      };

      let directorId: number;

      if (director.id && existingIds.has(director.id)) {
        directorId = director.id;
        await tx
          .updateTable("application_directors")
          .set(base)
          .where("id", "=", directorId)
          .where("application_id", "=", params.applicationId)
          .execute();
      } else {
        const inserted = await tx
          .insertInto("application_directors")
          .values({ application_id: params.applicationId, ...base })
          .executeTakeFirstOrThrow();
        directorId = Number(inserted.insertId);
      }

      keptIds.add(directorId);

      // The CNIC is sealed when it parses and held as typed when it does not.
      // A half-typed CNIC has to survive a reload like any other field, and
      // the encrypted column cannot hold "42101-123".
      const identity: Record<string, unknown> = {};
      const cnicKey = `directors.${index}.cnic`;

      if (director.cnic !== undefined) {
        const parsed = TYPED_FIELD_PARSERS.representativeCnic.safeParse(director.cnic);
        if (parsed.success && parsed.data !== undefined) {
          const sealed = sealField(
            "application_directors",
            directorId,
            "cnic",
            String(parsed.data),
          );
          identity.cnic_enc = sealed.enc;
          identity.cnic_hmac = sealed.hmac;
          delete scratch[cnicKey];
        } else if (String(director.cnic).trim() === "") {
          identity.cnic_enc = null;
          identity.cnic_hmac = null;
          delete scratch[cnicKey];
        } else {
          scratch[cnicKey] = String(director.cnic);
          pending.push(cnicKey);
        }
      }

      sealOptional(
        identity,
        "passport_enc",
        "application_directors",
        directorId,
        "passport",
        director.passport,
      );
      sealOptional(
        identity,
        "ntn_enc",
        "application_directors",
        directorId,
        "ntn",
        director.ntn,
      );

      if (Object.keys(identity).length > 0) {
        await tx
          .updateTable("application_directors")
          .set(identity)
          .where("id", "=", directorId)
          .execute();
      }
    }

    const removed = [...existingIds].filter((id) => !keptIds.has(id));

    if (removed.length > 0) {
      const attached = await tx
        .selectFrom("documents")
        .select(["subject_id"])
        .where("application_id", "=", params.applicationId)
        .where("subject_kind", "=", "director")
        .where("subject_id", "in", removed)
        .where("deleted_at", "is", null)
        .execute();

      if (attached.length > 0) {
        throw new ForbiddenError(
          null,
          "Remove that director's uploaded documents before removing the director.",
        );
      }

      await tx
        .deleteFrom("application_directors")
        .where("application_id", "=", params.applicationId)
        .where("id", "in", removed)
        .execute();

      // Scratch keys are positional, so a removal renumbers them all. Dropping
      // the lot is the honest response: a stale "directors.3.cnic" would
      // reappear beside the wrong person.
      for (const key of Object.keys(scratch)) {
        if (key.startsWith("directors.")) delete scratch[key];
      }
    }

    await tx
      .updateTable("applications")
      .set({ wizard_scratch: JSON.stringify(scratch), wizard_step: 2 })
      .where("id", "=", params.applicationId)
      .execute();

    return { saved: true as const, pending };
  });
}

function sealOptional(
  into: Record<string, unknown>,
  column: string,
  table: string,
  rowId: number,
  field: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  const text = normaliseText(value);
  into[column] = text === null ? null : sealField(table, rowId, field, text).enc;
}

export interface EndorserInput {
  readonly role: EndorsementRole;
  readonly firmName?: string;
  readonly membershipNo?: string;
  readonly representativeName?: string;
  readonly mobile?: string;
  readonly email?: string;
}

/**
 * Save the proposer and the seconder.
 *
 * An endorsement that has already been given is superseded rather than edited
 * when the member's identifying details change. Those two members attested to
 * a specific applicant under specific wording; silently moving that
 * endorsement onto a different firm's membership number would turn a record of
 * what someone agreed to into a record of what the applicant last typed. The
 * old row stays, marked `superseded`, and a fresh `invited` row takes its
 * place.
 */
export async function saveEndorsers(
  actor: ActorContext,
  params: {
    readonly applicationId: number;
    readonly endorsementMode?: string;
    readonly endorsers: readonly EndorserInput[];
  },
): Promise<SaveResult> {
  return transaction(async (tx) => {
    await requireEditableDraft(tx, actor, params.applicationId, { draftOnly: true });

    for (const endorser of params.endorsers) {
      const values = {
        firm_name: normaliseText(endorser.firmName),
        membership_no: normaliseText(endorser.membershipNo),
        representative_name: normaliseText(endorser.representativeName),
        mobile: normaliseText(endorser.mobile),
        email: normaliseText(endorser.email)?.toLowerCase() ?? null,
      };

      const live = await tx
        .selectFrom("application_endorsements")
        .selectAll()
        .where("application_id", "=", params.applicationId)
        .where("role", "=", endorser.role)
        .where("state", "!=", "superseded")
        .orderBy("id", "desc")
        .executeTakeFirst();

      if (!live) {
        await tx
          .insertInto("application_endorsements")
          .values({
            application_id: params.applicationId,
            role: endorser.role,
            state: "invited",
            declaration_text: ENDORSEMENT_DECLARATION,
            ...values,
          })
          .execute();
        continue;
      }

      const identityChanged =
        live.membership_no !== values.membership_no || live.firm_name !== values.firm_name;

      if (live.state === "endorsed" && identityChanged) {
        await tx
          .updateTable("application_endorsements")
          .set({ state: "superseded" })
          .where("id", "=", live.id)
          .execute();

        await tx
          .insertInto("application_endorsements")
          .values({
            application_id: params.applicationId,
            role: endorser.role,
            state: "invited",
            declaration_text: ENDORSEMENT_DECLARATION,
            ...values,
          })
          .execute();
        continue;
      }

      await tx
        .updateTable("application_endorsements")
        .set(values)
        .where("id", "=", live.id)
        .execute();
    }

    const mode =
      params.endorsementMode === "in_app" || params.endorsementMode === "signed_sheet"
        ? (params.endorsementMode as EndorsementMode)
        : null;

    await tx
      .updateTable("applications")
      .set({ endorsement_mode: mode, wizard_step: 2 })
      .where("id", "=", params.applicationId)
      .execute();

    return { saved: true as const, pending: [] };
  });
}

/* -------------------------------------------------------------------------- */
/* Step 3 — the declaration                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Record the declaration and the attestation.
 *
 * The wording is stored, not referenced. `applicantDeclarationText()` will
 * change at Rev 02 of the controlled form, and an application submitted under
 * Rev 01 has to keep what it was actually shown — the alternative is a record
 * saying someone agreed to words that did not exist when they agreed.
 *
 * The IP and user-agent hashes are the rest of the evidence. A ticked box with
 * no record of who ticked it, from where, under which wording, is not a
 * signature; it is a boolean.
 */
export async function acceptDeclaration(
  actor: ActorContext,
  params: {
    readonly applicationId: number;
    readonly attestingDirectorId: number;
    readonly accepted: boolean;
  },
): Promise<SaveResult> {
  if (!params.accepted) {
    throw new ForbiddenError(null, "The declaration must be accepted to continue.");
  }

  return transaction(async (tx) => {
    await requireEditableDraft(tx, actor, params.applicationId, { draftOnly: true });

    const attester = await tx
      .selectFrom("application_directors")
      .select(["id"])
      .where("id", "=", params.attestingDirectorId)
      .where("application_id", "=", params.applicationId)
      .executeTakeFirst();

    if (!attester) {
      throw new ForbiddenError(
        null,
        "Choose which director or partner attests to the representation.",
      );
    }

    const now = new Date();

    // Exactly one attester, enforced by clearing the flag before setting it.
    // Two ticked boxes would satisfy the workflow guard, which only asks that
    // the attester is not the representative, while the printed form has one
    // signature line.
    await tx
      .updateTable("application_directors")
      .set({ attests: 0 })
      .where("application_id", "=", params.applicationId)
      .execute();

    await tx
      .updateTable("application_directors")
      .set({ attests: 1 })
      .where("id", "=", attester.id)
      .execute();

    await tx
      .updateTable("application_authorisation")
      .set({
        declaration_accepted_at: now,
        declaration_text: applicantDeclarationText(),
        declared_by: actor.userId,
        declared_ip_hash: actor.ipHash,
        declared_ua_hash: actor.userAgentHash,
        attested_by_director_id: attester.id,
        attested_at: now,
      })
      .where("application_id", "=", params.applicationId)
      .execute();

    await tx
      .updateTable("applications")
      .set({ wizard_step: 3 })
      .where("id", "=", params.applicationId)
      .execute();

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: params.applicationId,
        action: "application.declaration_accepted",
        summary: "The applicant accepted the declaration.",
        context: {
          declarationVersion: DECLARATION_VERSION,
          attestingDirectorId: attester.id,
        },
      },
      tx,
    );

    return { saved: true as const, pending: [] };
  });
}
