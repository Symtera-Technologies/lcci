"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * Assign to me, or release.
 *
 * Two separate forms rather than one with a hidden intent field, so each
 * button submits only the thing it says. One `role="status"` region between
 * them, always in the DOM, because a live region inserted at the moment it
 * gains text is not reliably announced.
 */
export function AssignmentControls({
  applicationId,
  claim,
  release,
  mine,
  assignedToName,
}: {
  applicationId: number;
  claim: Action;
  release: Action;
  mine: boolean;
  assignedToName: string | null;
}) {
  const [claimState, claimFormAction, claiming] = useActionState(claim, IDLE);
  const [releaseState, releaseFormAction, releasing] = useActionState(
    release,
    IDLE,
  );
  const state = claimState.status !== "idle" ? claimState : releaseState;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {mine ? (
        <form action={releaseFormAction}>
          <input type="hidden" name="applicationId" value={applicationId} />
          <button
            type="submit"
            disabled={releasing}
            className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400 disabled:opacity-60"
          >
            {releasing ? "Releasing…" : "Release"}
          </button>
        </form>
      ) : (
        <form action={claimFormAction}>
          <input type="hidden" name="applicationId" value={applicationId} />
          <button
            type="submit"
            disabled={claiming || assignedToName !== null}
            className="inline-flex h-10 items-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-60"
          >
            {claiming ? "Assigning…" : "Assign to me"}
          </button>
        </form>
      )}

      <p
        role="status"
        className={
          state.status === "error"
            ? "text-[0.8125rem] font-medium text-urgent-700"
            : "text-[0.8125rem] text-stone-600"
        }
      >
        {state.message ?? ""}
      </p>
    </div>
  );
}
