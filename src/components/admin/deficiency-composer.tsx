"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export interface ComposerDocumentType {
  readonly code: string;
  readonly label: string;
}

export interface ComposerSubject {
  /** `company`, or `director:<id>`. */
  readonly value: string;
  readonly label: string;
}

export interface ComposerRow {
  /** Pre-filled from a failed checklist item, or blank. */
  readonly checklistItemCode: string | null;
  readonly fromItemLabel: string | null;
  readonly instruction: string;
  readonly documentTypeCode: string;
  readonly subject: string;
}

/**
 * Returning an application, as a list of things to do.
 *
 * The rows are the whole point. Each one is simultaneously the sentence the
 * applicant reads, the edit permission they are granted, and the line the
 * officer checks off when they come back — so a prose "please correct the
 * attached" is not an option here, and neither is a free-text email with a
 * separate hidden list of what it unlocked.
 *
 * Rows that came from a failed checklist item arrive pre-filled with the
 * officer's own note and the document type the item was about, because that is
 * the common case and retyping it invites a different sentence from the one
 * recorded against the item. They stay editable: the note was written for the
 * record and this is written for the applicant, and those are sometimes not
 * the same words.
 *
 * Three blank rows follow. More rows than most returns need, rather than an
 * "add another" button, because the alternative is client-side list state on a
 * screen that otherwise has none — and a row left blank is simply dropped.
 */
export function DeficiencyComposer({
  applicationId,
  rows,
  documentTypes,
  subjects,
  defaultWorkingDays,
  action,
}: {
  applicationId: number;
  rows: readonly ComposerRow[];
  documentTypes: readonly ComposerDocumentType[];
  subjects: readonly ComposerSubject[];
  defaultWorkingDays: number;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="applicationId" value={applicationId} />

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

      <div>
        <label
          htmlFor="deficiency-summary"
          className="block text-[0.8125rem] font-medium text-ink-800"
        >
          Covering note
          <span className="ml-2 font-normal text-stone-600">
            Optional. Appears above the list in the applicant&rsquo;s email.
          </span>
        </label>
        <textarea
          id="deficiency-summary"
          name="summary"
          rows={2}
          maxLength={1000}
          disabled={pending}
          className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-[0.9375rem] text-ink-900 placeholder:text-stone-500 focus-visible:border-ink-500 disabled:bg-stone-50"
          placeholder="Two documents need replacing before verification can continue."
        />
      </div>

      <ol className="space-y-3">
        {rows.map((row, index) => (
          <Row
            key={`${row.checklistItemCode ?? "blank"}-${index}`}
            row={row}
            index={index}
            documentTypes={documentTypes}
            subjects={subjects}
            disabled={pending}
          />
        ))}
      </ol>

      <div className="flex flex-wrap items-end gap-4 border-t border-stone-200 pt-5">
        <div>
          <label
            htmlFor="respond-by"
            className="block text-[0.8125rem] font-medium text-ink-800"
          >
            Working days to respond
          </label>
          <input
            id="respond-by"
            name="respondByWorkingDays"
            type="number"
            min={1}
            max={60}
            defaultValue={defaultWorkingDays}
            disabled={pending}
            className="mt-1 h-10 w-24 rounded-lg border border-stone-300 bg-white px-3 text-[0.9375rem] text-ink-900 tabular-nums focus-visible:border-ink-500 disabled:bg-stone-50"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
        >
          {pending ? "Sending…" : "Return to the applicant"}
        </button>

        <p className="text-[0.8125rem] text-stone-600">
          The processing clock pauses until they reply, so the days they take
          are not counted against the Chamber&rsquo;s promise.
        </p>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */

function Row({
  row,
  index,
  documentTypes,
  subjects,
  disabled,
}: {
  row: ComposerRow;
  index: number;
  documentTypes: readonly ComposerDocumentType[];
  subjects: readonly ComposerSubject[];
  disabled: boolean;
}) {
  const instructionId = `item-instruction-${index}`;
  const typeId = `item-type-${index}`;
  const subjectId = `item-subject-${index}`;

  return (
    <li className="rounded-xl border border-stone-200 bg-white p-5">
      <input
        type="hidden"
        name="item.checklistItem"
        value={row.checklistItemCode ?? ""}
      />
      {/* The kind is derived from whether a document type was chosen, so the
          officer never has to answer "is this a document item?" — a question
          about our data model rather than about their work. The server
          degrades a document row with no type to a plain instruction. */}
      <input type="hidden" name="item.kind" value="document" />
      <input type="hidden" name="item.fieldName" value="" />

      {row.fromItemLabel && (
        <p className="mb-2 text-[0.75rem] font-semibold tracking-wide text-stone-500 uppercase">
          From item {row.fromItemLabel}
        </p>
      )}

      <label
        htmlFor={instructionId}
        className="block text-[0.8125rem] font-medium text-ink-800"
      >
        What the applicant must do
      </label>
      <textarea
        id={instructionId}
        name="item.instruction"
        defaultValue={row.instruction}
        rows={2}
        maxLength={600}
        disabled={disabled}
        className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-[0.9375rem] text-ink-900 placeholder:text-stone-500 focus-visible:border-ink-500 disabled:bg-stone-50"
        placeholder={
          index === 0
            ? "Re-upload the CNIC of B. Partner: the right edge is cut off."
            : "Leave blank to skip this row."
        }
      />

      <div className="mt-3 flex flex-wrap gap-4">
        <div>
          <label
            htmlFor={typeId}
            className="block text-[0.8125rem] font-medium text-ink-800"
          >
            Document to re-upload
          </label>
          <select
            id={typeId}
            name="item.documentType"
            defaultValue={row.documentTypeCode}
            disabled={disabled}
            className="mt-1 h-10 rounded-lg border border-stone-300 bg-white px-3 text-[0.9375rem] text-ink-900 focus-visible:border-ink-500 disabled:bg-stone-50"
          >
            <option value="">None — an instruction to read</option>
            {documentTypes.map((type) => (
              <option key={type.code} value={type.code}>
                {type.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor={subjectId}
            className="block text-[0.8125rem] font-medium text-ink-800"
          >
            Whose
          </label>
          <select
            id={subjectId}
            name="item.subjectKindAndId"
            defaultValue={row.subject}
            disabled={disabled}
            className="mt-1 h-10 rounded-lg border border-stone-300 bg-white px-3 text-[0.9375rem] text-ink-900 focus-visible:border-ink-500 disabled:bg-stone-50"
          >
            <option value="">Anyone&rsquo;s — all of them</option>
            {subjects.map((subject) => (
              <option key={subject.value} value={subject.value}>
                {subject.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </li>
  );
}
