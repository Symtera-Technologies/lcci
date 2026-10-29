import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, sql } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import type { ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import {
  approveApplication,
  loadApproval,
  rejectApplication,
  returnForVerification,
  waiveConflict,
} from "@/membership/approval";
import { receiptPayment } from "@/membership/payments";
import { membershipYearFor } from "@/membership/year";
import {
  createUser,
  databaseAvailable,
  inParallel,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * Granting membership, against the database.
 *
 * The year arithmetic is pure and is tested on strings in
 * `tests/membership-year.test.ts`; the guard table is pure and is tested in
 * `tests/membership-workflow.test.ts`. What is left here is everything that is
 * only true of rows, and there are four claims worth the cost of a database.
 *
 * **One number, or none.** The sequence is read `FOR UPDATE` inside the
 * transaction, so two approvers pressing the button together serialise; the
 * loser must then be told the application has changed rather than being handed
 * a second number for one firm. A number is externally meaningful — printed on
 * a certificate, quoted by a future proposer — so a duplicate is not a tidiness
 * problem, it is two firms with one identity.
 *
 * **A refusal writes nothing.** Every refusal in `approveApplication` runs
 * before the allocation, which is what makes a gap in the series mean
 * something. If a mistyped confirmation burned a number, nobody could ever
 * answer "what happened to LCCI-000007?".
 *
 * **Separation of duties is re-checked here, not on the screen.** The facts are
 * gathered on the transaction's own connection, so an approver who receipted a
 * fee after the page rendered is still caught — and the only way past it is a
 * waiver naming them, the guard and the reason.
 *
 * **Approval and its consequences commit together.** The membership, its first
 * year, the company, the decision row, the stopped clock, the audit event and
 * the grant email are one transaction or they are nothing. A membership number
 * without a membership, or a granted member nobody told, are both worse than a
 * failed approval.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping approval tests: ${await skipReason()}`);
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

const SUPER_ADMIN: readonly PermissionCode[] = [
  "application.read",
  "role.manage",
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

function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

interface Fixture {
  applicationId: number;
  publicRef: string;
  applicantId: number;
  applicantEmail: string;
  /** Completed the checklist, so `not_the_verifier` must refuse them. */
  officerId: number;
  /** Receipted the fee, so `not_the_cashier` must refuse them. */
  cashierId: number;
  /** Did neither, so approval must succeed. */
  approverId: number;
}

/**
 * An application sitting in `PENDING_APPROVAL` with nothing outstanding.
 *
 * Built the long way round — the fee is receipted through `receiptPayment` and
 * not inserted — because `not_the_cashier` compares against
 * `payments.receipted_by`, and a hand-written row proves only that the test can
 * write what it expects to read.
 *
 * The checklist round *is* inserted. `completeChecklist` needs thirteen item
 * rows and a form revision to mean anything, and all this file asks of it is
 * one `completed_by` for the identity guard; the polarity logic that decides
 * `outcome` has its own test.
 *
 * No endorsement rows, deliberately. `endorsersInGoodStanding` is `.every()`
 * over the endorsed set, so it is vacuously true with none — which is exactly
 * what the lapsed-endorser case in the workflow test exercises, and exactly
 * what this file does not need to re-prove.
 */
async function fixture(
  options: { withSurcharge?: boolean; dueInDays?: number } = {},
): Promise<Fixture> {
  const db = getDb();

  const applicantEmail = `applicant-${randomUUID()}@example.com.pk`;
  const applicantId = await createUser(applicantEmail, "portal");
  const officerId = await createUser(`officer-${randomUUID()}@lcci.org.pk`);
  const cashierId = await createUser(`cashier-${randomUUID()}@lcci.org.pk`);
  const approverId = await createUser(`approver-${randomUUID()}@lcci.org.pk`);

  const publicRef = `LCCI-APP-T-${Math.floor(Math.random() * 1e6)}`;

  const inserted = await db
    .insertInto("applications")
    .values({
      state: "UNDER_VERIFICATION" as never,
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
      email: "office@mallroad.example.com.pk",
    })
    .execute();

  await db
    .insertInto("sla_clocks")
    .values({
      application_id: applicationId,
      processing_tier: "regular",
      working_days: 40,
      started_at: new Date(),
      due_date: isoDaysFromToday(options.dueInDays ?? 40),
    })
    .execute();

  const revision = await db
    .selectFrom("form_revisions")
    .select(["id"])
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();

  await db
    .insertInto("verification_checklists")
    .values({
      application_id: applicationId,
      round: 1,
      form_revision_id: Number(revision.id),
      state: "completed",
      outcome: "clear",
      started_by: officerId,
      started_at: new Date(),
      completed_by: officerId,
      completed_at: new Date(),
      completed_by_role_code: "membership_officer",
      request_id: newUlid(),
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

  const cashier = staffActor(cashierId, CASHIER, "cashier");
  const receipt = await receiptPayment(cashier, {
    paymentId: Number(payment.insertId),
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
      certificateAccountTitle: "M/s Mall Road Exports (Pvt) Ltd",
      certificateIssuedOn: isoDaysFromToday(-20),
    },
    bankMatchVerdict: "match",
    bankMatchNote: null,
    varianceReason: null,
    duplicateNote: null,
  });

  if (!receipt.ok) {
    throw new Error(`fixture could not receipt the fee: ${receipt.message}`);
  }

  if (options.withSurcharge) {
    // Waived rather than receipted: a second instrument would need a second
    // cashier to keep `not_the_cashier` honest, and what this option is for is
    // the `membership_years.payment_id` rule — two fees buy one year between
    // them, so neither gets to claim it.
    await db
      .insertInto("payments")
      .values({
        application_id: applicationId,
        fee_kind: "itd_surcharge",
        amount: "750.00",
        currency: "USD",
        state: "waived",
        method: "pay_order",
      })
      .execute();
  }

  // Straight to the approver's desk. `send_for_approval` has its own test; what
  // this file needs is the state it leaves behind, and an UPDATE keeps the
  // version at 1 so the optimistic check is exercised from a known value.
  await db
    .updateTable("applications")
    .set({ state: "PENDING_APPROVAL" as never })
    .where("id", "=", applicationId)
    .execute();

  return {
    applicationId,
    publicRef,
    applicantId,
    applicantEmail,
    officerId,
    cashierId,
    approverId,
  };
}

/**
 * Put the membership sequence back to 1.
 *
 * `number_sequences` is seeded reference data, so `resetTables` leaves it
 * alone — which would make every assertion about an actual number depend on
 * how many tests ran before it. Reset here, so the tests can say
 * `LCCI-000001` and mean it.
 */
async function resetMembershipSequence(): Promise<void> {
  await sql`
    UPDATE number_sequences
       SET next_value = 1, period_key = NULL
     WHERE name = 'membership_no'
  `.execute(getDb());
}

async function nextMembershipNumber(): Promise<number> {
  const row = await getDb()
    .selectFrom("number_sequences")
    .select(["next_value"])
    .where("name", "=", "membership_no")
    .executeTakeFirstOrThrow();
  return Number(row.next_value);
}

describe.skipIf(!available)("granting membership", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await resetMembershipSequence();
  });

  it("issues one number, one year and everything that goes with it", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: "Partnership deed and Form C both on file.",
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.membershipNo).toBe("LCCI-000001");
    expect(result.waived).toEqual([]);

    // The 31 March rule, from the same function the certificate will use.
    const expected = membershipYearFor(new Date().toISOString().slice(0, 10));
    expect(result.validUntil).toBe(expected.validUntil);
    expect(result.validUntil.endsWith("-03-31")).toBe(true);
    expect(result.label).toBe(expected.label);

    const db = getDb();

    const membership = await db
      .selectFrom("memberships")
      .selectAll()
      .where("granted_by_application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();

    expect(membership.membership_no).toBe("LCCI-000001");
    expect(membership.membership_class).toBe("corporate");
    expect(membership.status).toBe("active");
    expect(Number(membership.granted_by)).toBe(f.approverId);

    const years = await db
      .selectFrom("membership_years")
      .selectAll()
      .where("membership_id", "=", Number(membership.id))
      .execute();

    expect(years).toHaveLength(1);
    expect(years[0]?.valid_until).toBe(expected.validUntil);
    expect(years[0]?.source).toBe("grant");
    // One fee on this application, so the year says which money bought it.
    expect(years[0]?.payment_id).not.toBeNull();

    // The firm becomes a company at this moment and not before, and the
    // applicant's claim on it is what lets them see their own membership after
    // they sign in.
    const application = await db
      .selectFrom("applications")
      .select(["state", "company_id", "version", "decided_at"])
      .where("id", "=", f.applicationId)
      .executeTakeFirstOrThrow();

    expect(application.state).toBe("APPROVED");
    expect(application.company_id).not.toBeNull();
    expect(Number(application.version)).toBe(2);
    expect(application.decided_at).not.toBeNull();

    const link = await db
      .selectFrom("company_users")
      .select(["relation", "user_id"])
      .where("company_id", "=", Number(application.company_id))
      .executeTakeFirstOrThrow();

    expect(link.relation).toBe("owner");
    expect(Number(link.user_id)).toBe(f.applicantId);

    const decision = await db
      .selectFrom("application_decisions")
      .selectAll()
      .where("application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();

    expect(decision.decision).toBe("approved");
    expect(Number(decision.decided_by)).toBe(f.approverId);
    // Snapshotted, not joined: the role somebody held when they approved is a
    // historical fact that a later promotion must not rewrite.
    expect(decision.decided_by_role_code).toBe("membership_approver");
    expect(decision.reason).toBe("Partnership deed and Form C both on file.");

    const clock = await db
      .selectFrom("sla_clocks")
      .select(["state", "outcome", "stopped_at"])
      .where("application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();

    expect(clock.state).toBe("stopped");
    expect(clock.outcome).toBe("met");
    expect(clock.stopped_at).not.toBeNull();
    expect(result.slaOutcome).toBe("met");

    const email = await db
      .selectFrom("email_outbox")
      .selectAll()
      .where("template", "=", "application-approved")
      .executeTakeFirstOrThrow();

    // The address on the form, not the account that signed in. Where a clerk
    // files for a director those are two people, and the Chamber telling one
    // of them a file was granted and the other that it was returned is the
    // failure one address rule exists to prevent.
    expect(email.to_address).toBe("office@mallroad.example.com.pk");
    expect(email.to_address).not.toBe(f.applicantEmail);
    // mysql2 parses JSON columns, so this is already an object.
    expect(email.payload_json).toMatchObject({
      membershipNo: "LCCI-000001",
      membershipClass: "Corporate",
      reference: f.publicRef,
    });

    const granted = await db
      .selectFrom("audit_log")
      .select(["action", "after_json"])
      .where("action", "=", "membership.granted")
      .executeTakeFirstOrThrow();

    expect(granted.after_json).toMatchObject({
      membershipNo: "LCCI-000001",
      slaOutcome: "met",
      waivedGuards: [],
    });
  });

  it("records a breached deadline on the grant rather than hiding it", async () => {
    // The paid promise, resolved. A breached Executive tier took Rs 20,000 for
    // an undelivered three days, and the only moment that is cheaply knowable
    // is this one.
    const f = await fixture({ dueInDays: -5 });
    const approver = staffActor(f.approverId, APPROVER);

    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slaOutcome).toBe("breached");

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["state", "outcome"])
      .where("application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();

    expect(clock.state).toBe("stopped");
    expect(clock.outcome).toBe("breached");
  });

  it("leaves the year unattached when two fees paid for it", async () => {
    const f = await fixture({ withSurcharge: true });
    const approver = staffActor(f.approverId, APPROVER);

    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(true);

    const year = await getDb()
      .selectFrom("membership_years")
      .select(["payment_id"])
      .executeTakeFirstOrThrow();

    // Two fees buy one year between them, so naming one of them would be a
    // guess dressed as a fact.
    expect(year.payment_id).toBeNull();
  });

  it("refuses a second grant on an application that already has one", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const first = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });
    expect(first.ok).toBe(true);

    const second = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 2,
      note: null,
      confirm: f.publicRef,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal).toBe("already_granted");
    expect(second.message).toContain("LCCI-000001");
    expect(await nextMembershipNumber()).toBe(2);
  });
});

describe.skipIf(!available)("a refusal must not spend a number", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await resetMembershipSequence();
  });

  it("refuses a mistyped confirmation and allocates nothing", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: "LCCI-APP-2026-00001",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("confirm_mismatch");
    expect(result.message).toContain(f.publicRef);

    expect(await nextMembershipNumber()).toBe(1);
    const count = await getDb()
      .selectFrom("memberships")
      .select(sql<number>`COUNT(*)`.as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  it("accepts a confirmation in the wrong case and with stray spaces", async () => {
    // The control is "have you looked at which file you are on", not "can you
    // type". Trimming and case-folding costs nothing and refusing on them
    // would train approvers to paste.
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: `  ${f.publicRef.toLowerCase()} `,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a stale version and allocates nothing", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 7,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("wrong_state");
    expect(await nextMembershipNumber()).toBe(1);
  });

  it("refuses an unreceipted fee and allocates nothing", async () => {
    const f = await fixture();
    await getDb()
      .updateTable("payments")
      .set({ state: "due" })
      .where("application_id", "=", f.applicationId)
      .execute();

    const approver = staffActor(f.approverId, APPROVER);
    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("guards_failed");
    expect(result.reasons.join(" ")).toMatch(/fee/i);
    expect(await nextMembershipNumber()).toBe(1);
  });

  it("refuses an instrument the cashier judged a mismatch", async () => {
    // The one outcome the whole bank-match control exists to prevent: a pay
    // order drawn on an account that is not the one the certificate describes.
    const f = await fixture();
    await getDb()
      .updateTable("pay_orders")
      .set({ bank_match_verdict: "mismatch" })
      .execute();

    const approver = staffActor(f.approverId, APPROVER);
    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("guards_failed");
    expect(await nextMembershipNumber()).toBe(1);
  });

  it("refuses an application that was never sent for approval", async () => {
    const f = await fixture();
    await getDb()
      .updateTable("applications")
      .set({ state: "UNDER_VERIFICATION" as never })
      .where("id", "=", f.applicationId)
      .execute();

    const approver = staffActor(f.approverId, APPROVER);
    const result = await approveApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("wrong_state");
    expect(await nextMembershipNumber()).toBe(1);
  });
});

describe.skipIf(!available)("two approvers pressing the button together", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await resetMembershipSequence();
  });

  it("grants once, numbers once, and tells the loser the file moved", async () => {
    const f = await fixture();
    const second = await createUser(`approver2-${randomUUID()}@lcci.org.pk`);

    const actors = [
      staffActor(f.approverId, APPROVER),
      staffActor(second, APPROVER),
    ];

    const outcomes = await inParallel(2, (index) =>
      approveApplication(actors[index]!, {
        applicationId: f.applicationId,
        version: 1,
        note: null,
        confirm: f.publicRef,
      }),
    );

    const granted = outcomes.filter((o) => o.ok && o.value.ok);
    const lost = outcomes.filter((o) => !o.ok);

    expect(granted).toHaveLength(1);
    expect(lost).toHaveLength(1);

    // A version conflict, not a duplicate-key error. The distinction matters:
    // one is a race the UI can explain ("reload, somebody decided this"), the
    // other is the backstop firing because the first control failed.
    const error = lost[0]?.ok === false ? lost[0].error : null;
    expect((error as Error | null)?.name).toBe("ConcurrencyError");

    const db = getDb();
    const memberships = await db
      .selectFrom("memberships")
      .select(["membership_no"])
      .execute();

    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.membership_no).toBe("LCCI-000001");

    // The loser's transaction took the sequence lock and rolled back, so its
    // increment went with it. Had it committed, the register would carry a gap
    // nobody could account for.
    expect(await nextMembershipNumber()).toBe(2);

    const years = await db
      .selectFrom("membership_years")
      .select(["id"])
      .execute();
    expect(years).toHaveLength(1);
  });
});

describe.skipIf(!available)("separation of duties, per application", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await resetMembershipSequence();
  });

  it("refuses the officer who completed the checklist", async () => {
    const f = await fixture();
    const officerAsApprover = staffActor(f.officerId, APPROVER);

    const result = await approveApplication(officerAsApprover, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("guards_failed");
    expect(result.reasons.join(" ")).toMatch(/verification checklist/i);
    expect(await nextMembershipNumber()).toBe(1);
  });

  it("refuses the cashier who receipted the fee", async () => {
    const f = await fixture();
    const cashierAsApprover = staffActor(f.cashierId, APPROVER);

    const result = await approveApplication(cashierAsApprover, {
      applicationId: f.applicationId,
      version: 1,
      note: null,
      confirm: f.publicRef,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("guards_failed");
    expect(result.reasons.join(" ")).toMatch(/cashier/i);
  });

  it("names the failed guards on the screen, satisfied ones included", async () => {
    // An approver is signing off on a file somebody else assembled, so "the
    // checklist is clear, the fee is receipted, you did not verify this" is a
    // much stronger statement than "nothing is blocking you".
    const f = await fixture();
    const view = await loadApproval(
      staffActor(f.officerId, APPROVER),
      f.applicationId,
    );
    expect(view).not.toBeNull();
    if (view === null) return;

    const byCode = new Map(view.guards.map((g) => [g.code, g]));
    expect(byCode.get("checklist_clear")?.satisfied).toBe(true);
    expect(byCode.get("payments_receipted")?.satisfied).toBe(true);
    expect(byCode.get("not_the_verifier")?.satisfied).toBe(false);
    expect(byCode.get("not_the_verifier")?.waivable).toBe(true);
    // A missing document or an unreceipted fee is a fact about the file that
    // no authority changes, so offering to waive it would be offering to
    // approve an application that does not qualify.
    expect(byCode.get("payments_receipted")?.waivable).toBe(false);
    expect(view.mayApprove).toBe(false);
  });

  it("describes a file it cannot act on, rather than ticking everything", async () => {
    // The regression this pins was found on the screen. `canTransition` stops
    // at the wrong state and reports no failed guards, because it never
    // evaluated any; reading the tick-list off that made an application still
    // in verification print eight ticks, telling an approver the checklist was
    // "complete and signed" while a round of it was open with a defect.
    const f = await fixture();
    const db = getDb();

    await db
      .updateTable("applications")
      .set({ state: "UNDER_VERIFICATION" as never })
      .where("id", "=", f.applicationId)
      .execute();
    await db
      .updateTable("verification_checklists")
      .set({ state: "in_progress", outcome: null, completed_by: null })
      .where("application_id", "=", f.applicationId)
      .execute();

    const view = await loadApproval(
      staffActor(f.approverId, APPROVER),
      f.applicationId,
    );
    expect(view).not.toBeNull();
    if (view === null) return;

    const byCode = new Map(view.guards.map((g) => [g.code, g]));
    expect(byCode.get("checklist_complete")?.satisfied).toBe(false);
    expect(byCode.get("checklist_clear")?.satisfied).toBe(false);
    // Still true of the file, and still said so: the point is accuracy both
    // ways, not pessimism.
    expect(byCode.get("payments_receipted")?.satisfied).toBe(true);
    expect(view.mayApprove).toBe(false);
  });
});

describe.skipIf(!available)("the super-admin's recorded exception", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await resetMembershipSequence();
  });

  it("lets one named person past one guard, and says so on the grant", async () => {
    const f = await fixture();
    const adminId = await createUser(`admin-${randomUUID()}@lcci.org.pk`);
    const admin = staffActor(adminId, SUPER_ADMIN, "super_admin");

    const waiver = await waiveConflict(admin, {
      applicationId: f.applicationId,
      guard: "not_the_verifier",
      grantedFor: f.officerId,
      reason: "Only officer in the building during the Eid closure.",
    });

    expect(waiver.ok).toBe(true);

    const result = await approveApplication(
      staffActor(f.officerId, APPROVER),
      {
        applicationId: f.applicationId,
        version: 1,
        note: null,
        confirm: f.publicRef,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waived).toEqual(["not_the_verifier"]);

    const granted = await getDb()
      .selectFrom("audit_log")
      .select(["after_json"])
      .where("action", "=", "membership.granted")
      .executeTakeFirstOrThrow();

    // The most audit-relevant fact on the page: a guard that only passed
    // because somebody switched it off.
    expect(granted.after_json).toMatchObject({ waivedGuards: ["not_the_verifier"] });

    const waived = await getDb()
      .selectFrom("audit_log")
      .select(["summary"])
      .where("action", "=", "application.conflict_waived")
      .executeTakeFirstOrThrow();
    expect(waived.summary).toContain("not_the_verifier");
  });

  it("does not help a different approver", async () => {
    // A waiver names a person. One granted to the officer must do nothing for
    // the cashier, or it is not a waiver, it is the guard being off.
    const f = await fixture();
    const adminId = await createUser(`admin-${randomUUID()}@lcci.org.pk`);
    const admin = staffActor(adminId, SUPER_ADMIN, "super_admin");

    await waiveConflict(admin, {
      applicationId: f.applicationId,
      guard: "not_the_cashier",
      grantedFor: f.officerId,
      reason: "Standing in for the cashier during the audit week.",
    });

    const result = await approveApplication(
      staffActor(f.cashierId, APPROVER),
      {
        applicationId: f.applicationId,
        version: 1,
        note: null,
        confirm: f.publicRef,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("guards_failed");
  });

  it("refuses a guard that is a fact about the file", async () => {
    const f = await fixture();
    const adminId = await createUser(`admin-${randomUUID()}@lcci.org.pk`);
    const admin = staffActor(adminId, SUPER_ADMIN, "super_admin");

    const result = await waiveConflict(admin, {
      applicationId: f.applicationId,
      guard: "payments_receipted",
      grantedFor: f.officerId,
      reason: "The cashier is on leave until next month.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("not_waivable");
  });

  it("refuses a waiver granted to oneself", async () => {
    const f = await fixture();
    const adminId = await createUser(`admin-${randomUUID()}@lcci.org.pk`);
    const admin = staffActor(
      adminId,
      [...SUPER_ADMIN, "application.approve"],
      "super_admin",
    );

    const result = await waiveConflict(admin, {
      applicationId: f.applicationId,
      guard: "not_the_verifier",
      grantedFor: adminId,
      reason: "I verified this one myself and there is nobody else.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("not_waivable");
  });

  it("refuses a reason that is not one", async () => {
    const f = await fixture();
    const adminId = await createUser(`admin-${randomUUID()}@lcci.org.pk`);
    const admin = staffActor(adminId, SUPER_ADMIN, "super_admin");

    const result = await waiveConflict(admin, {
      applicationId: f.applicationId,
      guard: "not_the_verifier",
      grantedFor: f.officerId,
      reason: "ok",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("reason_required");

    const count = await getDb()
      .selectFrom("conflict_waivers")
      .select(sql<number>`COUNT(*)`.as("n"))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  it("refuses the same waiver twice", async () => {
    const f = await fixture();
    const adminId = await createUser(`admin-${randomUUID()}@lcci.org.pk`);
    const admin = staffActor(adminId, SUPER_ADMIN, "super_admin");

    const reason = "Only officer in the building during the Eid closure.";
    const first = await waiveConflict(admin, {
      applicationId: f.applicationId,
      guard: "not_the_verifier",
      grantedFor: f.officerId,
      reason,
    });
    expect(first.ok).toBe(true);

    const again = await waiveConflict(admin, {
      applicationId: f.applicationId,
      guard: "not_the_verifier",
      grantedFor: f.officerId,
      reason,
    });

    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal).toBe("already_waived");
  });
});

describe.skipIf(!available)("refusing, and sending back", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await resetMembershipSequence();
  });

  it("records a refusal with its reason and stops the clock", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const result = await rejectApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      reason: "The partnership deed is on plain paper, not Rs 1000 stamp paper.",
    });

    expect(result.ok).toBe(true);

    const db = getDb();
    const application = await db
      .selectFrom("applications")
      .select(["state"])
      .where("id", "=", f.applicationId)
      .executeTakeFirstOrThrow();
    expect(application.state).toBe("REJECTED");

    const decision = await db
      .selectFrom("application_decisions")
      .selectAll()
      .where("application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();

    expect(decision.decision).toBe("rejected");
    // Stored on the decision and not only in the audit log, because "why was
    // my application refused" has to be answerable from the file.
    expect(decision.reason).toContain("stamp paper");
    expect(decision.membership_id).toBeNull();

    const clock = await db
      .selectFrom("sla_clocks")
      .select(["state", "outcome"])
      .where("application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();
    expect(clock.state).toBe("stopped");
    expect(clock.outcome).toBe("met");

    // And the applicant is told, in the approver's own words. This assertion
    // used to read `toBe(0)`: the refusal was recorded and nobody was written
    // to, which is a file that goes quiet rather than a decision.
    const mail = await db
      .selectFrom("email_outbox")
      .select(["to_address", "template", "payload_json"])
      .where("template", "=", "application-not-approved")
      .executeTakeFirstOrThrow();
    expect(mail.to_address).toBe("office@mallroad.example.com.pk");
    expect(mail.payload_json).toMatchObject({
      reason: "The partnership deed is on plain paper, not Rs 1000 stamp paper.",
      // The fixture's fee is receipted, so the message says so — and says only
      // that the Chamber will write separately about it. What actually happens
      // to the money on a refusal is open question 12 and is not ours to
      // promise in an email.
      feeReceipted: true,
    });

    expect(await nextMembershipNumber()).toBe(1);
  });

  it("refuses to refuse with a reason that is not one", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const result = await rejectApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      // Trims to "no", which is not empty. The floor is in the domain and not
      // only in the action's schema, because the action is one caller among
      // several and this reason reaches the applicant.
      reason: "   no   ",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("reason_required");
  });

  it("sends a file back with the clock still running", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const result = await returnForVerification(approver, {
      applicationId: f.applicationId,
      version: 1,
      reason: "Item 4 ticked, but the NTN shown is the proprietor's, not the firm's.",
    });

    expect(result.ok).toBe(true);

    const db = getDb();
    const application = await db
      .selectFrom("applications")
      .select(["state"])
      .where("id", "=", f.applicationId)
      .executeTakeFirstOrThrow();
    expect(application.state).toBe("UNDER_VERIFICATION");

    const decision = await db
      .selectFrom("application_decisions")
      .select(["decision"])
      .where("application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();
    expect(decision.decision).toBe("returned");

    // The file is back in the chamber's own hands. Pausing the promise while
    // the chamber works on it would be the chamber excusing its own delay.
    const clock = await db
      .selectFrom("sla_clocks")
      .select(["state", "outcome"])
      .where("application_id", "=", f.applicationId)
      .executeTakeFirstOrThrow();
    expect(clock.state).toBe("running");
    expect(clock.outcome).toBeNull();
  });

  it("refuses a decision on a file somebody else has already decided", async () => {
    const f = await fixture();
    const approver = staffActor(f.approverId, APPROVER);

    const first = await returnForVerification(approver, {
      applicationId: f.applicationId,
      version: 1,
      reason: "Item 4 ticked, but the NTN shown is the proprietor's.",
    });
    expect(first.ok).toBe(true);

    const second = await rejectApplication(approver, {
      applicationId: f.applicationId,
      version: 1,
      reason: "Changed my mind about this one entirely.",
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.refusal).toBe("wrong_state");
  });
});
