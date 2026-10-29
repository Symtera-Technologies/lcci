/**
 * The application state machine: data plus one pure function.
 *
 * No `server-only` and no database import, deliberately. This module is a
 * table and some arithmetic over it, which means the admin UI can import it to
 * decide whether to grey out a button, the server can import it to enforce the
 * same rule, and the test suite can exercise all of it without a MySQL server.
 * One source of truth for "may this happen", in the only form that can be
 * shared between a client component and a transaction.
 *
 * `canTransition` returns the guards that **failed** rather than a boolean, so
 * the admin can both disable the button and say why — "cannot approve: the pay
 * order's bank does not match the account-maintenance certificate" — from the
 * same table the server refuses on. A boolean would force the UI to re-derive
 * the reason and the two would drift.
 */

import type { ApplicationState, ProcessingTier } from "@/db/schema";
import type { PermissionCode } from "@/server/permissions";

/* -------------------------------------------------------------------------- */
/* What the applicant is shown                                                */
/* -------------------------------------------------------------------------- */

/**
 * The four labels the specification commits to, plus the three it does not.
 *
 * The specification's list — Submitted, Under review, Approved, Need info —
 * covers neither rejection, withdrawal nor closure, and an applicant whose
 * application was rejected has to be told something. The three extra labels
 * are applicant-facing copy and need LCCI sign-off before launch.
 */
export type PublicStage =
  | "draft"
  | "submitted"
  | "under_review"
  | "need_info"
  | "approved"
  | "not_approved"
  | "withdrawn"
  | "closed";

/**
 * Derived, never stored.
 *
 * Twelve internal states collapse onto eight public ones. Storing both would
 * mean two columns that can disagree, and the one the applicant sees would be
 * the one nobody notices is stale.
 */
export function publicStage(state: ApplicationState): PublicStage {
  switch (state) {
    case "DRAFT":
      return "draft";
    case "SUBMITTED":
      return "submitted";
    case "UNDER_VERIFICATION":
    case "VERIFIED":
    case "PENDING_APPROVAL":
      return "under_review";
    case "AWAITING_APPLICANT":
      return "need_info";
    case "APPROVED":
      return "approved";
    case "REJECTED":
      return "not_approved";
    case "WITHDRAWAL_REQUESTED":
    case "WITHDRAWN":
      return "withdrawn";
    case "DRAFT_EXPIRED":
    case "CLOSED_NO_RESPONSE":
      return "closed";
  }
}

/**
 * What the applicant is told, per public stage.
 *
 * Here beside `publicStage` rather than in the page, because three screens
 * will say these words — the applicant's own page, the status email and the
 * tracker — and three copies would drift. Three of the eight are the labels
 * §7.1 commits to; the other five are ours and need LCCI sign-off, which is
 * easier to ask for against one list than against three templates.
 */
export const PUBLIC_STAGE_LABELS: Record<PublicStage, string> = {
  draft: "Draft",
  submitted: "Submitted",
  under_review: "Under review",
  need_info: "Need info",
  approved: "Approved",
  not_approved: "Not approved",
  withdrawn: "Withdrawn",
  closed: "Closed",
};

/** True where the applicant may still edit the form. */
export function applicantCanEdit(state: ApplicationState): boolean {
  return state === "DRAFT" || state === "AWAITING_APPLICANT";
}

/** True where the application has reached a final state. */
export function isTerminal(state: ApplicationState): boolean {
  return (
    state === "APPROVED" ||
    state === "REJECTED" ||
    state === "WITHDRAWN" ||
    state === "DRAFT_EXPIRED" ||
    state === "CLOSED_NO_RESPONSE"
  );
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The named conditions a transition can require.
 *
 * Each is evaluated against a `TransitionFacts` snapshot the caller assembles,
 * rather than by querying inside this module. That is what keeps the machine
 * pure: the server loads the facts in its transaction, the UI loads the same
 * facts in its page query, and both get the same answer.
 */
export type GuardCode =
  | "form_complete"
  | "documents_complete"
  | "endorsements_present"
  | "declaration_accepted"
  | "attested_by_other_director"
  | "checklist_complete"
  | "checklist_clear"
  | "payments_receipted"
  | "bank_match_resolved"
  | "bank_match_confirmed"
  | "endorsers_in_good_standing"
  | "not_the_verifier"
  | "not_the_cashier"
  | "originals_received";

/** What each guard says when it fails, for the officer or the applicant. */
export const GUARD_MESSAGES: Record<GuardCode, string> = {
  form_complete: "Some required details are still missing.",
  documents_complete: "Not every required document has been uploaded.",
  endorsements_present:
    "A proposer and a seconder are both required before submission.",
  declaration_accepted: "The declaration has not been accepted.",
  attested_by_other_director:
    "The attestation must be made by a director other than the representative.",
  checklist_complete: "The verification checklist has not been completed.",
  checklist_clear: "The verification checklist records an unresolved defect.",
  payments_receipted: "The fee has not been receipted by the cashier.",
  bank_match_resolved:
    "The cashier has not yet recorded whether the pay order matches the account-maintenance certificate.",
  bank_match_confirmed:
    "The pay order does not match the account-maintenance certificate. The applicant must supply a corrected instrument, or a certificate for the account it was drawn on.",
  endorsers_in_good_standing:
    "A proposer or seconder no longer holds valid membership status.",
  not_the_verifier:
    "The officer who completed the verification checklist cannot also approve this application.",
  not_the_cashier:
    "The cashier who receipted this fee cannot also approve this application.",
  originals_received:
    "The original bank account-maintenance certificate has not been recorded as received.",
};

/**
 * Everything the guards need, gathered by the caller.
 *
 * Assembled from the database by the server and from the page's own query by
 * the admin UI. Deliberately flat and primitive: anything richer would tempt
 * this module into knowing how applications are stored.
 */
export interface TransitionFacts {
  readonly state: ApplicationState;
  readonly formComplete: boolean;
  readonly documentsComplete: boolean;
  readonly hasProposer: boolean;
  readonly hasSeconder: boolean;
  readonly declarationAccepted: boolean;
  readonly attestingDirectorId: number | null;
  readonly representativeDirectorId: number | null;
  readonly checklistCompleted: boolean;
  readonly checklistClear: boolean;
  readonly allPaymentsReceipted: boolean;
  /**
   * Whether every instrument that was taken in has been compared.
   *
   * Vacuously true where no instrument exists — a waived fee has nothing to
   * compare, and a guard that cannot be satisfied by any action is a guard
   * that strands the application rather than protecting it.
   */
  readonly bankMatchVerdictRecorded: boolean;
  /**
   * Whether any recorded verdict is `mismatch`.
   *
   * Separate from `bankMatchVerdictRecorded` because the two failures need
   * different sentences and different remedies: an unrecorded verdict waits
   * on the cashier, while a mismatch waits on the applicant. Collapsing them
   * into "a verdict exists" would let a pay order the cashier flagged as drawn
   * on somebody else's account be approved, which is the one outcome this
   * whole control exists to prevent.
   */
  readonly bankMatchMismatch: boolean;
  readonly endorsersInGoodStanding: boolean;
  /** Who completed the checklist, so approval can refuse the same person. */
  readonly verifiedByUserId: number | null;
  /**
   * Everyone who receipted a fee on this application, for the same reason.
   *
   * A list and not one id: an application with a foreign partner owes two fees
   * by two separate pay orders, and two cashiers can receipt one each. Keeping
   * only the first would let the second of them approve their own receipt.
   */
  readonly receiptedByUserIds: readonly number[];
  /**
   * Whether the physical bank certificate has been received over the counter.
   *
   * "Original, not older than three months" is meaningless for an upload, and
   * whether applicants must still deliver originals is an open question for
   * LCCI. Until it is answered this is provisioned and the guard is attached
   * to no transition — see `ORIGINALS_GUARD_ENABLED`.
   */
  readonly originalsReceived: boolean;
}

/**
 * Whether the originals guard is active.
 *
 * False until LCCI answers whether applicants still deliver original
 * documents to the counter. A constant rather than a commented-out guard, so
 * turning it on is one edit and the intent is discoverable by search.
 */
export const ORIGINALS_GUARD_ENABLED = false;

function evaluateGuard(guard: GuardCode, facts: TransitionFacts, actorUserId: number | null): boolean {
  switch (guard) {
    case "form_complete":
      return facts.formComplete;
    case "documents_complete":
      return facts.documentsComplete;
    case "endorsements_present":
      return facts.hasProposer && facts.hasSeconder;
    case "declaration_accepted":
      return facts.declarationAccepted;
    case "attested_by_other_director":
      // The printed form has a second director attest to the representative's
      // declaration. One person doing both is not an attestation, so a null
      // attester fails and so does the representative attesting themselves.
      return (
        facts.attestingDirectorId !== null &&
        facts.attestingDirectorId !== facts.representativeDirectorId
      );
    case "checklist_complete":
      return facts.checklistCompleted;
    case "checklist_clear":
      return facts.checklistClear;
    case "payments_receipted":
      return facts.allPaymentsReceipted;
    case "bank_match_resolved":
      return facts.bankMatchVerdictRecorded;
    case "bank_match_confirmed":
      return !facts.bankMatchMismatch;
    case "endorsers_in_good_standing":
      return facts.endorsersInGoodStanding;
    case "not_the_verifier":
      // A null actor is the system, which never approves. A null verifier
      // means nobody has verified, which `checklist_complete` catches; this
      // guard's only job is the identity comparison.
      return (
        actorUserId === null ||
        facts.verifiedByUserId === null ||
        facts.verifiedByUserId !== actorUserId
      );
    case "not_the_cashier":
      return actorUserId === null || !facts.receiptedByUserIds.includes(actorUserId);
    case "originals_received":
      return !ORIGINALS_GUARD_ENABLED || facts.originalsReceived;
  }
}

/* -------------------------------------------------------------------------- */
/* The transition table                                                       */
/* -------------------------------------------------------------------------- */

export type TransitionCode =
  | "submit"
  | "withdraw_draft"
  | "expire_draft"
  | "begin_verification"
  | "raise_deficiency"
  | "applicant_responded"
  | "mark_verified"
  | "recommend_reject"
  | "send_for_approval"
  | "return_for_verification"
  | "approve"
  | "reject"
  | "request_withdrawal"
  | "confirm_withdrawal"
  | "deny_withdrawal"
  | "close_no_response"
  | "reopen_for_correction";

/** Who may invoke a transition. */
export type TransitionActor = "applicant" | "staff" | "system";

export interface Transition {
  readonly code: TransitionCode;
  readonly from: ApplicationState;
  readonly to: ApplicationState;
  readonly actor: TransitionActor;
  /** Null for applicant and system transitions. */
  readonly permission: PermissionCode | null;
  readonly guards: readonly GuardCode[];
  /** Why this transition exists, for the reader of the table. */
  readonly note: string;
}

/**
 * Every move the application can make.
 *
 * Keyed by `from` and `code` together, which is why the same code appears
 * several times: an applicant may request withdrawal from three different
 * states, and each is a distinct, separately-guarded edge rather than a
 * wildcard. A wildcard here would be the thing that lets a withdrawal slip
 * out of APPROVED.
 */
export const TRANSITIONS: readonly Transition[] = [
  {
    code: "submit",
    from: "DRAFT",
    to: "SUBMITTED",
    actor: "applicant",
    permission: null,
    guards: [
      "form_complete",
      "documents_complete",
      "endorsements_present",
      "declaration_accepted",
      "attested_by_other_director",
    ],
    note: "The load-bearing one. Assigns the public reference, snapshots the form revision, fee and document matrix, writes the submission snapshot, creates the payment rows, starts the SLA clock and locks applicant editing.",
  },
  {
    code: "withdraw_draft",
    from: "DRAFT",
    to: "WITHDRAWN",
    actor: "applicant",
    permission: null,
    guards: [],
    note: "An applicant abandoning a draft on purpose, as distinct from one that times out. No guards: nothing has been promised to anyone yet.",
  },
  {
    code: "expire_draft",
    from: "DRAFT",
    to: "DRAFT_EXPIRED",
    actor: "system",
    permission: null,
    guards: [],
    note: "Ninety days untouched. The job also deletes the draft's documents, which is the single most valuable deletion in the system for PII minimisation.",
  },

  {
    code: "begin_verification",
    from: "SUBMITTED",
    to: "UNDER_VERIFICATION",
    actor: "staff",
    permission: "application.verify",
    guards: [],
    note: "An officer picks the application up. Deliberately unguarded: verification is how deficiencies are found, so it cannot require the application to be sound.",
  },
  {
    code: "request_withdrawal",
    from: "SUBMITTED",
    to: "WITHDRAWAL_REQUESTED",
    actor: "applicant",
    permission: null,
    guards: [],
    note: "Not a direct withdrawal: a fee may already have been receipted, so a human has to decide the refund disposition.",
  },
  {
    code: "request_withdrawal",
    from: "UNDER_VERIFICATION",
    to: "WITHDRAWAL_REQUESTED",
    actor: "applicant",
    permission: null,
    guards: [],
    note: "Same request, from the state the application spends most of its life in.",
  },
  {
    code: "request_withdrawal",
    from: "AWAITING_APPLICANT",
    to: "WITHDRAWAL_REQUESTED",
    actor: "applicant",
    permission: null,
    guards: [],
    note: "An applicant who decides not to answer a deficiency. Better recorded as a withdrawal than left to time out.",
  },

  {
    code: "raise_deficiency",
    from: "UNDER_VERIFICATION",
    to: "AWAITING_APPLICANT",
    actor: "staff",
    permission: "application.raise_deficiency",
    guards: [],
    note: "Freezes the checklist, unlocks only the named fields and documents, pauses the SLA clock and emails an itemised list.",
  },
  {
    code: "applicant_responded",
    from: "AWAITING_APPLICANT",
    to: "UNDER_VERIFICATION",
    actor: "applicant",
    permission: null,
    guards: [],
    note: "New documents supersede rather than overwrite, a new snapshot round is written, and the SLA clock resumes.",
  },
  {
    code: "close_no_response",
    from: "AWAITING_APPLICANT",
    to: "CLOSED_NO_RESPONSE",
    actor: "system",
    permission: null,
    guards: [],
    note: "After the reminder sequence. Sets a refund disposition flag, because a fee may have been receipted before the deficiency was raised.",
  },

  {
    code: "mark_verified",
    from: "UNDER_VERIFICATION",
    to: "VERIFIED",
    actor: "staff",
    permission: "application.verify",
    guards: ["checklist_complete", "checklist_clear", "documents_complete", "originals_received"],
    note: "The checklist must be both completed and clear. Those are different conditions: two of the thirteen items are defects where a tick blocks.",
  },
  {
    code: "recommend_reject",
    from: "UNDER_VERIFICATION",
    to: "PENDING_APPROVAL",
    actor: "staff",
    permission: "application.recommend_reject",
    guards: ["checklist_complete"],
    note: "A verifier may recommend refusal but never refuse. Rejection is the approver's decision, which is what keeps one officer from both finding fault and acting on it.",
  },
  {
    code: "send_for_approval",
    from: "VERIFIED",
    to: "PENDING_APPROVAL",
    actor: "staff",
    permission: "application.verify",
    guards: ["payments_receipted", "bank_match_resolved", "bank_match_confirmed"],
    note: "Where payment becomes a guard. The pay order arrived with the form, so receipting ran in parallel with verification; this is the point the two have to meet.",
  },

  {
    code: "approve",
    from: "PENDING_APPROVAL",
    to: "APPROVED",
    actor: "staff",
    permission: "application.approve",
    guards: [
      "checklist_complete",
      "checklist_clear",
      "payments_receipted",
      "bank_match_resolved",
      "bank_match_confirmed",
      "endorsers_in_good_standing",
      "not_the_verifier",
      "not_the_cashier",
    ],
    note: "Allocates the membership number under a row lock inside this transaction. The two identity guards are the separation of duties the form's separate staff and cashier signatures exist to create.",
  },
  {
    code: "reject",
    from: "PENDING_APPROVAL",
    to: "REJECTED",
    actor: "staff",
    permission: "application.reject",
    guards: ["not_the_verifier"],
    note: "Refusal is the approver's call. The verifier guard applies here too: recommending rejection and granting it must be two people.",
  },
  {
    code: "return_for_verification",
    from: "PENDING_APPROVAL",
    to: "UNDER_VERIFICATION",
    actor: "staff",
    permission: "application.approve",
    guards: [],
    note: "An approver who is not satisfied sends it back rather than refusing it. Without this the only options are approve or reject, and an approver short of one document would be pushed toward the wrong one.",
  },

  {
    code: "confirm_withdrawal",
    from: "WITHDRAWAL_REQUESTED",
    to: "WITHDRAWN",
    actor: "staff",
    permission: "application.correct",
    guards: [],
    note: "A human confirms, because withdrawal after a receipted fee owes the applicant a refund decision.",
  },
  {
    code: "deny_withdrawal",
    from: "WITHDRAWAL_REQUESTED",
    to: "UNDER_VERIFICATION",
    actor: "staff",
    permission: "application.correct",
    guards: [],
    note: "Returns a request made in error to the queue, rather than leaving the application stranded in a state nothing can leave.",
  },
  {
    code: "reopen_for_correction",
    from: "REJECTED",
    to: "UNDER_VERIFICATION",
    actor: "staff",
    permission: "application.correct",
    guards: [],
    note: "Out-of-sequence correction for a rejection made in error. Separately permissioned and audited precisely because it undoes a decision.",
  },
];

/* -------------------------------------------------------------------------- */
/* Lookup and evaluation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Built once from the table above, keyed `FROM:code`.
 *
 * The table stays an array because its order is meaningful to a reader —
 * roughly the order an application travels — while lookup wants a map.
 */
const BY_KEY: ReadonlyMap<string, Transition> = new Map(
  TRANSITIONS.map((transition) => [`${transition.from}:${transition.code}`, transition]),
);

export function findTransition(
  from: ApplicationState,
  code: TransitionCode,
): Transition | null {
  return BY_KEY.get(`${from}:${code}`) ?? null;
}

/** Every transition available from a state, whatever its guards say. */
export function transitionsFrom(from: ApplicationState): readonly Transition[] {
  return TRANSITIONS.filter((transition) => transition.from === from);
}

export interface TransitionDecision {
  readonly allowed: boolean;
  /** Set when the transition does not exist from this state at all. */
  readonly unknown: boolean;
  /** Set when the actor lacks the permission the transition requires. */
  readonly missingPermission: PermissionCode | null;
  /** The guards that failed, in table order. Empty when allowed. */
  readonly failedGuards: readonly GuardCode[];
  /** The failed guards' messages, ready to show. */
  readonly reasons: readonly string[];
  readonly transition: Transition | null;
}

export interface TransitionActorView {
  readonly userId: number | null;
  readonly isStaff: boolean;
  readonly isSystem: boolean;
  readonly permissions: ReadonlySet<PermissionCode>;
}

/**
 * May this actor make this move, and if not, exactly why.
 *
 * Checks in a fixed order — existence, then actor kind, then permission, then
 * guards — because the answers are not equally safe to give away. "That
 * transition does not exist from this state" is fine for anyone to learn;
 * "the pay order does not match the bank certificate" is not something an
 * applicant should be told about someone else's application, so it is only
 * reached by an actor who already holds the permission.
 */
/**
 * Which of these guards the facts fail, with nothing else asked.
 *
 * Separate from `canTransition` because the two questions are genuinely
 * different. `canTransition` answers "may this actor do this now", and when the
 * answer is no because of the state, the audience or a missing permission it
 * stops there and reports no failed guards — correctly, since it never looked
 * at them.
 *
 * A screen listing the approval block needs the other question: "what is true
 * of this file", regardless of whether the person reading is allowed to act on
 * it. Reusing the short-circuiting answer for that is how an approval checklist
 * comes to print eight ticks beside a file whose checklist is still open.
 *
 * One implementation for both, so a guard cannot mean one thing to the server
 * and another to the page describing it.
 */
export function evaluateGuards(
  guards: readonly GuardCode[],
  facts: TransitionFacts,
  actorUserId: number | null,
): readonly GuardCode[] {
  return guards.filter((guard) => !evaluateGuard(guard, facts, actorUserId));
}

export function canTransition(
  facts: TransitionFacts,
  code: TransitionCode,
  actor: TransitionActorView,
): TransitionDecision {
  const transition = findTransition(facts.state, code);

  if (!transition) {
    return {
      allowed: false,
      unknown: true,
      missingPermission: null,
      failedGuards: [],
      reasons: [],
      transition: null,
    };
  }

  const actorMatches =
    transition.actor === "system"
      ? actor.isSystem
      : transition.actor === "staff"
        ? actor.isStaff
        : !actor.isStaff && !actor.isSystem;

  if (!actorMatches) {
    return {
      allowed: false,
      unknown: false,
      missingPermission: transition.permission,
      failedGuards: [],
      reasons: [],
      transition,
    };
  }

  if (transition.permission && !actor.permissions.has(transition.permission)) {
    return {
      allowed: false,
      unknown: false,
      missingPermission: transition.permission,
      failedGuards: [],
      reasons: [],
      transition,
    };
  }

  const failedGuards = evaluateGuards(transition.guards, facts, actor.userId);

  return {
    allowed: failedGuards.length === 0,
    unknown: false,
    missingPermission: null,
    failedGuards,
    reasons: failedGuards.map((guard) => GUARD_MESSAGES[guard]),
    transition,
  };
}

/* -------------------------------------------------------------------------- */
/* Tier arithmetic                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The promised working days per tier.
 *
 * Duplicated from `fee_schedule.working_days` on purpose, and the duplication
 * is checked by a test. The database row is authoritative because the chamber
 * can change the promise without a deploy; this constant exists so that the
 * pure machine and the UI can reason about tiers without a query, and the test
 * fails if the two ever disagree.
 */
export const TIER_WORKING_DAYS: Record<ProcessingTier, number> = {
  regular: 40,
  urgent: 15,
  executive: 3,
};
