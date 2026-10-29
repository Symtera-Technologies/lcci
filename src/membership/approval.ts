import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  ApplicationState,
  ApplicationDecisionKind,
  MembershipClass,
  MembershipStatus,
} from "@/db/schema";
import {
  ConcurrencyError,
  ForbiddenError,
  requirePermission,
  type ActorContext,
} from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { enqueue } from "@/server/mail/outbox";
import { formatDate } from "@/lib/format";
import { allocateNumber } from "@/membership/numbering";
import { moveState, recordTransition } from "@/membership/applications";
import { gatherFacts } from "@/membership/submit";
import { stopSlaClock } from "@/membership/sla";
import {
  anyFeeReceipted,
  applicantContact,
  notifyNotApproved,
} from "@/membership/notify";
import {
  canTransition,
  evaluateGuards,
  GUARD_MESSAGES,
  type GuardCode,
  type TransitionActorView,
  type TransitionCode,
  type TransitionDecision,
} from "@/membership/workflow";
import {
  membershipYearFor,
  type MembershipYearPolicy,
} from "@/membership/year";

/**
 * Granting membership: the one transition that creates something permanent.
 *
 * Everything before this point is reversible paperwork. This writes a
 * membership number that will be printed on a certificate, quoted by future
 * proposers and used to sign in — so the whole module is built around the
 * things that must not be able to go wrong:
 *
 * **One number, under a lock, inside the transaction.** `allocateNumber` reads
 * the sequence `FOR UPDATE`, so two concurrent approvals serialise and the
 * loser waits. `uq_membership_no` is the backstop. And the optimistic version
 * check on `applications` means the loser then finds the application already
 * approved and is told so, rather than allocating a second number for the same
 * firm.
 *
 * **Separation of duties re-checked in SQL, inside the transaction.** The
 * guards are evaluated from facts read with the transaction's own connection,
 * not from a value the screen rendered a minute ago. Without that, an approver
 * who received a receipt in the meantime would be judged against a snapshot
 * taken before it existed.
 *
 * **The email in the same transaction as the approval.** `enqueue` takes the
 * transaction precisely so the two cannot disagree: an approval that commits
 * without its grant email leaves a new member never told their number, and an
 * email announcing an approval that rolled back is worse.
 */

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface ApprovalGuard {
  readonly code: GuardCode;
  readonly satisfied: boolean;
  readonly message: string;
  /**
   * Whether a super-admin could waive this one.
   *
   * Only the two separation-of-duties guards. A missing document or an
   * unreceipted fee is a fact about the file that no amount of authority
   * changes, and offering to waive it would be offering to approve an
   * application that does not qualify.
   */
  readonly waivable: boolean;
  /** An existing waiver covering this guard for this actor. */
  readonly waivedBy: string | null;
}

export interface ApprovalView {
  readonly applicationId: number;
  readonly publicRef: string | null;
  readonly firmName: string | null;
  readonly state: ApplicationState;
  readonly membershipClass: MembershipClass | null;
  readonly version: number;
  readonly submittedAt: Date | null;
  readonly dueDate: string | null;
  readonly slaOutcome: string | null;
  /** Every guard on `approve`, satisfied or not, in the table's own order. */
  readonly guards: readonly ApprovalGuard[];
  readonly mayApprove: boolean;
  readonly mayReject: boolean;
  readonly mayWaive: boolean;
  /** What this application has already produced, if anything. */
  readonly membership: GrantedMembership | null;
  readonly decisions: readonly DecisionRecord[];
  /** The year a grant today would buy, for the screen to state before acting. */
  readonly yearIfGrantedToday: {
    readonly validUntil: string;
    readonly label: string;
  };
}

export interface GrantedMembership {
  readonly id: number;
  readonly membershipNo: string;
  readonly membershipClass: MembershipClass;
  readonly status: MembershipStatus;
  readonly grantedOn: string;
  readonly grantedByName: string | null;
  readonly suspendReason: string | null;
  readonly years: readonly {
    readonly label: string;
    readonly startsOn: string;
    readonly validUntil: string;
  }[];
}

export interface DecisionRecord {
  readonly decision: ApplicationDecisionKind;
  readonly decidedAt: Date;
  readonly decidedByName: string | null;
  readonly roleCode: string | null;
  readonly reason: string | null;
  readonly membershipNo: string | null;
}

/** The two guards a waiver may cover. Everything else is a fact about the file. */
const WAIVABLE: ReadonlySet<GuardCode> = new Set<GuardCode>([
  "not_the_verifier",
  "not_the_cashier",
]);

function actorView(actor: ActorContext): TransitionActorView {
  return {
    userId: actor.userId,
    isStaff: actor.userType === "staff",
    isSystem: actor.userId === null,
    permissions: actor.permissions,
  };
}

/**
 * The approval screen's whole state, including the guards that are *satisfied*.
 *
 * Satisfied guards are returned rather than filtered out because an approver is
 * signing off on a file somebody else assembled. "Nothing is blocking you" is a
 * much weaker statement than "the checklist is clear, the fee is receipted, the
 * pay order matched, you did not verify this and you did not receipt it" — and
 * the second is what the printed form's approval block is for.
 */
export async function loadApproval(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<ApprovalView | null> {
  requirePermission(actor, "application.read");

  const header = await db
    .selectFrom("applications")
    .leftJoin(
      "application_company",
      "application_company.application_id",
      "applications.id",
    )
    .leftJoin("sla_clocks", "sla_clocks.application_id", "applications.id")
    .select([
      "applications.id",
      "applications.public_ref",
      "applications.state",
      "applications.membership_class",
      "applications.version",
      "applications.submitted_at",
      "application_company.firm_name",
      "sla_clocks.due_date",
      "sla_clocks.outcome as sla_outcome",
    ])
    .where("applications.id", "=", applicationId)
    .executeTakeFirst();

  if (!header || header.submitted_at === null) return null;

  const state = header.state as ApplicationState;
  const facts = await gatherFacts(db, applicationId);
  const view = actorView(actor);

  const waivers = await db
    .selectFrom("conflict_waivers")
    .leftJoin("users", "users.id", "conflict_waivers.granted_by")
    .select(["conflict_waivers.waived_guard", "users.full_name"])
    .where("conflict_waivers.application_id", "=", applicationId)
    .where("conflict_waivers.granted_for", "=", actor.userId ?? -1)
    .execute();

  const waivedFor = new Map(
    waivers.map((row) => [row.waived_guard, row.full_name ?? "a super-admin"]),
  );

  const approve = canTransition({ ...facts, state }, "approve", view);
  const reject = canTransition({ ...facts, state }, "reject", view);

  // Keyed on the guard *codes* the decision reports, not on its message
  // strings. Matching on prose would break silently the first time somebody
  // reworded a message in `GUARD_MESSAGES`, which is exactly the kind of edit
  // nobody expects to change behaviour.
  // Evaluated against the facts directly, and *not* taken from `approve`.
  //
  // `canTransition` stops at the first thing that disqualifies the actor — the
  // wrong state, the wrong audience, a missing permission — and reports no
  // failed guards, because it never reached them. Reading the display list off
  // that is how this screen came to show eight ticks for an application still
  // in verification, telling an approver the checklist was "complete and
  // signed" while round 2 of it was open with an unresolved defect.
  //
  // So: the list below describes the file, and `mayApprove` below describes the
  // actor. They are different questions and they are asked separately.
  const failed = new Set<GuardCode>(
    evaluateGuards(APPROVE_GUARDS, { ...facts, state }, actor.userId),
  );

  // Every guard on `approve`, satisfied or not, so the screen can show the
  // whole approval block rather than the first thing that failed.
  const guards: ApprovalGuard[] = APPROVE_GUARDS.map((code) => ({
    code,
    satisfied: !failed.has(code),
    message: GUARD_MESSAGES[code],
    waivable: WAIVABLE.has(code),
    waivedBy: waivedFor.get(code) ?? null,
  }));

  const membership = await loadGrantedMembership(db, applicationId);
  const decisions = await loadDecisions(db, applicationId);
  const today = new Date().toISOString().slice(0, 10);
  const year = membershipYearFor(today, await loadYearPolicy(db));

  return {
    applicationId,
    publicRef: header.public_ref,
    firmName: header.firm_name,
    state,
    membershipClass: header.membership_class,
    version: Number(header.version),
    submittedAt: header.submitted_at,
    dueDate:
      header.due_date === null ? null : String(header.due_date).slice(0, 10),
    slaOutcome: header.sla_outcome,
    guards,
    // Allowed, or allowed once the waivers this actor holds are applied.
    mayApprove: approve.allowed || waivedIntoAllowance(approve, waivedFor),
    mayReject: reject.allowed,
    mayWaive: actor.permissions.has("role.manage"),
    membership,
    decisions,
    yearIfGrantedToday: { validUntil: year.validUntil, label: year.label },
  };
}

/**
 * Whether the only remaining obstacles are guards this actor holds a waiver for.
 *
 * Deliberately not "any waiver exists": a waiver is granted to one named
 * person for one application, so another approver gains nothing from it.
 */
function waivedIntoAllowance(
  decision: TransitionDecision,
  waivedFor: ReadonlyMap<string, string>,
): boolean {
  if (decision.missingPermission !== null || decision.unknown) return false;
  if (decision.failedGuards.length === 0) return decision.allowed;

  return decision.failedGuards.every(
    (code) => WAIVABLE.has(code) && waivedFor.has(code),
  );
}

/** The guards on `approve`, in the order the transition table lists them. */
const APPROVE_GUARDS: readonly GuardCode[] = [
  "checklist_complete",
  "checklist_clear",
  "payments_receipted",
  "bank_match_resolved",
  "bank_match_confirmed",
  "endorsers_in_good_standing",
  "not_the_verifier",
  "not_the_cashier",
];

async function loadYearPolicy(db: Queryable): Promise<MembershipYearPolicy> {
  const row = await db
    .selectFrom("membership_year_policy")
    .select([
      "expires_on_month",
      "expires_on_day",
      "carry_forward_month",
      "carry_forward_day",
    ])
    .where("id", "=", 1)
    .executeTakeFirst();

  if (!row) {
    // Seeded by migration 0007. Absent means somebody deleted reference data,
    // and guessing a policy for a date that goes on a certificate is worse
    // than refusing to guess.
    throw new Error(
      "membership_year_policy row 1 is missing. The membership year cannot be " +
        "computed without it, and defaulting would print a date nobody chose.",
    );
  }

  return {
    expiresOnMonth: Number(row.expires_on_month),
    expiresOnDay: Number(row.expires_on_day),
    carryForwardMonth:
      row.carry_forward_month === null ? null : Number(row.carry_forward_month),
    carryForwardDay:
      row.carry_forward_day === null ? null : Number(row.carry_forward_day),
  };
}

async function loadGrantedMembership(
  db: Queryable,
  applicationId: number,
): Promise<GrantedMembership | null> {
  const row = await db
    .selectFrom("memberships")
    .leftJoin("users", "users.id", "memberships.granted_by")
    .select([
      "memberships.id",
      "memberships.membership_no",
      "memberships.membership_class",
      "memberships.status",
      "memberships.granted_on",
      "memberships.suspend_reason",
      "users.full_name",
    ])
    .where("memberships.granted_by_application_id", "=", applicationId)
    .orderBy("memberships.id", "desc")
    .executeTakeFirst();

  if (!row) return null;

  const years = await db
    .selectFrom("membership_years")
    .select(["label", "starts_on", "valid_until"])
    .where("membership_id", "=", Number(row.id))
    .orderBy("valid_until", "asc")
    .execute();

  return {
    id: Number(row.id),
    membershipNo: row.membership_no,
    membershipClass: row.membership_class,
    status: row.status,
    grantedOn: String(row.granted_on).slice(0, 10),
    grantedByName: row.full_name,
    suspendReason: row.suspend_reason,
    years: years.map((year) => ({
      label: year.label,
      startsOn: String(year.starts_on).slice(0, 10),
      validUntil: String(year.valid_until).slice(0, 10),
    })),
  };
}

async function loadDecisions(
  db: Queryable,
  applicationId: number,
): Promise<readonly DecisionRecord[]> {
  const rows = await db
    .selectFrom("application_decisions")
    .leftJoin("users", "users.id", "application_decisions.decided_by")
    .leftJoin(
      "memberships",
      "memberships.id",
      "application_decisions.membership_id",
    )
    .select([
      "application_decisions.decision",
      "application_decisions.decided_at",
      "application_decisions.decided_by_role_code",
      "application_decisions.reason",
      "users.full_name",
      "memberships.membership_no",
    ])
    .where("application_decisions.application_id", "=", applicationId)
    .orderBy("application_decisions.decided_at", "desc")
    .execute();

  return rows.map((row) => ({
    decision: row.decision,
    decidedAt: row.decided_at,
    decidedByName: row.full_name,
    roleCode: row.decided_by_role_code,
    reason: row.reason,
    membershipNo: row.membership_no,
  }));
}

/* -------------------------------------------------------------------------- */
/* Granting                                                                   */
/* -------------------------------------------------------------------------- */

export type ApproveRefusal =
  | "not_found"
  | "wrong_state"
  | "guards_failed"
  | "already_granted"
  | "confirm_mismatch";

export type ApproveResult =
  | {
      readonly ok: true;
      readonly membershipNo: string;
      readonly validUntil: string;
      readonly label: string;
      readonly slaOutcome: "met" | "breached" | null;
      /** Guards that only passed because of a waiver, named for the message. */
      readonly waived: readonly GuardCode[];
    }
  | {
      readonly ok: false;
      readonly refusal: ApproveRefusal;
      readonly message: string;
      readonly reasons: readonly string[];
    };

export interface ApproveInput {
  readonly applicationId: number;
  readonly version: number;
  /** Optional: a clear file needs no explanation, and prose is not a guard. */
  readonly note: string | null;
  /**
   * The application's own reference, typed by the approver.
   *
   * Compared here and not in the form, because a check the client performs is
   * a ritual and a check the server performs is a control. It exists because
   * granting to the wrong firm cannot be undone — only cancelled, with the
   * number spent either way — and because a checkbox beside "Grant membership"
   * is clicked past without reading which file is open.
   *
   * Case and surrounding space are ignored; nothing else is.
   */
  readonly confirm: string;
}

/**
 * PENDING_APPROVAL → APPROVED, with everything that follows.
 *
 * In one transaction: the company and its link to the applicant, the
 * membership and its first year, the number, the decision row, the state move,
 * the stopped clock, the audit event and the queued email. Any of those
 * failing takes all of them with it, which is the only arrangement under which
 * a membership number cannot exist without the membership it belongs to.
 */
export async function approveApplication(
  actor: ActorContext,
  input: ApproveInput,
): Promise<ApproveResult> {
  requirePermission(actor, "application.approve");

  if (actor.userId === null) {
    // The system actor runs closures and expiries; it never grants. A
    // membership nobody decided to give is not a thing this register holds.
    throw new ForbiddenError(
      null,
      "Only a named approver can grant membership.",
    );
  }

  // Captured here because the narrowing above does not reach inside the
  // transaction closure.
  const actorUserId = actor.userId;
  const now = new Date();

  return transaction(async (tx) => {
    const application = await tx
      .selectFrom("applications")
      .leftJoin(
        "application_company",
        "application_company.application_id",
        "applications.id",
      )
      .select([
        "applications.id",
        "applications.state",
        "applications.version",
        "applications.membership_class",
        "applications.public_ref",
        "applications.created_by",
        "applications.company_id",
        "application_company.firm_name",
      ])
      .where("applications.id", "=", input.applicationId)
      .executeTakeFirst();

    if (!application) {
      return {
        ok: false as const,
        refusal: "not_found" as const,
        message: "That application could not be found.",
        reasons: [],
      };
    }

    const state = application.state as ApplicationState;

    // Refused before anything is written, so a refusal never burns a
    // membership number — the same rule the cashier's desk follows for receipt
    // numbers, and for the same reason: these sequences do not go backwards.
    if (Number(application.version) !== input.version) {
      return {
        ok: false as const,
        refusal: "wrong_state" as const,
        message:
          "This application has changed since the page was loaded. Reload it and " +
          "read the decision somebody else recorded before approving.",
        reasons: [],
      };
    }

    const reference = application.public_ref ?? "";
    if (
      input.confirm.trim().toUpperCase() !== reference.trim().toUpperCase() ||
      reference === ""
    ) {
      return {
        ok: false as const,
        refusal: "confirm_mismatch" as const,
        message:
          reference === ""
            ? "This application has no reference, so it was never submitted and cannot be approved."
            : `Type ${reference} exactly to confirm you are granting membership to this application.`,
        reasons: [],
      };
    }

    const existing = await tx
      .selectFrom("memberships")
      .select(["membership_no"])
      .where("granted_by_application_id", "=", input.applicationId)
      .where("status", "!=", "cancelled")
      .executeTakeFirst();

    if (existing) {
      return {
        ok: false as const,
        refusal: "already_granted" as const,
        message:
          `This application has already granted membership ${existing.membership_no}. ` +
          "A second grant would issue a second number for one firm.",
        reasons: [],
      };
    }

    /**
     * The guards, re-evaluated on the transaction's own connection.
     *
     * This is the separation-of-duties check the plan asks to be done "in SQL
     * inside the approval transaction": `gatherFacts` reads
     * `verification_checklists.completed_by` and `payments.receipted_by` here,
     * not on the connection that rendered the screen. An approver who
     * receipted a fee between loading the page and pressing the button is
     * caught by this read, and would not have been by the page's.
     */
    const facts = await gatherFacts(tx, input.applicationId);
    const decision = canTransition(
      { ...facts, state },
      "approve",
      actorView(actor),
    );

    const waived = await applicableWaivers(
      tx,
      input.applicationId,
      actorUserId,
    );
    const unwaived = decision.failedGuards.filter(
      (code) => !waived.codes.includes(code),
    );

    if (
      !decision.allowed &&
      (decision.missingPermission !== null ||
        decision.unknown ||
        unwaived.length > 0)
    ) {
      return {
        ok: false as const,
        refusal:
          state === "PENDING_APPROVAL"
            ? ("guards_failed" as const)
            : ("wrong_state" as const),
        message:
          state === "PENDING_APPROVAL"
            ? "This application cannot be approved yet."
            : `An application in "${state}" cannot be approved; it has to be sent for approval first.`,
        reasons: unwaived.map((code) => GUARD_MESSAGES[code]),
      };
    }

    const policy = await loadYearPolicy(tx);
    const grantedOn = now.toISOString().slice(0, 10);
    const year = membershipYearFor(grantedOn, policy);

    // The company row, created here because this is the moment a firm becomes
    // a member. `applications.company_id` is filled in at the same time so the
    // application keeps pointing at what it produced.
    const companyId =
      application.company_id === null
        ? await createCompany(tx, {
            name: application.firm_name ?? `Application ${input.applicationId}`,
            applicantUserId: Number(application.created_by),
            actorUserId,
            now,
          })
        : Number(application.company_id);

    // Under the sequence's row lock. Everything above this line can refuse;
    // nothing below it may.
    const membershipNo = await allocateNumber(tx, "membership_no", now);

    const membershipClass = (application.membership_class ??
      "associate") as MembershipClass;

    const inserted = await tx
      .insertInto("memberships")
      .values({
        company_id: companyId,
        membership_no: membershipNo,
        membership_class: membershipClass,
        status: "active",
        granted_on: grantedOn,
        granted_by: actorUserId,
        granted_by_application_id: input.applicationId,
      })
      .executeTakeFirst();

    const membershipId = Number(inserted.insertId);

    // Which fee bought the year, where exactly one did. Two fees — the
    // membership fee and the ITD surcharge — buy one year between them, so the
    // link is left null rather than arbitrarily naming one of them.
    const payments = await tx
      .selectFrom("payments")
      .select(["id"])
      .where("application_id", "=", input.applicationId)
      .where("state", "in", ["receipted", "waived"])
      .execute();

    await tx
      .insertInto("membership_years")
      .values({
        membership_id: membershipId,
        label: year.label,
        starts_on: year.startsOn,
        valid_until: year.validUntil,
        source: "grant",
        payment_id: payments.length === 1 ? Number(payments[0]?.id) : null,
      })
      .execute();

    await moveState(tx, {
      applicationId: input.applicationId,
      fromState: state,
      fromVersion: input.version,
      toState: "APPROVED",
      set: { decided_at: now, company_id: companyId },
    });

    await recordTransition(tx, actor, {
      applicationId: input.applicationId,
      fromState: state,
      toState: "APPROVED",
      transitionCode: "approve",
      reason: input.note,
    });

    await tx
      .insertInto("application_decisions")
      .values({
        application_id: input.applicationId,
        decision: "approved",
        decided_by: actorUserId,
        decided_by_role_code: actor.roleCode,
        decided_at: now,
        reason: input.note,
        membership_id: membershipId,
      })
      .execute();

    const clock = await stopSlaClock(tx, {
      applicationId: input.applicationId,
      at: now,
    });

    await writeAudit(
      actor,
      {
        entityType: "membership",
        entityId: membershipId,
        action: "membership.granted",
        summary:
          `Membership ${membershipNo} granted to ${application.firm_name ?? "the applicant"} ` +
          `on application ${application.public_ref ?? input.applicationId}, valid until ${year.validUntil}.`,
        after: {
          membershipNo,
          membershipClass,
          companyId,
          applicationId: input.applicationId,
          grantedOn,
          year: year.label,
          validUntil: year.validUntil,
          // The paid promise, resolved. Recorded on the event because this is
          // the only moment the answer is knowable without replaying the
          // calendar, and because a breached Executive tier took Rs 20,000 for
          // an undelivered three days.
          slaOutcome: clock.outcome,
          dueDate: clock.dueDate,
          // A guard that only passed because somebody waived it is the most
          // audit-relevant fact on this page.
          waivedGuards: waived.codes,
          note: input.note,
        },
      },
      tx,
    );

    await queueGrantEmail(tx, {
      applicationId: input.applicationId,
      membershipNo,
      membershipClass,
      validUntil: year.validUntil,
      note: input.note,
    });

    return {
      ok: true as const,
      membershipNo,
      validUntil: year.validUntil,
      label: year.label,
      slaOutcome: clock.outcome,
      waived: waived.codes,
    };
  });
}

/**
 * The company, and the applicant's claim on it.
 *
 * `company_users` with `relation: 'owner'` is what lets the member portal find
 * their own membership after they sign in. Without it a granted member would
 * authenticate successfully and see nothing.
 */
async function createCompany(
  tx: Queryable,
  params: {
    readonly name: string;
    readonly applicantUserId: number;
    readonly actorUserId: number;
    readonly now: Date;
  },
): Promise<number> {
  const inserted = await tx
    .insertInto("companies")
    .values({ name: params.name.slice(0, 200) })
    .executeTakeFirst();

  const companyId = Number(inserted.insertId);

  await tx
    .insertInto("company_users")
    .values({
      company_id: companyId,
      user_id: params.applicantUserId,
      relation: "owner",
      added_by: params.actorUserId,
    })
    .execute();

  return companyId;
}

async function queueGrantEmail(
  tx: Queryable,
  params: {
    readonly applicationId: number;
    readonly membershipNo: string;
    readonly membershipClass: MembershipClass;
    readonly validUntil: string;
    readonly note: string | null;
  },
): Promise<void> {
  // `applicantContact` rather than this application's `created_by` account.
  // The two differ whenever a clerk files on behalf of a director, and until
  // A8 put one rule in one place this message went to the account while the
  // deficiency list went to the address on the form — so the Chamber could
  // tell one person the file had been returned and another that it had been
  // granted.
  const contact = await applicantContact(tx, params.applicationId);

  // No address, no message, and the approval still stands. An applicant
  // without an email is not a reason to refuse them membership; it is a reason
  // for the secretariat to telephone them, and the audit event above records
  // the grant either way.
  if (!contact?.email) return;

  await enqueue(
    {
      to: contact.email,
      template: "application-approved",
      payload: {
        reference: contact.reference,
        firmName: contact.firmName,
        membershipNo: params.membershipNo,
        membershipClass:
          params.membershipClass === "corporate" ? "Corporate" : "Associate",
        // Formatted here, as a civil date string. The template takes a string
        // for exactly this reason: a `Date` crossing a timezone would move
        // 31 March to 30 March on the member's screen.
        validUntil: formatDate(params.validUntil),
        note: params.note,
      },
      entityType: "application",
      entityId: params.applicationId,
    },
    tx,
  );
}

/* -------------------------------------------------------------------------- */
/* Refusing, and sending back                                                 */
/* -------------------------------------------------------------------------- */

export type DecisionRefusal = "not_found" | "wrong_state" | "reason_required";

/**
 * The shortest reason this register will store.
 *
 * Ten characters, which is not a quality bar — it is a floor under "no", "ok"
 * and "-". Exported so the action's schema and the transaction enforce the same
 * number: the action is only one caller, and a refusal reason reaching the
 * applicant has to survive a cron job or a bulk tool arriving later with no
 * form in front of it.
 */
export const MIN_REASON_LENGTH = 10;

export type DecisionResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: DecisionRefusal;
      readonly message: string;
      readonly reasons: readonly string[];
    };

/**
 * PENDING_APPROVAL → REJECTED.
 *
 * The reason is mandatory and is stored on the decision rather than only in
 * the audit log, because the applicant will be told it and because "why was my
 * application refused" must be answerable from the file rather than from a
 * hash-chained event stream.
 *
 * The applicant is emailed, from inside this transaction. A refusal is an
 * outcome, and an outcome the register records but never tells anybody is a
 * file that simply goes quiet. The message carries this reason verbatim and is
 * deliberately silent on both the appeal route and what becomes of a receipted
 * fee, because LCCI has defined neither.
 */
export async function rejectApplication(
  actor: ActorContext,
  input: {
    readonly applicationId: number;
    readonly version: number;
    readonly reason: string;
  },
): Promise<DecisionResult> {
  return decide(actor, {
    ...input,
    decision: "rejected",
    permission: "application.reject",
    transitionCode: "reject",
    toState: "REJECTED",
    stopsClock: true,
    auditAction: "application.rejected",
  });
}

/**
 * PENDING_APPROVAL → UNDER_VERIFICATION.
 *
 * An approver short of one document should not have to choose between granting
 * and refusing. The reason is mandatory for the same purpose it is on a
 * deficiency: the officer who gets it back needs to know what to fix.
 *
 * The clock keeps running. The file is back inside the chamber's own hands, and
 * pausing the promise while the chamber works on it would be the chamber
 * excusing its own delay.
 */
export async function returnForVerification(
  actor: ActorContext,
  input: {
    readonly applicationId: number;
    readonly version: number;
    readonly reason: string;
  },
): Promise<DecisionResult> {
  return decide(actor, {
    ...input,
    decision: "returned",
    permission: "application.approve",
    transitionCode: "return_for_verification",
    toState: "UNDER_VERIFICATION",
    stopsClock: false,
    auditAction: "application.returned_for_verification",
  });
}

async function decide(
  actor: ActorContext,
  input: {
    readonly applicationId: number;
    readonly version: number;
    readonly reason: string;
    readonly decision: ApplicationDecisionKind;
    readonly permission: "application.reject" | "application.approve";
    readonly transitionCode: TransitionCode;
    readonly toState: ApplicationState;
    readonly stopsClock: boolean;
    readonly auditAction: string;
  },
): Promise<DecisionResult> {
  requirePermission(actor, input.permission);

  if (actor.userId === null) {
    throw new ForbiddenError(
      null,
      "Only a named approver can record this decision.",
    );
  }

  const actorUserId = actor.userId;
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      refusal: "reason_required",
      message:
        input.decision === "rejected"
          ? "Say why the application is being refused, in a sentence the applicant can act on. They will be told this."
          : "Say what the officer needs to put right, in a sentence they can act on.",
      reasons: [],
    };
  }

  const now = new Date();

  return transaction(async (tx) => {
    const application = await tx
      .selectFrom("applications")
      .select(["id", "state", "version", "public_ref"])
      .where("id", "=", input.applicationId)
      .executeTakeFirst();

    if (!application) {
      return {
        ok: false as const,
        refusal: "not_found" as const,
        message: "That application could not be found.",
        reasons: [],
      };
    }

    const state = application.state as ApplicationState;
    if (Number(application.version) !== input.version) {
      return {
        ok: false as const,
        refusal: "wrong_state" as const,
        message:
          "This application has changed since the page was loaded. Reload it before deciding.",
        reasons: [],
      };
    }

    const facts = await gatherFacts(tx, input.applicationId);
    const decision = canTransition(
      { ...facts, state },
      input.transitionCode,
      actorView(actor),
    );

    if (!decision.allowed) {
      return {
        ok: false as const,
        refusal: "wrong_state" as const,
        message: decision.missingPermission
          ? "You do not hold the permission for this decision."
          : `This application cannot be ${input.decision} from "${state}".`,
        reasons: decision.reasons,
      };
    }

    await moveState(tx, {
      applicationId: input.applicationId,
      fromState: state,
      fromVersion: input.version,
      toState: input.toState,
      set: input.stopsClock ? { decided_at: now } : {},
    });

    await recordTransition(tx, actor, {
      applicationId: input.applicationId,
      fromState: state,
      toState: input.toState,
      transitionCode: input.transitionCode,
      reason,
    });

    await tx
      .insertInto("application_decisions")
      .values({
        application_id: input.applicationId,
        decision: input.decision,
        decided_by: actorUserId,
        decided_by_role_code: actor.roleCode,
        decided_at: now,
        reason: reason.slice(0, 600),
        membership_id: null,
      })
      .execute();

    const clock = input.stopsClock
      ? await stopSlaClock(tx, { applicationId: input.applicationId, at: now })
      : { outcome: null, dueDate: null };

    // A refusal is told to the applicant; a return to verification is not.
    // The file going back to an officer is the Chamber's own business, and
    // emailing "we are still working on it" on every internal handover is how
    // an applicant learns to stop reading mail from us.
    if (input.decision === "rejected") {
      await notifyNotApproved(tx, {
        applicationId: input.applicationId,
        reason,
        feeReceipted: await anyFeeReceipted(tx, input.applicationId),
      });
    }

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: input.applicationId,
        action: input.auditAction,
        summary:
          input.decision === "rejected"
            ? `Application ${application.public_ref ?? input.applicationId} refused.`
            : `Application ${application.public_ref ?? input.applicationId} sent back for verification.`,
        after: {
          reason: reason.slice(0, 600),
          slaOutcome: clock.outcome,
          dueDate: clock.dueDate,
        },
      },
      tx,
    );

    return { ok: true as const };
  });
}

/* -------------------------------------------------------------------------- */
/* Waiving a separation-of-duties guard                                       */
/* -------------------------------------------------------------------------- */

export type WaiverRefusal =
  "not_found" | "not_waivable" | "reason_required" | "already_waived";

export type WaiverResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly refusal: WaiverRefusal;
      readonly message: string;
    };

/**
 * Let one named person break one guard on one application, on the record.
 *
 * This exists because the alternative is worse. A secretariat where the only
 * officer in the building both verified a file and must approve it will find a
 * way — and the way it finds, without this, is a shared login. That destroys
 * the audit log entirely, which is a far greater loss than a recorded,
 * reasoned, super-admin-authorised exception.
 *
 * Deliberately narrow: one guard, one application, one beneficiary, reason
 * mandatory, no expiry. A waiver with a lifetime is a window in which the
 * control is simply off.
 */
export async function waiveConflict(
  actor: ActorContext,
  input: {
    readonly applicationId: number;
    readonly guard: string;
    readonly grantedFor: number;
    readonly reason: string;
  },
): Promise<WaiverResult> {
  // Super-admin only. `role.manage` and not `application.approve`: the whole
  // point is that the person approving cannot clear their own way.
  requirePermission(actor, "role.manage");

  if (actor.userId === null) {
    throw new ForbiddenError(
      null,
      "Only a named super-admin can waive a guard.",
    );
  }

  const actorUserId = actor.userId;

  if (!WAIVABLE.has(input.guard as GuardCode)) {
    return {
      ok: false,
      refusal: "not_waivable",
      message:
        `"${input.guard}" cannot be waived. Only the separation-of-duties guards ` +
        "can: a missing document or an unreceipted fee is a fact about the file, " +
        "and waiving it would be approving an application that does not qualify.",
    };
  }

  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      refusal: "reason_required",
      message:
        "Say why this exception is being made, in a sentence an auditor will read " +
        "years from now without the context you have today.",
    };
  }

  if (input.grantedFor === actorUserId) {
    return {
      ok: false,
      refusal: "not_waivable",
      message:
        "A waiver cannot be granted to yourself. The control exists so that two " +
        "people are involved, and self-waiving removes the second one.",
    };
  }

  return transaction(async (tx) => {
    const application = await tx
      .selectFrom("applications")
      .select(["id", "public_ref"])
      .where("id", "=", input.applicationId)
      .executeTakeFirst();

    if (!application) {
      return {
        ok: false as const,
        refusal: "not_found" as const,
        message: "That application could not be found.",
      };
    }

    const beneficiary = await tx
      .selectFrom("users")
      .select(["id", "full_name"])
      .where("id", "=", input.grantedFor)
      .where("user_type", "=", "staff")
      .executeTakeFirst();

    if (!beneficiary) {
      return {
        ok: false as const,
        refusal: "not_found" as const,
        message: "That staff member could not be found.",
      };
    }

    const existing = await tx
      .selectFrom("conflict_waivers")
      .select(["id"])
      .where("application_id", "=", input.applicationId)
      .where("waived_guard", "=", input.guard)
      .where("granted_for", "=", input.grantedFor)
      .executeTakeFirst();

    if (existing) {
      return {
        ok: false as const,
        refusal: "already_waived" as const,
        message:
          "That guard is already waived for that person on this application.",
      };
    }

    await tx
      .insertInto("conflict_waivers")
      .values({
        application_id: input.applicationId,
        waived_guard: input.guard,
        reason: reason.slice(0, 600),
        granted_by: actorUserId,
        granted_at: new Date(),
        granted_for: input.grantedFor,
      })
      .execute();

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: input.applicationId,
        action: "application.conflict_waived",
        summary:
          `Separation of duties waived on ${application.public_ref ?? input.applicationId}: ` +
          `${beneficiary.full_name ?? `user ${input.grantedFor}`} may approve despite ` +
          `"${input.guard}".`,
        after: {
          guard: input.guard,
          grantedFor: input.grantedFor,
          grantedForName: beneficiary.full_name,
          reason: reason.slice(0, 600),
        },
      },
      tx,
    );

    return { ok: true as const };
  });
}

/** Waivers held by this actor on this application, as guard codes and messages. */
async function applicableWaivers(
  tx: Queryable,
  applicationId: number,
  actorUserId: number,
): Promise<{ codes: GuardCode[] }> {
  const rows = await tx
    .selectFrom("conflict_waivers")
    .select(["waived_guard"])
    .where("application_id", "=", applicationId)
    .where("granted_for", "=", actorUserId)
    .execute();

  // Filtered against `WAIVABLE` on the way out as well as on the way in: a row
  // naming a guard that is no longer waivable must stop having an effect the
  // moment the code says so, not whenever somebody remembers to delete it.
  return {
    codes: rows
      .map((row) => row.waived_guard as GuardCode)
      .filter((code) => WAIVABLE.has(code)),
  };
}

/* -------------------------------------------------------------------------- */
/* Suspension, as the consequence of a dishonoured fee                        */
/* -------------------------------------------------------------------------- */

export type SuspendResult =
  | { readonly ok: true; readonly membershipNo: string }
  | { readonly ok: false; readonly message: string };

/**
 * Suspend the membership a dishonoured fee paid for.
 *
 * `markDishonoured` in `payments.ts` reports `membershipSuspensionOwed` rather
 * than acting, because when it was written this register did not exist and an
 * event claiming a suspension that never happened would have been worse than
 * no event at all. This is the other half of that: the register exists now, so
 * the claim can be made true.
 *
 * Called from the dishonour transaction, so the fee's state and the
 * membership's cannot disagree. Returns rather than throws when there is no
 * membership to suspend: most dishonours arrive before approval, and that is
 * not an error.
 */
export async function suspendForDishonour(
  tx: Queryable,
  actor: ActorContext,
  params: {
    readonly applicationId: number;
    readonly reason: string;
    readonly at: Date;
  },
): Promise<SuspendResult> {
  const membership = await tx
    .selectFrom("memberships")
    .select(["id", "membership_no", "status", "version"])
    .where("granted_by_application_id", "=", params.applicationId)
    .where("status", "in", ["active", "lapsed"])
    .executeTakeFirst();

  if (!membership) {
    return {
      ok: false,
      message: "No live membership was granted by this application.",
    };
  }

  const result = await tx
    .updateTable("memberships")
    .set({
      status: "suspended",
      suspended_at: params.at,
      suspend_reason: `Fee dishonoured: ${params.reason}`.slice(0, 300),
      suspended_by: actor.userId,
      version: Number(membership.version) + 1,
    })
    .where("id", "=", Number(membership.id))
    .where("version", "=", Number(membership.version))
    .executeTakeFirst();

  if (Number(result.numUpdatedRows) !== 1) {
    throw new ConcurrencyError("This membership");
  }

  await writeAudit(
    actor,
    {
      entityType: "membership",
      entityId: Number(membership.id),
      action: "membership.suspended",
      summary:
        `Membership ${membership.membership_no} suspended: the fee that paid for it ` +
        "was returned unpaid.",
      before: { status: membership.status },
      after: { status: "suspended", reason: params.reason.slice(0, 300) },
    },
    tx,
  );

  return { ok: true, membershipNo: membership.membership_no };
}

/**
 * Whether a membership has run out, evaluated on read.
 *
 * Exported for the screens. `lapsed` is never written: a stored flag needs a
 * job to maintain it, and a job that falls behind leaves a lapsed member
 * reading as active — which is the state in which they could endorse somebody.
 */
export async function liveMembershipStatus(
  db: Queryable,
  membershipId: number,
): Promise<MembershipStatus | null> {
  const row = await sql<{ status: MembershipStatus; lapsed: number }>`
    SELECT m.status,
           CASE WHEN MAX(y.valid_until) < CURDATE() THEN 1 ELSE 0 END AS lapsed
      FROM memberships m
      LEFT JOIN membership_years y ON y.membership_id = m.id
     WHERE m.id = ${membershipId}
     GROUP BY m.id, m.status
  `.execute(db);

  const found = row.rows[0];
  if (!found) return null;

  // A suspension or a cancellation outranks expiry: both are decisions, and
  // "lapsed" would make a suspended membership look merely out of date.
  if (found.status !== "active") return found.status;
  return Number(found.lapsed) === 1 ? "lapsed" : "active";
}

/* -------------------------------------------------------------------------- */
/* Who a waiver could be granted to                                           */
/* -------------------------------------------------------------------------- */

/**
 * Staff who hold `application.approve`, other than the actor.
 *
 * For the waiver form's "for whom". The actor is excluded in SQL rather than
 * in the component, so a super-admin cannot waive a guard for themselves even
 * by editing the form — `waiveConflict` refuses it too, and a control worth
 * having is worth enforcing in both places.
 */
export async function approverCandidates(
  actor: ActorContext,
  db: Queryable = getDb(),
): Promise<readonly { id: number; name: string }[]> {
  requirePermission(actor, "role.manage");

  const rows = await sql<{
    id: number;
    full_name: string | null;
    email: string;
  }>`
    SELECT DISTINCT u.id, u.full_name, u.email
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN role_permissions rp ON rp.role_code = ur.role_code
     WHERE u.user_type = 'staff'
       AND u.status = 'active'
       AND rp.permission_code = 'application.approve'
       AND u.id <> ${actor.userId ?? -1}
     ORDER BY u.full_name, u.email
  `.execute(db);

  return rows.rows.map((row) => ({
    id: Number(row.id),
    name: row.full_name ?? row.email,
  }));
}
