"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import type { ContentStatus } from "@/db/schema";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * One transition per button, in the only form on the page that moves an item.
 *
 * Separate from the editor's form, and for the same reason
 * `ContentDeleteForm` is: a save and a publish are different decisions, and a
 * single form containing both would make "Save" and "Publish" two submit
 * buttons where pressing Enter in the headline field picks whichever comes
 * first in the markup.
 *
 * Several submit buttons *within* this form is safe, because the only control
 * here that takes text is a `textarea`, and Enter in a textarea inserts a
 * newline rather than submitting. Each button carries its own `code`, so the
 * browser sends exactly the move that was clicked.
 *
 * **The buttons come from the same table the server enforces.** The page asks
 * `availableContentTransitions` what this actor may do to this item, so a
 * button that renders is one that works. Nothing is drawn disabled with a
 * tooltip: a reviewer who cannot publish in this department is not helped by a
 * dead Publish button, and the status line above already says where the item
 * stands.
 */
export interface WorkflowChoice {
  readonly code: string;
  readonly label: string;
  readonly to: ContentStatus;
}

export function ContentWorkflowControls({
  kind,
  id,
  version,
  choices,
  action,
}: {
  kind: string;
  id: number;
  version: number;
  choices: readonly WorkflowChoice[];
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  /**
   * Rendered on both branches below, and that is the whole point.
   *
   * A successful move usually *removes* the actor's remaining moves — a
   * department editor submitting for review has nothing further to do with
   * the item — so the branch with no buttons is exactly the branch that most
   * often has something to say. Returning early from it swallowed the
   * confirmation for the commonest successful action in the CMS, which is how
   * this was found: the status pill changed and nothing else did.
   */
  const message = (
    <>
      {state.status === "error" && state.message && (
        <p
          role="alert"
          className="mb-3 max-w-2xl rounded-lg border border-urgent-600/50 bg-urgent-50 px-4 py-3 text-[0.9375rem] text-urgent-800"
        >
          {state.message}
        </p>
      )}

      {state.status === "ok" && state.message && (
        <p
          role="status"
          className="mb-3 max-w-2xl rounded-lg border border-success-600/50 bg-success-50 px-4 py-3 text-[0.9375rem] text-success-800"
        >
          {state.message}
        </p>
      )}
    </>
  );

  if (choices.length === 0) {
    return (
      <div className="mt-3">
        {message}
        <p className="max-w-prose text-[0.875rem] leading-relaxed text-stone-600">
          This account cannot move this item from where it is. Someone with the
          matching role can take it from here.
        </p>
      </div>
    );
  }

  const needsNote = choices.some((choice) => choice.code === "return_to_draft");
  const noteError = state.fieldErrors?.note;

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="content_type" value={kind} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />

      {message}

      {needsNote && (
        <div className="mb-4 max-w-2xl">
          <label
            htmlFor="review-note"
            className="block text-[0.875rem] font-medium text-ink-900"
          >
            Note for the author
          </label>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-stone-600">
            Required when sending back, and the only thing they will see. Say
            what needs changing.
          </p>
          <textarea
            id="review-note"
            name="note"
            rows={3}
            maxLength={2000}
            aria-invalid={noteError ? true : undefined}
            aria-describedby={noteError ? "review-note-error" : undefined}
            className="mt-2 w-full rounded-lg border border-stone-300 px-3 py-2 text-[0.9375rem] text-ink-950 focus:border-brand-800 focus:outline-2 focus:outline-offset-2 focus:outline-brand-800 aria-[invalid]:border-urgent-600"
          />
          {noteError && (
            <p id="review-note-error" className="mt-1 text-[0.8125rem] text-urgent-800">
              {noteError}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {choices.map((choice) => (
          <button
            key={choice.code}
            type="submit"
            name="code"
            value={choice.code}
            disabled={pending}
            className={
              choice.to === "published"
                ? "rounded-lg bg-brand-800 px-5 py-2.5 text-[0.9375rem] font-medium text-white hover:bg-brand-900 disabled:opacity-60"
                : choice.to === "archived"
                  ? "rounded-lg border border-urgent-600 bg-white px-4 py-2.5 text-[0.9375rem] font-medium text-urgent-800 hover:bg-urgent-50 disabled:opacity-60"
                  : "rounded-lg border border-stone-300 bg-white px-4 py-2.5 text-[0.9375rem] font-medium text-ink-900 hover:bg-stone-50 disabled:opacity-60"
            }
          >
            {choice.label}
          </button>
        ))}
      </div>
    </form>
  );
}
