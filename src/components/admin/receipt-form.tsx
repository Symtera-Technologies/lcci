"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  ChoiceGroup,
  SelectField,
  TextAreaField,
  TextField,
} from "@/components/membership/fields";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * The cashier block from page 2 of the printed form, plus the control behind it.
 *
 * The paper block asks for five things — class, amount received, cash/cheque
 * number, receipt number and date — and the receipt number is the one the
 * cashier does *not* fill in here: it is allocated by the server under the
 * sequence row's own lock, because two cashiers writing the same number is
 * exactly what a paper counterfoil prevents by being physical and a database
 * has to prevent deliberately.
 *
 * Everything else on this form exists because of the sentence on the fee page:
 * the fee is paid by pay order *drawn on the same bank account* as the attached
 * account-maintenance certificate. So the form captures both sides of that
 * comparison as separate fields, side by side, and asks the cashier to say
 * whether they match.
 *
 * Three deliberate refusals to be helpful.
 *
 * **The verdict has no default.** Pre-selecting "match" would record a
 * judgement nobody made on the single field approval is guarded on, and the
 * cashier would learn to tab past it.
 *
 * **The certificate side is prefilled from the applicant's own declaration,
 * and nothing more.** It is a starting point for the eyes, not an answer: what
 * gets stored is what the cashier confirms against the paper in front of them,
 * because the control compares the *certificate* against the instrument and
 * the applicant's particulars are only a guess at what the certificate says.
 *
 * **No live comparison.** The normalised compare runs server-side and comes
 * back in the result, beside the cashier's own verdict. A green tick appearing
 * as somebody types is an invitation to agree with it.
 */
export function ReceiptForm({
  applicationId,
  paymentId,
  version,
  feeLabel,
  amountOwed,
  currency,
  declared,
  action,
}: {
  applicationId: number;
  paymentId: number;
  version: number;
  feeLabel: string;
  amountOwed: string;
  currency: string;
  declared: {
    firmName: string | null;
    bankName: string | null;
    bankBranch: string | null;
  };
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};
  const today = new Date().toISOString().slice(0, 10);

  /**
   * What the cashier typed, where a refusal handed it back.
   *
   * A refused receipt writes nothing — that is the point, so no receipt number
   * is spent on one — which leaves the server nothing to re-read these twelve
   * fields from on the next render. So the action returns them, and the fields
   * are keyed on `attempt` to force a remount: changing `defaultValue` alone
   * updates the attribute and leaves the live input untouched, so the restore
   * would look implemented and do nothing.
   */
  const was = state.data;
  const attempt = was?.attempt ?? "fresh";
  const prior = (name: string, fallback: string | null = null) =>
    was ? (was[name] ?? "") : fallback;

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="paymentId" value={paymentId} />
      {/* Optimistic concurrency. The version this screen was rendered from, so
          a second cashier at another counter loses the update rather than
          overwriting the first one's receipt. */}
      <input type="hidden" name="version" value={version} />

      <p
        role="status"
        aria-live="polite"
        className={
          state.status === "error"
            ? "min-h-6 text-[0.875rem] font-medium text-urgent-700"
            : "min-h-6 text-[0.875rem] text-brand-800"
        }
      >
        {state.message ?? ""}
      </p>

      <div key={attempt} className="space-y-6">
        <section aria-labelledby="instrument-heading" className="space-y-4">
          <h3
            id="instrument-heading"
            className="text-[0.9375rem] font-semibold text-ink-950"
          >
            The instrument, as printed
          </h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              name="method"
              label="Paid by"
              required
              error={errors.method}
              defaultValue={prior("method", "pay_order")}
              placeholder="Choose…"
              options={[
                { value: "pay_order", label: "Pay order" },
                { value: "cheque", label: "Cheque" },
              ]}
              hint="Cash cannot be receipted here: it has no drawee bank, so the control the form builds in cannot be performed on it."
            />
            <TextField
              name="receivedOn"
              label="Date received"
              type="date"
              required
              defaultValue={prior("receivedOn", today)}
              error={errors.receivedOn}
              hint="The date in the cashier block, which need not be today."
            />
            <TextField
              name="draweeBankName"
              label="Bank on the instrument"
              required
              error={errors.draweeBankName}
              maxLength={160}
              defaultValue={prior("draweeBankName")}
              placeholder="Habib Bank Limited"
            />
            <TextField
              name="draweeBranch"
              label="Issuing branch"
              error={errors.draweeBranch}
              maxLength={160}
              defaultValue={prior("draweeBranch")}
              placeholder="Gulberg III, Lahore"
            />
            <TextField
              name="instrumentNo"
              label="Instrument number"
              required
              error={errors.instrumentNo}
              maxLength={40}
              defaultValue={prior("instrumentNo")}
              hint="Exactly as printed, leading zeros included."
            />
            <TextField
              name="instrumentDate"
              label="Instrument date"
              type="date"
              required
              defaultValue={prior("instrumentDate")}
              error={errors.instrumentDate}
            />
            <TextField
              name="instrumentAmount"
              label="Amount on the instrument"
              required
              inputMode="numeric"
              error={errors.instrumentAmount}
              defaultValue={prior("instrumentAmount", amountOwed)}
              hint={`${feeLabel}: ${amountOwed} ${currency} owed.`}
            />
            <SelectField
              name="instrumentCurrency"
              label="Currency"
              required
              error={errors.instrumentCurrency}
              defaultValue={prior(
                "instrumentCurrency",
                currency === "USD" ? "USD" : "PKR",
              )}
              options={[
                { value: "PKR", label: "PKR" },
                { value: "USD", label: "USD" },
              ]}
            />
            <div className="sm:col-span-2">
              <TextField
                name="accountTitle"
                label="Account title on the instrument"
                error={errors.accountTitle}
                maxLength={200}
                defaultValue={prior("accountTitle")}
                hint="Whose account the pay order was drawn on, where the instrument names it."
              />
            </div>
          </div>
        </section>

        <section aria-labelledby="certificate-heading" className="space-y-4">
          <h3
            id="certificate-heading"
            className="text-[0.9375rem] font-semibold text-ink-950"
          >
            The account-maintenance certificate, as attached
          </h3>
          <p className="text-[0.875rem] text-stone-600">
            Prefilled from what the applicant declared. Correct it against the
            certificate itself — what is stored here is one half of the
            comparison, and it must be what the paper says rather than what the
            form said.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="certificateBankName"
              label="Bank on the certificate"
              error={errors.certificateBankName}
              maxLength={160}
              defaultValue={prior("certificateBankName", declared.bankName)}
            />
            <TextField
              name="certificateBranch"
              label="Branch on the certificate"
              error={errors.certificateBranch}
              maxLength={160}
              defaultValue={prior("certificateBranch", declared.bankBranch)}
            />
            <TextField
              name="certificateAccountTitle"
              label="Account title on the certificate"
              error={errors.certificateAccountTitle}
              maxLength={200}
              defaultValue={prior("certificateAccountTitle", declared.firmName)}
            />
            <TextField
              name="certificateIssuedOn"
              label="Certificate issued on"
              type="date"
              defaultValue={prior("certificateIssuedOn")}
              error={errors.certificateIssuedOn}
              hint="The form asks for one no older than three months."
            />
          </div>
        </section>

        <section aria-labelledby="verdict-heading" className="space-y-4">
          <h3
            id="verdict-heading"
            className="text-[0.9375rem] font-semibold text-ink-950"
          >
            Your verdict
          </h3>

          <ChoiceGroup
            name="bankMatchVerdict"
            legend="Is the pay order drawn on the account the certificate is for?"
            required
            error={errors.bankMatchVerdict}
            selected={was?.bankMatchVerdict ? [was.bankMatchVerdict] : []}
            hint="This is what approval is guarded on. The system's own comparison is advisory and is recorded beside your answer, not instead of it."
            options={[
              { value: "match", label: "Yes — same account" },
              { value: "mismatch", label: "No — a different account" },
            ]}
          />

          <TextAreaField
            name="bankMatchNote"
            label="Note"
            error={errors.bankMatchNote}
            maxLength={400}
            rows={3}
            defaultValue={prior("bankMatchNote")}
            hint="Required if you record a mismatch, or if you record a match the system read differently. This is what an auditor reads instead of the comparison."
          />

          {/* Shown only once the near-duplicate refusal has come back. On a
              blank form, "is this a different instrument?" is a question about
              nothing, and a field that is always present is a field that gets
              filled in by habit. */}
          {errors.duplicateNote && (
            <TextAreaField
              name="duplicateNote"
              label="This number and date are already receipted — what did you check?"
              required
              rows={2}
              maxLength={400}
              error={errors.duplicateNote}
              defaultValue={prior("duplicateNote")}
              hint="Kept apart from the bank-match note, because it answers a different question: whether the Chamber has seen this piece of paper before."
            />
          )}

          <TextAreaField
            name="varianceReason"
            label="If the amount differs from the fee owed, why is it being accepted?"
            error={errors.varianceReason}
            maxLength={300}
            rows={2}
            defaultValue={prior("varianceReason")}
            hint="Class is self-declared, so a pay order drawn for the wrong one of the six published amounts is routine. Leave blank when the amount agrees."
          />
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-stone-200 pt-5">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {pending ? "Receipting…" : "Receipt and issue a number"}
        </button>
        <p className="text-[0.8125rem] text-stone-600">
          The receipt number is allocated by the Chamber, not typed here.
        </p>
      </div>
    </form>
  );
}
