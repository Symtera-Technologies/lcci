import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, sql } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import type { ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import { listApplications, loadTracker } from "@/membership/tracker";
import { applicantContact } from "@/membership/notify";
import { rejectApplication, returnForVerification } from "@/membership/approval";
import { receiptPayment } from "@/membership/payments";
import {
  createUser,
  databaseAvailable,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * What the applicant can see, and what the Chamber writes to them.
 *
 * Three claims that are only true of rows.
 *
 * **The applicant's own, and nobody else's.** Scoping lives in the loaders'
 * `WHERE`, so the test that matters is the one where a second applicant asks
 * for the first one's application by id and is told it does not exist.
 *
 * **Internal states do not reach them.** The timeline maps through
 * `publicStage` and collapses runs, so the Chamber's three internal moves
 * between desks are one "Under review" line. If this breaks, applicants start
 * reading the word `PENDING_APPROVAL`.
 *
 * **One address rule.** Before A8 the deficiency list went to the address on
 * the form and the grant email to the signing-in account, which are different
 * people whenever a clerk files for a director.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping tracker tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

const TABLES = [
  "membership_years",
  "memberships",
  "application_decisions",
  "conflict_waivers",
  "company_users",
  "companies",
  "pay_orders",
  "payments",
  "verification_checklist_items",
  "verification_checklists",
  "application_state_transitions",
  "application_company",
  "sla_pauses",
  "sla_clocks",
  "applications",
  "email_outbox",
  "audit_log",
  "users",
];

const CASHIER: readonly PermissionCode[] = [
  "application.read",
  "payment.read",
  "payment.receipt",
  "documents.read_financial",
];

const APPROVER: readonly PermissionCode[] = [
  "application.read",
  "application.approve",
  "application.reject",
  "membership.issue",
];

function staffActor(
  userId: number,
  permissions: readonly PermissionCode[],
  roleCode = "membership_approver",
): ActorContext {
  return {
    userId,
    userType: "staff",
    roleCode,
    roleCodes: [roleCode],
    permissions: new Set(permissions),
    requestId: newUlid(),
    ipHash: "a".repeat(64),
    userAgentHash: "b".repeat(64),
    onBehalfOfUserId: null,
  };
}

function memberActor(userId: number): ActorContext {
  return {
    userId,
    userType: "portal",
    roleCode: null,
    roleCodes: [],
    permissions: new Set<PermissionCode>(),
    requestId: newUlid(),
    ipHash: "a".repeat(64),
    userAgentHash: "b".repeat(64),
    onBehalfOfUserId: null,
  };
}

function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

interface Fixture {
  applicationId: number;
  publicRef: string;
  applicantId: number;
  accountEmail: string;
  formEmail: string | null;
  paymentId: number;
}

/**
 * A submitted application with its fee row and a short transition history.
 *
 * The history is inserted rather than driven through the machine: every
 * transition has its own test, and what this file is about is how the log
 * reads once it exists.
 */
async function fixture(
  options: { formEmail?: string | null; state?: string } = {},
): Promise<Fixture> {
  const db = getDb();

  const accountEmail = `applicant-${randomUUID()}@example.com.pk`;
  const applicantId = await createUser(accountEmail, "portal");

  const formEmail =
    options.formEmail === undefined
      ? `office-${randomUUID()}@example.com.pk`
      : options.formEmail;

  const publicRef = `LCCI-APP-T-${Math.floor(Math.random() * 1e6)}`;

  const inserted = await db
    .insertInto("applications")
    .values({
      state: (options.state ?? "PENDING_APPROVAL") as never,
      created_by: applicantId,
      membership_class: "corporate",
      processing_tier: "regular",
      company_status_code: "partnership",
      public_ref: publicRef,
      submitted_at: new Date(),
    })
    .executeTakeFirstOrThrow();

  const applicationId = Number(inserted.insertId);

  await db
    .insertInto("application_company")
    .values({
      application_id: applicationId,
      firm_name: "Mall Road Exports",
      representative_name: "A. Representative",
      bank_name: "Habib Bank Limited",
      bank_branch: "Gulberg III, Lahore",
      email: formEmail,
    })
    .execute();

  await db
    .insertInto("sla_clocks")
    .values({
      application_id: applicationId,
      processing_tier: "regular",
      working_days: 40,
      started_at: new Date(),
      due_date: isoDaysFromToday(40),
    })
    .execute();

  const payment = await db
    .insertInto("payments")
    .values({
      application_id: applicationId,
      fee_kind: "membership",
      amount: "10650.00",
      currency: "PKR",
      state: "due",
      method: "pay_order",
    })
    .executeTakeFirstOrThrow();

  return {
    applicationId,
    publicRef,
    applicantId,
    accountEmail,
    formEmail,
    paymentId: Number(payment.insertId),
  };
}

/** The Chamber's internal journey, as the transition log records it. */
async function recordHistory(
  applicationId: number,
  steps: readonly {
    to: string;
    code: string;
    reason?: string;
    minutesAgo: number;
  }[],
): Promise<void> {
  const db = getDb();
  for (const step of steps) {
    await db
      .insertInto("application_state_transitions")
      .values({
        application_id: applicationId,
        from_state: null,
        to_state: step.to,
        transition_code: step.code,
        actor_user_id: null,
        actor_role_code: null,
        reason: step.reason ?? null,
        request_id: newUlid(),
        occurred_at: new Date(Date.now() - step.minutesAgo * 60_000),
      })
      .execute();
  }
}

describe.skipIf(!available)("the applicant's own list", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("lists every application the applicant filed, terminal ones included", async () => {
    // The gap this closes: `/membership/apply` redirects only to an
    // application in flight, so an approved or refused one had no URL at all.
    const f = await fixture();
    const db = getDb();

    await db
      .insertInto("applications")
      .values({
        state: "APPROVED" as never,
        created_by: f.applicantId,
        membership_class: "associate",
        processing_tier: "urgent",
        company_status_code: "proprietorship",
        public_ref: "LCCI-APP-T-OLD",
        submitted_at: new Date(Date.now() - 86_400_000 * 90),
      })
      .execute();

    const list = await listApplications(memberActor(f.applicantId));

    expect(list).toHaveLength(2);

    // Most recently started first, which is `applications.id DESC` and not
    // `submitted_at DESC`: a draft has no `submitted_at`, and the row an
    // applicant is halfway through typing is the one that must not sort last.
    // The approved row here was inserted second, so it leads.
    expect(list.map((row) => row.stage)).toEqual(["approved", "under_review"]);
    expect(list.map((row) => row.stageLabel)).toEqual([
      "Approved",
      "Under review",
    ]);
  });

  it("flags the ones waiting on the applicant, and only those", async () => {
    const f = await fixture({ state: "AWAITING_APPLICANT" });
    const db = getDb();

    await db
      .insertInto("applications")
      .values({
        state: "DRAFT" as never,
        created_by: f.applicantId,
        public_ref: null,
      })
      .execute();
    await db
      .insertInto("applications")
      .values({
        state: "UNDER_VERIFICATION" as never,
        created_by: f.applicantId,
        public_ref: "LCCI-APP-T-BUSY",
        submitted_at: new Date(),
      })
      .execute();

    const list = await listApplications(memberActor(f.applicantId));
    const byStage = new Map(list.map((row) => [row.stage, row.needsYou]));

    expect(byStage.get("need_info")).toBe(true);
    expect(byStage.get("draft")).toBe(true);
    expect(byStage.get("under_review")).toBe(false);
  });

  it("shows the membership number once there is one", async () => {
    const f = await fixture();
    const db = getDb();

    const company = await db
      .insertInto("companies")
      .values({ name: "Mall Road Exports" })
      .executeTakeFirstOrThrow();

    await db
      .insertInto("memberships")
      .values({
        company_id: Number(company.insertId),
        membership_no: "LCCI-000314",
        membership_class: "corporate",
        status: "active",
        granted_on: isoDaysFromToday(-1),
        granted_by_application_id: f.applicationId,
      })
      .execute();

    const list = await listApplications(memberActor(f.applicantId));
    expect(list[0]?.membershipNo).toBe("LCCI-000314");
  });

  it("never shows one applicant another's application", async () => {
    const f = await fixture();
    const stranger = await createUser(
      `stranger-${randomUUID()}@example.com.pk`,
      "portal",
    );

    expect(await listApplications(memberActor(stranger))).toEqual([]);
    // Null and not a refusal: a 403 on a real id and a 404 on a fake one is an
    // oracle for which application ids exist.
    expect(await loadTracker(memberActor(stranger), f.applicationId)).toBeNull();
  });
});

describe.skipIf(!available)("the timeline, in the applicant's vocabulary", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("collapses the Chamber's internal moves into one line", async () => {
    const f = await fixture();
    await recordHistory(f.applicationId, [
      { to: "SUBMITTED", code: "submit", minutesAgo: 500 },
      { to: "UNDER_VERIFICATION", code: "begin_verification", minutesAgo: 400 },
      { to: "VERIFIED", code: "mark_verified", minutesAgo: 300 },
      { to: "PENDING_APPROVAL", code: "send_for_approval", minutesAgo: 200 },
    ]);

    const view = await loadTracker(memberActor(f.applicantId), f.applicationId);
    expect(view).not.toBeNull();
    if (view === null) return;

    expect(view.timeline.map((entry) => entry.label)).toEqual([
      "Submitted",
      "Under review",
    ]);

    // Dated at the *first* of the three, which is the honest answer to "when
    // did you start looking at it?" — the later two are the file moving desks.
    const underReview = view.timeline[1];
    const begun = Date.now() - 400 * 60_000;
    expect(
      Math.abs((underReview?.at.getTime() ?? 0) - begun),
    ).toBeLessThan(60_000);
  });

  it("drops the draft, which the applicant was present for", async () => {
    const f = await fixture();
    await recordHistory(f.applicationId, [
      { to: "DRAFT", code: "start_draft", minutesAgo: 600 },
      { to: "SUBMITTED", code: "submit", minutesAgo: 500 },
    ]);

    const view = await loadTracker(memberActor(f.applicantId), f.applicationId);
    expect(view?.timeline.map((entry) => entry.label)).toEqual(["Submitted"]);
  });

  it("carries the reasons written for the applicant and no others", async () => {
    const f = await fixture();
    await recordHistory(f.applicationId, [
      { to: "SUBMITTED", code: "submit", minutesAgo: 600 },
      { to: "UNDER_VERIFICATION", code: "begin_verification", minutesAgo: 500 },
      {
        to: "AWAITING_APPLICANT",
        code: "raise_deficiency",
        reason: "The CNIC scan of B. Partner is cut off at the edge.",
        minutesAgo: 400,
      },
      { to: "UNDER_VERIFICATION", code: "applicant_responded", minutesAgo: 300 },
      {
        to: "UNDER_VERIFICATION",
        code: "return_for_verification",
        reason: "Item 4 ticked but the NTN shown is the proprietor's.",
        minutesAgo: 200,
      },
    ]);

    const view = await loadTracker(memberActor(f.applicantId), f.applicationId);
    expect(view).not.toBeNull();
    if (view === null) return;

    const notes = view.timeline
      .map((entry) => entry.note)
      .filter((note): note is string => note !== null);

    expect(notes).toEqual(["The CNIC scan of B. Partner is cut off at the edge."]);
    // The officer's note to a colleague stays between colleagues. Both live in
    // the same column; the transition code is the only thing that tells them
    // apart, which is why the filter keys on it.
    expect(notes.join(" ")).not.toContain("proprietor");
  });

  it("keeps a second deficiency round as its own entry", async () => {
    // Same stage twice, but a new thing the applicant has to read. Collapsing
    // on the stage alone would silently drop the second list.
    const f = await fixture();
    await recordHistory(f.applicationId, [
      {
        to: "AWAITING_APPLICANT",
        code: "raise_deficiency",
        reason: "Round one: the CNIC scan is illegible.",
        minutesAgo: 400,
      },
      { to: "UNDER_VERIFICATION", code: "applicant_responded", minutesAgo: 350 },
      {
        to: "AWAITING_APPLICANT",
        code: "raise_deficiency",
        reason: "Round two: the replacement is still cut off.",
        minutesAgo: 300,
      },
    ]);

    const view = await loadTracker(memberActor(f.applicantId), f.applicationId);
    const notes = view?.timeline.map((entry) => entry.note).filter(Boolean);
    expect(notes).toEqual([
      "Round one: the CNIC scan is illegible.",
      "Round two: the replacement is still cut off.",
    ]);
  });
});

describe.skipIf(!available)("the fee, as the applicant sees it", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("says what is owed and that it is not receipted yet", async () => {
    const f = await fixture();
    const view = await loadTracker(memberActor(f.applicantId), f.applicationId);

    expect(view?.fees).toHaveLength(1);
    expect(view?.fees[0]).toMatchObject({
      feeKind: "membership",
      amount: "10650.00",
      currency: "PKR",
      settled: false,
      receiptNo: null,
      dishonoured: false,
    });
  });

  it("shows the receipt number once a cashier has issued one", async () => {
    const f = await fixture();
    const cashierId = await createUser(`cashier-${randomUUID()}@lcci.org.pk`);

    const receipt = await receiptPayment(
      staffActor(cashierId, CASHIER, "cashier"),
      {
        paymentId: f.paymentId,
        version: 1,
        method: "pay_order",
        receivedOn: isoDaysFromToday(0),
        instrument: {
          draweeBankName: "HBL",
          draweeBranch: "Gulberg III, Lahore",
          instrumentNo: `0004${Math.floor(Math.random() * 1e5)}`,
          instrumentDate: isoDaysFromToday(-3),
          instrumentAmount: "10650.00",
          instrumentCurrency: "PKR",
          accountTitle: "Mall Road Exports",
          certificateBankName: "Habib Bank Limited",
          certificateBranch: "Gulberg III Lahore",
          certificateAccountTitle: "M/s Mall Road Exports",
          certificateIssuedOn: isoDaysFromToday(-20),
        },
        bankMatchVerdict: "match",
        bankMatchNote: null,
        varianceReason: null,
        duplicateNote: null,
      },
    );

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    const view = await loadTracker(memberActor(f.applicantId), f.applicationId);
    expect(view?.fees[0]).toMatchObject({
      settled: true,
      receiptNo: receipt.receiptNo,
    });
    expect(view?.fees[0]?.receivedAt).not.toBeNull();

    // And the applicant was told, which is the message §7.1 promised at
    // submission and could not send then: nothing had been receipted.
    const mail = await getDb()
      .selectFrom("email_outbox")
      .select(["to_address", "template", "payload_json"])
      .where("template", "=", "fee-receipted")
      .executeTakeFirstOrThrow();

    expect(mail.to_address).toBe(f.formEmail);
    expect(mail.payload_json).toMatchObject({
      receiptNo: receipt.receiptNo,
      amount: "Rs 10,650",
    });
  });
});

describe.skipIf(!available)("what the Chamber writes, and to whom", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("prefers the address on the form over the signing-in account", async () => {
    // Field 7 of the printed form is the firm's office email and is what the
    // applicant nominated for correspondence.
    const f = await fixture();
    const contact = await applicantContact(getDb(), f.applicationId);

    expect(contact?.email).toBe(f.formEmail);
    expect(contact?.firmName).toBe("Mall Road Exports");
    expect(contact?.reference).toBe(f.publicRef);
  });

  it("falls back to the account where the form gives no address", async () => {
    const f = await fixture({ formEmail: null });
    const contact = await applicantContact(getDb(), f.applicationId);
    expect(contact?.email).toBe(f.accountEmail);
  });

  it("treats an empty form field as no address rather than as an answer", async () => {
    // A text input produces "" where a nullable column would hold NULL, and
    // "" as a recipient is a send that fails at the provider.
    const f = await fixture({ formEmail: "   " });
    const contact = await applicantContact(getDb(), f.applicationId);
    expect(contact?.email).toBe(f.accountEmail);
  });

  it("emails the refusal with the approver's own words", async () => {
    const f = await fixture();
    const approverId = await createUser(`approver-${randomUUID()}@lcci.org.pk`);

    const result = await rejectApplication(staffActor(approverId, APPROVER), {
      applicationId: f.applicationId,
      version: 1,
      reason: "The partnership deed is on plain paper, not Rs 1000 stamp paper.",
    });

    expect(result.ok).toBe(true);

    const mail = await getDb()
      .selectFrom("email_outbox")
      .select(["to_address", "template", "payload_json"])
      .where("template", "=", "application-not-approved")
      .executeTakeFirstOrThrow();

    expect(mail.to_address).toBe(f.formEmail);
    expect(mail.payload_json).toMatchObject({
      reference: f.publicRef,
      reason: "The partnership deed is on plain paper, not Rs 1000 stamp paper.",
      // Nothing receipted on this application, so the message does not raise
      // the fee at all — and, either way, it never promises a refund.
      feeReceipted: false,
    });
  });

  it("tells a refused applicant a fee was taken, without promising anything", async () => {
    const f = await fixture();
    const approverId = await createUser(`approver-${randomUUID()}@lcci.org.pk`);

    await getDb()
      .updateTable("payments")
      .set({ state: "receipted", receipt_no: "LCCI-RCPT-2026-00099" })
      .where("id", "=", f.paymentId)
      .execute();

    await rejectApplication(staffActor(approverId, APPROVER), {
      applicationId: f.applicationId,
      version: 1,
      reason: "Turnover declared does not support the Corporate class claimed.",
    });

    const mail = await getDb()
      .selectFrom("email_outbox")
      .select(["payload_json"])
      .where("template", "=", "application-not-approved")
      .executeTakeFirstOrThrow();

    expect(mail.payload_json).toMatchObject({ feeReceipted: true });
  });

  it("sends nothing on a return to verification", async () => {
    // The file going back to an officer is the Chamber's own business.
    // Emailing "we are still working on it" on every internal handover is how
    // an applicant learns to stop reading mail from the Chamber.
    const f = await fixture();
    const approverId = await createUser(`approver-${randomUUID()}@lcci.org.pk`);

    const result = await returnForVerification(
      staffActor(approverId, APPROVER),
      {
        applicationId: f.applicationId,
        version: 1,
        reason: "Item 4 ticked but the NTN shown is the proprietor's.",
      },
    );

    expect(result.ok).toBe(true);

    const count = await getDb()
      .selectFrom("email_outbox")
      .select(sql<number>`COUNT(*)`.as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });
});
