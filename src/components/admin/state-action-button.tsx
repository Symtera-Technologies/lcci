"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * One transition, one button, one live region.
 *
 * Every action in this app goes through `withAction`, which returns a
 * `(previousState, formData)` reducer and so cannot be handed to a plain
 * `<form action>` — it needs `useActionState`. That is not a nuisance to work
 * around: the reducer is what turns a refused transition into a *sentence*
 * rather than an exception, and "cannot approve: the pay order's bank does not
 * match the account-maintenance certificate" has to land somewhere the officer
 * will see it.
 *
 * So this is the smallest client component that can render one of those
 * sentences: a button, and a `role="status"` region that is always in the DOM
 * because a live region inserted at the moment it gains text is not reliably
 * announced.
 */
export function StateActionButton({
  applicationId,
  action,
  label,
  pendingLabel,
  note,
  tone = "primary",
}: {
  applicationId: number;
  action: Action;
  label: string;
  pendingLabel: string;
  /** One line under the button on what happens next. */
  note?: string;
  tone?: "primary" | "secondary";
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);

  return (
    <form action={formAction} className="mt-4">
      <input type="hidden" name="applicationId" value={applicationId} />

      <button
        type="submit"
        disabled={pending}
        className={
          tone === "primary"
            ? "inline-flex h-10 items-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
            : "inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400 disabled:opacity-60"
        }
      >
        {pending ? pendingLabel : label}
      </button>

      <p
        role="status"
        aria-live="polite"
        className={
          state.status === "error"
            ? "mt-2 text-[0.8125rem] font-medium text-urgent-700"
            : "mt-2 text-[0.8125rem] text-stone-600"
        }
      >
        {state.message ?? note ?? ""}
      </p>
    </form>
  );
}
