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
 * The approval block from page 2 of the printed form.
 *
 * Three forms rather than three buttons, and the order they appear in is
 * deliberate: grant, send back, refuse. The destructive option is last because
 * the common case is the first, and because "Reject" sitting beside "Approve"
 * at the same visual weight is how a tired approver at five o'clock refuses
 * somebody by accident.
 */

function Status({ state }: { state: ActionState }) {
  return (
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
  );
}

export function GrantForm({
  applicationId,
  version,
  reference,
  firmName,
  validUntil,
  yearLabel,
  action,
}: {
  applicationId: number;
  version: number;
  reference: string;
  firmName: string;
  validUntil: string;
  yearLabel: string;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="version" value={version} />

      <Status state={state} />

      {/*
        What the grant will actually do, before it is done. The expiry is the
        surprising part and it is stated here rather than discovered in the
        email: under the form's rule a grant in February buys weeks, not a
        year, and the approver should see that at the moment they decide.
      */}
      <div className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-[0.9375rem] text-ink-900">
        <p>
          Granting issues a membership number to{" "}
          <span className="font-semibold">{firmName}</span> and starts
          membership year <span className="font-semibold">{yearLabel}</span>,
          valid until <span className="font-semibold">{validUntil}</span>.
        </p>
        <p className="mt-2 text-[0.875rem] text-stone-600">
          Membership expires 31 March whatever the date of grant, so this is the
          end of the current year and not twelve months from today. The number
          is allocated once and is never reused, even if the approval is later
          reversed.
        </p>
      </div>

      <TextField
        name="confirm"
        label={`Type ${reference} to confirm`}
        required
        autoComplete="off"
        error={errors.confirm}
        hint="Typed rather than ticked: a number issued to the wrong firm cannot be taken back, only cancelled."
      />

      <TextAreaField
        name="note"
        label="Note for the record"
        rows={2}
        maxLength={600}
        error={errors.note}
        hint="Optional. A clear file needs no explanation; this is for the one that needed a judgement."
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center rounded-lg bg-brand-800 px-5 text-sm font-semibold text-white hover:bg-brand-900 disabled:opacity-60"
      >
        {pending ? "Granting…" : "Grant membership"}
      </button>
    </form>
  );
}

export function ReturnForm({
  applicationId,
  version,
  action,
}: {
  applicationId: number;
  version: number;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="version" value={version} />

      <Status state={state} />

      <TextAreaField
        name="reason"
        label="What the officer needs to put right"
        required
        rows={3}
        maxLength={600}
        error={errors.reason}
        hint="This goes to the verification queue, not to the applicant. The processing clock keeps running: the file is back in the Chamber's hands."
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400 disabled:opacity-60"
      >
        {pending ? "Sending back…" : "Send back for verification"}
      </button>
    </form>
  );
}

export function RefuseForm({
  applicationId,
  version,
  action,
}: {
  applicationId: number;
  version: number;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="version" value={version} />

      <Status state={state} />

      <TextAreaField
        name="reason"
        label="Why the application is refused"
        required
        rows={3}
        maxLength={600}
        error={errors.reason}
        hint="The applicant will be told this. Write it as the sentence they will read, not as a note to a colleague."
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center rounded-lg border border-urgent-300 bg-white px-4 text-sm font-medium text-urgent-800 hover:border-urgent-600 disabled:opacity-60"
      >
        {pending ? "Recording…" : "Refuse the application"}
      </button>
    </form>
  );
}

/**
 * The super-admin's exception, and the reason it is a form and not a toggle.
 *
 * It names a person, a guard and a reason. Every one of those is there because
 * the alternative to an awkward, recorded exception is a shared login — and a
 * shared login destroys the audit log that the rest of this module exists to
 * keep honest.
 */
export function WaiverForm({
  applicationId,
  candidates,
  waivableGuards,
  action,
}: {
  applicationId: number;
  candidates: readonly { id: number; name: string }[];
  waivableGuards: readonly { code: string; label: string }[];
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.fieldErrors ?? {};

  if (waivableGuards.length === 0) {
    return (
      <p className="text-[0.9375rem] text-ink-700">
        Nothing to waive: no separation-of-duties guard is blocking this
        application.
      </p>
    );
  }

  if (candidates.length === 0) {
    return (
      <p className="text-[0.9375rem] text-ink-700">
        No approver to waive for. A waiver is granted to one named person, and
        nobody other than you holds the approval permission.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />

      <Status state={state} />

      <ChoiceGroup
        name="guard"
        legend="Which guard"
        required
        error={errors.guard}
        // No default. Which control is being switched off is the decision, and
        // preselecting one would make it the one that gets waived.
        selected={[]}
        options={waivableGuards.map((guard) => ({
          value: guard.code,
          label: guard.label,
        }))}
      />

      <SelectField
        name="grantedFor"
        label="For whom"
        required
        error={errors.grantedFor}
        hint="One person. A different approver gains nothing from this waiver, and you cannot grant one to yourself."
        options={candidates.map((person) => ({
          value: String(person.id),
          label: person.name,
        }))}
      />

      <TextAreaField
        name="reason"
        label="Why this exception is being made"
        required
        rows={3}
        maxLength={600}
        error={errors.reason}
        hint="Written for an auditor reading it years from now without the context you have today."
      />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-10 items-center rounded-lg border border-urgent-300 bg-white px-4 text-sm font-medium text-urgent-800 hover:border-urgent-600 disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record the waiver"}
      </button>
    </form>
  );
}
