import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import type { ActorContext } from "@/server/actor";
import { ConcurrencyError } from "@/server/actor";
import {
  acceptDeclaration,
  saveDirectors,
  saveEndorsers,
  saveParticulars,
  startOrResumeDraft,
  loadDraft,
} from "@/membership/applications";
import {
  SubmitBlockedError,
  checkCompleteness,
  submitApplication,
} from "@/membership/submit";
import { nthWorkingDayAfter } from "@/membership/sla";
import { verifyAuditChain } from "@/server/audit";
import {
  createUser,
  databaseAvailable,
  inParallel,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * The submit transition, end to end.
 *
 * This is the test the plan describes as "the one path that proves the
 * system", minus the office half that Track A has not built yet. Everything it
 * asserts is a claim no unit test can make: a reference allocated under a row
 * lock, payment rows that match a dated fee schedule, a due date counted off a
 * working-day calendar, a hashed snapshot of what was submitted, and a second
 * concurrent submission losing cleanly.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping submit tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

/** Children before parents; the FK cascades do the rest. */
const TABLES = [
  "documents",
  "submission_snapshots",
  "application_state_transitions",
  "application_required_documents",
  "application_authorisation",
  "application_endorsements",
  "application_directors",
  "application_business_types",
  "application_company",
  "sla_pauses",
  "sla_clocks",
  "pay_orders",
  "payments",
  "applications",
  "audit_log",
  "users",
];

function portalActor(userId: number): ActorContext {
  return {
    userId,
    userType: "portal",
    roleCode: null,
    roleCodes: [],
    permissions: new Set(),
    departmentScopes: [],
    requestId: newUlid(),
    ipHash: "a".repeat(64),
    userAgentHash: "b".repeat(64),
    onBehalfOfUserId: null,
  };
}

const PARTICULARS = {
  membershipClass: "corporate",
  processingTier: "regular",
  companyStatus: "partnership",
  firmName: "Shalimar Textiles",
  representativeName: "A. Representative",
  representativeCnic: "35202-1234567-1",
  representativeDob: "1980-04-15",
  representativeBirthplace: "Lahore",
  representativeNationality: "Pakistani",
  postalAddress: "11 Shara-e-Aiwan-e-Sanat-o-Tijarat, Lahore",
  premisesTenure: "rented",
  email: "office@example.com.pk",
  officePhone1: "042-37654321",
  representativeMobile1: "0300-1234567",
  paidUpCapital: "5000000",
  annualTurnover: "60000000",
  employeeCount: "42",
  ntn: "1234567-8",
  strnRegistered: "on",
  strn: "17-00-9999-999-99",
  businessSector: "Textiles",
  businessSubSector: "Home textiles",
  mainCommodity: "Bed linen",
  businessTypes: ["exporter", "manufacturer"],
  bankName: "Habib Bank Limited",
  bankBranch: "Gulberg III, Lahore",
};

/**
 * Build a draft that is ready to submit.
 *
 * Deliberately through the same repository functions the wizard calls, not by
 * inserting rows. A fixture that writes the tables directly would pass while
 * the save path was broken, which is most of what there is to get wrong here.
 */
async function completeDraft(
  actor: ActorContext,
  options: { foreignDirector?: boolean } = {},
): Promise<number> {
  const db = getDb();
  const applicationId = await startOrResumeDraft(actor);

  await saveParticulars(actor, { applicationId, ...PARTICULARS });

  await saveDirectors(actor, {
    applicationId,
    directors: [
      {
        // The representative's own row: same CNIC, which is how the
        // representative is found among the directors.
        fullName: "A. Representative",
        designation: "Managing Partner",
        cell: "0300-1234567",
        cnic: "35202-1234567-1",
      },
      {
        fullName: "B. Partner",
        designation: "Partner",
        cell: "0300-7654321",
        cnic: "35202-7654321-2",
        isForeignNational: options.foreignDirector ? "on" : "",
      },
    ],
  });

  await saveEndorsers(actor, {
    applicationId,
    endorsementMode: "in_app",
    endorsers: [
      {
        role: "proposer",
        firmName: "Ravi Trading Co",
        membershipNo: "L-1001",
        representativeName: "C. Member",
        mobile: "0321-1112223",
      },
      {
        role: "seconder",
        firmName: "Mall Road Exports",
        membershipNo: "L-1002",
        representativeName: "D. Member",
        mobile: "0321-4445556",
      },
    ],
  });

  // Both endorsements given and in good standing. The in-app endorsement flow
  // is Track A's next piece; what this transition needs is the state.
  await db
    .updateTable("application_endorsements")
    .set({
      state: "endorsed",
      standing_at_endorsement: "active",
      endorsed_at: new Date(),
    })
    .where("application_id", "=", applicationId)
    .execute();

  const draft = await loadDraft(actor, applicationId);
  const attester = draft!.directors.find(
    (director) => director.full_name === "B. Partner",
  );

  await acceptDeclaration(actor, {
    applicationId,
    attestingDirectorId: Number(attester!.id),
    accepted: true,
  });

  await uploadRequiredDocuments(actor, applicationId);

  return applicationId;
}

/**
 * One document per requirement, straight into the table.
 *
 * The upload route has its own tests; what matters here is that the matrix is
 * read from reference data rather than hard-coded, so this fixture keeps
 * working when LCCI corrects the Partnership list.
 */
async function uploadRequiredDocuments(
  actor: ActorContext,
  applicationId: number,
): Promise<void> {
  const db = getDb();

  const completeness = await checkCompleteness(db, applicationId);
  const directors = await db
    .selectFrom("application_directors")
    .select(["id"])
    .where("application_id", "=", applicationId)
    .execute();

  for (const requirement of completeness.required) {
    if (requirement.cardinality === "optional") continue;

    const subjects =
      requirement.cardinality === "all_directors"
        ? directors.map((director) => director.id)
        : [null];

    for (const subjectId of subjects) {
      const id = randomUUID();
      await db
        .insertInto("documents")
        .values({
          id,
          application_id: applicationId,
          document_type_code: requirement.documentTypeCode,
          subject_kind: subjectId === null ? "company" : "director",
          subject_id: subjectId,
          original_filename: `${requirement.documentTypeCode}.pdf`,
          storage_key: `test/${id}.pdf`,
          mime_type: "application/pdf",
          byte_size: 1024,
          sha256: "c".repeat(64),
          uploaded_by: actor.userId,
        })
        .execute();
    }
  }
}

describe.skipIf(!available)("the submit transition", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    // Reference data, not test data: reset the counter rather than the rows,
    // or the sequence the transition reads disappears.
    await sql`
      UPDATE number_sequences SET next_value = 1, period_key = NULL WHERE name = 'application_ref'
    `.execute(getDb());
  });

  it("submits a complete application", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("applicant@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    const completeness = await checkCompleteness(db, applicationId);
    expect(completeness.fieldErrors).toEqual({});
    expect(completeness.formComplete).toBe(true);
    expect(completeness.documentsComplete).toBe(true);

    const result = await submitApplication(actor, applicationId);

    expect(result.publicRef).toMatch(/^LCCI-APP-\d{4}-\d{5}$/);
    expect(result.snapshotRound).toBe(1);
    expect(result.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);

    const application = await db
      .selectFrom("applications")
      .selectAll()
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(application.state).toBe("SUBMITTED");
    expect(application.public_ref).toBe(result.publicRef);
    expect(application.submitted_at).not.toBeNull();
    expect(application.form_revision_id).not.toBeNull();
    expect(application.fee_schedule_id).not.toBeNull();
    // A submitted application must never be swept by the draft-expiry job.
    expect(application.expires_at).toBeNull();
    expect(application.version).toBe(2);
  });

  it("charges the Corporate Regular fee and nothing else", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("fees@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    await submitApplication(actor, applicationId);

    const payments = await db
      .selectFrom("payments")
      .select(["fee_kind", "amount", "currency", "state", "method"])
      .where("application_id", "=", applicationId)
      .execute();

    expect(payments).toHaveLength(1);
    expect(payments[0].fee_kind).toBe("membership");
    expect(Number(payments[0].amount)).toBe(10_650);
    expect(payments[0].currency).toBe("PKR");
    expect(payments[0].state).toBe("due");
    expect(payments[0].method).toBe("pay_order");
  });

  it("adds the USD 750 surcharge when a partner is a foreign national", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("foreign@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor, { foreignDirector: true });

    await submitApplication(actor, applicationId);

    const payments = await db
      .selectFrom("payments")
      .select(["fee_kind", "amount", "currency"])
      .where("application_id", "=", applicationId)
      .orderBy("fee_kind", "asc")
      .execute();

    expect(payments.map((row) => row.fee_kind).sort()).toEqual([
      "itd_surcharge",
      "membership",
    ]);

    const surcharge = payments.find((row) => row.fee_kind === "itd_surcharge")!;
    expect(Number(surcharge.amount)).toBe(750);
    // The form requires a *separate* pay order in USD; the rupee equivalent is
    // Finance's to state, which is why `amount_pkr` stays null here.
    expect(surcharge.currency).toBe("USD");

    const application = await db
      .selectFrom("applications")
      .select(["requires_itd_surcharge"])
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();
    expect(application.requires_itd_surcharge).toBe(1);
  });

  it("starts the clock on the 40th working day", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("sla@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    const result = await submitApplication(actor, applicationId);

    const clock = await db
      .selectFrom("sla_clocks")
      .selectAll()
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(clock.state).toBe("running");
    expect(clock.working_days).toBe(40);
    expect(clock.due_date).toBe(result.dueDate);

    // The same answer, computed the same way: there is one implementation of
    // "the 40th working day" and this is it.
    const expected = await nthWorkingDayAfter(
      db,
      new Date().toISOString().slice(0, 10),
      40,
    );
    expect(clock.due_date).toBe(expected);
    expect(clock.due_date > new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("freezes the document matrix as rows", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("matrix@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    await submitApplication(actor, applicationId);

    const frozen = await db
      .selectFrom("application_required_documents")
      .selectAll()
      .where("application_id", "=", applicationId)
      .execute();

    expect(frozen.length).toBeGreaterThan(0);

    // "CNIC of ALL directors" against a two-person board is two, and the
    // applicant should have been told two.
    const perDirector = frozen.filter((row) => row.cardinality === "all_directors");
    expect(perDirector.length).toBeGreaterThan(0);
    for (const row of perDirector) expect(row.required_count).toBe(2);
  });

  it("writes a verifiable snapshot and leaves the audit chain intact", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("snapshot@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    const result = await submitApplication(actor, applicationId);

    const snapshot = await db
      .selectFrom("submission_snapshots")
      .selectAll()
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(snapshot.round).toBe(1);
    expect(snapshot.payload_sha256).toBe(result.snapshotSha256);

    // mysql2 parses a JSON column for you, so what comes back is already an
    // object. Handled both ways rather than assumed, because MariaDB stores
    // JSON as LONGTEXT and hands back the string.
    const raw = snapshot.payload_json as unknown;
    const payload = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;

    // The CNIC is in the snapshot in the clear and the ciphertext is not.
    // Both halves matter: an auditable record of a declaration has to carry
    // what was declared, and a hash that included the ciphertext would change
    // on every re-encryption and be unverifiable.
    expect(payload.company.representative_cnic).toBe("35202-1234567-1");
    expect(JSON.stringify(payload)).not.toContain("_enc");

    expect(payload.documents.length).toBeGreaterThan(0);
    expect(payload.authorisation.declarationText).toContain("solemnly declare");

    const verification = await verifyAuditChain();
    expect(verification.brokenAtId).toBeNull();
    expect(verification.checked).toBeGreaterThan(0);

    const events = await db
      .selectFrom("audit_log")
      .select(["action"])
      .where("entity_type", "=", "application")
      .execute();
    expect(events.map((row) => row.action)).toContain("application.submitted");
  });

  it("records the transition in the application's own history", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("history@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    await submitApplication(actor, applicationId);

    const transitions = await db
      .selectFrom("application_state_transitions")
      .selectAll()
      .where("application_id", "=", applicationId)
      .execute();

    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_state).toBe("DRAFT");
    expect(transitions[0].to_state).toBe("SUBMITTED");
    expect(transitions[0].transition_code).toBe("submit");
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("submission refusals", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await sql`
      UPDATE number_sequences SET next_value = 1, period_key = NULL WHERE name = 'application_ref'
    `.execute(getDb());
  });

  it("refuses an incomplete draft without consuming a reference", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("partial@example.com.pk", "portal"));
    const applicationId = await startOrResumeDraft(actor);

    await saveParticulars(actor, { applicationId, firmName: "Half a Form" });

    await expect(submitApplication(actor, applicationId)).rejects.toBeInstanceOf(
      SubmitBlockedError,
    );

    const application = await db
      .selectFrom("applications")
      .select(["state", "public_ref", "version"])
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();

    // The whole transaction rolled back: still a draft, still unreferenced.
    // A refused submission that burned a reference would leave a gap in a
    // sequence applicants quote, and nobody could later say why.
    expect(application.state).toBe("DRAFT");
    expect(application.public_ref).toBeNull();
    expect(application.version).toBe(1);

    const sequence = await db
      .selectFrom("number_sequences")
      .select(["next_value"])
      .where("name", "=", "application_ref")
      .executeTakeFirstOrThrow();
    expect(Number(sequence.next_value)).toBe(1);
  });

  it("says which step to go back to", async () => {
    const actor = portalActor(await createUser("step@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    // Break one step-1 field and nothing else.
    await getDb()
      .updateTable("application_company")
      .set({ bank_branch: null })
      .where("application_id", "=", applicationId)
      .execute();

    await expect(submitApplication(actor, applicationId)).rejects.toMatchObject({
      name: "SubmitBlockedError",
      step: 1,
    });
  });

  it("refuses when the representative attests to their own representation", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("self@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    const representative = await db
      .selectFrom("application_directors")
      .select(["id"])
      .where("application_id", "=", applicationId)
      .where("full_name", "=", "A. Representative")
      .executeTakeFirstOrThrow();

    await acceptDeclaration(actor, {
      applicationId,
      attestingDirectorId: representative.id,
      accepted: true,
    });

    await expect(submitApplication(actor, applicationId)).rejects.toBeInstanceOf(
      SubmitBlockedError,
    );
  });

  it("refuses to submit another applicant's draft", async () => {
    const owner = portalActor(await createUser("owner@example.com.pk", "portal"));
    const stranger = portalActor(await createUser("stranger@example.com.pk", "portal"));
    const applicationId = await completeDraft(owner);

    await expect(submitApplication(stranger, applicationId)).rejects.toThrow(
      /could not be found/,
    );
  });

  it("refuses a second submission of the same application", async () => {
    const actor = portalActor(await createUser("twice@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    await submitApplication(actor, applicationId);

    await expect(submitApplication(actor, applicationId)).rejects.toBeInstanceOf(
      ConcurrencyError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The race                                                                   */
/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("two submissions at once", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await sql`
      UPDATE number_sequences SET next_value = 1, period_key = NULL WHERE name = 'application_ref'
    `.execute(getDb());
  });

  it("lets exactly one win and allocates exactly one reference", async () => {
    const db = getDb();
    const actor = portalActor(await createUser("race@example.com.pk", "portal"));
    const applicationId = await completeDraft(actor);

    // Four at once. Passenger runs several worker processes, so an impatient
    // double-click is genuinely two requests racing on one row — this is not
    // a hypothetical.
    const results = await inParallel(4, () =>
      submitApplication(portalActor(actor.userId!), applicationId),
    );

    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);

    for (const loser of results.filter((result) => !result.ok)) {
      expect(loser.ok).toBe(false);
    }

    const applications = await db
      .selectFrom("applications")
      .select(["public_ref", "state", "version"])
      .where("id", "=", applicationId)
      .execute();

    expect(applications[0].state).toBe("SUBMITTED");
    expect(applications[0].version).toBe(2);

    // One reference consumed, not four. The losers rolled back their
    // allocation along with everything else.
    const sequence = await db
      .selectFrom("number_sequences")
      .select(["next_value"])
      .where("name", "=", "application_ref")
      .executeTakeFirstOrThrow();
    expect(Number(sequence.next_value)).toBe(2);

    const payments = await db
      .selectFrom("payments")
      .select(["id"])
      .where("application_id", "=", applicationId)
      .execute();
    expect(payments).toHaveLength(1);

    const clocks = await db
      .selectFrom("sla_clocks")
      .select(["id"])
      .where("application_id", "=", applicationId)
      .execute();
    expect(clocks).toHaveLength(1);

    const snapshots = await db
      .selectFrom("submission_snapshots")
      .select(["round"])
      .where("application_id", "=", applicationId)
      .execute();
    expect(snapshots).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Autosave                                                                   */
/* -------------------------------------------------------------------------- */

describe.skipIf(!available)("autosave", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("keeps a value that cannot go in its column, and gives it back", async () => {
    const actor = portalActor(await createUser("scratch@example.com.pk", "portal"));
    const applicationId = await startOrResumeDraft(actor);

    const result = await saveParticulars(actor, {
      applicationId,
      firmName: "Shalimar Textiles",
      annualTurnover: "approx 60m",
    });

    expect(result.pending).toContain("annualTurnover");

    const draft = await loadDraft(actor, applicationId);
    expect(draft!.company!.annual_turnover).toBeNull();
    expect(draft!.scratch.annualTurnover).toBe("approx 60m");
    // The rest of the form survived, which is the point.
    expect(draft!.company!.firm_name).toBe("Shalimar Textiles");
  });

  it("clears the scratch entry once the value parses", async () => {
    const actor = portalActor(await createUser("scratch2@example.com.pk", "portal"));
    const applicationId = await startOrResumeDraft(actor);

    await saveParticulars(actor, { applicationId, annualTurnover: "approx 60m" });
    await saveParticulars(actor, { applicationId, annualTurnover: "60,000,000" });

    const draft = await loadDraft(actor, applicationId);
    expect(Number(draft!.company!.annual_turnover)).toBe(60_000_000);
    expect(draft!.scratch.annualTurnover).toBeUndefined();
  });

  it("returns the same draft rather than opening a second one", async () => {
    const actor = portalActor(await createUser("resume@example.com.pk", "portal"));

    const first = await startOrResumeDraft(actor);
    const second = await startOrResumeDraft(actor);

    expect(second).toBe(first);
  });

  it("refuses to save into someone else's draft", async () => {
    const owner = portalActor(await createUser("mine@example.com.pk", "portal"));
    const stranger = portalActor(await createUser("theirs@example.com.pk", "portal"));
    const applicationId = await startOrResumeDraft(owner);

    await expect(
      saveParticulars(stranger, { applicationId, firmName: "Not mine" }),
    ).rejects.toThrow(/could not be found/);
  });
});
