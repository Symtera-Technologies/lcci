"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * Deleting a draft, as its own form.
 *
 * Separate from the editor's form rather than a second button inside it: a
 * form with two submit buttons submits the first one when Enter is pressed in
 * a text field, and the first one must never be the destructive one.
 *
 * No version field. `deleteDraftContentItem` guards on the status instead —
 * only a draft that has never been published can go — and asking for a version
 * here would imply a concurrency check that function does not make.
 *
 * On success the action redirects, so the only thing this renders is a
 * refusal: the draft was published while the page was open, or the actor's
 * department scope changed.
 */
export function ContentDeleteForm({
  kind,
  id,
  action,
}: {
  kind: string;
  id: number;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="content_type" value={kind} />
      <input type="hidden" name="id" value={id} />

      {state.status === "error" && state.message && (
        <p
          role="alert"
          className="mb-3 max-w-2xl rounded-lg border border-urgent-600/50 bg-urgent-50 px-4 py-3 text-[0.9375rem] text-urgent-800"
        >
          {state.message}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-urgent-600 bg-white px-4 py-2 text-[0.875rem] font-medium text-urgent-800 hover:bg-urgent-50 disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Delete draft"}
      </button>
    </form>
  );
}
