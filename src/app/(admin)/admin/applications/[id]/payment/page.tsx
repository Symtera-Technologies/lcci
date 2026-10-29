import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireStaffPage } from "@/server/auth/dal";
import {
  declaredBankDetails,
  financialDocuments,
  loadPayments,
  type PaymentView,
} from "@/membership/payments";
import {
  CERTIFICATE_MAX_AGE_DAYS,
  certificateAgeDays,
} from "@/membership/bank-match";
import { formatDate } from "@/lib/format";
import { StatusPill } from "@/components/admin/status-pill";
import { ReceiptForm } from "@/components/admin/receipt-form";
import {
  DishonourForm,
  ReviseVerdictForm,
} from "@/components/admin/payment-controls";
import {
  DocumentViewer,
  type ViewableDocument,
} from "@/components/admin/document-viewer";
import type { ApplicationState } from "@/db/schema";
import {
  markDishonouredAction,
  receiptPaymentAction,
  reviseBankMatchAction,
} from "./actions";

export const metadata: Metadata = {
  title: "Fee receipting",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The cashier's desk: page 2 of the printed form.
 *
 * Guarded on `payment.read` and not `application.read`, which is the whole
 * point of this screen existing separately from the review screen. A cashier
 * holds `payment.read`, `payment.receipt`, `application.read` and
 * `documents.read_financial` — and deliberately not `documents.read`, so they
 * can open the pay order and the account-maintenance certificate and nothing
 * else. Putting receipting on the review screen would have meant giving them a
 * page built around every director's CNIC.
 *
 * The two documents are shown beside the form because the comparison *is* the
 * control. A cashier asked to judge whether the instrument was drawn on the
 * certificate's account, with the certificate one navigation away, will
 * reliably answer from the applicant's declaration instead — which is the one
 * source the control is supposed to be independent of.
 */
export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("payment.read");
  const { id } = await params;
  const query = await searchParams;

  const applicationId = Number(id);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) notFound();

  const db = getDb();

  const header = await db
    .selectFrom("applications")
    .leftJoin(
      "application_company",
      "application_company.application_id",
      "applications.id",
    )
    .select([
      "applications.id",
      "applications.public_ref",
      "applications.state",
      "applications.membership_class",
      "applications.processing_tier",
      "applications.submitted_at",
      "application_company.firm_name",
    ])
    .where("applications.id", "=", applicationId)
    .executeTakeFirst();

  // A draft has no fees yet — payment rows are created by the submit
  // transaction — so there is nothing for a cashier to do and no page to show.
  if (!header || header.submitted_at === null) notFound();

  const [payments, declared, documents] = await Promise.all([
    loadPayments(actor, applicationId, db),
    declaredBankDetails(actor, applicationId, db),
    financialDocuments(actor, applicationId, db),
  ]);

  const mayReceipt = actor.permissions.has("payment.receipt");

  const viewable: ViewableDocument[] = documents.map((doc) => ({
    id: doc.id,
    typeLabel: doc.superseded ? `${doc.typeLabel} (superseded)` : doc.typeLabel,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    viewable: doc.viewable,
  }));

  const selectedId = typeof query.doc === "string" ? query.doc : null;
  const selected =
    (selectedId ? viewable.find((doc) => doc.id === selectedId) : undefined) ??
    // Default to the pay order: it is the document the cashier has in hand and
    // the one the form's first half is transcribed from.
    viewable.find(
      (doc) => doc.id === documents.find((d) => d.typeCode === "pay_order")?.id,
    ) ??
    viewable[0] ??
    null;

  return (
    <main className="mx-auto max-w-[96rem] px-5 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="text-[0.8125rem] text-stone-600">
        <Link
          href="/admin/payments"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Fees
        </Link>
        <span aria-hidden="true" className="mx-2 text-stone-400">
          /
        </span>
        <Link
          href={`/admin/applications/${applicationId}`}
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          {header.public_ref ?? `Application ${applicationId}`}
        </Link>
        <span aria-hidden="true" className="mx-2 text-stone-400">
          /
        </span>
        <span>Fee</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            Fee receipting
          </h1>
          <p className="mt-1 text-[0.9375rem] text-ink-700">
            {header.firm_name ?? "This application"} ·{" "}
            <span className="text-stone-600">
              {header.public_ref ?? `#${applicationId}`}
            </span>
            {header.membership_class && header.processing_tier && (
              <>
                {" · "}
                <span className="text-stone-600">
                  {header.membership_class === "corporate"
                    ? "Corporate"
                    : "Associate"}
                  , {header.processing_tier} tier, as declared
                </span>
              </>
            )}
          </p>
        </div>
        <StatusPill state={header.state as ApplicationState} />
      </header>

      {!mayReceipt && (
        <p className="mt-6 rounded-lg border border-stone-200 bg-stone-50 p-4 text-[0.9375rem] text-ink-700">
          You can read the fee record but not receipt it. Taking money in is the
          cashier&rsquo;s duty, and holding it apart from verification and
          approval is what the separate signatures on the printed form exist to
          create.
        </p>
      )}

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-8">
          {payments.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-[0.9375rem] text-ink-700">
              No fee rows exist for this application, which should not be
              possible after submission. Raise it rather than working around it.
            </p>
          ) : (
            payments.map((payment) => (
              <PaymentSection
                key={payment.id}
                applicationId={applicationId}
                payment={payment}
                declared={declared}
                mayReceipt={mayReceipt}
              />
            ))
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <h2 className="text-[1.0625rem] font-semibold text-ink-950">
            What the applicant attached
          </h2>

          {documents.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-300 bg-white p-6 text-[0.9375rem] text-ink-700">
              Neither a pay order nor an account-maintenance certificate has
              been uploaded. Both sides of the comparison are missing, so a
              verdict recorded now would be a verdict about nothing.
            </p>
          ) : (
            <>
              <ul className="flex flex-wrap gap-2">
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <Link
                      href={`/admin/applications/${applicationId}/payment?doc=${doc.id}`}
                      aria-current={
                        selected?.id === doc.id ? "true" : undefined
                      }
                      className={
                        selected?.id === doc.id
                          ? "inline-flex min-h-11 items-center rounded-lg border border-ink-900 bg-ink-900 px-3 text-[0.875rem] font-medium text-white"
                          : "inline-flex min-h-11 items-center rounded-lg border border-stone-300 bg-white px-3 text-[0.875rem] font-medium text-ink-800 hover:border-ink-400"
                      }
                    >
                      {doc.typeLabel}
                      {doc.superseded && (
                        <span className="ml-1.5 text-[0.75rem] font-normal opacity-80">
                          superseded
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>

              {documents.some(
                (doc) => doc.typeCode === "bank_certificate" && !doc.superseded,
              ) && (
                <CertificateAge
                  documents={documents}
                  transcribed={
                    payments.find((p) => p.payOrder?.certificateIssuedOn)
                      ?.payOrder?.certificateIssuedOn ?? null
                  }
                />
              )}

              <DocumentViewer
                document={selected}
                height="70vh"
                emptyMessage="Choose the pay order or the certificate to view it here."
              />
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * The age of the live certificate, stated rather than enforced.
 *
 * The form asks for one no older than three months, but that is checklist item
 * 5 — the officer's judgement on page 5, not the cashier's on page 2. A cashier
 * is taking money in; refusing a receipt over a document's age would move a
 * verification decision to the counter, where the applicant is standing and the
 * officer is not.
 */
function CertificateAge({
  documents,
  transcribed,
}: {
  documents: Awaited<ReturnType<typeof financialDocuments>>;
  /**
   * The date the cashier read off the certificate itself, where one has been
   * receipted. Preferred over the document row's, which is what the applicant
   * typed when they uploaded the scan — the cashier had the paper in hand and
   * the form asks them to correct the declaration against it.
   */
  transcribed: string | null;
}) {
  const live = documents.find(
    (doc) => doc.typeCode === "bank_certificate" && !doc.superseded,
  );
  const issuedOn = transcribed ?? live?.issuedOn ?? null;
  if (!issuedOn) return null;

  const age = certificateAgeDays(issuedOn, new Date());
  if (age === null) return null;

  const stale = age > CERTIFICATE_MAX_AGE_DAYS;

  return (
    <p
      className={
        stale
          ? "rounded-lg border border-urgent-300 bg-urgent-50 p-3 text-[0.875rem] text-ink-900"
          : "rounded-lg border border-stone-200 bg-stone-50 p-3 text-[0.875rem] text-ink-800"
      }
    >
      Certificate issued {formatDate(issuedOn)}
      {transcribed ? ", as transcribed at the counter" : ", as declared"} —{" "}
      {age} day
      {age === 1 ? "" : "s"} ago.{" "}
      {stale
        ? `Older than the ${CERTIFICATE_MAX_AGE_DAYS} days the form allows. That is checklist item 5 for the officer to judge, not a reason to refuse the money.`
        : "Inside the three months the form asks for."}
    </p>
  );
}

const FEE_LABELS: Record<string, string> = {
  membership: "Membership fee",
  itd_surcharge: "International Trade Development surcharge",
};

const METHOD_WORDING: Record<string, string> = {
  pay_order: "Pay order",
  cheque: "Cheque",
  cash: "Cash",
  online: "Online",
};

const STATE_WORDING: Record<string, string> = {
  due: "Outstanding",
  instrument_received: "Instrument taken in, not yet receipted",
  receipted: "Receipted",
  dishonoured: "Dishonoured",
  refunded: "Refunded",
  waived: "Waived",
  cancelled: "Cancelled",
};

function PaymentSection({
  applicationId,
  payment,
  declared,
  mayReceipt,
}: {
  applicationId: number;
  payment: PaymentView;
  declared: Awaited<ReturnType<typeof declaredBankDetails>>;
  mayReceipt: boolean;
}) {
  const label = FEE_LABELS[payment.feeKind] ?? payment.feeKind;
  const receiptable =
    payment.state === "due" || payment.state === "instrument_received";

  return (
    <section
      aria-labelledby={`fee-${payment.id}`}
      className="rounded-xl border border-stone-200 bg-white p-6"
    >
      <h2
        id={`fee-${payment.id}`}
        className="text-[1.0625rem] font-semibold text-ink-950"
      >
        {label}
      </h2>
      <p className="mt-1 text-[0.9375rem] text-ink-700">
        {payment.amount} {payment.currency} ·{" "}
        <span className="text-stone-600">
          {STATE_WORDING[payment.state] ?? payment.state}
        </span>
      </p>

      {payment.feeKind === "itd_surcharge" && (
        <p className="mt-3 text-[0.875rem] text-stone-600">
          The form requires this by a <em>separate</em> pay order, so it is
          receipted on its own instrument and gets its own receipt number. The
          rate the USD 750 was converted at is Finance&rsquo;s to state and is
          recorded against the payment rather than recomputed.
        </p>
      )}

      {receiptable && mayReceipt && (
        <div className="mt-6 border-t border-stone-200 pt-6">
          <ReceiptForm
            applicationId={applicationId}
            paymentId={payment.id}
            version={payment.version}
            feeLabel={label}
            amountOwed={payment.amount}
            currency={payment.currency}
            declared={declared}
            action={receiptPaymentAction}
          />
        </div>
      )}

      {payment.state === "dishonoured" && (
        <div className="mt-5 rounded-lg border border-urgent-300 bg-urgent-50 p-4 text-[0.9375rem] text-ink-900">
          <p className="font-semibold text-urgent-800">
            Receipt {payment.receiptNo ?? "(none)"} did not clear
          </p>
          <p className="mt-1">{payment.dishonourReason}</p>
          {payment.dishonouredAt && (
            <p className="mt-1 text-[0.875rem] text-stone-600">
              Recorded {formatDate(payment.dishonouredAt.toISOString())}.
              Approval is blocked while this is the fee&rsquo;s standing.
            </p>
          )}
          {/*
            Said out loud because the alternative is a cashier holding a
            replacement pay order and hunting for the button. There isn't one:
            a replacement needs a fee row of its own so this receipt number
            keeps resolving to the money that was returned, and what LCCI
            actually does with a bounced pay order — demand a fresh one, or
            close the application — is open question 12, not ours to decide.
          */}
          <p className="mt-2 text-[0.875rem] text-stone-600">
            A replacement instrument cannot be receipted against this fee:
            receipt {payment.receiptNo ?? "(none)"} has been issued and stays
            issued. Taking a fresh pay order means raising a new fee for it,
            which is not built yet.
          </p>
        </div>
      )}

      {/*
        The same detail for a dishonoured fee as for a live one, minus the
        controls. A dishonour is when finance most needs to read which
        instrument it was, what the receipt number was and who took it in —
        they are reconciling a returned pay order against a counterfoil.
      */}
      {(payment.state === "receipted" || payment.state === "dishonoured") && (
        <ReceiptedDetail
          applicationId={applicationId}
          payment={payment}
          mayReceipt={mayReceipt && payment.state === "receipted"}
        />
      )}
    </section>
  );
}

function ReceiptedDetail({
  applicationId,
  payment,
  mayReceipt,
}: {
  applicationId: number;
  payment: PaymentView;
  mayReceipt: boolean;
}) {
  const po = payment.payOrder;

  return (
    <div className="mt-6 space-y-6 border-t border-stone-200 pt-6">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Pair term="Receipt number" detail={payment.receiptNo} />
        <Pair
          term="Receipted"
          detail={
            payment.receiptedAt
              ? `${formatDate(payment.receiptedAt.toISOString())}${payment.receiptedByName ? ` by ${payment.receiptedByName}` : ""}`
              : null
          }
        />
        <Pair
          term="Amount received"
          detail={
            payment.amountReceived
              ? `${payment.amountReceived} ${payment.currency}`
              : null
          }
        />
        <Pair
          term="Paid by"
          detail={
            payment.method === null
              ? null
              : (METHOD_WORDING[payment.method] ?? payment.method)
          }
        />
        {po && (
          <>
            <Pair
              term="Instrument"
              detail={`${po.instrumentNo} dated ${formatDate(po.instrumentDate)}`}
            />
            <Pair
              term="Drawn on"
              detail={[po.draweeBankName, po.draweeBranch]
                .filter(Boolean)
                .join(" — ")}
            />
            <Pair
              term="Account title on the instrument"
              detail={po.accountTitle}
            />
            <Pair
              term="Certificate"
              detail={[po.certificateBankName, po.certificateBranch]
                .filter(Boolean)
                .join(" — ")}
            />
            <Pair
              term="Account title on the certificate"
              detail={po.certificateAccountTitle}
            />
            <Pair
              term="Certificate issued"
              detail={
                po.certificateIssuedOn
                  ? formatDate(po.certificateIssuedOn)
                  : null
              }
            />
          </>
        )}
      </dl>

      {po?.duplicateClearedNote && (
        <p className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-[0.9375rem] text-ink-900">
          <span className="font-semibold">
            Instrument {po.instrumentNo} matched an earlier receipt&rsquo;s
            number and date, and was receipted anyway:
          </span>{" "}
          {po.duplicateClearedNote}
        </p>
      )}

      {payment.varianceReason && (
        <p className="rounded-lg border border-urgent-300 bg-urgent-50 p-4 text-[0.9375rem] text-ink-900">
          <span className="font-semibold">
            Accepted for {payment.amountReceived} against {payment.amount}{" "}
            {payment.currency}:
          </span>{" "}
          {payment.varianceReason}
        </p>
      )}

      {po && (
        <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
          <h3 className="text-[0.9375rem] font-semibold text-ink-950">
            The bank-match control
          </h3>
          <p className="mt-2 text-[0.9375rem] text-ink-900">
            <span className="font-semibold">
              {po.bankMatchVerdict === "match"
                ? "Same account"
                : po.bankMatchVerdict === "mismatch"
                  ? "A different account"
                  : "No verdict recorded"}
            </span>
            {po.bankMatchVerdictByName && ` — ${po.bankMatchVerdictByName}`}
            {po.bankMatchVerdictAt &&
              `, ${formatDate(po.bankMatchVerdictAt.toISOString())}`}
          </p>
          {po.bankMatchNote && (
            <p className="mt-1 text-[0.9375rem] text-ink-800">
              {po.bankMatchNote}
            </p>
          )}
          <p className="mt-2 text-[0.875rem] text-stone-600">
            The system&rsquo;s own normalised comparison read these as{" "}
            <strong>{po.bankMatchSystem ?? "not compared"}</strong>.{" "}
            {po.bankMatchSystem !== null &&
            po.bankMatchVerdict !== null &&
            po.bankMatchSystem !== "uncertain" &&
            po.bankMatchSystem !== po.bankMatchVerdict
              ? "That disagrees with the recorded verdict, which is why the note above is required."
              : "It is advisory only: approval is guarded on the human verdict."}
          </p>

          {po.bankMatchVerdict === "mismatch" && (
            <p className="mt-3 text-[0.9375rem] text-ink-900">
              Approval is blocked while this stands. The way forward is a
              deficiency: the applicant supplies a corrected instrument, or the
              certificate for the account this one was drawn on — and the
              verdict is then revised rather than the receipt being cancelled.
            </p>
          )}
        </div>
      )}

      {po && mayReceipt && (
        <details className="rounded-lg border border-stone-200 bg-white p-4">
          <summary className="cursor-pointer text-[0.9375rem] font-medium text-ink-900">
            Revise the verdict
          </summary>
          <div className="mt-4">
            <ReviseVerdictForm
              applicationId={applicationId}
              payOrderId={po.id}
              current={po.bankMatchVerdict ?? "mismatch"}
              action={reviseBankMatchAction}
            />
          </div>
        </details>
      )}

      {mayReceipt && (
        <details className="rounded-lg border border-stone-200 bg-white p-4">
          <summary className="cursor-pointer text-[0.9375rem] font-medium text-ink-900">
            The instrument did not clear
          </summary>
          <div className="mt-4">
            <p className="mb-4 text-[0.875rem] text-stone-600">
              Recording a dishonour puts the fee back into arrears and blocks
              approval. Where membership has already been granted it also owes a
              suspension, which is logged as owed — the membership register is
              not built yet, and an event claiming a suspension that never
              happened would be worse than none.
            </p>
            <DishonourForm
              applicationId={applicationId}
              paymentId={payment.id}
              version={payment.version}
              receiptNo={payment.receiptNo}
              action={markDishonouredAction}
            />
          </div>
        </details>
      )}
    </div>
  );
}

function Pair({ term, detail }: { term: string; detail: string | null }) {
  if (detail === null || detail === "") return null;
  return (
    <div>
      <dt className="text-[0.8125rem] text-stone-600">{term}</dt>
      <dd className="text-[0.9375rem] text-ink-900">{detail}</dd>
    </div>
  );
}
