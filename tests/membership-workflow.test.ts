import { describe, expect, it } from "vitest";
import {
  GUARD_MESSAGES,
  ORIGINALS_GUARD_ENABLED,
  TIER_WORKING_DAYS,
  TRANSITIONS,
  canTransition,
  findTransition,
  isTerminal,
  applicantCanEdit,
  publicStage,
  transitionsFrom,
  type GuardCode,
  type TransitionActorView,
  type TransitionFacts,
} from "@/membership/workflow";
import type { ApplicationState } from "@/db/schema";
import type { PermissionCode } from "@/server/permissions";

/**
 * The application state machine.
 *
 * The machine is a table plus one pure function precisely so that it can be
 * tested like this: no database, no fixtures, no server. Every claim the admin
 * UI makes about whether a button should be enabled, and every refusal the
 * server issues, comes from the rows exercised here.
 */

const ALL_STATES: readonly ApplicationState[] = [
  "DRAFT",
  "SUBMITTED",
  "UNDER_VERIFICATION",
  "VERIFIED",
  "PENDING_APPROVAL",
  "AWAITING_APPLICANT",
  "APPROVED",
  "REJECTED",
  "WITHDRAWAL_REQUESTED",
  "WITHDRAWN",
  "DRAFT_EXPIRED",
  "CLOSED_NO_RESPONSE",
];

/** Everything true, so a test can turn off exactly the fact it is about. */
function perfectFacts(state: ApplicationState): TransitionFacts {
  return {
    state,
    formComplete: true,
    documentsComplete: true,
    hasProposer: true,
    hasSeconder: true,
    declarationAccepted: true,
    attestingDirectorId: 2,
    representativeDirectorId: 1,
    checklistCompleted: true,
    checklistClear: true,
    allPaymentsReceipted: true,
    bankMatchVerdictRecorded: true,
    endorsersInGoodStanding: true,
    verifiedByUserId: 10,
    receiptedByUserId: 11,
    originalsReceived: true,
  };
}

function staff(permissions: PermissionCode[], userId = 99): TransitionActorView {
  return { userId, isStaff: true, isSystem: false, permissions: new Set(permissions) };
}

const applicant: TransitionActorView = {
  userId: 5,
  isStaff: false,
  isSystem: false,
  permissions: new Set<PermissionCode>(),
};

const system: TransitionActorView = {
  userId: null,
  isStaff: false,
  isSystem: true,
  permissions: new Set<PermissionCode>(),
};

/* -------------------------------------------------------------------------- */
/* The table itself                                                           */
/* -------------------------------------------------------------------------- */

describe("the transition table", () => {
  it("has no duplicate (from, code) pairs", () => {
    const keys = TRANSITIONS.map((transition) => `${transition.from}:${transition.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("names a message for every guard it uses", () => {
    const used = new Set<GuardCode>(TRANSITIONS.flatMap((t) => [...t.guards]));
    for (const guard of used) {
      expect(GUARD_MESSAGES[guard], `no message for guard ${guard}`).toBeTruthy();
    }
  });

  it("gives every staff transition a permission, and no other kind one", () => {
    for (const transition of TRANSITIONS) {
      if (transition.actor === "staff") {
        expect(transition.permission, `${transition.code} from ${transition.from}`).not.toBeNull();
      } else {
        expect(transition.permission, `${transition.code} from ${transition.from}`).toBeNull();
      }
    }
  });

  it("leaves every terminal state terminal", () => {
    // A withdrawal escaping APPROVED is exactly the kind of thing a wildcard
    // "any state -> WITHDRAWN" edge would permit, which is why the table has
    // one row per origin state instead.
    for (const state of ALL_STATES.filter(isTerminal)) {
      const outgoing = transitionsFrom(state);
      const allowed = state === "REJECTED" ? ["reopen_for_correction"] : [];
      expect(outgoing.map((t) => t.code).sort()).toEqual(allowed);
    }
  });

  it("can reach every non-draft state from somewhere", () => {
    const reachable = new Set(TRANSITIONS.map((transition) => transition.to));
    for (const state of ALL_STATES) {
      if (state === "DRAFT") continue;
      expect(reachable.has(state), `nothing transitions into ${state}`).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Public labels                                                              */
/* -------------------------------------------------------------------------- */

describe("the public stage", () => {
  it("collapses the three review states onto one label", () => {
    expect(publicStage("UNDER_VERIFICATION")).toBe("under_review");
    expect(publicStage("VERIFIED")).toBe("under_review");
    expect(publicStage("PENDING_APPROVAL")).toBe("under_review");
  });

  it("lets the applicant edit in exactly the two states that unlock the form", () => {
    const editable = ALL_STATES.filter(applicantCanEdit);
    expect(editable).toEqual(["DRAFT", "AWAITING_APPLICANT"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Submission                                                                 */
/* -------------------------------------------------------------------------- */

describe("submit", () => {
  it("passes when everything is in place", () => {
    const decision = canTransition(perfectFacts("DRAFT"), "submit", applicant);
    expect(decision.allowed).toBe(true);
    expect(decision.failedGuards).toEqual([]);
  });

  it.each([
    ["formComplete", "form_complete"],
    ["documentsComplete", "documents_complete"],
    ["declarationAccepted", "declaration_accepted"],
  ] as const)("fails on %s", (fact, guard) => {
    const decision = canTransition(
      { ...perfectFacts("DRAFT"), [fact]: false },
      "submit",
      applicant,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.failedGuards).toContain(guard);
    expect(decision.reasons).toContain(GUARD_MESSAGES[guard]);
  });

  it("requires both a proposer and a seconder", () => {
    for (const missing of ["hasProposer", "hasSeconder"] as const) {
      const decision = canTransition(
        { ...perfectFacts("DRAFT"), [missing]: false },
        "submit",
        applicant,
      );
      expect(decision.failedGuards).toContain("endorsements_present");
    }
  });

  it("refuses an attestation by the representative themselves", () => {
    // The whole point of the attestation on page 3 of the form: "any one of
    // the Directors/Partners other than representing the Company/Firm". One
    // person doing both is not an attestation.
    const decision = canTransition(
      { ...perfectFacts("DRAFT"), attestingDirectorId: 1, representativeDirectorId: 1 },
      "submit",
      applicant,
    );
    expect(decision.failedGuards).toContain("attested_by_other_director");
  });

  it("refuses when nobody has attested at all", () => {
    const decision = canTransition(
      { ...perfectFacts("DRAFT"), attestingDirectorId: null },
      "submit",
      applicant,
    );
    expect(decision.failedGuards).toContain("attested_by_other_director");
  });

  it("is not a transition staff can make", () => {
    const decision = canTransition(
      perfectFacts("DRAFT"),
      "submit",
      staff(["application.verify"]),
    );
    expect(decision.allowed).toBe(false);
  });

  it("does not exist from any state but DRAFT", () => {
    for (const state of ALL_STATES.filter((value) => value !== "DRAFT")) {
      expect(findTransition(state, "submit")).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Separation of duties                                                       */
/* -------------------------------------------------------------------------- */

describe("approval", () => {
  const facts = perfectFacts("PENDING_APPROVAL");
  const approver = staff(["application.approve"], 42);

  it("passes for an approver who neither verified nor receipted", () => {
    expect(canTransition(facts, "approve", approver).allowed).toBe(true);
  });

  it("refuses the officer who completed the checklist", () => {
    const decision = canTransition(
      { ...facts, verifiedByUserId: 42 },
      "approve",
      approver,
    );
    expect(decision.failedGuards).toContain("not_the_verifier");
  });

  it("refuses the cashier who receipted the fee", () => {
    const decision = canTransition(
      { ...facts, receiptedByUserId: 42 },
      "approve",
      approver,
    );
    expect(decision.failedGuards).toContain("not_the_cashier");
  });

  it("refuses while the fee is unreceipted", () => {
    const decision = canTransition(
      { ...facts, allPaymentsReceipted: false },
      "approve",
      approver,
    );
    expect(decision.failedGuards).toContain("payments_receipted");
  });

  it("refuses until an officer has ruled on the bank match", () => {
    // The system's own normalised comparison is advisory: "HBL", "Habib Bank
    // Ltd" and "H.B.L Gulberg III" are the same branch, and a machine that
    // says otherwise must not block an approval on its own.
    const decision = canTransition(
      { ...facts, bankMatchVerdictRecorded: false },
      "approve",
      approver,
    );
    expect(decision.failedGuards).toContain("bank_match_resolved");
  });

  it("refuses when an endorser has lapsed since endorsing", () => {
    const decision = canTransition(
      { ...facts, endorsersInGoodStanding: false },
      "approve",
      approver,
    );
    expect(decision.failedGuards).toContain("endorsers_in_good_standing");
  });

  it("reports the missing permission without evaluating guards", () => {
    // Order matters: "the pay order does not match the bank certificate" is
    // not something to tell a caller who has no right to the application.
    const decision = canTransition(
      { ...facts, allPaymentsReceipted: false },
      "approve",
      staff([]),
    );
    expect(decision.missingPermission).toBe("application.approve");
    expect(decision.failedGuards).toEqual([]);
  });

  it("lets a verifier recommend rejection but never reject", () => {
    const verifier = staff(["application.verify", "application.recommend_reject"], 7);
    expect(canTransition(perfectFacts("UNDER_VERIFICATION"), "recommend_reject", verifier).allowed)
      .toBe(true);
    expect(canTransition(facts, "reject", verifier).allowed).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

describe("verification", () => {
  const verifier = staff(["application.verify"]);

  it("can be picked up regardless of the state of the application", () => {
    // Deliberately unguarded: verification is how deficiencies are found, so
    // it cannot require the application to already be sound.
    const broken: TransitionFacts = {
      ...perfectFacts("SUBMITTED"),
      formComplete: false,
      documentsComplete: false,
    };
    expect(canTransition(broken, "begin_verification", verifier).allowed).toBe(true);
  });

  it("distinguishes a completed checklist from a clear one", () => {
    // Two of the thirteen items are defects where a tick blocks, so
    // "completed" and "clear" are different questions. Collapsing them is the
    // single easiest way to get this module quietly wrong.
    const decision = canTransition(
      { ...perfectFacts("UNDER_VERIFICATION"), checklistClear: false },
      "mark_verified",
      verifier,
    );
    expect(decision.failedGuards).toContain("checklist_clear");
    expect(decision.failedGuards).not.toContain("checklist_complete");
  });

  it("ignores the originals guard while the policy is unanswered", () => {
    // Whether applicants must still deliver original documents to the counter
    // is an open question for LCCI. Until it is answered the guard is
    // provisioned and inert, and this test is what will fail loudly on the day
    // somebody flips the constant without wiring the rest.
    const decision = canTransition(
      { ...perfectFacts("UNDER_VERIFICATION"), originalsReceived: false },
      "mark_verified",
      verifier,
    );
    expect(ORIGINALS_GUARD_ENABLED).toBe(false);
    expect(decision.failedGuards).not.toContain("originals_received");
  });
});

/* -------------------------------------------------------------------------- */
/* System transitions                                                         */
/* -------------------------------------------------------------------------- */

describe("system transitions", () => {
  it("expires a draft, and only the system may", () => {
    expect(canTransition(perfectFacts("DRAFT"), "expire_draft", system).allowed).toBe(true);
    expect(canTransition(perfectFacts("DRAFT"), "expire_draft", applicant).allowed).toBe(false);
    expect(
      canTransition(perfectFacts("DRAFT"), "expire_draft", staff(["application.verify"])).allowed,
    ).toBe(false);
  });

  it("closes an unanswered deficiency", () => {
    expect(
      canTransition(perfectFacts("AWAITING_APPLICANT"), "close_no_response", system).allowed,
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Tiers                                                                      */
/* -------------------------------------------------------------------------- */

describe("processing tiers", () => {
  it("matches the promises printed on the form", () => {
    expect(TIER_WORKING_DAYS).toEqual({ regular: 40, urgent: 15, executive: 3 });
  });
});
