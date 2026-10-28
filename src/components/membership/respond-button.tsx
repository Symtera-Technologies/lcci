"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { IDLE, type ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * "I have attended to everything" — the applicant's way back to the Chamber.
 *
 * A client component for two reasons. `withAction` returns a
 * `(previousState, formData)` reducer, which a plain `<form action>` cannot
 * take; and the refusal is the interesting result. If a named document has not
 * arrived the server says which ones, and that sentence has to land somewhere
 * the applicant will read it rather than being thrown.
 *
 * On success it refreshes rather than redirects. This is already the right
 * page — what changes is that the deficiency is answered and the stage is
 * "under review" — so re-rendering it in place avoids a navigation that would
 * look like being sent somewhere else.
 *
 * The button is deliberately never disabled. `outstanding` only changes the
 * note under it, because the applicant may have good reason to believe they
 * are finished — a document the Chamber already holds, a figure they conclude
 * was right as filed — and the server refuses with a list either way. A
 * greyed-out button that explains nothing is worse than a refusal that says
 * exactly what is still missing.
 */
export function RespondButton({
  applicationId,
  action,
  outstanding,
}: {
  applicationId: number;
  action: Action;
  /** How many named items the page can see are still unanswered. */
  outstanding: number;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData) => {
      const result = await action(previous, formData);
      if (result.status === "ok") router.refresh();
      return result;
    },
    IDLE,
  );

  return (
    <form action={formAction} className="mt-6">
      <input type="hidden" name="applicationId" value={applicationId} />

      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center rounded-lg bg-brand-800 px-5 text-[0.9375rem] font-semibold text-white hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {pending ? "Sending…" : "Send back to the Chamber"}
      </button>

      {/* Always in the DOM, never conditionally inserted: a live region that
          appears at the moment it gains text is not reliably announced. */}
      <p
        role="status"
        aria-live="polite"
        className={
          state.status === "error"
            ? "mt-3 max-w-prose text-[0.875rem] font-medium text-urgent-700"
            : "mt-3 max-w-prose text-[0.875rem] text-stone-600"
        }
      >
        {state.message ??
          (outstanding > 0
            ? `${outstanding} item${outstanding === 1 ? "" : "s"} above still ${
                outstanding === 1 ? "looks" : "look"
              } unanswered. You can still send it back, and the Chamber will tell you if anything is missing.`
            : "The Chamber will pick your application up again where it left off.")}
      </p>
    </form>
  );
}
