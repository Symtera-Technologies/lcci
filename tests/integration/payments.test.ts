import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, sql } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import type { ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import {
  cashierQueue,
  loadPayments,
  markDishonoured,
  receiptPayment,
  recordBankMatchVerdict,
  type InstrumentInput,
} from "@/membership/payments";
import { gatherFacts } from "@/membership/submit";
import { canTransition } from "@/membership/workflow";
import {
  createUser,
  databaseAvailable,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * Cashier receipting, against the database.
 *
 * The comparison itself is arithmetic and is tested as such in
 * `tests/payments-bank-match.test.ts`. What is left for this file is every
 * claim about rows, and there are four that matter.
 *
 * **A receipt number is allocated once, under a lock, and never for a refused
 * receipt.** Finance reconciles bank statements against these numbers, so a
 * gap is a question nobody can answer later.
 *
 * **One pay order cannot pay two fees.** The fingerprint's UNIQUE index is the
 * guarantee; the refusal that names the other application is the usability.
 *
 * **A recorded verdict is not the same as a favourable one.** Approval has to
 * refuse an instrument the cashier flagged as drawn on somebody else's
 * account, which is the single outcome the whole control exists to prevent.
 *
 * **The cashier cannot approve their own receipt.** Separation of duties, as
 * the form's two separate signatures intend it — and specifically with *two*
 * cashiers, because an application with a foreign partner owes two fees by two
 * separate instruments.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping payment tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

const TABLES = [
  "pay_orders",
  "payments",
  "document_access_log",
  "documents",
  "application_required_documents",
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
  roleCode = "cashier",
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
  cashierId: number;
  membershipPaymentId: number;
  surchargePaymentId: number | null;
}

/**
 * A submitted application with its fee rows, as submit leaves them.
 *
 * Inserted directly. The submit transition has its own test; what this file
 * needs is the row shape it produces — `payments` in state `due`, with
 * `method` already set to `pay_order` because that is what the form requires,
 * and a running clock so the cashier's queue has something to order by.
 */
async function fixture(
  options: { withSurcharge?: boolean; state?: string } = {},
): Promise<Fixture> {
  const db = getDb();

  const applicantId = await createUser(
    `applicant-${randomUUID()}@example.com.pk`,
    "portal",
  );
  const cashierId = await createUser(`cashier-${randomUUID()}@lcci.org.pk`);

  const publicRef = `LCCI-T-${Math.floor(Math.random() * 1e6)}`;

  const inserted = await db
    .insertInto("applications")
    .values({
      state: (options.state ?? "UNDER_VERIFICATION") as never,
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
      due_date: isoDaysFromToday(40),
    })
    .execute();

  const membership = await db
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

  let surchargePaymentId: number | null = null;
  if (options.withSurcharge) {
    const surcharge = await db
      .insertInto("payments")
      .values({
        application_id: applicationId,
        fee_kind: "itd_surcharge",
        amount: "750.00",
        currency: "USD",
        state: "due",
        method: "pay_order",
      })
      .executeTakeFirstOrThrow();
    surchargePaymentId = Number(surcharge.insertId);
  }

  return {
    applicationId,
    publicRef,
    cashierId,
    membershipPaymentId: Number(membership.insertId),
    surchargePaymentId,
  };
}

/** A pay order that matches the firm's declared account in every field. */
function matchingInstrument(
  overrides: Partial<InstrumentInput> = {},
): InstrumentInput {
  return {
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
    ...overrides,
  };
}

describe.skipIf(!available)("cashier receipting", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("issues a receipt number and records both sides of the comparison", async () => {
    const f = await fixture();
    const cashier = staffActor(f.cashierId, CASHIER);
    const instrument = matchingInstrument();

    const result = await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument,
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Yearly series, zero-padded to five. The format is reconciled against by
    // eye, so it is asserted rather than left to whatever the seed says.
    expect(result.receiptNo).toMatch(/^LCCI-RCPT-\d{4}-\d{5}$/);
    expect(result.bankMatchSystem).toBe("match");

    const payments = await loadPayments(cashier, f.applicationId);
    expect(payments).toHaveLength(1);

    const payment = payments[0];
    expect(payment?.state).toBe("receipted");
    expect(payment?.receiptNo).toBe(result.receiptNo);
    expect(payment?.receiptedByName).toBeTruthy();
    expect(payment?.amountReceived).toBe("10650.00");
    // The version moved, which is what makes a second cashier's stale form lose.
    expect(payment?.version).toBe(2);

    const po = payment?.payOrder;
    expect(po?.bankMatchSystem).toBe("match");
    expect(po?.bankMatchVerdict).toBe("match");
    // Both sides stored, so the comparison can be re-read years later without
    // depending on particulars the applicant may since have edited.
    expect(po?.draweeBankName).toBe("HBL");
    expect(po?.certificateBankName).toBe("Habib Bank Limited");
  });

  it("writes one audit event carrying the comparison and the certificate's age", async () => {
    const f = await fixture();
    const cashier = staffActor(f.cashierId, CASHIER);

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument({
        certificateIssuedOn: isoDaysFromToday(-120),
      }),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    const events = await sql<{ action: string; after_json: unknown }>`
      SELECT action, after_json FROM audit_log WHERE action = 'payment.receipted'
    `.execute(getDb());

    expect(events.rows).toHaveLength(1);

    // mysql2 parses a JSON column, so this is already an object.
    const after = events.rows[0]?.after_json as {
      receiptNo: string;
      certificate: { ageDays: number; olderThanAllowed: boolean };
      bankMatch: { system: string; verdict: string; overrode: boolean };
    };

    expect(after.receiptNo).toMatch(/^LCCI-RCPT-/);
    expect(after.certificate.ageDays).toBe(120);
    // Recorded, not refused: the age of the certificate is checklist item 5,
    // the officer's judgement on page 5, not the cashier's on page 2.
    expect(after.certificate.olderThanAllowed).toBe(true);
    expect(after.bankMatch.overrode).toBe(false);
  });

  it("refuses cash and says why rather than quietly skipping the control", async () => {
    const f = await fixture();
    const cashier = staffActor(f.cashierId, CASHIER);

    const result = await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "cash",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal).toBe("method_unsupported");
    expect(result.message).toMatch(/drawee bank/);
  });

  it("refuses an unexplained amount variance, and accepts an explained one", async () => {
    const f = await fixture();
    const cashier = staffActor(f.cashierId, CASHIER);

    // The Associate regular fee presented on a Corporate declaration: the
    // self-declared-class problem, as the counter meets it.
    const short = matchingInstrument({ instrumentAmount: "4450.00" });

    const refused = await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: short,
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.refusal).toBe("variance_unexplained");
      expect(refused.message).toMatch(/6200\.00/);
    }

    // Nothing was written, and in particular no receipt number was burned.
    const untouched = await loadPayments(cashier, f.applicationId);
    expect(untouched[0]?.state).toBe("due");
    expect(untouched[0]?.receiptNo).toBeNull();

    const accepted = await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: short,
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason:
        "Applicant is being re-classified as Associate; top-up waived by the Secretary.",
      duplicateNote: null,
    });

    expect(accepted.ok).toBe(true);

    const payments = await loadPayments(cashier, f.applicationId);
    expect(payments[0]?.amountReceived).toBe("4450.00");
    expect(payments[0]?.varianceReason).toMatch(/re-classified/);
  });

  it("requires a note where the cashier overrides the comparison", async () => {
    const f = await fixture();
    const cashier = staffActor(f.cashierId, CASHIER);

    // Two plainly different institutions, passed as a match.
    const instrument = matchingInstrument({
      draweeBankName: "United Bank Limited",
    });

    const refused = await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument,
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal).toBe("override_unexplained");

    const accepted = await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument,
      bankMatchVerdict: "match",
      bankMatchNote:
        "Certificate names UBL as correspondent; account is the same, confirmed by phone.",
      varianceReason: null,
      duplicateNote: null,
    });

    expect(accepted.ok).toBe(true);

    const events = await sql<{ after_json: unknown }>`
      SELECT after_json FROM audit_log WHERE action = 'payment.receipted'
    `.execute(getDb());
    const after = events.rows[0]?.after_json as {
      bankMatch: { system: string; verdict: string; overrode: boolean };
    };

    // The fact an auditor comes looking for: a machine verdict somebody
    // overrode, with both halves kept.
    expect(after.bankMatch.system).toBe("mismatch");
    expect(after.bankMatch.verdict).toBe("match");
    expect(after.bankMatch.overrode).toBe(true);
  });

  it("refuses the same pay order on a second application, and names the first", async () => {
    const first = await fixture();
    const second = await fixture();
    const cashier = staffActor(first.cashierId, CASHIER);

    const instrument = matchingInstrument({ instrumentNo: "000412" });

    const one = await receiptPayment(cashier, {
      paymentId: first.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument,
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });
    expect(one.ok).toBe(true);

    // Same bank, same number, same date — typed with different punctuation and
    // spacing, which is how it would actually arrive at a second counter. Note
    // what is varied and what is not: dots in the bank name and a space inside
    // the number are noise, so they must still collide. A *prefix* would not
    // be: "PO000412" is extra content, and a bank numbering its instruments
    // with a series letter genuinely has a different number.
    const two = await receiptPayment(cashier, {
      paymentId: second.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: {
        ...instrument,
        draweeBankName: "H.B.L.",
        instrumentNo: "00-0412",
      },
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    expect(two.ok).toBe(false);
    if (two.ok) return;
    expect(two.refusal).toBe("duplicate_instrument");
    expect(two.conflictingRef).toBe(first.publicRef);

    // And the second application is untouched: no receipt number, no row.
    const payments = await loadPayments(cashier, second.applicationId);
    expect(payments[0]?.state).toBe("due");
    expect(payments[0]?.payOrder).toBeNull();
  });

  it("refuses the same number and date under a different bank spelling, until cleared", async () => {
    // The hole the fingerprint leaves open by design. It hashes the bank name
    // without the alias list — so the hash keeps meaning the same thing across
    // a release that edits that list — which means one physical pay order
    // typed "United Bank Limited" here and "U.B.L." there produces two
    // fingerprints and no collision. This is the second check that closes it,
    // and it is a refusal rather than a constraint because two banks really
    // can issue instrument 000412 on the same day.
    const first = await fixture();
    const second = await fixture();
    const cashier = staffActor(first.cashierId, CASHIER);

    const one = await receiptPayment(cashier, {
      paymentId: first.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument({
        draweeBankName: "United Bank Limited",
        instrumentNo: "000412",
      }),
      bankMatchVerdict: "mismatch",
      bankMatchNote: "Drawn on a UBL account.",
      varianceReason: null,
      duplicateNote: null,
    });
    expect(one.ok).toBe(true);

    const near = await receiptPayment(cashier, {
      paymentId: second.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument({
        draweeBankName: "U.B.L.",
        instrumentNo: "00-0412",
      }),
      bankMatchVerdict: "mismatch",
      bankMatchNote: "Drawn on a UBL account.",
      varianceReason: null,
      duplicateNote: null,
    });

    expect(near.ok).toBe(false);
    if (!near.ok) {
      expect(near.refusal).toBe("possible_duplicate");
      expect(near.conflictingRef).toBe(first.publicRef);
    }

    // Still only one receipt number spent.
    const spent = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM payments WHERE receipt_no IS NOT NULL
    `.execute(getDb());
    expect(Number(spent.rows[0]?.n)).toBe(1);

    const cleared = await receiptPayment(cashier, {
      paymentId: second.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument({
        draweeBankName: "U.B.L.",
        instrumentNo: "00-0412",
      }),
      bankMatchVerdict: "mismatch",
      bankMatchNote: "Drawn on a UBL account.",
      varianceReason: null,
      duplicateNote:
        "Both instruments seen side by side; different serials under the same number series.",
    });

    expect(cleared.ok).toBe(true);

    // The clearing is a recorded judgement, and its presence in the log is
    // itself what makes "which near-duplicates were waved through" a query.
    const events = await sql<{ after_json: unknown }>`
      SELECT after_json FROM audit_log
       WHERE action = 'payment.receipted'
       ORDER BY id DESC LIMIT 1
    `.execute(getDb());
    expect(
      (events.rows[0]?.after_json as { duplicateCleared: string | null })
        .duplicateCleared,
    ).toMatch(/side by side/);
  });

  it("refuses a second receipt for a fee already receipted", async () => {
    const f = await fixture();
    const cashier = staffActor(f.cashierId, CASHIER);

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    // A second cashier working from a page rendered before the first receipt.
    const again = await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal).toBe("wrong_state");

    // Exactly one receipt number was allocated, which is the property that
    // matters: a refused receipt must never consume one.
    const numbers = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM payments WHERE receipt_no IS NOT NULL
    `.execute(getDb());
    expect(Number(numbers.rows[0]?.n)).toBe(1);
  });
});

describe.skipIf(!available)("the approval guards", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  const approverView = (userId: number) => ({
    userId,
    isStaff: true,
    isSystem: false,
    permissions: new Set<PermissionCode>(APPROVER),
  });

  it("blocks approval while the fee is unreceipted and clears once it is", async () => {
    const f = await fixture({ state: "PENDING_APPROVAL" });
    const cashier = staffActor(f.cashierId, CASHIER);
    const approverId = await createUser(`approver-${randomUUID()}@lcci.org.pk`);

    const before = await gatherFacts(getDb(), f.applicationId);
    expect(before.allPaymentsReceipted).toBe(false);
    expect(
      canTransition(before, "approve", approverView(approverId)).failedGuards,
    ).toContain("payments_receipted");

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    const after = await gatherFacts(getDb(), f.applicationId);
    expect(after.allPaymentsReceipted).toBe(true);
    expect(after.bankMatchVerdictRecorded).toBe(true);
    expect(after.bankMatchMismatch).toBe(false);

    const guards = canTransition(
      after,
      "approve",
      approverView(approverId),
    ).failedGuards;
    expect(guards).not.toContain("payments_receipted");
    expect(guards).not.toContain("bank_match_resolved");
    expect(guards).not.toContain("bank_match_confirmed");
  });

  it("blocks approval of an instrument the cashier called a mismatch", async () => {
    const f = await fixture({ state: "PENDING_APPROVAL" });
    const cashier = staffActor(f.cashierId, CASHIER);
    const approverId = await createUser(`approver-${randomUUID()}@lcci.org.pk`);

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument({ draweeBankName: "United Bank Limited" }),
      bankMatchVerdict: "mismatch",
      bankMatchNote:
        "Drawn on a UBL account; the certificate is for an HBL account.",
      varianceReason: null,
      duplicateNote: null,
    });

    const facts = await gatherFacts(getDb(), f.applicationId);
    // The fee *is* receipted and a verdict *is* recorded. Neither of those is
    // the same as the control having passed, which is the whole reason the two
    // guards are separate.
    expect(facts.allPaymentsReceipted).toBe(true);
    expect(facts.bankMatchVerdictRecorded).toBe(true);
    expect(facts.bankMatchMismatch).toBe(true);

    const guards = canTransition(
      facts,
      "approve",
      approverView(approverId),
    ).failedGuards;
    expect(guards).toContain("bank_match_confirmed");
    expect(guards).not.toContain("bank_match_resolved");
  });

  it("unblocks it when the resolved verdict is revised, keeping both judgements", async () => {
    const f = await fixture({ state: "PENDING_APPROVAL" });
    const cashier = staffActor(f.cashierId, CASHIER);
    const approverId = await createUser(`approver-${randomUUID()}@lcci.org.pk`);

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument({ draweeBankName: "United Bank Limited" }),
      bankMatchVerdict: "mismatch",
      bankMatchNote: "Drawn on a UBL account.",
      varianceReason: null,
      duplicateNote: null,
    });

    const payments = await loadPayments(cashier, f.applicationId);
    const payOrderId = payments[0]?.payOrder?.id;
    expect(payOrderId).toBeTruthy();

    const bare = await recordBankMatchVerdict(cashier, {
      payOrderId: payOrderId as number,
      verdict: "match",
      note: "   ",
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.refusal).toBe("note_required");

    const revised = await recordBankMatchVerdict(cashier, {
      payOrderId: payOrderId as number,
      verdict: "match",
      note: "Applicant produced the UBL account-maintenance certificate; same account after all.",
    });
    expect(revised.ok).toBe(true);

    const facts = await gatherFacts(getDb(), f.applicationId);
    expect(facts.bankMatchMismatch).toBe(false);
    expect(
      canTransition(facts, "approve", approverView(approverId)).failedGuards,
    ).not.toContain("bank_match_confirmed");

    // The receipt number is unchanged — the route forward is a revised verdict,
    // not a cancelled receipt that finance would be left reconciling.
    const after = await loadPayments(cashier, f.applicationId);
    expect(after[0]?.receiptNo).toBe(payments[0]?.receiptNo);

    // Both judgements survive, in order.
    const events = await sql<{
      action: string;
      before_json: unknown;
      after_json: unknown;
    }>`
      SELECT action, before_json, after_json
        FROM audit_log
       WHERE action IN ('payment.receipted','payment.bank_match_revised')
       ORDER BY id
    `.execute(getDb());

    expect(events.rows.map((row) => row.action)).toEqual([
      "payment.receipted",
      "payment.bank_match_revised",
    ]);
    expect((events.rows[1]?.before_json as { verdict: string }).verdict).toBe(
      "mismatch",
    );
    expect((events.rows[1]?.after_json as { verdict: string }).verdict).toBe(
      "match",
    );
  });

  it("refuses every cashier who receipted a fee, not only the first", async () => {
    // Two fees, two instruments, two cashiers — which is what a firm with a
    // foreign partner produces. Recording one id would refuse whichever
    // happened to be stored and let the other approve their own receipt.
    const f = await fixture({ withSurcharge: true, state: "PENDING_APPROVAL" });
    const cashierOne = staffActor(f.cashierId, CASHIER);
    const secondCashierId = await createUser(
      `cashier2-${randomUUID()}@lcci.org.pk`,
    );
    const cashierTwo = staffActor(secondCashierId, CASHIER);

    await receiptPayment(cashierOne, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    await receiptPayment(cashierTwo, {
      paymentId: f.surchargePaymentId as number,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument({
        instrumentAmount: "750.00",
        instrumentCurrency: "USD",
      }),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    const facts = await gatherFacts(getDb(), f.applicationId);
    expect(facts.receiptedByUserIds).toHaveLength(2);
    expect(facts.allPaymentsReceipted).toBe(true);

    for (const id of [f.cashierId, secondCashierId]) {
      expect(
        canTransition(facts, "approve", {
          userId: id,
          isStaff: true,
          isSystem: false,
          permissions: new Set<PermissionCode>(APPROVER),
        }).failedGuards,
      ).toContain("not_the_cashier");
    }

    const uninvolved = await createUser(`approver-${randomUUID()}@lcci.org.pk`);
    expect(
      canTransition(facts, "approve", approverView(uninvolved)).failedGuards,
    ).not.toContain("not_the_cashier");
  });

  it("does not demand a bank-match verdict for a waived fee", async () => {
    // A waived fee has no instrument, so there is nothing to compare. A guard
    // that asked for a verdict anyway would be one no action could satisfy,
    // and the application would be stranded short of approval forever.
    const f = await fixture({ state: "PENDING_APPROVAL" });

    await getDb()
      .updateTable("payments")
      .set({ state: "waived", method: null })
      .where("id", "=", f.membershipPaymentId)
      .execute();

    const facts = await gatherFacts(getDb(), f.applicationId);
    expect(facts.allPaymentsReceipted).toBe(true);
    expect(facts.bankMatchVerdictRecorded).toBe(true);
    expect(facts.bankMatchMismatch).toBe(false);
  });
});

describe.skipIf(!available)("dishonour", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("puts the fee back into arrears and blocks approval again", async () => {
    const f = await fixture({ state: "PENDING_APPROVAL" });
    const cashier = staffActor(f.cashierId, CASHIER);

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    const receipted = await loadPayments(cashier, f.applicationId);
    const version = receipted[0]?.version as number;

    const bare = await markDishonoured(cashier, {
      paymentId: f.membershipPaymentId,
      version,
      reason: "  ",
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.refusal).toBe("reason_required");

    const result = await markDishonoured(cashier, {
      paymentId: f.membershipPaymentId,
      version,
      reason: "Returned by the bank: insufficient funds.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not yet approved, so no membership exists to suspend.
    expect(result.suspendedMembershipNo).toBeNull();

    const after = await loadPayments(cashier, f.applicationId);
    expect(after[0]?.state).toBe("dishonoured");
    expect(after[0]?.dishonourReason).toMatch(/insufficient funds/);
    // The receipt number survives the dishonour. Finance has it on a
    // counterfoil and in a ledger, and deleting it here would leave them with a
    // number that resolves to nothing.
    expect(after[0]?.receiptNo).toBeTruthy();

    const facts = await gatherFacts(getDb(), f.applicationId);
    expect(facts.allPaymentsReceipted).toBe(false);
  });

  it("suspends the membership a dishonoured fee paid for", async () => {
    const f = await fixture({ state: "PENDING_APPROVAL" });
    const cashier = staffActor(f.cashierId, CASHIER);

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    // The approved state and its membership inserted directly, at the same
    // level of abstraction this test already used for the state. The grant
    // path itself is exercised end to end in `approval.test.ts`; what is under
    // test here is only what a dishonour does to a membership that exists.
    const company = await getDb()
      .insertInto("companies")
      .values({ name: "Dishonour Fixture Ltd" })
      .executeTakeFirst();

    await getDb()
      .insertInto("memberships")
      .values({
        company_id: Number(company.insertId),
        membership_no: `LCCI-T-${Math.floor(Math.random() * 1e6)}`,
        membership_class: "corporate",
        status: "active",
        granted_on: isoDaysFromToday(0),
        granted_by_application_id: f.applicationId,
      })
      .execute();

    await getDb()
      .updateTable("applications")
      .set({ state: "APPROVED" })
      .where("id", "=", f.applicationId)
      .execute();

    const receipted = await loadPayments(cashier, f.applicationId);

    const result = await markDishonoured(cashier, {
      paymentId: f.membershipPaymentId,
      version: receipted[0]?.version as number,
      reason: "Pay order cancelled by the drawer.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.suspendedMembershipNo).toMatch(/^LCCI-T-/);

    // Suspended in the same transaction as the dishonour, not recorded as a
    // debt somebody has to remember. The two states cannot disagree.
    const membership = await getDb()
      .selectFrom("memberships")
      .select(["status", "suspend_reason"])
      .where("granted_by_application_id", "=", f.applicationId)
      .executeTakeFirst();
    expect(membership?.status).toBe("suspended");
    expect(membership?.suspend_reason).toMatch(/cancelled by the drawer/);

    const events = await sql<{ action: string; after_json: unknown }>`
      SELECT action, after_json FROM audit_log
       WHERE action IN ('payment.dishonoured', 'membership.suspended')
       ORDER BY id
    `.execute(getDb());
    // Both, in one commit. The suspension is the earlier row because the
    // dishonour event carries its number as a cross-reference and so has to
    // wait for it; they are one atomic fact under one request id, not a
    // sequence, which is why this asserts the set rather than the order.
    expect([...events.rows.map((row) => row.action)].sort()).toEqual([
      "membership.suspended",
      "payment.dishonoured",
    ]);

    const dishonour = events.rows.find(
      (row) => row.action === "payment.dishonoured",
    );
    const after = dishonour?.after_json as {
      suspendedMembershipNo: string | null;
      applicationRef: string;
    };
    expect(after.suspendedMembershipNo).toMatch(/^LCCI-T-/);
    expect(after.applicationRef).toBe(f.publicRef);
  });

  it("refuses to dishonour a fee that was never receipted", async () => {
    const f = await fixture();
    const cashier = staffActor(f.cashierId, CASHIER);

    const result = await markDishonoured(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      reason: "Returned by the bank.",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal).toBe("wrong_state");
  });
});

describe.skipIf(!available)("the cashier's queue", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("lists what is outstanding, soonest promise first, and drops it once receipted", async () => {
    const slow = await fixture();
    const urgent = await fixture();

    // The Executive tier's three working days against the Regular forty. The
    // one that arrived second is due first, which is exactly what ordering by
    // arrival would hide.
    await getDb()
      .updateTable("sla_clocks")
      .set({
        due_date: isoDaysFromToday(3),
        processing_tier: "executive",
        working_days: 3,
      })
      .where("application_id", "=", urgent.applicationId)
      .execute();

    const cashier = staffActor(slow.cashierId, CASHIER);

    const outstanding = await cashierQueue(cashier);
    expect(outstanding.map((row) => row.applicationId)).toEqual([
      urgent.applicationId,
      slow.applicationId,
    ]);

    await receiptPayment(cashier, {
      paymentId: urgent.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    const left = await cashierQueue(cashier);
    expect(left.map((row) => row.applicationId)).toEqual([slow.applicationId]);

    const all = await cashierQueue(cashier, { outstandingOnly: false });
    expect(all).toHaveLength(2);
    expect(
      all.find((row) => row.applicationId === urgent.applicationId)?.receiptNo,
    ).toMatch(/^LCCI-RCPT-/);
  });

  it("keeps a dishonoured fee in the outstanding queue", async () => {
    // Found in the browser: receipting removed the row from the queue, and a
    // dishonour did not put it back. A returned pay order is money the Chamber
    // was promised and did not get, it blocks approval, and nothing else in
    // the admin shows it to the cashier — so dropping it here is how it
    // becomes nobody's job.
    const f = await fixture({ state: "UNDER_VERIFICATION" });
    const cashier = staffActor(f.cashierId, CASHIER);

    await receiptPayment(cashier, {
      paymentId: f.membershipPaymentId,
      version: 1,
      method: "pay_order",
      receivedOn: isoDaysFromToday(0),
      instrument: matchingInstrument(),
      bankMatchVerdict: "match",
      bankMatchNote: null,
      varianceReason: null,
      duplicateNote: null,
    });

    const receipted = await loadPayments(cashier, f.applicationId);
    expect(
      (await cashierQueue(cashier)).map((row) => row.applicationId),
    ).not.toContain(f.applicationId);

    const dishonoured = await markDishonoured(cashier, {
      paymentId: f.membershipPaymentId,
      version: receipted[0]?.version as number,
      reason: "Returned unpaid: payment stopped by drawer.",
    });
    expect(dishonoured.ok).toBe(true);

    const queue = await cashierQueue(cashier);
    const row = queue.find((r) => r.applicationId === f.applicationId);
    expect(row?.state).toBe("dishonoured");
    // The receipt number comes back with it, because the screen has to be able
    // to name the receipt that did not clear.
    expect(row?.receiptNo).toMatch(/^LCCI-RCPT-/);
  });

  it("never shows a draft, which has no fee rows at all", async () => {
    const f = await fixture({ state: "DRAFT" });
    await getDb()
      .updateTable("applications")
      .set({ submitted_at: null })
      .where("id", "=", f.applicationId)
      .execute();

    const cashier = staffActor(f.cashierId, CASHIER);
    expect(await cashierQueue(cashier, { outstandingOnly: false })).toEqual([]);
  });
});
