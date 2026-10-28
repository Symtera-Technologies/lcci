import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { requireMember } from "@/server/auth/dal";
import {
  inFlightApplicationFor,
  loadDraft,
  startOrResumeDraft,
  type DraftView,
} from "@/membership/applications";
import { checkCompleteness } from "@/membership/submit";
import { openField } from "@/membership/sensitive";
import { GUARD_MESSAGES } from "@/membership/workflow";
import { stepForField } from "@/membership/validation";
import type { DocumentSubjectKind } from "@/db/schema";
import { StepIndicator, STEPS } from "@/components/membership/wizard-chrome";
import { StepParticulars } from "@/components/membership/step-particulars";
import { StepPeople } from "@/components/membership/step-people";
import { StepReview } from "@/components/membership/step-review";
import type { UploadSlotProps, UploadedDocument } from "@/components/membership/document-upload";

export const metadata: Metadata = {
  title: "Apply for membership",
  description:
    "Apply for LCCI membership online: your firm's particulars, directors and partners, proposer and seconder, and the supporting documents.",
  robots: { index: false, follow: false },
};

/**
 * The membership wizard.
 *
 * Rendered per request and never cached: it shows one applicant their own
 * half-finished form, and a cached page here would be a page served to the
 * wrong person.
 */
export const dynamic = "force-dynamic";

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const actor = await requireMember();

  // Before anything is created. `startOrResumeDraft` resumes a DRAFT and
  // nothing else, so calling it first for an applicant whose form is already
  // with the Chamber would open a second, empty application underneath them —
  // including for every applicant who follows the deficiency email back here.
  const inFlight = await inFlightApplicationFor(actor);
  if (inFlight) {
    // Their own application's page, whatever it needs from them. The wizard is
    // the wrong screen even in AWAITING_APPLICANT: a deficiency unlocks the
    // named fields and documents, not the form, and rendering all sixty inputs
    // would invite edits whose save is refused.
    redirect(`/membership/applications/${inFlight.id}`);
  }

  const applicationId = await startOrResumeDraft(actor);
  const draft = await loadDraft(actor, applicationId);

  if (!draft) notFound();

  const params = await searchParams;
  const step = pickStep(params.step, draft.application.wizard_step);

  const db = getDb();
  const completeness = await checkCompleteness(db, applicationId);
  const fieldErrors = flatten(completeness.fieldErrors);

  const [companyStatuses, businessTypes, documentTypes] = await Promise.all([
    db
      .selectFrom("company_statuses")
      .select(["code", "label_en"])
      .where("active", "=", 1)
      .orderBy("sort_order", "asc")
      .execute(),
    db
      .selectFrom("business_types")
      .select(["code", "label_en"])
      .where("active", "=", 1)
      .orderBy("sort_order", "asc")
      .execute(),
    db
      .selectFrom("document_types")
      .select(["code", "label_en", "guidance_en", "subject_kind"])
      .execute(),
  ]);

  const completed = completedSteps(completeness, draft);

  return (
    <main className="container-page py-12 lg:py-16">
      <header className="max-w-3xl">
        <p className="text-[0.8125rem] font-semibold uppercase tracking-wide text-brand-700">
          Membership application
        </p>
        <h1 className="mt-2 font-display text-display-md font-semibold text-ink-950">
          Apply to join the Lahore Chamber
        </h1>
        <p className="mt-3 text-[1.0625rem] leading-relaxed text-stone-600">
          Three steps. Your answers are saved as you type, so you can leave this and come
          back — a draft is kept for ninety days.
        </p>
      </header>

      <div className="mt-10">
        <StepIndicator current={step} completed={completed} />
      </div>

      <h2 className="sr-only">
        Step {step} of 3: {STEPS[step - 1].title}
      </h2>

      <div className="mt-10 max-w-3xl">
        {step === 1 && (
          <StepParticulars
            applicationId={applicationId}
            values={particularsValues(draft, applicationId)}
            scratch={draft.scratch}
            selectedBusinessTypes={draft.businessTypes}
            companyStatuses={companyStatuses.map((row) => ({
              value: row.code,
              label: row.label_en,
            }))}
            businessTypes={businessTypes.map((row) => ({
              value: row.code,
              label: row.label_en,
            }))}
            fieldErrors={fieldErrors}
          />
        )}

        {step === 2 && (
          <StepPeople
            applicationId={applicationId}
            directors={draft.directors.map((director) => ({
              id: Number(director.id),
              fullName: String(director.full_name ?? ""),
              designation: String(director.designation ?? ""),
              membershipNo: String(director.membership_no ?? ""),
              cell: String(director.cell ?? ""),
              cnic:
                openField(
                  "application_directors",
                  Number(director.id),
                  "cnic",
                  (director.cnic_enc as Buffer | null) ?? null,
                ) ?? "",
              passport:
                openField(
                  "application_directors",
                  Number(director.id),
                  "passport",
                  (director.passport_enc as Buffer | null) ?? null,
                ) ?? "",
              ntn:
                openField(
                  "application_directors",
                  Number(director.id),
                  "ntn",
                  (director.ntn_enc as Buffer | null) ?? null,
                ) ?? "",
              isForeignNational: director.is_foreign_national === 1,
            }))}
            proposer={endorserRow(draft, "proposer")}
            seconder={endorserRow(draft, "seconder")}
            endorsementMode={draft.application.endorsement_mode}
            scratch={draft.scratch}
            fieldErrors={fieldErrors}
          />
        )}

        {step === 3 && (
          <StepReview
            applicationId={applicationId}
            slots={uploadSlots(draft, completeness.required, documentTypes, applicationId)}
            attesterOptions={draft.directors
              .filter((director) => Number(director.id) !== completeness.representativeDirectorId)
              .map((director) => ({
                value: String(director.id),
                label: String(director.full_name ?? `Director ${director.id}`),
              }))}
            attestingDirectorId={completeness.attestingDirectorId}
            declarationAccepted={completeness.declarationAccepted}
            blockers={blockers(completeness)}
            missingDocuments={completeness.missingDocuments}
            readyToSubmit={completeness.formComplete && completeness.documentsComplete}
            fieldErrors={fieldErrors}
          />
        )}
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* View model                                                                 */
/* -------------------------------------------------------------------------- */

function pickStep(requested: string | undefined, saved: number): 1 | 2 | 3 {
  const asked = Number(requested);
  if (asked === 1 || asked === 2 || asked === 3) return asked;
  return saved === 2 || saved === 3 ? saved : 1;
}

/**
 * The applicant's own values, with the encrypted columns opened.
 *
 * Decrypted on purpose: this is the applicant looking at their own CNIC, and a
 * form that shows an empty box where their identity number should be is a form
 * they will retype it into — producing a second chance to mistype it and no
 * way to tell which of the two the Chamber should believe.
 */
function particularsValues(
  draft: DraftView,
  applicationId: number,
): Record<string, string | undefined> {
  const company = draft.company ?? {};
  const text = (key: string) => {
    const value = company[key];
    return value === null || value === undefined ? "" : String(value);
  };

  const sealed = (column: string) =>
    openField(
      "application_company",
      applicationId,
      column,
      (company[`${column}_enc`] as Buffer | null) ?? null,
    ) ?? "";

  return {
    membershipClass: draft.application.membership_class ?? "",
    processingTier: draft.application.processing_tier ?? "",
    companyStatus: draft.application.company_status_code ?? "",
    firmName: text("firm_name"),
    representativeName: text("representative_name"),
    representativeCnic: sealed("representative_cnic"),
    representativePassport: sealed("representative_passport"),
    representativeDob: text("representative_dob"),
    representativeBirthplace: text("representative_birthplace"),
    representativeNationality: text("representative_nationality"),
    postalAddress: text("postal_address"),
    premisesTenure: text("premises_tenure"),
    email: text("email"),
    officePhone1: text("office_phone_1"),
    officePhone2: text("office_phone_2"),
    fax: text("fax"),
    representativeMobile1: text("representative_mobile_1"),
    representativeMobile2: text("representative_mobile_2"),
    paidUpCapital: text("paid_up_capital"),
    annualTurnover: text("annual_turnover"),
    employeeCount: text("employee_count"),
    ntn: sealed("ntn"),
    strn: sealed("strn"),
    businessSector: text("business_sector"),
    businessSubSector: text("business_sub_sector"),
    mainCommodity: text("main_commodity"),
    bankName: text("bank_name"),
    bankBranch: text("bank_branch"),
  };
}

function endorserRow(draft: DraftView, role: "proposer" | "seconder") {
  const row = draft.endorsements.find((entry) => entry.role === role);

  return {
    firmName: String(row?.firm_name ?? ""),
    membershipNo: String(row?.membership_no ?? ""),
    representativeName: String(row?.representative_name ?? ""),
    mobile: String(row?.mobile ?? ""),
    email: String(row?.email ?? ""),
    state: String(row?.state ?? "invited"),
  };
}

/**
 * One upload slot per required document, and one per director where the
 * requirement is per-person.
 *
 * `all_directors` is the reason this is not a flat list: "CNIC of ALL
 * directors" against a board of six is six slots, each labelled with whose
 * CNIC it wants. A single slot that silently needs six files is how an
 * application arrives with one.
 */
function uploadSlots(
  draft: DraftView,
  required: readonly {
    documentTypeCode: string;
    cardinality: string;
    requiredCount: number;
    note: string | null;
  }[],
  documentTypes: readonly {
    code: string;
    label_en: string;
    guidance_en: string | null;
    subject_kind: DocumentSubjectKind;
  }[],
  applicationId: number,
): UploadSlotProps[] {
  const labels = new Map(documentTypes.map((row) => [row.code, row]));
  const slots: UploadSlotProps[] = [];

  for (const requirement of required) {
    const type = labels.get(requirement.documentTypeCode);
    const label = type?.label_en ?? requirement.documentTypeCode;
    const note = requirement.note ?? type?.guidance_en ?? null;
    // The subject comes from the document type, not from the slot: a
    // representative's photograph belongs to the representative and a utility
    // bill belongs to the company, and the upload route records which so the
    // officer's checklist can tie a tick to the right person.
    const subjectKind = type?.subject_kind ?? "company";

    if (requirement.cardinality === "all_directors") {
      for (const director of draft.directors) {
        const directorId = Number(director.id);
        slots.push({
          applicationId,
          documentTypeCode: requirement.documentTypeCode,
          label,
          note,
          subjectKind: "director",
          subjectId: directorId,
          subjectLabel: String(director.full_name ?? `Director ${directorId}`),
          existing: documentsFor(draft, requirement.documentTypeCode, directorId),
        });
      }
      continue;
    }

    slots.push({
      applicationId,
      documentTypeCode: requirement.documentTypeCode,
      label,
      note,
      subjectKind,
      subjectId: null,
      existing: documentsFor(draft, requirement.documentTypeCode, null),
    });
  }

  return slots;
}

function documentsFor(
  draft: DraftView,
  typeCode: string,
  subjectId: number | null,
): UploadedDocument[] {
  return draft.documents
    .filter(
      (document) =>
        document.document_type_code === typeCode &&
        (subjectId === null || Number(document.subject_id) === subjectId) &&
        document.review_state !== "superseded",
    )
    .map((document) => ({
      id: String(document.id),
      filename: String(document.original_filename),
      byteSize: Number(document.byte_size),
      reviewState: String(document.review_state),
    }));
}

/** What still stands between this application and submission, in plain words. */
function blockers(completeness: {
  formComplete: boolean;
  documentsComplete: boolean;
  declarationAccepted: boolean;
}): string[] {
  const out: string[] = [];
  if (!completeness.formComplete) out.push(GUARD_MESSAGES.form_complete);
  if (!completeness.documentsComplete) out.push(GUARD_MESSAGES.documents_complete);
  if (!completeness.declarationAccepted) out.push(GUARD_MESSAGES.declaration_accepted);
  return out;
}

/**
 * Which steps to tick.
 *
 * Derived from the same completeness check the submit transition runs, so a
 * ticked step and a refused submission cannot disagree.
 */
function completedSteps(
  completeness: { fieldErrors: Record<string, string[]>; documentsComplete: boolean; declarationAccepted: boolean },
  draft: DraftView,
): number[] {
  const fields = Object.keys(completeness.fieldErrors);
  const done: number[] = [];

  const step1Clean = !fields.some((field) => stepForField(field) === 1);
  const step2Clean = !fields.some((field) => stepForField(field) === 2) && draft.directors.length > 0;

  if (step1Clean) done.push(1);
  if (step2Clean) done.push(2);
  if (completeness.documentsComplete && completeness.declarationAccepted) done.push(3);

  return done;
}

function flatten(errors: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) {
    if (messages.length > 0) out[field] = messages[0];
  }
  return out;
}
