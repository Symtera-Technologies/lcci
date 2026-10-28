"use client";

import { useActionState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  acceptDeclarationAction,
  submitAction,
} from "@/app/(portal)/membership/apply/actions";
import {
  APPLICATION_UNDERTAKING,
  ATTESTATION_NOTE,
  DECLARATION_CLAUSES,
  DECLARATION_HEADING,
  REPRESENTATION_DECLARATION,
} from "@/membership/declaration";
import { SelectField } from "./fields";
import { FieldSet } from "./wizard-chrome";
import { UploadSlot, type UploadSlotProps } from "./document-upload";

/**
 * Step 3: the documents, the declaration, and the submission.
 *
 * The declaration text is rendered from the constants transcribed off the
 * controlled form, and the same text is stored on the row when it is accepted.
 * Showing a summary and storing the full wording — or the reverse — would mean
 * the record of what someone agreed to was not the thing they read.
 */

export interface ReviewProps {
  readonly applicationId: number;
  readonly slots: readonly UploadSlotProps[];
  readonly attesterOptions: readonly { value: string; label: string }[];
  readonly attestingDirectorId: number | null;
  readonly declarationAccepted: boolean;
  readonly blockers: readonly string[];
  readonly missingDocuments: readonly string[];
  readonly readyToSubmit: boolean;
  readonly fieldErrors: Record<string, string>;
}

export function StepReview(props: ReviewProps) {
  return (
    <div className="space-y-12">
      <Documents slots={props.slots} missing={props.missingDocuments} />
      <Declaration {...props} />
      <Submit {...props} />
    </div>
  );
}

function Documents({
  slots,
  missing,
}: {
  slots: readonly UploadSlotProps[];
  missing: readonly string[];
}) {
  const missingSet = new Set(missing);

  return (
    <FieldSet
      title="Documents"
      description="What the Chamber needs depends on the status of your concern. Each file is checked when you upload it, and an officer reviews it after you submit."
      columns={1}
    >
      <div className="space-y-4">
        {slots.length === 0 ? (
          <p className="rounded-lg bg-stone-50 p-4 text-[0.9375rem] text-stone-600">
            Choose the status of your concern on step 1 and the document list will appear
            here.
          </p>
        ) : (
          slots.map((slot) => (
            <UploadSlot
              key={`${slot.documentTypeCode}-${slot.subjectId ?? "company"}`}
              {...slot}
            />
          ))
        )}
      </div>

      {missingSet.size > 0 && (
        <p className="text-[0.8125rem] text-stone-600">
          {missingSet.size} document {missingSet.size === 1 ? "type is" : "types are"} still
          outstanding.
        </p>
      )}
    </FieldSet>
  );
}

function Declaration(props: ReviewProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    acceptDeclarationAction,
    IDLE,
  );
  const errors = state.fieldErrors ?? props.fieldErrors;

  return (
    <form action={formAction}>
      <input type="hidden" name="applicationId" value={props.applicationId} />

      <FieldSet title="Declaration" columns={1}>
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-5 text-[0.9375rem] leading-relaxed text-ink-900">
          <p>{APPLICATION_UNDERTAKING}</p>

          <p className="mt-4 font-semibold">I/We {DECLARATION_HEADING}</p>
          <ol className="mt-2 list-[lower-alpha] space-y-1.5 pl-5">
            {DECLARATION_CLAUSES.map((clause) => (
              <li key={clause}>{clause}</li>
            ))}
          </ol>

          <p className="mt-4">{REPRESENTATION_DECLARATION}</p>
        </div>

        <SelectField
          name="attestingDirectorId"
          label="Who attests to the representation?"
          required
          options={props.attesterOptions}
          defaultValue={props.attestingDirectorId ? String(props.attestingDirectorId) : ""}
          error={errors.attestingDirectorId}
          hint={ATTESTATION_NOTE}
        />

        <label className="flex min-h-11 items-start gap-2.5 text-[0.9375rem] text-ink-900">
          <input
            type="checkbox"
            name="declarationAccepted"
            defaultChecked={props.declarationAccepted}
            aria-invalid={errors.declarationAccepted ? true : undefined}
            className="mt-1 h-4 w-4 shrink-0 accent-brand-700"
          />
          <span>
            I have read the declaration above and I accept it on behalf of the firm.
          </span>
        </label>

        {errors.declarationAccepted && (
          <p className="text-[0.8125rem] text-urgent-700">{errors.declarationAccepted}</p>
        )}
      </FieldSet>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Recording…" : "Record the declaration"}
        </Button>
        <p role="status" aria-live="polite" className="text-[0.8125rem] text-stone-600">
          {props.declarationAccepted && !state.message
            ? "Recorded."
            : state.message}
        </p>
      </div>
    </form>
  );
}

function Submit(props: ReviewProps) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    submitAction,
    IDLE,
  );

  return (
    <form action={formAction} className="border-t border-stone-200 pt-8">
      <input type="hidden" name="applicationId" value={props.applicationId} />

      <h3 className="font-display text-lg font-semibold text-ink-950">Submit</h3>

      {props.blockers.length > 0 ? (
        <div className="mt-4 rounded-xl border border-urgent-200 bg-urgent-50 p-5">
          <p className="flex items-center gap-2 text-sm font-semibold text-urgent-800">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            Not ready yet
          </p>
          <ul className="mt-3 space-y-1.5 text-[0.9375rem] text-ink-900">
            {props.blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-[0.9375rem] text-success-700">
          <Check className="h-4 w-4" aria-hidden />
          Everything the Chamber needs is here.
        </p>
      )}

      <p className="mt-4 max-w-prose text-[0.9375rem] leading-relaxed text-stone-600">
        Submitting assigns your application a reference, records the fee due against it and
        starts the working-day clock for the processing you chose. You will not be able to
        edit the form afterwards unless the Chamber asks you for something.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending || !props.readyToSubmit}>
          {pending ? "Submitting…" : "Submit application"}
        </Button>
        <p
          role="status"
          aria-live="polite"
          className={
            state.status === "error"
              ? "text-[0.8125rem] text-urgent-700"
              : "text-[0.8125rem] text-stone-600"
          }
        >
          {state.message}
        </p>
      </div>
    </form>
  );
}
