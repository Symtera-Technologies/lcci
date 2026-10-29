import "server-only";

import { sql, transaction } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  ApplicationState,
  DocumentCardinality,
  MembershipClass,
  ProcessingTier,
} from "@/db/schema";
import { ConcurrencyError, ForbiddenError, type ActorContext } from "@/server/actor";
import { openField } from "@/membership/sensitive";
import { writeAudit } from "@/server/audit";
import { moveState, recordTransition } from "@/membership/applications";
import { notifySubmitted } from "@/membership/notify";
import { requiresItdSurcharge } from "@/membership/fees";
import { startSlaClock } from "@/membership/sla";
import { allocateNumber } from "@/membership/numbering";
import { writeSubmissionSnapshot } from "@/membership/snapshot";
import { canTransition, type TransitionFacts } from "@/membership/workflow";
import { step1Schema, step2Schema, stepForField } from "@/membership/validation";

/**
 * The submit transition.
 *
 * Everything that makes a draft into an application the Chamber owes an answer
 * on happens here, in one transaction: the public reference is allocated, the
 * form revision and fee row are snapshotted, the document matrix is resolved
 * and frozen, the immutable submission record is written and hashed, the
 * payment rows are created, the SLA clock starts, and applicant editing stops.
 *
 * It is one transaction because the halves are worthless apart. A reference
 * with no snapshot is a number nobody can audit; a started clock with no
 * payment row is a promise with no fee against it; a locked form with no
 * reference is an application the applicant cannot ask about. If any step
 * fails the applicant keeps an editable draft, which is the only safe
 * outcome.
 */

/* -------------------------------------------------------------------------- */
/* Failure as a value                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Raised when the form is not ready to submit.
 *
 * Carries the per-field errors and the step to send the applicant back to,
 * because "something is wrong" on step 3 is useless when the missing field is
 * the bank branch on step 1.
 */
export class SubmitBlockedError extends Error {
  readonly fieldErrors: Record<string, string[]>;
  readonly missingDocuments: readonly string[];
  readonly reasons: readonly string[];
  readonly step: 1 | 2 | 3;

  constructor(params: {
    fieldErrors: Record<string, string[]>;
    missingDocuments: readonly string[];
    reasons: readonly string[];
    step: 1 | 2 | 3;
  }) {
    super("This application is not ready to submit.");
    this.name = "SubmitBlockedError";
    this.fieldErrors = params.fieldErrors;
    this.missingDocuments = params.missingDocuments;
    this.reasons = params.reasons;
    this.step = params.step;
  }
}

/* -------------------------------------------------------------------------- */
/* The document matrix                                                        */
/* -------------------------------------------------------------------------- */

export interface RequiredDocument {
  readonly documentTypeCode: string;
  readonly cardinality: DocumentCardinality;
  readonly requiredCount: number;
  readonly note: string | null;
}

/**
 * Which documents this application needs, with `all_directors` resolved.
 *
 * The matrix lives in `document_requirements` keyed by company status, because
 * a Partnership owes a partnership deed and a Company owes a Form 9 — and
 * because that table is reference data the Chamber can correct without a
 * deploy. `all_directors` against a five-person board is five, and the
 * applicant should be told five rather than "one per director": a count they
 * can check off is the difference between a complete submission and a
 * deficiency round.
 *
 * A board of zero would make `all_directors` zero and quietly require nothing,
 * so the count floors at one. Step 2 already refuses an empty board; this is
 * the belt that stops a reference-data edit from turning a validation gap into
 * a document the office never receives.
 */
export async function resolveRequiredDocuments(
  db: Queryable,
  params: {
    readonly companyStatusCode: string;
    readonly directorCount: number;
  },
): Promise<readonly RequiredDocument[]> {
  const rows = await db
    .selectFrom("document_requirements")
    .select(["document_type_code", "cardinality", "note_en"])
    .where("company_status_code", "=", params.companyStatusCode)
    .orderBy("document_type_code", "asc")
    .execute();

  const board = Math.max(1, params.directorCount);

  return rows.map((row) => ({
    documentTypeCode: row.document_type_code,
    cardinality: row.cardinality,
    requiredCount: row.cardinality === "all_directors" ? board : 1,
    note: row.note_en,
  }));
}

/* -------------------------------------------------------------------------- */
/* Completeness                                                               */
/* -------------------------------------------------------------------------- */

export interface CompletenessReport {
  readonly formComplete: boolean;
  readonly documentsComplete: boolean;
  readonly declarationAccepted: boolean;
  readonly fieldErrors: Record<string, string[]>;
  readonly missingDocuments: readonly string[];
  readonly step: 1 | 2 | 3;
  readonly required: readonly RequiredDocument[];
  readonly directorCount: number;
  readonly attestingDirectorId: number | null;
  readonly representativeDirectorId: number | null;
  readonly representativeIsForeign: boolean;
  readonly anyDirectorIsForeign: boolean;
  readonly membershipClass: MembershipClass | null;
  readonly processingTier: ProcessingTier | null;
  readonly companyStatusCode: string | null;
}

const PAKISTANI_NATIONALITIES = new Set(["pakistani", "pakistan", "pak"]);

/**
 * Check the whole draft against the strict schemas.
 *
 * Completeness is enforced here and nowhere else. Every particulars column is
 * nullable in the schema so that autosave can store a half-typed form, which
 * means the database cannot tell a complete application from an abandoned one
 * — only this function can. It is therefore also what the wizard calls to
 * decide whether to enable the submit button, so the applicant sees the same
 * verdict the transaction will reach.
 */
export async function checkCompleteness(
  db: Queryable,
  applicationId: number,
): Promise<CompletenessReport> {
  const application = await db
    .selectFrom("applications")
    .select([
      "id",
      "membership_class",
      "processing_tier",
      "company_status_code",
      "endorsement_mode",
    ])
    .where("id", "=", applicationId)
    .executeTakeFirstOrThrow();

  const [company, businessTypes, directors, endorsements, authorisation] =
    await Promise.all([
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
        .select(["id", "role", "state", "firm_name", "membership_no", "representative_name", "mobile", "email"])
        .where("application_id", "=", applicationId)
        .where("state", "!=", "superseded")
        .execute(),
      db
        .selectFrom("application_authorisation")
        .selectAll()
        .where("application_id", "=", applicationId)
        .executeTakeFirst(),
    ]);

  const fieldErrors: Record<string, string[]> = {};

  // The encrypted identifiers are opened and checked for real, not probed with
  // a stand-in value. An earlier version passed a fixed placeholder to mean "a
  // CNIC is stored" and the placeholder did not itself satisfy the CNIC rule,
  // so no application could ever be complete. Beyond that near-miss, a
  // sentinel only ever answers "is the column populated", while opening it
  // answers "is what we stored still readable and still valid" — which is the
  // question, since a ciphertext that will not decrypt is as good as a missing
  // CNIC and should be reported as one.
  const openCompany = (column: string): string =>
    openField(
      "application_company",
      applicationId,
      column,
      ((company?.[`${column}_enc` as keyof typeof company] as Buffer | null) ?? null),
    ) ?? "";

  // Step 1 is parsed from the typed columns rather than from a form payload,
  // because by submission time the form payload is gone — the applicant filled
  // it in over several sittings. The strict schema accepts the column values
  // directly: money arrives as a DECIMAL string, dates as "YYYY-MM-DD", both
  // of which it already handles.
  const step1 = step1Schema.safeParse({
    membershipClass: application.membership_class ?? "",
    processingTier: application.processing_tier ?? "",
    companyStatus: application.company_status_code ?? "",
    firmName: company?.firm_name ?? "",
    representativeName: company?.representative_name ?? "",
    representativeCnic: openCompany("representative_cnic"),
    representativePassport: openCompany("representative_passport"),
    representativeDob: company?.representative_dob ?? "",
    representativeBirthplace: company?.representative_birthplace ?? "",
    representativeNationality: company?.representative_nationality ?? "",
    postalAddress: company?.postal_address ?? "",
    premisesTenure: company?.premises_tenure ?? "",
    email: company?.email ?? "",
    officePhone1: company?.office_phone_1 ?? "",
    officePhone2: company?.office_phone_2 ?? "",
    fax: company?.fax ?? "",
    representativeMobile1: company?.representative_mobile_1 ?? "",
    representativeMobile2: company?.representative_mobile_2 ?? "",
    paidUpCapital: company?.paid_up_capital ?? "",
    annualTurnover: company?.annual_turnover ?? "",
    employeeCount: company?.employee_count ?? "",
    ntn: openCompany("ntn"),
    strnRegistered: company?.strn_registered === 1,
    strn: openCompany("strn"),
    businessSector: company?.business_sector ?? "",
    businessSubSector: company?.business_sub_sector ?? "",
    mainCommodity: company?.main_commodity ?? "",
    businessTypes: businessTypes.map((row) => row.business_type_code),
    bankName: company?.bank_name ?? "",
    bankBranch: company?.bank_branch ?? "",
  });

  collectErrors(step1, fieldErrors);

  const proposer = endorsements.find((row) => row.role === "proposer");
  const seconder = endorsements.find((row) => row.role === "seconder");

  const step2 = step2Schema.safeParse({
    directors: directors.map((director) => ({
      fullName: director.full_name ?? "",
      designation: director.designation ?? "",
      membershipNo: director.membership_no ?? "",
      cell: director.cell ?? "",
      cnic: openDirector(director, "cnic"),
      passport: openDirector(director, "passport"),
      ntn: openDirector(director, "ntn"),
      isForeignNational: director.is_foreign_national === 1,
      attests: director.attests === 1,
    })),
    endorsementMode: application.endorsement_mode ?? "",
    proposer: endorserPayload(proposer),
    seconder: endorserPayload(seconder),
  });

  collectErrors(step2, fieldErrors);

  if (!authorisation?.declaration_accepted_at) {
    push(fieldErrors, "declarationAccepted", "The declaration has not been accepted.");
  }

  const companyStatusCode = application.company_status_code;
  const required = companyStatusCode
    ? await resolveRequiredDocuments(db, {
        companyStatusCode,
        directorCount: directors.length,
      })
    : [];

  const counts = await documentCounts(db, applicationId);
  const missingDocuments: string[] = [];

  for (const requirement of required) {
    if (requirement.cardinality === "optional") continue;
    const held = counts.get(requirement.documentTypeCode) ?? 0;
    if (held < requirement.requiredCount) missingDocuments.push(requirement.documentTypeCode);
  }

  if (missingDocuments.length > 0) {
    push(
      fieldErrors,
      "documentIds",
      missingDocuments.length === 1
        ? "One required document has not been uploaded."
        : `${missingDocuments.length} required documents have not been uploaded.`,
    );
  }

  // The representative's own director row, found by comparing the peppered
  // HMAC of the CNIC rather than by name. Names are typed twice and differ by
  // a middle initial; the HMAC is exactly what it exists for — equality
  // without an index on the plaintext.
  const representativeHmac = company?.representative_cnic_hmac ?? null;
  const representativeDirector = representativeHmac
    ? (directors.find((director) => director.cnic_hmac === representativeHmac) ?? null)
    : null;

  // The form is explicit about this: "Any one of the Directors or Partners can
  // represent the concern and in case of Proprietorship only Proprietor can be
  // a representative." So a representative who does not appear on the
  // directors list is not a representative, and the attestation guard — which
  // asks that the attester be someone *other* than the representative — has
  // nothing to compare against. Caught here, where the applicant can fix it,
  // rather than as an opaque guard failure at submission.
  if (directors.length > 0 && representativeHmac !== null && representativeDirector === null) {
    push(
      fieldErrors,
      "directors",
      "The representative must also be listed as a director or partner, with the same CNIC.",
    );
  }

  const nationality = (company?.representative_nationality ?? "").trim().toLowerCase();

  const report: CompletenessReport = {
    // Derived from the error map rather than from the two parse results, so a
    // rule added outside the schemas — like the representative being on the
    // directors list — cannot be checked, reported, and then quietly ignored
    // by the thing that decides whether submission may proceed.
    formComplete: Object.keys(fieldErrors).length === 0,
    documentsComplete: missingDocuments.length === 0,
    declarationAccepted: Boolean(authorisation?.declaration_accepted_at),
    fieldErrors,
    missingDocuments,
    step: firstIncompleteStep(fieldErrors),
    required,
    directorCount: directors.length,
    attestingDirectorId:
      directors.find((director) => director.attests === 1)?.id ?? null,
    representativeDirectorId: representativeDirector?.id ?? null,
    // Nationality decides the surcharge, not the presence of a passport. The
    // form asks for a passport "for foreign nationals", but a Pakistani
    // applicant who fills their passport number in anyway must not be charged
    // USD 750 for it. Nationality is a required field at submission, so it is
    // always available here — and it is free text, so verification confirms it
    // rather than this function being the last word on a fee.
    representativeIsForeign:
      nationality !== "" && !PAKISTANI_NATIONALITIES.has(nationality),
    anyDirectorIsForeign: directors.some((director) => director.is_foreign_national === 1),
    membershipClass: application.membership_class,
    processingTier: application.processing_tier,
    companyStatusCode,
  };

  return report;
}

/** One director's sealed column, opened, or "" when absent or unreadable. */
function openDirector(
  director: { id: number } & Record<string, unknown>,
  column: string,
): string {
  return (
    openField(
      "application_directors",
      Number(director.id),
      column,
      (director[`${column}_enc`] as Buffer | null) ?? null,
    ) ?? ""
  );
}

function endorserPayload(
  row:
    | {
        firm_name: string | null;
        membership_no: string | null;
        representative_name: string | null;
        mobile: string | null;
        email: string | null;
      }
    | undefined,
): Record<string, string> {
  return {
    firmName: row?.firm_name ?? "",
    membershipNo: row?.membership_no ?? "",
    representativeName: row?.representative_name ?? "",
    mobile: row?.mobile ?? "",
    email: row?.email ?? "",
  };
}

/** Live documents per type: superseded and deleted rows do not count. */
async function documentCounts(
  db: Queryable,
  applicationId: number,
): Promise<Map<string, number>> {
  const rows = await sql<{ document_type_code: string; n: number }>`
    SELECT document_type_code, COUNT(*) AS n
      FROM documents
     WHERE application_id = ${applicationId}
       AND deleted_at IS NULL
       AND review_state <> 'superseded'
     GROUP BY document_type_code
  `.execute(db);

  return new Map(rows.rows.map((row) => [row.document_type_code, Number(row.n)]));
}

function collectErrors(
  result: { success: boolean; error?: { issues: readonly { path: readonly (string | number | symbol)[]; message: string }[] } },
  into: Record<string, string[]>,
): void {
  if (result.success || !result.error) return;
  for (const issue of result.error.issues) {
    const key = issue.path.length === 0 ? "form" : issue.path.map(String).join(".");
    push(into, key, issue.message);
  }
}

function push(into: Record<string, string[]>, key: string, message: string): void {
  (into[key] ??= []).push(message);
}

/**
 * The step to land the applicant on.
 *
 * The earliest one with an error, because fixing step 3 while step 1 is
 * incomplete just produces the same refusal again.
 */
function firstIncompleteStep(fieldErrors: Record<string, string[]>): 1 | 2 | 3 {
  let earliest: 1 | 2 | 3 = 3;
  for (const field of Object.keys(fieldErrors)) {
    const step = stepForField(field);
    if (step < earliest) earliest = step;
  }
  return earliest;
}

/* -------------------------------------------------------------------------- */
/* Facts for the machine                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Assemble what the workflow guards need.
 *
 * The machine is pure and takes a flat snapshot, so this is the one place that
 * knows how each fact is stored. The admin page calls it for its own query and
 * the transaction calls it inside the lock; both get the same answer because
 * there is one assembler, not one per caller.
 */
export async function gatherFacts(
  db: Queryable,
  applicationId: number,
): Promise<TransitionFacts> {
  const application = await db
    .selectFrom("applications")
    .select(["id", "state"])
    .where("id", "=", applicationId)
    .executeTakeFirstOrThrow();

  const completeness = await checkCompleteness(db, applicationId);

  const [endorsements, payments, payOrders, checklist] = await Promise.all([
    db
      .selectFrom("application_endorsements")
      .select(["role", "state", "standing_at_endorsement", "standing_at_approval"])
      .where("application_id", "=", applicationId)
      .where("state", "!=", "superseded")
      .execute(),
    db
      .selectFrom("payments")
      .select(["fee_kind", "state", "receipted_by"])
      .where("application_id", "=", applicationId)
      .execute(),
    // Pay orders hang off the payment, not the application: one application
    // can owe two fees by two separate instruments, and the bank-match
    // control is performed per instrument.
    //
    // A LEFT JOIN and not an inner one, because the question the guards ask is
    // "has every instrument that was taken in been compared", and an inner
    // join cannot see a receipted payment whose pay-order row is missing — the
    // one case that most needs catching.
    sql<{
      state: string;
      method: string | null;
      bank_match_verdict: string | null;
    }>`
      SELECT p.state, p.method, o.bank_match_verdict
        FROM payments p
        LEFT JOIN pay_orders o ON o.payment_id = p.id
       WHERE p.application_id = ${applicationId}
    `.execute(db),
    // The most recent *completed* round, which is the one the guards ask
    // about. A round still in progress has not concluded anything, and a
    // superseded one was answered by a later round — so neither can satisfy
    // `checklist_complete`, and ordering by round and filtering on state is
    // how that stays true without a second flag to keep in step.
    db
      .selectFrom("verification_checklists")
      .select(["round", "outcome", "completed_by"])
      .where("application_id", "=", applicationId)
      .where("state", "=", "completed")
      .orderBy("round", "desc")
      .executeTakeFirst(),
  ]);

  const endorsed = endorsements.filter((row) => row.state === "endorsed");

  // A payment that exists but is still `due` fails the guard; a waived or
  // cancelled one does not, because there is nothing left to collect. The
  // absence of any payment row is not "all receipted": it means submission
  // never created one, which is a fault, so an empty set fails.
  const settled = new Set(["receipted", "waived", "refunded"]);
  const allPaymentsReceipted =
    payments.length > 0 && payments.every((row) => settled.has(row.state));

  // An instrument was taken in: a pay order or a cheque, receipted. Cash and
  // an online payment have no drawee bank, so the control the form builds in
  // cannot be performed on them and is not pretended to be.
  const instruments = payOrders.rows.filter(
    (row) =>
      row.state === "receipted" &&
      (row.method === "pay_order" || row.method === "cheque"),
  );

  return {
    state: application.state as ApplicationState,
    formComplete: completeness.formComplete,
    documentsComplete: completeness.documentsComplete,
    hasProposer: endorsed.some((row) => row.role === "proposer"),
    hasSeconder: endorsed.some((row) => row.role === "seconder"),
    declarationAccepted: completeness.declarationAccepted,
    attestingDirectorId: completeness.attestingDirectorId,
    representativeDirectorId: completeness.representativeDirectorId,
    // Two conditions, not one, and the distinction is the whole point of the
    // checklist module: a round can be signed off and still record a defect.
    // Items 1 and 13 of the printed form are inverted, so "completed" and
    // "clear" are genuinely different questions and `mark_verified` asks both.
    checklistCompleted: checklist !== undefined,
    checklistClear: checklist?.outcome === "clear",
    allPaymentsReceipted,
    // One verdict per instrument, and every one of them has to be recorded:
    // an application with two pay orders and one unexamined is not resolved.
    //
    // Scoped to the payments that actually took an instrument in. A waived fee
    // has no pay order and nothing to compare, so requiring a verdict for it
    // would be a guard no action could ever satisfy.
    bankMatchVerdictRecorded: instruments.every(
      (row) => row.bank_match_verdict !== null,
    ),
    bankMatchMismatch: instruments.some(
      (row) => row.bank_match_verdict === "mismatch",
    ),
    endorsersInGoodStanding: endorsed.every(
      (row) => (row.standing_at_approval ?? row.standing_at_endorsement) === "active",
    ),
    // Who signed the checklist off, so approval can refuse that same person.
    // Separation of duties is enforced three ways and this is the second: by
    // grant, then per-application here, then by an audited waiver.
    verifiedByUserId: checklist?.completed_by ?? null,
    receiptedByUserIds: payments
      .map((row) => row.receipted_by)
      .filter((id): id is number => id !== null)
      .map(Number),
    originalsReceived: false,
  };
}

/* -------------------------------------------------------------------------- */
/* The transition                                                             */
/* -------------------------------------------------------------------------- */

export interface SubmitResult {
  readonly applicationId: number;
  readonly publicRef: string;
  readonly dueDate: string;
  readonly snapshotRound: number;
  readonly snapshotSha256: string;
  readonly payments: readonly {
    readonly feeKind: "membership" | "itd_surcharge";
    readonly amount: string;
    readonly currency: string;
  }[];
}

/**
 * Submit a draft.
 *
 * The order inside the transaction is not arbitrary. The fee row is read
 * before anything is written, so a missing fee schedule fails before a
 * reference is consumed. The reference is allocated before the snapshot,
 * because the snapshot records it. The SLA clock is started before the state
 * moves, so a calendar that does not reach far enough refuses the submission
 * rather than leaving an application with a promise nobody can date. And the
 * guarded `UPDATE` is last: it is the step that can lose a race, and losing it
 * must undo everything above rather than leave a half-submitted application.
 */
export async function submitApplication(
  actor: ActorContext,
  applicationId: number,
): Promise<SubmitResult> {
  if (actor.userId === null) {
    throw new ForbiddenError(null, "Sign in to submit your application.");
  }
  const userId = actor.userId;
  const now = new Date();

  return transaction(async (tx) => {
    // Locked for the duration: the facts below are read on the assumption
    // that nothing else is moving this row, and two submit clicks are two
    // Passenger workers racing.
    const locked = await sql<{
      id: number;
      state: ApplicationState;
      version: number;
      created_by: number;
      public_ref: string | null;
      membership_class: MembershipClass | null;
      processing_tier: ProcessingTier | null;
      company_status_code: string | null;
    }>`
      SELECT id, state, version, created_by, public_ref,
             membership_class, processing_tier, company_status_code
        FROM applications
       WHERE id = ${applicationId}
       FOR UPDATE
    `.execute(tx);

    const application = locked.rows[0];
    if (!application || application.created_by !== userId) {
      throw new ForbiddenError(null, "That application could not be found.");
    }

    const completeness = await checkCompleteness(tx, applicationId);
    const facts = await gatherFacts(tx, applicationId);

    const decision = canTransition(facts, "submit", {
      userId,
      isStaff: false,
      isSystem: false,
      permissions: actor.permissions,
    });

    if (!decision.allowed) {
      if (decision.unknown) {
        // Already submitted, or withdrawn. Not a validation failure: the
        // applicant pressed submit twice, or on a stale page.
        throw new ConcurrencyError("This application");
      }
      throw new SubmitBlockedError({
        fieldErrors: completeness.fieldErrors,
        missingDocuments: completeness.missingDocuments,
        reasons: decision.reasons,
        step: completeness.step,
      });
    }

    // Guarded above by `form_complete`, which cannot pass with either null.
    const membershipClass = completeness.membershipClass as MembershipClass;
    const processingTier = completeness.processingTier as ProcessingTier;
    const companyStatusCode = completeness.companyStatusCode as string;

    // The revision in force today: effective, not retired, newest first.
    // Dated rather than flagged, so a Rev 02 can be entered ahead of its
    // effective date without silently re-labelling today's submissions.
    const today = now.toISOString().slice(0, 10);
    const formRevision = await tx
      .selectFrom("form_revisions")
      .select(["id"])
      .where("effective_from", "<=", today)
      .where((eb) => eb.or([eb("retired_on", "is", null), eb("retired_on", ">", today)]))
      .orderBy("effective_from", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();

    if (!formRevision) {
      // The form is a controlled document under the Chamber's ISO procedure
      // and every submission records which revision it was answered against.
      // Without one there is no auditable record to write, so this refuses
      // rather than storing a submission that cannot be reproduced.
      throw new Error(
        "No active form revision is configured; the controlled form identifier is required on every submission.",
      );
    }

    const fee = await currentFee(tx, {
      feeKind: "membership",
      membershipClass,
      processingTier,
      on: now,
    });

    if (!fee) {
      throw new Error(
        `No fee is published for a ${membershipClass} application on the ${processingTier} tier. ` +
          "Add it to the fee schedule before this combination can be submitted.",
      );
    }

    const surchargeApplies = requiresItdSurcharge({
      representativeIsForeign: completeness.representativeIsForeign,
      anyDirectorIsForeign: completeness.anyDirectorIsForeign,
    });

    const surcharge = surchargeApplies
      ? await currentFee(tx, { feeKind: "itd_surcharge", on: now })
      : null;

    if (surchargeApplies && !surcharge) {
      throw new Error(
        "The International Trade Development surcharge applies to this application but no " +
          "surcharge row is published in the fee schedule.",
      );
    }

    // Allocated under the sequence row's own lock. Not before the checks
    // above: a refused submission must not burn a reference, because the
    // references are quoted by applicants and a gap is a question nobody can
    // answer later.
    const publicRef = await allocateNumber(tx, "application_ref", now);

    await tx
      .updateTable("applications")
      .set({
        public_ref: publicRef,
        form_revision_id: formRevision.id,
        fee_schedule_id: fee.id,
        requires_itd_surcharge: surchargeApplies ? 1 : 0,
        submitted_at: now,
        // The draft expiry no longer applies: this is the Chamber's to answer
        // now, and a submitted application must never be swept.
        expires_at: null,
      })
      .where("id", "=", applicationId)
      .execute();

    // The matrix is frozen as rows rather than recomputed on each read. The
    // reference data behind it is editable, so an edit six weeks from now
    // would otherwise retroactively change what this applicant was asked for
    // — and the deficiency letter already sent would cite a list that no
    // longer exists.
    const required = await resolveRequiredDocuments(tx, {
      companyStatusCode,
      directorCount: completeness.directorCount,
    });

    if (required.length > 0) {
      await tx
        .insertInto("application_required_documents")
        .values(
          required.map((requirement) => ({
            application_id: applicationId,
            document_type_code: requirement.documentTypeCode,
            cardinality: requirement.cardinality,
            required_count: requirement.requiredCount,
            note_en: requirement.note,
            satisfied_at: requirement.cardinality === "optional" ? null : now,
          })),
        )
        .execute();
    }

    const snapshot = await writeSubmissionSnapshot(tx, {
      applicationId,
      formRevisionId: formRevision.id,
      createdBy: userId,
      requestId: actor.requestId,
    });

    const paymentRows: {
      feeKind: "membership" | "itd_surcharge";
      amount: string;
      currency: string;
    }[] = [
      { feeKind: "membership", amount: fee.amount, currency: fee.currency },
    ];
    if (surcharge) {
      paymentRows.push({
        feeKind: "itd_surcharge",
        amount: surcharge.amount,
        currency: surcharge.currency,
      });
    }

    await tx
      .insertInto("payments")
      .values(
        paymentRows.map((row) => ({
          application_id: applicationId,
          fee_kind: row.feeKind,
          fee_schedule_id: row.feeKind === "membership" ? fee.id : (surcharge?.id ?? null),
          amount: row.amount,
          currency: row.currency,
          state: "due" as const,
          method: "pay_order" as const,
        })),
      )
      .execute();

    // The promise, in working days, read from the fee row the applicant paid
    // against rather than from the tier constant — the Chamber can change the
    // promise without a deploy, and the row is what was in force when this
    // pay order was drawn.
    const workingDays = fee.workingDays;
    if (workingDays === null) {
      throw new Error(
        `Fee schedule row ${fee.id} has no working-day promise, so no deadline can be set.`,
      );
    }

    const clock = await startSlaClock(tx, {
      applicationId,
      processingTier,
      workingDays,
      startedAt: now,
    });

    await recordTransition(tx, actor, {
      applicationId,
      fromState: "DRAFT",
      toState: "SUBMITTED",
      transitionCode: "submit",
    });

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.submitted",
        summary: `Application ${publicRef} submitted.`,
        after: {
          publicRef,
          membershipClass,
          processingTier,
          companyStatus: companyStatusCode,
          feeScheduleId: fee.id,
          requiresItdSurcharge: surchargeApplies,
          snapshotRound: snapshot.round,
          snapshotSha256: snapshot.sha256,
          dueDate: clock.dueDate,
          workingDays,
          requiredDocuments: required.map((requirement) => ({
            code: requirement.documentTypeCode,
            count: requirement.requiredCount,
          })),
        },
        formRevisionId: formRevision.id,
      },
      tx,
    );

    // The confirmation §7.1 commits to, queued inside this transaction so a
    // submission the applicant was never told about cannot exist. It is not
    // called a receipt: the pay order is in an envelope and no cashier has
    // seen it yet.
    await notifySubmitted(tx, {
      applicationId,
      membershipClass,
      processingTier,
      dueDate: clock.dueDate,
      fees: paymentRows,
    });

    // Last, and the only step that can lose. Everything above is rolled back
    // if it does.
    await moveState(tx, {
      applicationId,
      fromState: "DRAFT",
      fromVersion: application.version,
      toState: "SUBMITTED",
    });

    return {
      applicationId,
      publicRef,
      dueDate: clock.dueDate,
      snapshotRound: snapshot.round,
      snapshotSha256: snapshot.sha256,
      payments: paymentRows,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Fee lookup                                                                 */
/* -------------------------------------------------------------------------- */

interface FeeRow {
  readonly id: number;
  readonly amount: string;
  readonly currency: string;
  readonly workingDays: number | null;
}

/**
 * The fee in force on a date.
 *
 * Dated rather than "the current one", because a fee change must not alter
 * what an application submitted last month was charged. `effective_to` is
 * nullable for the open-ended current row, and the newest matching
 * `effective_from` wins where two overlap — which the UNIQUE key on
 * `(fee_kind, membership_class, processing_tier, effective_from)` makes
 * unambiguous.
 */
export async function currentFee(
  db: Queryable,
  params: {
    readonly feeKind: "membership" | "itd_surcharge";
    readonly membershipClass?: MembershipClass;
    readonly processingTier?: ProcessingTier;
    readonly on: Date;
  },
): Promise<FeeRow | null> {
  const on = params.on.toISOString().slice(0, 10);

  let query = db
    .selectFrom("fee_schedule")
    .select(["id", "amount", "currency", "working_days"])
    .where("fee_kind", "=", params.feeKind)
    .where("effective_from", "<=", on)
    .where((eb) =>
      eb.or([eb("effective_to", "is", null), eb("effective_to", ">=", on)]),
    )
    .orderBy("effective_from", "desc")
    .limit(1);

  query = params.membershipClass
    ? query.where("membership_class", "=", params.membershipClass)
    : query.where("membership_class", "is", null);

  query = params.processingTier
    ? query.where("processing_tier", "=", params.processingTier)
    : query.where("processing_tier", "is", null);

  const row = await query.executeTakeFirst();
  if (!row) return null;

  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    workingDays: row.working_days === null ? null : Number(row.working_days),
  };
}
