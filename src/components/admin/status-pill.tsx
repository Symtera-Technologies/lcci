import { cn } from "@/lib/cn";
import type { ApplicationState } from "@/db/schema";

/**
 * The workflow status badge.
 *
 * Twelve internal states, each with its own label and its own colour — but the
 * colour is never the only signal. Every pill carries words, and the SLA
 * column carries "3 days late" in text rather than relying on a red row,
 * because a status system that encodes meaning in hue alone fails for the
 * eight percent of men who cannot separate these particular greens and reds,
 * and fails completely in a printout of the queue.
 *
 * The palette only had four `success` and three `urgent` steps, so the pairs
 * below are chosen against the measured tokens rather than reaching for a
 * near-miss: every combination clears 4.5:1 for its text and 3:1 for its
 * border, which is what WCAG 2.2 asks of a bounded control.
 */
const STYLES: Record<ApplicationState, { label: string; className: string }> = {
  DRAFT: {
    label: "Draft",
    className: "border-stone-300 bg-stone-100 text-ink-700",
  },
  SUBMITTED: {
    label: "Submitted",
    className: "border-brand-600/40 bg-brand-50 text-brand-800",
  },
  UNDER_VERIFICATION: {
    label: "Verifying",
    className: "border-brand-600/40 bg-brand-50 text-brand-800",
  },
  VERIFIED: {
    label: "Verified",
    className: "border-success-600/40 bg-success-50 text-success-800",
  },
  PENDING_APPROVAL: {
    label: "For approval",
    className: "border-success-600/40 bg-success-50 text-success-800",
  },
  AWAITING_APPLICANT: {
    label: "Need info",
    className: "border-urgent-600/40 bg-urgent-50 text-urgent-800",
  },
  APPROVED: {
    label: "Approved",
    className: "border-success-700/50 bg-success-100 text-success-900",
  },
  REJECTED: {
    label: "Rejected",
    className: "border-ink-300 bg-ink-50 text-ink-800",
  },
  WITHDRAWAL_REQUESTED: {
    label: "Withdrawal asked",
    className: "border-stone-300 bg-stone-100 text-ink-700",
  },
  WITHDRAWN: {
    label: "Withdrawn",
    className: "border-stone-300 bg-stone-100 text-ink-700",
  },
  DRAFT_EXPIRED: {
    label: "Draft expired",
    className: "border-stone-300 bg-stone-100 text-ink-700",
  },
  CLOSED_NO_RESPONSE: {
    label: "Closed, no reply",
    className: "border-stone-300 bg-stone-100 text-ink-700",
  },
};

export function StatusPill({ state }: { state: ApplicationState }) {
  const style = STYLES[state];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[0.75rem] font-medium whitespace-nowrap",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

export function stateLabel(state: ApplicationState): string {
  return STYLES[state].label;
}
