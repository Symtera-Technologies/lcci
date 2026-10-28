import "server-only";

import { getDb } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  ApplicationState,
  MembershipClass,
  ProcessingTier,
} from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { ForbiddenError } from "@/server/actor";
import { openField } from "@/membership/sensitive";
import { gatherFacts } from "@/membership/submit";
import {
  canTransition,
  transitionsFrom,
  type TransitionCode,
  type TransitionDecision,
  type TransitionFacts,
} from "@/membership/workflow";

/**
 * One application, assembled for the review screen.
 *
 * Deliberately separate from the applicant-facing draft loader, because the
 * scoping is the opposite way round: that one carries an ownership predicate so
 * a person sees their own draft, this one carries a permission check so an
 * officer sees anybody's. Sharing a loader would mean one function whose access
 * rule depends on a flag, which is how an ownership predicate eventually gets
 * passed `undefined`.
 *
 * **Identity numbers are decrypted here and masked here.** An officer verifying
 * a CNIC against its scan needs the digits; a cashier receipting a pay order
 * does not, and holds `documents.read_financial` rather than `documents.read`
 * precisely so that difference is expressible. So the whole number is returned
 * only to an actor holding `documents.read` and everyone else gets the last
 * four characters — masked in this module rather than in the template, because
 * a value that reaches the page can reach a log line, an error report or a
 * print view, and none of those get reviewed again.
 */

export interface ReviewParticulars {
  readonly firmName: string | null;
  readonly representativeName: string | null;
  readonly representativeCnic: string | null;
  readonly representativePassport: string | null;
  readonly representativeDob: string | null;
  readonly representativeBirthplace: string | null;
  readonly representativeNationality: string | null;
  readonly postalAddress: string | null;
  readonly premisesTenure: string | null;
  readonly email: string | null;
  readonly officePhone1: string | null;
  readonly officePhone2: string | null;
  readonly fax: string | null;
  readonly mobile1: string | null;
  readonly mobile2: string | null;
  readonly paidUpCapital: string | null;
  readonly annualTurnover: string | null;
  readonly employeeCount: number | null;
  readonly ntn: string | null;
  readonly strnRegistered: boolean | null;
  readonly strn: string | null;
  readonly businessSector: string | null;
  readonly businessSubSector: string | null;
  readonly mainCommodity: string | null;
  readonly bankName: string | null;
  readonly bankBranch: string | null;
}

export interface ReviewDirector {
  readonly id: number;
  readonly position: number;
  readonly fullName: string | null;
  readonly designation: string | null;
  readonly membershipNo: string | null;
  readonly cnic: string | null;
  readonly cell: string | null;
  readonly isForeignNational: boolean;
  readonly attests: boolean;
}

export interface ReviewDocument {
  readonly id: string;
  readonly typeCode: string;
  readonly typeLabel: string;
  readonly subjectKind: string;
  readonly subjectId: number | null;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly issuedOn: string | null;
  readonly reviewState: string;
  readonly scanState: string;
  readonly reviewNote: string | null;
  readonly uploadedAt: Date;
  /** Whether the browser can render it in a frame; everything else downloads. */
  readonly viewable: boolean;
}

export interface ReviewEndorsement {
  readonly id: number;
  readonly role: string;
  readonly firmName: string | null;
  readonly membershipNo: string | null;
  readonly representativeName: string | null;
  readonly mobile: string | null;
  readonly state: string;
  readonly standingAtEndorsement: string | null;
  readonly endorsedAt: Date | null;
}

export interface ReviewRequiredDocument {
  readonly typeCode: string;
  readonly typeLabel: string;
  readonly cardinality: string;
  readonly requiredCount: number;
  readonly suppliedCount: number;
  readonly satisfied: boolean;
}

export interface ReviewTransition {
  readonly fromState: string | null;
  readonly toState: string;
  readonly code: string;
  readonly actorName: string | null;
  readonly actorRoleCode: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}

export interface ReviewNextStep {
  readonly code: TransitionCode;
  readonly toState: ApplicationState;
  readonly decision: TransitionDecision;
}

export interface ReviewView {
  readonly id: number;
  readonly publicRef: string | null;
  readonly state: ApplicationState;
  readonly version: number;
  readonly membershipClass: MembershipClass | null;
  readonly processingTier: ProcessingTier | null;
  readonly companyStatusCode: string | null;
  readonly companyStatusLabel: string | null;
  readonly requiresItdSurcharge: boolean;
  readonly endorsementMode: string | null;
  readonly submittedAt: Date | null;
  readonly decidedAt: Date | null;
  readonly assignedToId: number | null;
  readonly assignedToName: string | null;
  readonly applicantName: string;
  readonly applicantEmail: string;
  readonly particulars: ReviewParticulars;
  readonly businessTypes: readonly string[];
  readonly directors: readonly ReviewDirector[];
  readonly endorsements: readonly ReviewEndorsement[];
  /** Live documents: not deleted, not superseded. */
  readonly documents: readonly ReviewDocument[];
  /** Replaced ones, still visible because what changed after a deficiency matters. */
  readonly supersededDocuments: readonly ReviewDocument[];
  readonly requiredDocuments: readonly ReviewRequiredDocument[];
  readonly history: readonly ReviewTransition[];
  readonly dueDate: string | null;
  readonly slaState: string | null;
  readonly nextSteps: readonly ReviewNextStep[];
  readonly facts: TransitionFacts;
  /** False when identity numbers came back masked rather than whole. */
  readonly identitiesVisible: boolean;
}

/** The four formats upload accepts; nothing else can be rendered inline. */
const VIEWABLE = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * Keep the last four characters and nothing else.
 *
 * Four is enough for a cashier to say "yes, that is the number on the pay
 * order" while leaving a thirteen-digit CNIC unreconstructible.
 */
function maskIdentity(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/[^0-9A-Za-z]/g, "");
  if (compact.length <= 4) return "••••";
  return `•••• ${compact.slice(-4)}`;
}

export async function loadForReview(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<ReviewView | null> {
  if (!actor.permissions.has("application.read")) {
    throw new ForbiddenError("application.read");
  }

  const identitiesVisible = actor.permissions.has("documents.read");

  const application = await db
    .selectFrom("applications")
    .innerJoin("users as applicant", "applicant.id", "applications.created_by")
    .leftJoin("users as officer", "officer.id", "applications.assigned_to")
    .leftJoin(
      "company_statuses",
      "company_statuses.code",
      "applications.company_status_code",
    )
    .select([
      "applications.id",
      "applications.public_ref",
      "applications.state",
      "applications.version",
      "applications.membership_class",
      "applications.processing_tier",
      "applications.company_status_code",
      "applications.requires_itd_surcharge",
      "applications.endorsement_mode",
      "applications.submitted_at",
      "applications.decided_at",
      "applications.assigned_to",
      "applicant.full_name as applicant_name",
      "applicant.email as applicant_email",
      "officer.full_name as officer_name",
      "company_statuses.label_en as company_status_label",
    ])
    .where("applications.id", "=", applicationId)
    .executeTakeFirst();

  if (!application) return null;

  const [
    company,
    typeRows,
    directorRows,
    endorsementRows,
    documentRows,
    requiredRows,
    historyRows,
    clock,
    facts,
  ] = await Promise.all([
    db
      .selectFrom("application_company")
      .selectAll()
      .where("application_id", "=", applicationId)
      .executeTakeFirst(),
    db
      .selectFrom("application_business_types")
      .leftJoin(
        "business_types",
        "business_types.code",
        "application_business_types.business_type_code",
      )
      .select([
        "application_business_types.business_type_code",
        "business_types.label_en",
      ])
      .where("application_business_types.application_id", "=", applicationId)
      .orderBy("business_types.sort_order", "asc")
      .execute(),
    db
      .selectFrom("application_directors")
      .selectAll()
      .where("application_id", "=", applicationId)
      .orderBy("position", "asc")
      .execute(),
    db
      .selectFrom("application_endorsements")
      .selectAll()
      .where("application_id", "=", applicationId)
      .orderBy("role", "asc")
      .orderBy("id", "asc")
      .execute(),
    db
      .selectFrom("documents")
      .leftJoin(
        "document_types",
        "document_types.code",
        "documents.document_type_code",
      )
      .select([
        "documents.id",
        "documents.document_type_code",
        "documents.subject_kind",
        "documents.subject_id",
        "documents.original_filename",
        "documents.mime_type",
        "documents.byte_size",
        "documents.page_count",
        "documents.issued_on",
        "documents.review_state",
        "documents.scan_state",
        "documents.review_note",
        "documents.uploaded_at",
        "document_types.label_en",
      ])
      .where("documents.application_id", "=", applicationId)
      .where("documents.deleted_at", "is", null)
      .orderBy("document_types.sort_order", "asc")
      .orderBy("documents.uploaded_at", "desc")
      .execute(),
    db
      .selectFrom("application_required_documents")
      .leftJoin(
        "document_types",
        "document_types.code",
        "application_required_documents.document_type_code",
      )
      .select([
        "application_required_documents.document_type_code",
        "application_required_documents.cardinality",
        "application_required_documents.required_count",
        "application_required_documents.satisfied_at",
        "document_types.label_en",
      ])
      .where("application_required_documents.application_id", "=", applicationId)
      .orderBy("document_types.sort_order", "asc")
      .execute(),
    db
      .selectFrom("application_state_transitions")
      .leftJoin(
        "users",
        "users.id",
        "application_state_transitions.actor_user_id",
      )
      .select([
        "application_state_transitions.from_state",
        "application_state_transitions.to_state",
        "application_state_transitions.transition_code",
        "application_state_transitions.actor_role_code",
        "application_state_transitions.reason",
        "application_state_transitions.occurred_at",
        "users.full_name as actor_name",
      ])
      .where("application_state_transitions.application_id", "=", applicationId)
      .orderBy("application_state_transitions.id", "asc")
      .execute(),
    db
      .selectFrom("sla_clocks")
      .select(["due_date", "state"])
      .where("application_id", "=", applicationId)
      .orderBy("id", "desc")
      .executeTakeFirst(),
    gatherFacts(db, applicationId),
  ]);

  /**
   * Decrypt, then mask if this actor may not see the whole number.
   *
   * A column that will not decrypt returns null rather than throwing: it means
   * the key changed or the row was copied between environments, and the officer
   * looking at the screen is the person who will notice first. A 500 would hide
   * that behind a generic error page.
   */
  const identity = (
    table: string,
    rowId: number,
    column: string,
    enc: Buffer | null,
  ): string | null => {
    if (!enc) return null;
    let plain: string | null;
    try {
      plain = openField(table, rowId, column, enc);
    } catch {
      return null;
    }
    return identitiesVisible ? plain : maskIdentity(plain);
  };

  const particulars: ReviewParticulars = {
    firmName: company?.firm_name ?? null,
    representativeName: company?.representative_name ?? null,
    representativeCnic: identity(
      "application_company",
      applicationId,
      "representative_cnic",
      company?.representative_cnic_enc ?? null,
    ),
    representativePassport: identity(
      "application_company",
      applicationId,
      "representative_passport",
      company?.representative_passport_enc ?? null,
    ),
    representativeDob: company?.representative_dob ?? null,
    representativeBirthplace: company?.representative_birthplace ?? null,
    representativeNationality: company?.representative_nationality ?? null,
    postalAddress: company?.postal_address ?? null,
    premisesTenure: company?.premises_tenure ?? null,
    email: company?.email ?? null,
    officePhone1: company?.office_phone_1 ?? null,
    officePhone2: company?.office_phone_2 ?? null,
    fax: company?.fax ?? null,
    mobile1: company?.representative_mobile_1 ?? null,
    mobile2: company?.representative_mobile_2 ?? null,
    paidUpCapital: company?.paid_up_capital ?? null,
    annualTurnover: company?.annual_turnover ?? null,
    employeeCount: company?.employee_count ?? null,
    ntn: identity(
      "application_company",
      applicationId,
      "ntn",
      company?.ntn_enc ?? null,
    ),
    strnRegistered:
      company?.strn_registered === null || company?.strn_registered === undefined
        ? null
        : company.strn_registered === 1,
    strn: identity(
      "application_company",
      applicationId,
      "strn",
      company?.strn_enc ?? null,
    ),
    businessSector: company?.business_sector ?? null,
    businessSubSector: company?.business_sub_sector ?? null,
    mainCommodity: company?.main_commodity ?? null,
    bankName: company?.bank_name ?? null,
    bankBranch: company?.bank_branch ?? null,
  };

  const toDocument = (row: (typeof documentRows)[number]): ReviewDocument => ({
    id: row.id,
    typeCode: row.document_type_code,
    typeLabel: row.label_en ?? row.document_type_code,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    pageCount: row.page_count,
    issuedOn: row.issued_on,
    reviewState: row.review_state,
    scanState: row.scan_state,
    reviewNote: row.review_note,
    uploadedAt: row.uploaded_at,
    viewable: VIEWABLE.has(row.mime_type),
  });

  const live = documentRows.filter((row) => row.review_state !== "superseded");
  const superseded = documentRows.filter(
    (row) => row.review_state === "superseded",
  );

  // Counted against the frozen matrix rather than today's document_types, so a
  // later policy change cannot retroactively make a complete application
  // deficient.
  const suppliedByType = new Map<string, number>();
  for (const row of live) {
    suppliedByType.set(
      row.document_type_code,
      (suppliedByType.get(row.document_type_code) ?? 0) + 1,
    );
  }

  const actorView = {
    userId: actor.userId,
    isStaff: actor.userType === "staff",
    isSystem: actor.userType === "system",
    permissions: actor.permissions,
  };

  const nextSteps: ReviewNextStep[] = transitionsFrom(application.state)
    // Applicant-only edges are not the officer's to make and would read as
    // buttons they are inexplicably forbidden to press.
    .filter((transition) => transition.actor !== "applicant")
    .map((transition) => ({
      code: transition.code,
      toState: transition.to,
      decision: canTransition(facts, transition.code, actorView),
    }));

  return {
    id: application.id,
    publicRef: application.public_ref,
    state: application.state,
    version: application.version,
    membershipClass: application.membership_class,
    processingTier: application.processing_tier,
    companyStatusCode: application.company_status_code,
    companyStatusLabel: application.company_status_label ?? null,
    requiresItdSurcharge: application.requires_itd_surcharge === 1,
    endorsementMode: application.endorsement_mode,
    submittedAt: application.submitted_at,
    decidedAt: application.decided_at,
    assignedToId: application.assigned_to,
    assignedToName: application.officer_name ?? null,
    applicantName: application.applicant_name,
    applicantEmail: application.applicant_email,
    particulars,
    businessTypes: typeRows.map((row) => row.label_en ?? row.business_type_code),
    directors: directorRows.map((row) => ({
      id: row.id,
      position: row.position,
      fullName: row.full_name,
      designation: row.designation,
      membershipNo: row.membership_no,
      cnic: identity("application_directors", row.id, "cnic", row.cnic_enc),
      cell: row.cell,
      isForeignNational: row.is_foreign_national === 1,
      attests: row.attests === 1,
    })),
    endorsements: endorsementRows.map((row) => ({
      id: row.id,
      role: row.role,
      firmName: row.firm_name,
      membershipNo: row.membership_no,
      representativeName: row.representative_name,
      mobile: row.mobile,
      state: row.state,
      standingAtEndorsement: row.standing_at_endorsement,
      endorsedAt: row.endorsed_at,
    })),
    documents: live.map(toDocument),
    supersededDocuments: superseded.map(toDocument),
    requiredDocuments: requiredRows.map((row) => ({
      typeCode: row.document_type_code,
      typeLabel: row.label_en ?? row.document_type_code,
      cardinality: row.cardinality,
      requiredCount: row.required_count,
      suppliedCount: suppliedByType.get(row.document_type_code) ?? 0,
      satisfied: row.satisfied_at !== null,
    })),
    history: historyRows.map((row) => ({
      fromState: row.from_state,
      toState: row.to_state,
      code: row.transition_code,
      actorName: row.actor_name ?? null,
      actorRoleCode: row.actor_role_code,
      reason: row.reason,
      occurredAt: row.occurred_at,
    })),
    dueDate: clock?.due_date ?? null,
    slaState: clock?.state ?? null,
    nextSteps,
    facts,
    identitiesVisible,
  };
}
