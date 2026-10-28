import "server-only";

import { sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import { canonicalJson } from "@/server/audit";
import { sha256Hex } from "@/server/crypto";
import { openField } from "@/membership/sensitive";

/**
 * The immutable record of what was submitted.
 *
 * This is what makes the digital form auditable under the chamber's ISO
 * procedure, and it replaces rendering and storing a PDF per submission —
 * which on this host would have to be an off-box job, because a PDF renderer
 * in a Passenger worker is the same memory problem as an image decoder.
 *
 * Instead: canonical JSON of every field plus every document's SHA-256, keys
 * sorted, the whole thing hashed. The human-readable artefact is an HTML view
 * of this snapshot with a print stylesheet, which costs essentially no memory
 * and can be regenerated from the row at any time. The hash is what an auditor
 * verifies; the HTML is only a rendering of it.
 *
 * One row per round. Answering a deficiency writes round 2 rather than editing
 * round 1, so every successive version of the truth survives.
 */

/**
 * The canonical serialisation is `audit.ts`'s, imported rather than
 * reimplemented.
 *
 * Two implementations of "the hash" is the same mistake as two
 * implementations of "the 40th working day": they agree until one of them
 * learns about a new type, and then an auditor holding the same data computes
 * a different digest and cannot tell which side is wrong. Re-exported so this
 * module still reads as the owner of the snapshot format.
 */
export { canonicalJson };

export interface SnapshotResult {
  readonly round: number;
  readonly sha256: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Build and store the snapshot for an application.
 *
 * Identity numbers are decrypted into the snapshot on purpose. The snapshot is
 * the auditable record of what the applicant declared, and a record that says
 * "a CNIC was supplied" cannot be audited against the CNIC on the scan. The
 * payload column therefore holds PII and is covered by the same retention rule
 * as the documents — which is exactly why that rule has to be ratified rather
 * than assumed.
 */
export async function writeSubmissionSnapshot(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    readonly formRevisionId: number;
    readonly createdBy: number | null;
    readonly requestId: string;
  },
): Promise<SnapshotResult> {
  const { applicationId } = params;

  const application = await tx
    .selectFrom("applications")
    .select([
      "id",
      "public_ref",
      "state",
      "membership_class",
      "processing_tier",
      "company_status_code",
      "form_revision_id",
      "fee_schedule_id",
      "requires_itd_surcharge",
      "endorsement_mode",
    ])
    .where("id", "=", applicationId)
    .executeTakeFirstOrThrow();

  const company = await tx
    .selectFrom("application_company")
    .selectAll()
    .where("application_id", "=", applicationId)
    .executeTakeFirst();

  const businessTypes = await tx
    .selectFrom("application_business_types")
    .select("business_type_code")
    .where("application_id", "=", applicationId)
    .orderBy("business_type_code", "asc")
    .execute();

  const directors = await tx
    .selectFrom("application_directors")
    .selectAll()
    .where("application_id", "=", applicationId)
    .orderBy("position", "asc")
    .orderBy("id", "asc")
    .execute();

  const endorsements = await tx
    .selectFrom("application_endorsements")
    .select([
      "id",
      "role",
      "firm_name",
      "membership_no",
      "representative_name",
      "mobile",
      "email",
      "state",
      "standing_at_endorsement",
      "endorsed_at",
      "declaration_text",
    ])
    .where("application_id", "=", applicationId)
    .orderBy("role", "asc")
    .orderBy("id", "asc")
    .execute();

  const authorisation = await tx
    .selectFrom("application_authorisation")
    .selectAll()
    .where("application_id", "=", applicationId)
    .executeTakeFirst();

  // Documents enter the snapshot as a manifest, never as bytes: type, subject,
  // size and digest. That is what ties the record to the files, and it is what
  // survives the retention sweep deleting the files themselves.
  const documents = await tx
    .selectFrom("documents")
    .select([
      "id",
      "document_type_code",
      "subject_kind",
      "subject_id",
      "mime_type",
      "byte_size",
      "sha256",
      "page_count",
      "issued_on",
      "review_state",
      "uploaded_at",
    ])
    .where("application_id", "=", applicationId)
    .where("deleted_at", "is", null)
    .orderBy("document_type_code", "asc")
    .orderBy("id", "asc")
    .execute();

  const payload: Record<string, unknown> = {
    application: {
      id: application.id,
      publicRef: application.public_ref,
      membershipClass: application.membership_class,
      processingTier: application.processing_tier,
      companyStatus: application.company_status_code,
      formRevisionId: params.formRevisionId,
      feeScheduleId: application.fee_schedule_id,
      requiresItdSurcharge: application.requires_itd_surcharge === 1,
      endorsementMode: application.endorsement_mode,
    },
    company: company ? snapshotCompany(applicationId, company) : null,
    businessTypes: businessTypes.map((row) => row.business_type_code),
    directors: directors.map((director) => snapshotDirector(director)),
    endorsements,
    authorisation: authorisation
      ? {
          declarationAcceptedAt: authorisation.declaration_accepted_at,
          declarationText: authorisation.declaration_text,
          declaredBy: authorisation.declared_by,
          attestedByDirectorId: authorisation.attested_by_director_id,
          attestedAt: authorisation.attested_at,
        }
      : null,
    documents,
  };

  const canonical = canonicalJson(payload);
  const digest = sha256Hex(canonical);

  // The round number is taken under a lock on the application's existing
  // snapshots, so two concurrent writers cannot both claim round 2. The UNIQUE
  // index on (application_id, round) is the backstop.
  const highest = await sql<{ round: number | null }>`
    SELECT MAX(round) AS round
      FROM submission_snapshots
     WHERE application_id = ${applicationId}
     FOR UPDATE
  `.execute(tx);

  const round = Number(highest.rows[0]?.round ?? 0) + 1;

  await tx
    .insertInto("submission_snapshots")
    .values({
      application_id: applicationId,
      round,
      form_revision_id: params.formRevisionId,
      payload_json: canonical,
      payload_sha256: digest,
      created_by: params.createdBy,
      request_id: params.requestId,
    })
    .execute();

  return { round, sha256: digest, payload };
}

/**
 * The company satellite, with the encrypted columns opened and the ciphertext
 * left out.
 *
 * Including both the plaintext and the ciphertext would make the hash depend
 * on the encryption nonce, so the same declaration snapshotted twice would
 * produce two different digests and the record would be unverifiable.
 */
function snapshotCompany(
  applicationId: number,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_enc") || key.endsWith("_hmac")) continue;
    if (key === "application_id" || key === "updated_at") continue;
    out[key] = value;
  }

  out.representative_cnic = openField(
    "application_company",
    applicationId,
    "representative_cnic",
    (row.representative_cnic_enc as Buffer | null) ?? null,
  );
  out.representative_passport = openField(
    "application_company",
    applicationId,
    "representative_passport",
    (row.representative_passport_enc as Buffer | null) ?? null,
  );
  out.ntn = openField(
    "application_company",
    applicationId,
    "ntn",
    (row.ntn_enc as Buffer | null) ?? null,
  );
  out.strn = openField(
    "application_company",
    applicationId,
    "strn",
    (row.strn_enc as Buffer | null) ?? null,
  );

  return out;
}

function snapshotDirector(row: Record<string, unknown>): Record<string, unknown> {
  const id = row.id as number;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_enc") || key.endsWith("_hmac")) continue;
    if (key === "updated_at") continue;
    out[key] = value;
  }

  out.cnic = openField("application_directors", id, "cnic", (row.cnic_enc as Buffer | null) ?? null);
  out.passport = openField(
    "application_directors",
    id,
    "passport",
    (row.passport_enc as Buffer | null) ?? null,
  );
  out.ntn = openField("application_directors", id, "ntn", (row.ntn_enc as Buffer | null) ?? null);

  return out;
}
