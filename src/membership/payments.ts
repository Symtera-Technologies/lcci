import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  BankMatchSystem,
  BankMatchVerdict,
  FeeKind,
  PaymentMethod,
  PaymentState,
  RefundDisposition,
} from "@/db/schema";
import {
  ConcurrencyError,
  requirePermission,
  type ActorContext,
} from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { allocateNumber } from "@/membership/numbering";
import { notifyFeeReceipted } from "@/membership/notify";
import { suspendForDishonour } from "@/membership/approval";
import { formatDate } from "@/lib/format";
import {
  amountAgrees,
  certificateAgeDays,
  instrumentFingerprint,
  instrumentKey,
  shortfallPaisa,
  systemBankMatch,
  CERTIFICATE_MAX_AGE_DAYS,
  type BankMatchAdvice,
} from "@/membership/bank-match";

/**
 * The cashier's desk: receipting, the bank-match control, and dishonour.
 *
 * Page 2 of the printed form carries a cashier block with its own signature —
 * class, amount received, cash/cheque number, receipt number, date — separate
 * from the staff signature on the verification checklist on page 5. That
 * separation is not decoration. It is the chamber's own separation of duties,
 * and this module is one of the three places it is enforced: by grant
 * (`payment.receipt` is never on the same role as `application.approve`), here
 * by recording *who* receipted, and inside the approval transaction by a SQL
 * check that the approver is none of them.
 *
 * Four rules shape the file.
 *
 * **Receipting is a one-way door, decided by an affected-row count.** `UPDATE …
 * WHERE id = ? AND state IN (…) AND version = ?`; zero rows means another
 * cashier got there first and the caller is told to reload rather than
 * overwriting them. Two cashiers at one counter is not a hypothetical on a host
 * that runs several Passenger workers.
 *
 * **The machine advises and the cashier decides.** `bank_match_system` is a
 * normalised string compare and is recorded for the audit trail;
 * `bank_match_verdict` is the human judgement, and that is the one approval is
 * guarded on. Where the two disagree the cashier must say why, for the same
 * reason the checklist records `disagreements`: a machine verdict somebody
 * overrode is the most audit-relevant fact on the page.
 *
 * **Cash is refused, and the refusal says why.** The form requires the fee by
 * pay order drawn on the same account as the attached account-maintenance
 * certificate. Cash has no drawee bank, so the control cannot be performed on
 * it at all — and quietly accepting it would create applications that pass
 * every guard with the anti-fraud check simply absent. Whether the chamber
 * accepts cash is a policy decision for LCCI, not something this module should
 * decide by omission.
 *
 * **Nothing throws for a refusal.** Every outcome a cashier can cause is a
 * value with a sentence attached, because the screen has to render it. Only a
 * lost race and a genuine fault throw.
 */

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface PayOrderView {
  readonly id: number;
  readonly draweeBankName: string;
  readonly draweeBranch: string | null;
  readonly instrumentNo: string;
  readonly instrumentDate: string;
  readonly instrumentAmount: string;
  readonly instrumentCurrency: string;
  readonly accountTitle: string | null;
  readonly certificateBankName: string | null;
  readonly certificateBranch: string | null;
  readonly certificateAccountTitle: string | null;
  readonly certificateIssuedOn: string | null;
  readonly bankMatchSystem: BankMatchSystem | null;
  readonly bankMatchVerdict: BankMatchVerdict | null;
  readonly bankMatchNote: string | null;
  readonly bankMatchVerdictAt: Date | null;
  readonly bankMatchVerdictByName: string | null;
  /**
   * Why the cashier let an instrument through that matched an earlier one's
   * number and date. Read back because a stored reason nobody can see is not a
   * reason — it is only a row, and the auditor asking "why are there two
   * receipts for pay order 000412?" is standing in front of this screen.
   */
  readonly duplicateClearedNote: string | null;
}

export interface PaymentView {
  readonly id: number;
  readonly feeKind: FeeKind;
  readonly amount: string;
  readonly amountReceived: string | null;
  readonly varianceReason: string | null;
  readonly currency: string;
  readonly state: PaymentState;
  readonly method: PaymentMethod | null;
  readonly receiptNo: string | null;
  readonly receiptedAt: Date | null;
  readonly receiptedByName: string | null;
  readonly dishonouredAt: Date | null;
  readonly dishonourReason: string | null;
  readonly refundDisposition: RefundDisposition | null;
  readonly version: number;
  readonly payOrder: PayOrderView | null;
}

/**
 * Every payment on one application, with its instrument.
 *
 * `payment.read` and not `application.read`: the cashier's grant is the narrow
 * one, and an officer who may read an application is not thereby entitled to
 * its banking details. Both roles hold both permissions today; the check is
 * what keeps that a grant decision rather than an accident of which function
 * somebody called.
 */
export async function loadPayments(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<readonly PaymentView[]> {
  requirePermission(actor, "payment.read");

  const rows = await sql<{
    id: number;
    fee_kind: FeeKind;
    amount: string;
    amount_received: string | null;
    variance_reason: string | null;
    currency: string;
    state: PaymentState;
    method: PaymentMethod | null;
    receipt_no: string | null;
    receipted_at: Date | null;
    receipted_by_name: string | null;
    dishonoured_at: Date | null;
    dishonour_reason: string | null;
    refund_disposition: RefundDisposition | null;
    version: number;
    po_id: number | null;
    drawee_bank_name: string | null;
    drawee_branch: string | null;
    instrument_no: string | null;
    instrument_date: string | null;
    instrument_amount: string | null;
    instrument_currency: string | null;
    account_title: string | null;
    certificate_bank_name: string | null;
    certificate_branch: string | null;
    certificate_account_title: string | null;
    certificate_issued_on: string | null;
    bank_match_system: BankMatchSystem | null;
    bank_match_verdict: BankMatchVerdict | null;
    bank_match_note: string | null;
    bank_match_verdict_at: Date | null;
    verdict_by_name: string | null;
    duplicate_cleared_note: string | null;
  }>`
    SELECT p.id, p.fee_kind, p.amount, p.amount_received, p.variance_reason,
           p.currency, p.state, p.method, p.receipt_no, p.receipted_at,
           cashier.full_name AS receipted_by_name,
           p.dishonoured_at, p.dishonour_reason, p.refund_disposition, p.version,
           o.id AS po_id, o.drawee_bank_name, o.drawee_branch, o.instrument_no,
           o.instrument_date, o.instrument_amount, o.instrument_currency,
           o.account_title, o.certificate_bank_name, o.certificate_branch,
           o.certificate_account_title, o.certificate_issued_on,
           o.bank_match_system, o.bank_match_verdict, o.bank_match_note,
           o.bank_match_verdict_at, verdict.full_name AS verdict_by_name,
           o.duplicate_cleared_note
      FROM payments p
      LEFT JOIN pay_orders o ON o.payment_id = p.id
      LEFT JOIN users cashier ON cashier.id = p.receipted_by
      LEFT JOIN users verdict ON verdict.id = o.bank_match_verdict_by
     WHERE p.application_id = ${applicationId}
     ORDER BY p.fee_kind
  `.execute(db);

  return rows.rows.map((row) => ({
    id: Number(row.id),
    feeKind: row.fee_kind,
    amount: row.amount,
    amountReceived: row.amount_received,
    varianceReason: row.variance_reason,
    currency: row.currency,
    state: row.state,
    method: row.method,
    receiptNo: row.receipt_no,
    receiptedAt: row.receipted_at,
    receiptedByName: row.receipted_by_name,
    dishonouredAt: row.dishonoured_at,
    dishonourReason: row.dishonour_reason,
    refundDisposition: row.refund_disposition,
    version: Number(row.version),
    payOrder:
      row.po_id === null
        ? null
        : {
            id: Number(row.po_id),
            draweeBankName: row.drawee_bank_name ?? "",
            draweeBranch: row.drawee_branch,
            instrumentNo: row.instrument_no ?? "",
            instrumentDate: String(row.instrument_date ?? "").slice(0, 10),
            instrumentAmount: row.instrument_amount ?? "0.00",
            instrumentCurrency: row.instrument_currency ?? "PKR",
            accountTitle: row.account_title,
            certificateBankName: row.certificate_bank_name,
            certificateBranch: row.certificate_branch,
            certificateAccountTitle: row.certificate_account_title,
            certificateIssuedOn:
              row.certificate_issued_on === null
                ? null
                : String(row.certificate_issued_on).slice(0, 10),
            bankMatchSystem: row.bank_match_system,
            bankMatchVerdict: row.bank_match_verdict,
            bankMatchNote: row.bank_match_note,
            bankMatchVerdictAt: row.bank_match_verdict_at,
            bankMatchVerdictByName: row.verdict_by_name,
            duplicateClearedNote: row.duplicate_cleared_note,
          },
  }));
}

export interface CashierQueueRow {
  readonly applicationId: number;
  readonly publicRef: string | null;
  readonly firmName: string | null;
  readonly applicationState: string;
  readonly paymentId: number;
  readonly feeKind: FeeKind;
  readonly amount: string;
  readonly currency: string;
  readonly state: PaymentState;
  readonly receiptNo: string | null;
  readonly submittedAt: Date | null;
  readonly dueDate: string | null;
  /** Null where the instrument has not been captured yet. */
  readonly bankMatchVerdict: BankMatchVerdict | null;
}

/**
 * What the cashier sees on opening the backend.
 *
 * Ordered by the SLA deadline and not by arrival, because the tiers are a paid
 * promise in working days and the cashier's desk is one of the two places that
 * promise is spent. An Executive application submitted this morning is due
 * before a Regular one from six weeks ago, and a queue ordered by submission
 * hides that.
 */
export async function cashierQueue(
  actor: ActorContext,
  options: { readonly outstandingOnly?: boolean; readonly limit?: number } = {},
  db: Queryable = getDb(),
): Promise<readonly CashierQueueRow[]> {
  requirePermission(actor, "payment.read");

  const outstandingOnly = options.outstandingOnly ?? true;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300);

  const rows = await sql<{
    application_id: number;
    public_ref: string | null;
    firm_name: string | null;
    application_state: string;
    payment_id: number;
    fee_kind: FeeKind;
    amount: string;
    currency: string;
    state: PaymentState;
    receipt_no: string | null;
    submitted_at: Date | null;
    due_date: string | null;
    bank_match_verdict: BankMatchVerdict | null;
  }>`
    SELECT a.id AS application_id, a.public_ref, c.firm_name,
           a.state AS application_state,
           p.id AS payment_id, p.fee_kind, p.amount, p.currency, p.state,
           p.receipt_no, a.submitted_at, s.due_date, o.bank_match_verdict
      FROM payments p
      JOIN applications a ON a.id = p.application_id
      LEFT JOIN application_company c ON c.application_id = a.id
      LEFT JOIN pay_orders o ON o.payment_id = p.id
      LEFT JOIN sla_clocks s ON s.application_id = a.id
     WHERE a.submitted_at IS NOT NULL
       ${
         outstandingOnly
           ? // `dishonoured` belongs in the outstanding list even though it
             // cannot be receipted: it is money the Chamber was promised and
             // did not get, it blocks approval, and dropping it out of this
             // queue is how a returned pay order becomes nobody's job. The
             // `receipted` rows are the ones that leave.
             sql`AND p.state IN ('due','instrument_received','dishonoured')`
           : sql``
       }
     ORDER BY s.due_date IS NULL, s.due_date, a.submitted_at
     LIMIT ${limit}
  `.execute(db);

  return rows.rows.map((row) => ({
    applicationId: Number(row.application_id),
    publicRef: row.public_ref,
    firmName: row.firm_name,
    applicationState: row.application_state,
    paymentId: Number(row.payment_id),
    feeKind: row.fee_kind,
    amount: row.amount,
    currency: row.currency,
    state: row.state,
    receiptNo: row.receipt_no,
    submittedAt: row.submitted_at,
    dueDate: row.due_date === null ? null : String(row.due_date).slice(0, 10),
    bankMatchVerdict: row.bank_match_verdict,
  }));
}

/* -------------------------------------------------------------------------- */
/* What the cashier is shown before committing                                */
/* -------------------------------------------------------------------------- */

/**
 * The business and bank details the applicant declared.
 *
 * Offered as the default for the certificate side of the comparison, so the
 * cashier confirms what is on the paper in front of them rather than retyping
 * it. Prefilling is not the same as copying: the stored certificate values are
 * whatever the cashier submits, because the control compares the *certificate*
 * against the instrument, and the applicant's particulars are only a guess at
 * what the certificate says.
 */
export interface DeclaredBankDetails {
  readonly firmName: string | null;
  readonly bankName: string | null;
  readonly bankBranch: string | null;
}

export async function declaredBankDetails(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<DeclaredBankDetails> {
  requirePermission(actor, "payment.read");

  const row = await db
    .selectFrom("application_company")
    .select(["firm_name", "bank_name", "bank_branch"])
    .where("application_id", "=", applicationId)
    .executeTakeFirst();

  return {
    firmName: row?.firm_name ?? null,
    bankName: row?.bank_name ?? null,
    bankBranch: row?.bank_branch ?? null,
  };
}

/**
 * The two documents the control compares, and nothing else.
 *
 * Scoped by type rather than by `subject_kind`, matching the narrow
 * `documents.read_financial` grant the serve route enforces: a pay order's
 * subject kind is `payment` and a bank certificate's is `company`, so a filter
 * on subject kind alone would offer the cashier the instrument and withhold the
 * certificate it is meant to be checked against.
 *
 * Superseded documents are kept and marked. A pay order replaced after a
 * deficiency is exactly the history the cashier needs when the applicant says
 * "but I already sent one".
 */
export interface FinancialDocument {
  readonly id: string;
  readonly typeCode: string;
  readonly typeLabel: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly issuedOn: string | null;
  readonly superseded: boolean;
  readonly uploadedAt: Date;
  readonly viewable: boolean;
}

const VIEWABLE_MIME: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export async function financialDocuments(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<readonly FinancialDocument[]> {
  requirePermission(actor, "payment.read");

  const rows = await sql<{
    id: string;
    document_type_code: string;
    label_en: string;
    original_filename: string;
    mime_type: string;
    issued_on: string | null;
    review_state: string;
    uploaded_at: Date;
  }>`
    SELECT d.id, d.document_type_code, t.label_en, d.original_filename,
           d.mime_type, d.issued_on, d.review_state, d.uploaded_at
      FROM documents d
      JOIN document_types t ON t.code = d.document_type_code
     WHERE d.application_id = ${applicationId}
       AND d.deleted_at IS NULL
       AND d.document_type_code IN ('pay_order', 'bank_certificate')
     ORDER BY d.document_type_code, d.uploaded_at DESC
  `.execute(db);

  return rows.rows.map((row) => ({
    id: row.id,
    typeCode: row.document_type_code,
    typeLabel: row.label_en,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    issuedOn:
      row.issued_on === null ? null : String(row.issued_on).slice(0, 10),
    superseded: row.review_state === "superseded",
    uploadedAt: row.uploaded_at,
    viewable: VIEWABLE_MIME.has(row.mime_type),
  }));
}

/* -------------------------------------------------------------------------- */
/* Receipting                                                                 */
/* -------------------------------------------------------------------------- */

/** The instrument, as printed, plus the certificate it is claimed to match. */
export interface InstrumentInput {
  readonly draweeBankName: string;
  readonly draweeBranch: string | null;
  readonly instrumentNo: string;
  /** `YYYY-MM-DD`. */
  readonly instrumentDate: string;
  readonly instrumentAmount: string;
  readonly instrumentCurrency: string;
  readonly accountTitle: string | null;
  readonly certificateBankName: string | null;
  readonly certificateBranch: string | null;
  readonly certificateAccountTitle: string | null;
  /** `YYYY-MM-DD`, or null where the certificate carries no date. */
  readonly certificateIssuedOn: string | null;
}

export interface ReceiptInput {
  readonly paymentId: number;
  /** Optimistic concurrency: the version the cashier's screen was rendered from. */
  readonly version: number;
  readonly method: PaymentMethod;
  /** `YYYY-MM-DD`: the date in the cashier block, which may not be today. */
  readonly receivedOn: string;
  readonly instrument: InstrumentInput;
  readonly bankMatchVerdict: BankMatchVerdict;
  readonly bankMatchNote: string | null;
  /** Required where the instrument is not drawn for the amount owed. */
  readonly varianceReason: string | null;
  /**
   * Why a near-duplicate is a different instrument after all.
   *
   * Set only after the cashier has been shown the `possible_duplicate`
   * refusal. Separate from `bankMatchNote` because the two answer different
   * questions — one is about the account the instrument was drawn on, the
   * other about whether the Chamber has seen this piece of paper before — and
   * an auditor reading one sentence could not tell which judgement it was.
   */
  readonly duplicateNote: string | null;
}

export type ReceiptRefusal =
  | "not_found"
  | "wrong_state"
  | "method_unsupported"
  | "duplicate_instrument"
  | "possible_duplicate"
  | "variance_unexplained"
  | "override_unexplained";

export type ReceiptResult =
  | {
      readonly ok: true;
      readonly receiptNo: string;
      readonly bankMatchSystem: BankMatchSystem;
      readonly advice: BankMatchAdvice;
    }
  | {
      readonly ok: false;
      readonly refusal: ReceiptRefusal;
      readonly message: string;
      /** Where a duplicate was refused, which application already holds it. */
      readonly conflictingRef?: string | null;
    };

/**
 * Take in a pay order and issue a receipt number.
 *
 * The order inside the transaction is deliberate: everything that can refuse
 * runs before anything is written, so a refusal never burns a receipt number.
 * Receipt numbers are quoted by applicants and reconciled against bank
 * statements by finance, so a gap is a question nobody can answer later — the
 * same reason `submit` allocates the application reference last.
 */
export async function receiptPayment(
  actor: ActorContext,
  input: ReceiptInput,
  now: Date = new Date(),
): Promise<ReceiptResult> {
  requirePermission(actor, "payment.receipt");

  if (input.method !== "pay_order" && input.method !== "cheque") {
    return {
      ok: false,
      refusal: "method_unsupported",
      message:
        "Only a pay order or a cheque can be receipted here. Neither cash nor an online payment " +
        "has a drawee bank, so the control the form builds in — the instrument drawn on the same " +
        "account as the attached certificate — cannot be performed on it. Whether the Chamber " +
        "accepts cash is a policy decision, not something this screen should settle by letting it through.",
    };
  }

  const advice = systemBankMatch(
    {
      bankName: input.instrument.draweeBankName,
      branch: input.instrument.draweeBranch,
      accountTitle: input.instrument.accountTitle,
    },
    {
      bankName: input.instrument.certificateBankName,
      branch: input.instrument.certificateBranch,
      accountTitle: input.instrument.certificateAccountTitle,
    },
  );

  const note = input.bankMatchNote?.trim() ?? "";

  // Overriding the machine has to be explained. Not because the machine is
  // right — it is a string compare over bank names and it is often wrong — but
  // because "the cashier passed an instrument the comparison flagged" is
  // exactly the fact an auditor comes looking for, and an unexplained override
  // tells them nothing.
  if (
    advice.verdict === "mismatch" &&
    input.bankMatchVerdict === "match" &&
    note === ""
  ) {
    return {
      ok: false,
      refusal: "override_unexplained",
      message:
        "The comparison reads these as different banks. Recording a match anyway is allowed — " +
        "the comparison is advisory — but say what you checked, because the note is what an " +
        "auditor will read instead of the comparison.",
    };
  }

  if (input.bankMatchVerdict === "mismatch" && note === "") {
    return {
      ok: false,
      refusal: "override_unexplained",
      message:
        "Recording a mismatch blocks approval until the applicant supplies a corrected " +
        "instrument, so the note is what the deficiency letter will be written from.",
    };
  }

  const fingerprint = instrumentFingerprint({
    bankName: input.instrument.draweeBankName,
    instrumentNo: input.instrument.instrumentNo,
    instrumentDate: input.instrument.instrumentDate,
  });

  const key = instrumentKey({
    instrumentNo: input.instrument.instrumentNo,
    instrumentDate: input.instrument.instrumentDate,
  });

  const duplicateNote = input.duplicateNote?.trim() ?? "";

  return transaction(async (tx) => {
    const payment = await tx
      .selectFrom("payments")
      .select([
        "id",
        "application_id",
        "fee_kind",
        "amount",
        "currency",
        "state",
        "version",
      ])
      .where("id", "=", input.paymentId)
      .executeTakeFirst();

    if (!payment) {
      return {
        ok: false as const,
        refusal: "not_found" as const,
        message: "That payment no longer exists.",
      };
    }

    if (payment.state !== "due" && payment.state !== "instrument_received") {
      return {
        ok: false as const,
        refusal: "wrong_state" as const,
        message:
          payment.state === "receipted"
            ? "This fee has already been receipted. Reload the page to see the receipt."
            : `A payment in the state "${payment.state}" cannot be receipted.`,
      };
    }

    if (
      !amountAgrees(payment.amount, input.instrument.instrumentAmount) &&
      (input.varianceReason === null || input.varianceReason.trim() === "")
    ) {
      const short = shortfallPaisa(
        payment.amount,
        input.instrument.instrumentAmount,
      );
      return {
        ok: false as const,
        refusal: "variance_unexplained" as const,
        message:
          `The fee owed is ${payment.amount} ${payment.currency} and the instrument is drawn for ` +
          `${input.instrument.instrumentAmount}, ${short > 0n ? "short by" : "over by"} ` +
          `${formatPaisa(short < 0n ? -short : short)}. Class is self-declared, so this happens; ` +
          "receipt it if the Chamber is accepting it, but say why.",
      };
    }

    // The duplicate check, read before the insert so the refusal can name the
    // application that already holds the instrument. The UNIQUE key is still
    // the thing that guarantees it — two cashiers receipting the same pay order
    // at the same moment both read nothing here and one of them loses the
    // insert, which is caught below.
    const existing = await sql<{ public_ref: string | null }>`
      SELECT a.public_ref
        FROM pay_orders o
        JOIN payments p ON p.id = o.payment_id
        JOIN applications a ON a.id = p.application_id
       WHERE o.instrument_fingerprint = ${fingerprint}
       LIMIT 1
    `.execute(tx);

    if (existing.rows.length > 0) {
      return {
        ok: false as const,
        refusal: "duplicate_instrument" as const,
        message:
          `${input.instrument.draweeBankName} instrument ${input.instrument.instrumentNo} dated ` +
          `${formatDate(input.instrument.instrumentDate)} has already been receipted against application ` +
          `${existing.rows[0]?.public_ref ?? "another application"}. One pay order cannot pay two fees.`,
        conflictingRef: existing.rows[0]?.public_ref ?? null,
      };
    }

    // The near-duplicate, which the fingerprint cannot see.
    //
    // Same number, same date, a bank name spelled differently — which is one
    // physical pay order far more often than it is two banks coinciding. Not a
    // constraint, because two banks coinciding does happen; a refusal the
    // cashier clears by saying they checked, so the clearing is a recorded
    // judgement rather than an absent one.
    if (duplicateNote === "") {
      const near = await sql<{
        public_ref: string | null;
        bank: string;
        no: string;
      }>`
        SELECT a.public_ref, o.drawee_bank_name AS bank, o.instrument_no AS no
          FROM pay_orders o
          JOIN payments p ON p.id = o.payment_id
          JOIN applications a ON a.id = p.application_id
         WHERE o.instrument_key = ${key}
         LIMIT 1
      `.execute(tx);

      const row = near.rows[0];
      if (row) {
        return {
          ok: false as const,
          refusal: "possible_duplicate" as const,
          message:
            `Instrument ${row.no} dated ${formatDate(input.instrument.instrumentDate)} is already receipted ` +
            `against application ${row.public_ref ?? "another application"}, drawn on ` +
            `${row.bank}. The number and the date are the same; only the bank is written ` +
            "differently, which is usually one pay order being presented twice. If this really " +
            "is a different instrument, say so and it will be receipted.",
          conflictingRef: row.public_ref ?? null,
        };
      }
    }

    const receiptNo = await allocateNumber(tx, "fee_receipt", now);

    const claimed = await tx
      .updateTable("payments")
      .set({
        state: "receipted",
        method: input.method,
        amount_received: input.instrument.instrumentAmount,
        variance_reason:
          input.varianceReason === null || input.varianceReason.trim() === ""
            ? null
            : input.varianceReason.trim().slice(0, 300),
        received_at: new Date(`${input.receivedOn}T00:00:00Z`),
        receipted_at: now,
        receipted_by: actor.userId,
        receipt_no: receiptNo,
        version: Number(payment.version) + 1,
      })
      .where("id", "=", input.paymentId)
      .where("state", "in", ["due", "instrument_received"])
      .where("version", "=", input.version)
      .executeTakeFirst();

    if (Number(claimed.numUpdatedRows) !== 1) {
      throw new ConcurrencyError("This payment");
    }

    try {
      await tx
        .insertInto("pay_orders")
        .values({
          payment_id: input.paymentId,
          drawee_bank_name: input.instrument.draweeBankName.trim(),
          drawee_branch: blankToNull(input.instrument.draweeBranch),
          instrument_no: input.instrument.instrumentNo.trim(),
          instrument_date: input.instrument.instrumentDate,
          instrument_amount: input.instrument.instrumentAmount,
          instrument_currency: input.instrument.instrumentCurrency,
          account_title: blankToNull(input.instrument.accountTitle),
          certificate_bank_name: blankToNull(
            input.instrument.certificateBankName,
          ),
          certificate_branch: blankToNull(input.instrument.certificateBranch),
          certificate_account_title: blankToNull(
            input.instrument.certificateAccountTitle,
          ),
          certificate_issued_on: input.instrument.certificateIssuedOn,
          bank_match_system: advice.verdict,
          bank_match_verdict: input.bankMatchVerdict,
          bank_match_verdict_by: actor.userId,
          bank_match_verdict_at: now,
          bank_match_note: note === "" ? null : note.slice(0, 400),
          instrument_fingerprint: fingerprint,
          instrument_key: key,
          duplicate_cleared_note:
            duplicateNote === "" ? null : duplicateNote.slice(0, 400),
        })
        .execute();
    } catch (error) {
      // The race the SELECT above cannot close. Converted to the same refusal
      // the cashier would have seen a moment earlier, because "a duplicate was
      // caught by the index rather than by the query" is a distinction only
      // this file cares about.
      if (isDuplicateKey(error)) {
        return {
          ok: false as const,
          refusal: "duplicate_instrument" as const,
          message:
            "Another cashier receipted this same instrument a moment ago. Reload the page.",
          conflictingRef: null,
        };
      }
      throw error;
    }

    const ageDays =
      input.instrument.certificateIssuedOn === null
        ? null
        : certificateAgeDays(input.instrument.certificateIssuedOn, now);

    await writeAudit(
      actor,
      {
        entityType: "payment",
        entityId: input.paymentId,
        action: "payment.receipted",
        summary:
          `Receipt ${receiptNo}: ${payment.fee_kind === "itd_surcharge" ? "ITD surcharge" : "membership fee"} ` +
          `of ${input.instrument.instrumentAmount} ${payment.currency} by ${input.method}.`,
        after: {
          applicationId: Number(payment.application_id),
          receiptNo,
          feeKind: payment.fee_kind,
          amountOwed: payment.amount,
          amountReceived: input.instrument.instrumentAmount,
          varianceReason: input.varianceReason,
          method: input.method,
          receivedOn: input.receivedOn,
          instrument: {
            bank: input.instrument.draweeBankName,
            branch: input.instrument.draweeBranch,
            no: input.instrument.instrumentNo,
            date: input.instrument.instrumentDate,
            accountTitle: input.instrument.accountTitle,
          },
          certificate: {
            bank: input.instrument.certificateBankName,
            branch: input.instrument.certificateBranch,
            accountTitle: input.instrument.certificateAccountTitle,
            issuedOn: input.instrument.certificateIssuedOn,
            ageDays,
            // The form says "not older than three months". Recorded rather than
            // refused: the age of the certificate is checklist item 5, the
            // officer's to judge, and a cashier is taking in money, not
            // verifying documents.
            olderThanAllowed:
              ageDays !== null && ageDays > CERTIFICATE_MAX_AGE_DAYS,
          },
          // Present only where a near-duplicate was cleared, so its presence
          // in the log is itself the signal worth searching for.
          duplicateCleared: duplicateNote === "" ? null : duplicateNote,
          bankMatch: {
            system: advice.verdict,
            verdict: input.bankMatchVerdict,
            note: note === "" ? null : note,
            // The whole point of storing both: a cashier who passed an
            // instrument the comparison flagged, or flagged one it passed.
            overrode:
              advice.verdict !== "uncertain" &&
              advice.verdict !== input.bankMatchVerdict,
            reasons: advice.reasons,
          },
        },
      },
      tx,
    );

    // The receipt the applicant actually wanted, now that a human has issued
    // one. §7.1 promised this at submission; it could not be sent then,
    // because the instrument had not been compared with anything.
    //
    // Inside the transaction, so the number quoted in the message and the
    // number in the register are the same number or neither exists.
    await notifyFeeReceipted(tx, {
      applicationId: Number(payment.application_id),
      receiptNo,
      amount: input.instrument.instrumentAmount,
      currency: payment.currency,
      receivedOn: input.receivedOn,
      instrumentNo: input.instrument.instrumentNo,
    });

    return {
      ok: true as const,
      receiptNo,
      bankMatchSystem: advice.verdict,
      advice,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Revising the verdict                                                       */
/* -------------------------------------------------------------------------- */

export interface VerdictInput {
  readonly payOrderId: number;
  readonly verdict: BankMatchVerdict;
  readonly note: string;
}

export type VerdictResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: "not_found" | "note_required";
      readonly message: string;
    };

/**
 * Change a recorded bank-match verdict.
 *
 * It exists because a mismatch is routinely *resolved* rather than final: the
 * applicant brings the certificate for the account the instrument was actually
 * drawn on, and the same instrument now matches. Without this the only way
 * forward would be to cancel the payment and re-receipt it, which would burn a
 * receipt number and leave finance reconciling a receipt that no longer refers
 * to anything.
 *
 * The previous verdict is not overwritten in the audit log, so the sequence of
 * judgements stays readable — the same property the checklist gets from opening
 * round N+1 instead of editing round N.
 */
export async function recordBankMatchVerdict(
  actor: ActorContext,
  input: VerdictInput,
  now: Date = new Date(),
): Promise<VerdictResult> {
  requirePermission(actor, "payment.receipt");

  const note = input.note.trim();
  if (note === "") {
    return {
      ok: false,
      refusal: "note_required",
      message:
        "Say what changed. A verdict revised without a reason reads as a mistake.",
    };
  }

  return transaction(async (tx) => {
    const before = await tx
      .selectFrom("pay_orders")
      .select([
        "id",
        "payment_id",
        "bank_match_system",
        "bank_match_verdict",
        "bank_match_note",
      ])
      .where("id", "=", input.payOrderId)
      .executeTakeFirst();

    if (!before) {
      return {
        ok: false as const,
        refusal: "not_found" as const,
        message: "That pay order no longer exists.",
      };
    }

    await tx
      .updateTable("pay_orders")
      .set({
        bank_match_verdict: input.verdict,
        bank_match_verdict_by: actor.userId,
        bank_match_verdict_at: now,
        bank_match_note: note.slice(0, 400),
      })
      .where("id", "=", input.payOrderId)
      .execute();

    await writeAudit(
      actor,
      {
        entityType: "payment",
        entityId: Number(before.payment_id),
        action: "payment.bank_match_revised",
        summary: `Bank-match verdict changed from ${before.bank_match_verdict ?? "none"} to ${input.verdict}.`,
        before: {
          verdict: before.bank_match_verdict,
          note: before.bank_match_note,
        },
        after: {
          payOrderId: Number(before.id),
          verdict: input.verdict,
          note,
          system: before.bank_match_system,
        },
      },
      tx,
    );

    return { ok: true as const };
  });
}

/* -------------------------------------------------------------------------- */
/* Dishonour                                                                  */
/* -------------------------------------------------------------------------- */

export interface DishonourInput {
  readonly paymentId: number;
  readonly version: number;
  readonly reason: string;
}

export type DishonourResult =
  | {
      readonly ok: true;
      /**
       * The membership this dishonour suspended, where there was one.
       *
       * Null in the ordinary case: most pay orders bounce before approval, so
       * there is no membership yet and nothing to suspend. A name rather than
       * a boolean because the cashier is told which membership they have just
       * taken away.
       */
      readonly suspendedMembershipNo: string | null;
    }
  | {
      readonly ok: false;
      readonly refusal: "not_found" | "wrong_state" | "reason_required";
      readonly message: string;
    };

/**
 * Record that a receipted instrument did not clear.
 *
 * This is the state the paper process has no answer for. On paper the receipt
 * has been issued, the membership may already have been granted, and the fact
 * that the pay order bounced surfaces weeks later when somebody reconciles a
 * bank statement — by which time the member is in the directory.
 *
 * Here it is an event. The payment leaves `receipted`, an audit row records who
 * said so and why, and the membership the fee paid for is suspended in the same
 * transaction — so the fee's state and the member's cannot disagree, and
 * nobody has to remember to do the second half.
 *
 * It did not always do that. Until the register existed this reported that a
 * suspension was *owed* and left it, because an audit event claiming a
 * suspension that never happened is worse than no event at all. The register
 * exists now, so the claim is made true instead of recorded as a debt.
 */
export async function markDishonoured(
  actor: ActorContext,
  input: DishonourInput,
  now: Date = new Date(),
): Promise<DishonourResult> {
  requirePermission(actor, "payment.receipt");

  const reason = input.reason.trim();
  if (reason === "") {
    return {
      ok: false,
      refusal: "reason_required",
      message:
        "The bank's reason is what the member will be shown and what finance will reconcile against.",
    };
  }

  return transaction(async (tx) => {
    const payment = await tx
      .selectFrom("payments")
      .select([
        "id",
        "application_id",
        "fee_kind",
        "state",
        "receipt_no",
        "version",
      ])
      .where("id", "=", input.paymentId)
      .executeTakeFirst();

    if (!payment) {
      return {
        ok: false as const,
        refusal: "not_found" as const,
        message: "That payment no longer exists.",
      };
    }

    if (payment.state !== "receipted") {
      return {
        ok: false as const,
        refusal: "wrong_state" as const,
        message: `Only a receipted payment can be dishonoured; this one is "${payment.state}".`,
      };
    }

    const claimed = await tx
      .updateTable("payments")
      .set({
        state: "dishonoured",
        dishonoured_at: now,
        dishonour_reason: reason.slice(0, 300),
        dishonoured_by: actor.userId,
        version: Number(payment.version) + 1,
      })
      .where("id", "=", input.paymentId)
      .where("state", "=", "receipted")
      .where("version", "=", input.version)
      .executeTakeFirst();

    if (Number(claimed.numUpdatedRows) !== 1) {
      throw new ConcurrencyError("This payment");
    }

    const application = await tx
      .selectFrom("applications")
      .select(["state", "public_ref"])
      .where("id", "=", Number(payment.application_id))
      .executeTakeFirst();

    // In the same transaction as the dishonour. A membership left active
    // because a second statement failed is a member in the directory whose fee
    // was returned — which is precisely the gap the paper process has.
    //
    // This runs before the `payment.dishonoured` event below, so
    // `membership.suspended` is the earlier of the two rows in the chain. That
    // is the consequence preceding its cause, which looks wrong and is not:
    // both rows commit together, and the alternative is either writing the
    // membership's event from this module — which would put register knowledge
    // in the cashier's desk — or dropping the cross-reference the dishonour
    // event carries, which is what makes "were any memberships suspended by a
    // bounced pay order?" answerable from one table.
    const suspension =
      application?.state === "APPROVED"
        ? await suspendForDishonour(tx, actor, {
            applicationId: Number(payment.application_id),
            reason,
            at: now,
          })
        : null;

    const suspendedMembershipNo =
      suspension !== null && suspension.ok ? suspension.membershipNo : null;

    await writeAudit(
      actor,
      {
        entityType: "payment",
        entityId: input.paymentId,
        action: "payment.dishonoured",
        summary: `Receipt ${payment.receipt_no ?? "(none)"} dishonoured: ${reason}.`,
        before: { state: "receipted" },
        after: {
          applicationId: Number(payment.application_id),
          applicationRef: application?.public_ref ?? null,
          feeKind: payment.fee_kind,
          receiptNo: payment.receipt_no,
          reason,
          // What was actually done, in the same transaction. `membership.suspended`
          // is written by `suspendForDishonour` as its own event, so this field
          // is the cross-reference rather than the record.
          suspendedMembershipNo,
        },
      },
      tx,
    );

    return { ok: true as const, suspendedMembershipNo };
  });
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function blankToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function formatPaisa(paisa: bigint): string {
  const whole = paisa / 100n;
  const fraction = paisa % 100n;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
}

/**
 * Whether an error is MySQL's duplicate-key error.
 *
 * Matched on the driver's `code` rather than on the message, which is
 * localised, and narrowed with a property check rather than a cast because the
 * value arriving here is genuinely `unknown`.
 */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY"
  );
}
