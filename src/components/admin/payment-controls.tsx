"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import { ChoiceGroup, TextAreaField } from "@/components/membership/fields";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * The two things that happen to a payment *after* it is receipted.
 *
 * Both are small forms rather than buttons, because both require a sentence
 * and neither should be a single click. Revising a verdict changes what
 * approval is guarded on; a dishonour takes away a membership. A button that
 * does either without asking what happened leaves the record unreadable six
 * months later, which is the failure mode the whole audit trail exists to
 * avoid.
 */

export function ReviseVerdictForm({
  applicationId,
  payOrderId,
  current,
  action,
}: {
  applicationId: number;
  payOrderId: number;
  current: "match" | "mismatch";
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="payOrderId" value={payOrderId} />

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

      <ChoiceGroup
        name="verdict"
        legend="Revised verdict"
        required
        error={errors.verdict}
        // Prefilled with what is recorded, because the common case is changing
        // the note on an unchanged verdict — a mismatch that has now been
        // explained, say — and retyping an unchanged answer invites a slip.
        selected={[current]}
        options={[
          { value: "match", label: "Same account" },
          { value: "mismatch", label: "A different account" },
        ]}
      />

      <TextAreaField
        name="note"
        label="What changed"
        required
        rows={3}
        maxLength={400}
        error={errors.note}
        hint="The previous verdict and note stay in the audit log, so this reads as a sequence of judgements rather than replacing one."
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400 disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record the revised verdict"}
      </button>
    </form>
  );
}

export function DishonourForm({
  applicationId,
  paymentId,
  version,
  receiptNo,
  action,
}: {
  applicationId: number;
  paymentId: number;
  version: number;
  receiptNo: string | null;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="paymentId" value={paymentId} />
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

      <TextAreaField
        name="reason"
        label={`Why ${receiptNo ?? "this receipt"} did not clear`}
        required
        rows={2}
        maxLength={300}
        error={errors.reason}
        hint="The bank's own wording. This is what the member is shown and what finance reconciles against."
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center rounded-lg border border-urgent-600 bg-white px-4 text-sm font-medium text-urgent-700 hover:bg-urgent-50 disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record a dishonour"}
      </button>
    </form>
  );
}
