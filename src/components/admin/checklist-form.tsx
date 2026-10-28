"use client";

import { useActionState } from "react";
import Link from "next/link";
import { IDLE, type ActionState } from "@/lib/action-state";
import { affirmativeLabel, negativeLabel } from "@/membership/checklist";
import type { ChecklistItemView } from "@/membership/verification";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * The thirteen items, as one form.
 *
 * One form and not thirteen, because an officer works down the page and then
 * saves — thirteen separate submissions would mean thirteen round trips and
 * thirteen chances to lose a half-typed note to a reload. The two buttons at
 * the bottom submit the same form with a different `intent`: save and keep
 * working, or save and sign the round off.
 *
 * The answers are phrased in each item's own polarity, which is the single
 * most important thing on this screen. Items 1 and 13 of the printed form are
 * defects — a tick blocks — so a control labelled "Satisfactory" against
 * "Signatures do not match with CNIC" would be asking the opposite of what it
 * appears to ask. The labels come from `affirmativeLabel`/`negativeLabel` in
 * the shared pure module, and the clearing answer is listed first in both
 * cases so the column of radio buttons means the same thing all the way down.
 *
 * The polarity is deliberately *not* posted. The server reads it from the
 * definitions, so a tampered request cannot record a defect as a pass.
 */
export function ChecklistForm({
  applicationId,
  round,
  items,
  selectedDocumentId,
  action,
  readOnly = false,
}: {
  applicationId: number;
  round: number;
  items: readonly ChecklistItemView[];
  selectedDocumentId: string | null;
  action: Action;
  readOnly?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const fieldErrors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="applicationId" value={applicationId} />

      {/* Always in the DOM, never conditionally inserted: a live region that
          appears at the moment it gains text is not reliably announced. */}
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

      <ol className="space-y-3">
        {items.map((item) => (
          <ChecklistRow
            key={item.code}
            item={item}
            error={fieldErrors[`answer.${item.code}`] ?? null}
            selectedDocumentId={selectedDocumentId}
            disabled={readOnly || pending}
          />
        ))}
      </ol>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3 border-t border-stone-200 pt-5">
          <button
            type="submit"
            name="intent"
            value="save"
            disabled={pending}
            className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400 disabled:opacity-60"
          >
            {pending ? "Saving…" : "Save progress"}
          </button>
          <button
            type="submit"
            name="intent"
            value="complete"
            disabled={pending}
            className="inline-flex h-10 items-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
          >
            {pending ? "Working…" : `Sign off round ${round}`}
          </button>
          <p className="text-[0.8125rem] text-stone-600">
            Signing off is final. A change of mind opens a new round rather than
            editing this one.
          </p>
        </div>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */

function ChecklistRow({
  item,
  error,
  selectedDocumentId,
  disabled,
}: {
  item: ChecklistItemView;
  error: string | null;
  selectedDocumentId: string | null;
  disabled: boolean;
}) {
  const errorId = `error-${item.code}`;
  const hintId = `hint-${item.code}`;
  const noteId = `note-${item.code}`;
  const labelId = `label-${item.code}`;

  // The clearing answer first, in both polarities, so the shape of the column
  // carries meaning even before the labels are read.
  const options =
    item.polarity === "defect"
      ? ([
          { value: "no", label: negativeLabel("defect") },
          { value: "yes", label: affirmativeLabel("defect") },
          { value: "na", label: "Not applicable" },
        ] as const)
      : ([
          { value: "yes", label: affirmativeLabel("compliance") },
          { value: "no", label: negativeLabel("compliance") },
          { value: "na", label: "Not applicable" },
        ] as const);

  const selected =
    item.outcome === null
      ? item.suggestNotApplicable
        ? "na"
        : null
      : item.outcome === "not_applicable"
        ? "na"
        : item.marked
          ? "yes"
          : "no";

  const failing = item.outcome === "fail";

  return (
    <li
      className={
        failing
          ? "rounded-xl border border-urgent-300 bg-urgent-50/40 p-5"
          : "rounded-xl border border-stone-200 bg-white p-5"
      }
    >
      <input type="hidden" name="code" value={item.code} />

      <fieldset>
        <legend className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span id={labelId} className="text-[0.9375rem] font-semibold text-ink-950">
            <span className="mr-2 inline-block min-w-5 text-stone-500 tabular-nums">
              {item.ordinal}.
            </span>
            {item.labelEn}
          </span>
          {item.polarity === "defect" && (
            <span className="rounded border border-ink-300 bg-ink-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-ink-800 uppercase">
              Finding a defect blocks
            </span>
          )}
        </legend>

        {/* An explicit radiogroup around the options rather than aria on the
            inputs: `aria-invalid` and `aria-describedby` belong to the group —
            the item is deficient, not one of its three buttons — and a radio
            does not support `aria-invalid` at all. */}
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [error ? errorId : null, item.systemBecause ? hintId : null]
              .filter(Boolean)
              .join(" ") || undefined
          }
          className="mt-3 flex flex-wrap gap-x-6 gap-y-2"
        >
          {options.map((option) => (
            <label
              key={option.value}
              className="inline-flex items-center gap-2 text-[0.9375rem] text-ink-800"
            >
              <input
                type="radio"
                name={`answer.${item.code}`}
                value={option.value}
                defaultChecked={selected === option.value}
                disabled={disabled}
                className="size-4 accent-ink-900"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      {item.systemBecause && (
        <p id={hintId} className="mt-3 text-[0.8125rem] text-stone-600">
          <span className="font-semibold text-ink-800">
            {item.systemVerdict === "fail"
              ? "The system found a problem: "
              : item.systemVerdict === "pass"
                ? "The system checked: "
                : "For information: "}
          </span>
          {item.systemBecause}
        </p>
      )}

      {error && (
        <p id={errorId} className="mt-3 text-[0.8125rem] font-medium text-urgent-700">
          {error}
        </p>
      )}

      <div className="mt-4">
        <label
          htmlFor={noteId}
          className="block text-[0.8125rem] font-medium text-ink-800"
        >
          Note
          <span className="ml-2 font-normal text-stone-600">
            Required when the item is deficient. Sent to the applicant as
            written.
          </span>
        </label>
        <textarea
          id={noteId}
          name={`note.${item.code}`}
          defaultValue={item.note ?? ""}
          rows={2}
          maxLength={500}
          disabled={disabled}
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-[0.9375rem] text-ink-900 placeholder:text-stone-500 focus-visible:border-ink-500 disabled:bg-stone-50"
          placeholder={
            item.polarity === "defect"
              ? "What the defect is, and where you found it."
              : "What is missing or wrong, and what would satisfy it."
          }
        />
      </div>

      {item.candidateDocuments.length > 0 && (
        <fieldset className="mt-4">
          <legend className="text-[0.8125rem] font-medium text-ink-800">
            Which document you looked at
            {item.requiresDocumentView && (
              <span className="ml-2 font-normal text-stone-600">
                This item cannot be decided until you have opened one.
              </span>
            )}
          </legend>

          <ul className="mt-2 space-y-1.5">
            {item.candidateDocuments.map((document) => (
              <li key={document.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="inline-flex items-center gap-2 text-[0.875rem] text-ink-800">
                  <input
                    type="checkbox"
                    name={`doc.${item.code}`}
                    value={document.id}
                    defaultChecked={item.linkedDocumentIds.includes(document.id)}
                    disabled={disabled}
                    className="size-4 accent-ink-900"
                  />
                  <span className="truncate">{document.label}</span>
                </label>

                {document.subjectLabel && (
                  <span className="text-[0.8125rem] text-stone-600">
                    {document.subjectLabel}
                  </span>
                )}

                <Link
                  href={`?doc=${document.id}`}
                  scroll={false}
                  aria-current={selectedDocumentId === document.id ? "true" : undefined}
                  className={
                    selectedDocumentId === document.id
                      ? "text-[0.8125rem] font-semibold text-ink-900"
                      : "text-[0.8125rem] font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
                  }
                >
                  {selectedDocumentId === document.id ? "Showing" : "Show"}
                </Link>

                <span
                  className={
                    document.viewed
                      ? "text-[0.75rem] text-stone-600"
                      : "text-[0.75rem] text-stone-500"
                  }
                >
                  {document.viewed ? "opened" : "not opened yet"}
                </span>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </li>
  );
}
