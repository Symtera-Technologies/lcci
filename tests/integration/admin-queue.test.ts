import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import type { ActorContext } from "@/server/actor";
import { ForbiddenError } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import { loadQueue } from "@/membership/queue";
import { loadForReview } from "@/membership/review";
import { claimApplication, releaseApplication } from "@/membership/assignment";
import { sealField } from "@/membership/sensitive";
import {
  createUser,
  databaseAvailable,
  inParallel,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * The admin queue, the review loader and assignment, against the database.
 *
 * Everything here is a claim the unit tests cannot make. The scope tabs are a
 * `WHERE state IN (…)`, the counts are a `GROUP BY` that has to agree with the
 * list it sits above, identity masking depends on a permission set, and the
 * assignment guard only means anything when two writers actually race for one
 * row.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping admin queue tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

const TABLES = [
  "documents",
  "application_state_transitions",
  "application_required_documents",
  "application_company",
  "sla_clocks",
  "applications",
  "audit_log",
  "users",
];

function staffActor(
  userId: number,
  permissions: readonly PermissionCode[],
  roleCode = "membership_officer",
): ActorContext {
  return {
    userId,
    userType: "staff",
    roleCode,
    roleCodes: [roleCode],
    permissions: new Set(permissions),
    requestId: newUlid(),
    ipHash: "c".repeat(64),
    userAgentHash: "d".repeat(64),
    onBehalfOfUserId: null,
  };
}

/**
 * Insert an application directly.
 *
 * The submit transition has its own test; these cases need a dozen
 * applications in specific states with specific deadlines, and driving each
 * one through the wizard to get there would make this file a test of the
 * wizard with assertions about the queue bolted on.
 */
async function makeApplication(options: {
  applicantId: number;
  state: string;
  firmName?: string;
  publicRef?: string | null;
  tier?: "regular" | "urgent" | "executive";
  dueDate?: string;
  assignedTo?: number | null;
  cnic?: string;
}): Promise<number> {
  const db = getDb();

  const inserted = await db
    .insertInto("applications")
    .values({
      state: options.state as never,
      created_by: options.applicantId,
      membership_class: "corporate",
      processing_tier: options.tier ?? "regular",
      company_status_code: "partnership",
      public_ref: options.publicRef ?? null,
      assigned_to: options.assignedTo ?? null,
      submitted_at: options.state === "DRAFT" ? null : new Date(),
    })
    .executeTakeFirst();

  const applicationId = Number(inserted.insertId ?? 0);

  const cnic = options.cnic ?? "35202-1234567-1";
  const sealed = sealField(
    "application_company",
    applicationId,
    "representative_cnic",
    cnic,
  );

  await db
    .insertInto("application_company")
    .values({
      application_id: applicationId,
      firm_name: options.firmName ?? "Test Firm",
      representative_name: "A. Representative",
      representative_cnic_enc: sealed.enc,
      representative_cnic_hmac: sealed.hmac,
      email: "office@example.com.pk",
    })
    .execute();

  if (options.dueDate) {
    await db
      .insertInto("sla_clocks")
      .values({
        application_id: applicationId,
        processing_tier: options.tier ?? "regular",
        working_days: 40,
        started_at: new Date(),
        due_date: options.dueDate,
      })
      .execute();
  }

  return applicationId;
}

/** Yesterday and a fortnight out, as civil dates. */
function civilDate(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

describe.skipIf(!available)("the admin queue", () => {
  let applicantId = 0;
  let officerId = 0;

  beforeEach(async () => {
    await resetTables(TABLES);
    applicantId = await createUser("applicant@example.com.pk", "portal");
    officerId = await createUser("officer@lcci.test");
  });

  it("refuses an actor without application.read", async () => {
    const cashier = staffActor(officerId, ["payment.receipt"], "cashier");

    await expect(loadQueue(cashier, { scope: "open" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("puts each state in exactly one tab, and keeps the applicant's out of the work list", async () => {
    await makeApplication({ applicantId, state: "SUBMITTED" });
    await makeApplication({ applicantId, state: "UNDER_VERIFICATION" });
    await makeApplication({ applicantId, state: "AWAITING_APPLICANT" });
    await makeApplication({ applicantId, state: "APPROVED" });
    await makeApplication({ applicantId, state: "DRAFT" });

    const officer = staffActor(officerId, ["application.read"]);
    const page = await loadQueue(officer, { scope: "open" });

    // The two the chamber owes an answer on. AWAITING_APPLICANT is excluded on
    // purpose: its clock is paused and nobody here can act on it.
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
    expect(page.scopeCounts).toMatchObject({
      open: 2,
      awaiting: 1,
      decided: 1,
      drafts: 1,
    });
  });

  it("sorts a breached deadline above an earlier one that is still in time", async () => {
    const late = await makeApplication({
      applicantId,
      state: "SUBMITTED",
      firmName: "Late Textiles",
      dueDate: civilDate(-3),
    });
    await makeApplication({
      applicantId,
      state: "SUBMITTED",
      firmName: "In Time Traders",
      dueDate: civilDate(5),
    });
    const noClock = await makeApplication({
      applicantId,
      state: "SUBMITTED",
      firmName: "No Clock Co",
    });

    const officer = staffActor(officerId, ["application.read"]);
    const page = await loadQueue(officer, { scope: "open" });

    expect(page.rows[0]!.id).toBe(late);
    expect(page.rows[0]!.breached).toBe(true);
    // Nothing without a deadline sorts above something with one.
    expect(page.rows[2]!.id).toBe(noClock);
  });

  it("applies every filter to the counts as well as the list", async () => {
    await makeApplication({ applicantId, state: "SUBMITTED", tier: "executive" });
    await makeApplication({ applicantId, state: "SUBMITTED", tier: "regular" });
    await makeApplication({ applicantId, state: "AWAITING_APPLICANT", tier: "regular" });

    const officer = staffActor(officerId, ["application.read"]);
    const page = await loadQueue(officer, { scope: "open", tier: "regular" });

    // The one that matters: a count computed without the tier filter would say
    // 2 above a table of 1, which is how an officer learns to distrust the
    // numbers on this screen.
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    expect(page.scopeCounts.open).toBe(1);
    expect(page.scopeCounts.awaiting).toBe(1);
  });

  it("matches a firm name or a reference as a prefix, and nothing else", async () => {
    const shalimar = await makeApplication({
      applicantId,
      state: "SUBMITTED",
      firmName: "Shalimar Textiles",
      publicRef: "LCCI/2026/000001",
    });
    await makeApplication({
      applicantId,
      state: "SUBMITTED",
      firmName: "Ravi Trading",
      publicRef: "LCCI/2026/000002",
    });

    const officer = staffActor(officerId, ["application.read"]);

    expect((await loadQueue(officer, { scope: "open", search: "Shalimar" })).rows)
      .toHaveLength(1);
    expect(
      (await loadQueue(officer, { scope: "open", search: "LCCI/2026/000001" }))
        .rows[0]!.id,
    ).toBe(shalimar);

    // A wildcard is stripped rather than escaped, so "Shalimar%Textiles"
    // searches for the literal run of characters and finds nothing — the one
    // thing it must never do is reach LIKE as a wildcard.
    expect(
      (await loadQueue(officer, { scope: "open", search: "Shalimar%Textiles" }))
        .rows,
    ).toHaveLength(0);

    // And a search of nothing but wildcards is no filter at all, rather than
    // a `LIKE '%'` that happens to match every row by accident.
    expect(
      (await loadQueue(officer, { scope: "open", search: "%%" })).rows,
    ).toHaveLength(2);
  });

  it("separates mine from unassigned", async () => {
    const mine = await makeApplication({
      applicantId,
      state: "SUBMITTED",
      assignedTo: officerId,
    });
    const free = await makeApplication({ applicantId, state: "SUBMITTED" });

    const officer = staffActor(officerId, ["application.read"]);

    expect((await loadQueue(officer, { scope: "open", mine: true })).rows[0]!.id).toBe(
      mine,
    );
    expect(
      (await loadQueue(officer, { scope: "open", unassigned: true })).rows[0]!.id,
    ).toBe(free);
  });

  it("counts live documents only, so a replacement does not look like extra evidence", async () => {
    const applicationId = await makeApplication({ applicantId, state: "SUBMITTED" });
    const db = getDb();

    const base = {
      application_id: applicationId,
      document_type_code: "cnic",
      subject_kind: "director" as const,
      storage_key: "x",
      mime_type: "image/jpeg",
      byte_size: 1024,
      sha256: "f".repeat(64),
      uploaded_by: applicantId,
    };

    await db
      .insertInto("documents")
      .values([
        { ...base, id: "11111111-1111-4111-8111-111111111111", original_filename: "old.jpg", review_state: "superseded" },
        { ...base, id: "22222222-2222-4222-8222-222222222222", original_filename: "new.jpg" },
        { ...base, id: "33333333-3333-4333-8333-333333333333", original_filename: "gone.jpg", deleted_at: new Date() },
      ])
      .execute();

    const officer = staffActor(officerId, ["application.read"]);
    const page = await loadQueue(officer, { scope: "open" });

    expect(page.rows[0]!.documentCount).toBe(1);
  });
});

describe.skipIf(!available)("the review loader", () => {
  let applicantId = 0;
  let officerId = 0;
  let applicationId = 0;

  beforeEach(async () => {
    await resetTables(TABLES);
    applicantId = await createUser("applicant@example.com.pk", "portal");
    officerId = await createUser("officer@lcci.test");
    applicationId = await makeApplication({
      applicantId,
      state: "SUBMITTED",
      firmName: "Shalimar Textiles",
      publicRef: "LCCI/2026/000001",
      cnic: "35202-1234567-1",
    });
  });

  it("returns null for an application that does not exist", async () => {
    const officer = staffActor(officerId, ["application.read", "documents.read"]);
    expect(await loadForReview(officer, applicationId + 5000)).toBeNull();
  });

  it("shows the whole CNIC to an actor holding documents.read", async () => {
    const officer = staffActor(officerId, ["application.read", "documents.read"]);
    const review = await loadForReview(officer, applicationId);

    expect(review!.identitiesVisible).toBe(true);
    expect(review!.particulars.representativeCnic).toBe("35202-1234567-1");
  });

  it("masks it to the last four for an actor who holds only the financial scope", async () => {
    // A cashier: enough to match a pay order against the certificate, not
    // enough to read every applicant's identity number off the screen.
    const cashier = staffActor(
      officerId,
      ["application.read", "documents.read_financial"],
      "cashier",
    );
    const review = await loadForReview(cashier, applicationId);

    expect(review!.identitiesVisible).toBe(false);
    // The last four of the whole number, not of its middle block.
    expect(review!.particulars.representativeCnic).toBe(
      "•••• 5671",
    );
    // The point of masking in the loader: the digits are not in the object the
    // page renders, so they cannot reach a log line or an error report.
    expect(JSON.stringify(review!.particulars)).not.toContain("1234567");
  });

  it("explains why a blocked next step is blocked, from the guards themselves", async () => {
    const officer = staffActor(officerId, [
      "application.read",
      "application.verify",
    ]);
    const review = await loadForReview(officer, applicationId);

    const verify = review!.nextSteps.find((step) =>
      step.code.includes("verification"),
    );
    expect(verify).toBeDefined();

    // Nothing has been verified or receipted, so whichever moves exist from
    // SUBMITTED must either be available or carry a reason — never be blocked
    // silently with nothing to show the officer.
    for (const step of review!.nextSteps) {
      if (step.decision.allowed) continue;
      const explained =
        step.decision.missingPermission !== null ||
        step.decision.reasons.length > 0;
      expect(explained).toBe(true);
    }
  });

  it("offers no applicant-only moves to an officer", async () => {
    const officer = staffActor(officerId, ["application.read"]);
    const review = await loadForReview(officer, applicationId);

    for (const step of review!.nextSteps) {
      expect(step.decision.transition?.actor).not.toBe("applicant");
    }
  });
});

describe.skipIf(!available)("assignment", () => {
  let applicantId = 0;
  let officerId = 0;
  let otherOfficerId = 0;
  let applicationId = 0;

  beforeEach(async () => {
    await resetTables(TABLES);
    applicantId = await createUser("applicant@example.com.pk", "portal");
    officerId = await createUser("officer@lcci.test");
    otherOfficerId = await createUser("second@lcci.test");
    applicationId = await makeApplication({ applicantId, state: "SUBMITTED" });
  });

  it("refuses an actor without application.assign", async () => {
    const officer = staffActor(officerId, ["application.read"]);
    await expect(
      claimApplication(officer, applicationId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("gives one winner when several officers claim at once", async () => {
    // Distinct officers, one per concurrent attempt. Letting the same officer
    // appear twice would make the expected outcome three-valued — the second
    // attempt legitimately reports `alreadyMine` once the first has committed,
    // and whether it does depends on timing, which is not what this test is
    // about.
    const officers = [
      officerId,
      otherOfficerId,
      await createUser("third@lcci.test"),
    ];

    const results = await inParallel(officers.length, (index) =>
      claimApplication(
        staffActor(officers[index]!, ["application.assign"]),
        applicationId,
      ),
    );

    const succeeded = results.filter(
      (result) => result.ok && result.value.ok && !result.value.alreadyMine,
    );
    const taken = results.filter(
      (result) => result.ok && !result.value.ok && result.value.reason === "taken",
    );

    // Exactly one, and the losers are told so rather than silently stealing
    // the row from whoever is already reading it.
    expect(succeeded).toHaveLength(1);
    // Every loser is refused cleanly rather than throwing, so the officer who
    // clicked second gets a sentence instead of an error page.
    expect(succeeded.length + taken.length).toBe(officers.length);

    const row = await getDb()
      .selectFrom("applications")
      .select(["assigned_to", "version"])
      .where("id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(officers).toContain(row.assigned_to);
    // Assignment is not a transition, so the concurrency token the transitions
    // compare must not have moved.
    expect(row.version).toBe(1);
  });

  it("is idempotent for the officer who already holds it", async () => {
    const officer = staffActor(officerId, ["application.assign"]);

    expect(await claimApplication(officer, applicationId)).toMatchObject({
      ok: true,
      alreadyMine: false,
    });
    expect(await claimApplication(officer, applicationId)).toMatchObject({
      ok: true,
      alreadyMine: true,
    });
  });

  it("lets only the holder release it", async () => {
    await claimApplication(
      staffActor(officerId, ["application.assign"]),
      applicationId,
    );

    expect(
      await releaseApplication(
        staffActor(otherOfficerId, ["application.assign"]),
        applicationId,
      ),
    ).toMatchObject({ ok: false, reason: "not_mine" });

    expect(
      await releaseApplication(
        staffActor(officerId, ["application.assign"]),
        applicationId,
      ),
    ).toMatchObject({ ok: true });
  });

  it("records both sides of the change in the audit log", async () => {
    const officer = staffActor(officerId, ["application.assign"]);
    await claimApplication(officer, applicationId);
    await releaseApplication(officer, applicationId);

    const events = await getDb()
      .selectFrom("audit_log")
      .select(["action"])
      .where("entity_type", "=", "application")
      .orderBy("id", "asc")
      .execute();

    expect(events.map((event) => event.action)).toEqual([
      "application.assigned",
      "application.unassigned",
    ]);
  });

  it("reports a missing application rather than claiming nothing", async () => {
    const officer = staffActor(officerId, ["application.assign"]);
    expect(await claimApplication(officer, applicationId + 5000)).toMatchObject({
      ok: false,
      reason: "missing",
    });
  });
});
