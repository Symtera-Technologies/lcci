import type { TransitionCode } from "@/membership/workflow";

/**
 * What each move is called on screen.
 *
 * Separate from `TRANSITIONS[].note`, which exists for whoever reads the
 * transition table — "Deliberately unguarded: verification is how deficiencies
 * are found" is the right sentence in that file and the wrong one on a button.
 *
 * A total `Record` rather than a lookup with a fallback, so adding a
 * transition to the machine without naming it here is a build error. A
 * fallback would render the code itself — `send_for_approval` — which looks
 * like a bug to the officer and like nothing at all to the developer.
 *
 * Written as an officer would say it, not as the state machine thinks of it:
 * the audience is a person at a desk with a paper file beside them.
 */
export const TRANSITION_LABELS: Record<TransitionCode, string> = {
  submit: "Submit the application",
  withdraw_draft: "Withdraw the draft",
  expire_draft: "Expire the draft",
  begin_verification: "Start verification",
  raise_deficiency: "Return for more information",
  applicant_responded: "Record the applicant's response",
  mark_verified: "Mark as verified",
  recommend_reject: "Recommend rejection",
  send_for_approval: "Send for approval",
  return_for_verification: "Send back for verification",
  approve: "Grant membership",
  reject: "Reject the application",
  request_withdrawal: "Request withdrawal",
  confirm_withdrawal: "Confirm the withdrawal",
  deny_withdrawal: "Refuse the withdrawal",
  close_no_response: "Close, no response",
  reopen_for_correction: "Reopen for correction",
};
