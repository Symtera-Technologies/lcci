import "server-only";

import { getDb, type Queryable } from "@/db/client";
import type { ActorContext } from "@/server/actor";
import type {
  ApplicationState,
  MembershipClass,
  MembershipStatus,
  ProcessingTier,
} from "@/db/schema";
import {
  PUBLIC_STAGE_LABELS,
  publicStage,
  type PublicStage,
} from "@/membership/workflow";

/**
 * What the applicant can see of their own application.
 *
 * §7.1 commits to "status tracking", and what the site had was one page
 * reachable from one redirect: `/membership/apply` forwards to the application
 * it finds *in flight*, and an approved or refused application is not in
 * flight. So a granted member following the instruction in their own grant
 * email — "sign in to see your membership" — arrived at the wizard, which
 * opened them a fresh draft. Their membership number existed and the site had
 * no page that showed it.
 *
 * Hence two loaders: a list, so every application an applicant has ever filed
 * has a URL, and a timeline, so "where is it?" is answered by the screen
 * rather than by the secretariat's telephone.
 *
 * **Internal states never reach the applicant.** The timeline is built from
 * `application_state_transitions` and then mapped through `publicStage`, with
 * consecutive duplicates collapsed: `UNDER_VERIFICATION → VERIFIED →
 * PENDING_APPROVAL` is one line reading "Under review", because the three are
 * the Chamber's own business and an applicant who learns the word
 * `PENDING_APPROVAL` has learned something only useful for guessing at a
 * process they cannot influence.
 *
 * Every query is scoped by `created_by` in its own `WHERE`. Not a check after
 * the fetch: a row read and then rejected has already been read, and it leaks
 * through a log line, a count or an error message.
 */

export interface TrackerListItem {
  readonly id: number;
  readonly reference: string | null;
  readonly firmName: string | null;
  readonly stage: PublicStage;
  readonly stageLabel: string;
  readonly membershipClass: MembershipClass | null;
  readonly submittedAt: Date | null;
  readonly updatedAt: Date;
  /** Set once granted, so the list can show the number without a second load. */
  readonly membershipNo: string | null;
  /** True where the Chamber is waiting on the applicant. */
  readonly needsYou: boolean;
}

/**
 * Every application this applicant has filed, newest first.
 *
 * Including drafts, and including the terminal ones. A refused application is
 * exactly the thing somebody wants to re-read before applying again, and
 * hiding it would make the refusal email's "you may submit a fresh
 * application" an instruction with no context attached to it.
 */
export async function listApplications(
  actor: ActorContext,
  db: Queryable = getDb(),
): Promise<readonly TrackerListItem[]> {
  if (actor.userId === null) return [];

  const rows = await db
    .selectFrom("applications")
    .leftJoin(
      "application_company",
      "application_company.application_id",
      "applications.id",
    )
    .leftJoin("memberships", (join) =>
      join.onRef(
        "memberships.granted_by_application_id",
        "=",
        "applications.id",
      ),
    )
    .select([
      "applications.id",
      "applications.state",
      "applications.public_ref",
      "applications.membership_class",
      "applications.submitted_at",
      "applications.updated_at",
      "application_company.firm_name",
      "memberships.membership_no",
    ])
    .where("applications.created_by", "=", actor.userId)
    .orderBy("applications.id", "desc")
    .execute();

  return rows.map((row) => {
    const state = row.state as ApplicationState;
    const stage = publicStage(state);
    return {
      id: Number(row.id),
      reference: row.public_ref,
      firmName: row.firm_name,
      stage,
      stageLabel: PUBLIC_STAGE_LABELS[stage],
      membershipClass: row.membership_class,
      submittedAt: row.submitted_at,
      updatedAt: row.updated_at,
      membershipNo: row.membership_no ?? null,
      // The two stages where nothing moves until the applicant acts. A list of
      // five applications should put the one that needs them at a glance,
      // rather than making them open each.
      needsYou: stage === "draft" || stage === "need_info",
    };
  });
}

/* -------------------------------------------------------------------------- */
/* One application's history                                                  */
/* -------------------------------------------------------------------------- */

export interface TimelineEntry {
  readonly stage: PublicStage;
  readonly label: string;
  readonly at: Date;
  /**
   * What the Chamber said at this step, where it said anything.
   *
   * Only for the steps whose reason was written *for the applicant* — the
   * refusal and the deficiency summary. An officer's internal note on sending
   * a file back for re-verification is a note to a colleague and is not shown,
   * because `application_state_transitions.reason` holds both and the
   * difference is not in the column.
   */
  readonly note: string | null;
}

export interface TrackerFee {
  readonly feeKind: "membership" | "itd_surcharge";
  readonly label: string;
  readonly amount: string;
  readonly currency: string;
  readonly settled: boolean;
  readonly receiptNo: string | null;
  readonly receivedAt: Date | null;
  /** True where a receipted instrument was later returned by the bank. */
  readonly dishonoured: boolean;
}

export interface TrackerMembership {
  readonly membershipNo: string;
  readonly membershipClass: MembershipClass;
  readonly status: MembershipStatus;
  readonly grantedOn: string;
  readonly validUntil: string | null;
  readonly yearLabel: string | null;
}

export interface TrackerView {
  readonly applicationId: number;
  readonly reference: string | null;
  readonly firmName: string | null;
  readonly stage: PublicStage;
  readonly stageLabel: string;
  readonly membershipClass: MembershipClass | null;
  readonly processingTier: ProcessingTier | null;
  readonly submittedAt: Date | null;
  readonly dueDate: string | null;
  /** Null while the clock still runs; `met` or `breached` once it is stopped. */
  readonly slaOutcome: string | null;
  readonly timeline: readonly TimelineEntry[];
  readonly fees: readonly TrackerFee[];
  readonly membership: TrackerMembership | null;
}

const FEE_LABELS: Record<"membership" | "itd_surcharge", string> = {
  membership: "Membership fee",
  itd_surcharge: "International Trade Development surcharge",
};

/**
 * One application, as its own applicant sees it.
 *
 * Returns null for both "not yours" and "does not exist", so the caller's
 * `notFound()` cannot be used to discover which application ids exist.
 */
export async function loadTracker(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<TrackerView | null> {
  if (actor.userId === null) return null;

  const application = await db
    .selectFrom("applications")
    .leftJoin(
      "application_company",
      "application_company.application_id",
      "applications.id",
    )
    .leftJoin("sla_clocks", "sla_clocks.application_id", "applications.id")
    .select([
      "applications.id",
      "applications.state",
      "applications.public_ref",
      "applications.membership_class",
      "applications.processing_tier",
      "applications.submitted_at",
      "application_company.firm_name",
      "sla_clocks.due_date",
      "sla_clocks.outcome as sla_outcome",
    ])
    .where("applications.id", "=", applicationId)
    .where("applications.created_by", "=", actor.userId)
    .executeTakeFirst();

  if (!application) return null;

  const state = application.state as ApplicationState;
  const stage = publicStage(state);

  const [timeline, fees, membership] = await Promise.all([
    loadTimeline(db, applicationId),
    loadFees(db, applicationId),
    loadMembership(db, applicationId),
  ]);

  return {
    applicationId: Number(application.id),
    reference: application.public_ref,
    firmName: application.firm_name,
    stage,
    stageLabel: PUBLIC_STAGE_LABELS[stage],
    membershipClass: application.membership_class,
    processingTier: application.processing_tier,
    submittedAt: application.submitted_at,
    dueDate:
      application.due_date === null
        ? null
        : String(application.due_date).slice(0, 10),
    slaOutcome: application.sla_outcome,
    timeline,
    fees,
    membership,
  };
}

/**
 * The public stages this application has passed through, in order.
 *
 * Collapsed on the stage, not on the state. Three internal moves that all mean
 * "Under review" produce one entry dated at the first of them, which is the
 * honest answer to "when did you start looking at it?" — the later two are the
 * file moving between desks.
 *
 * `draft` is dropped. Every application was a draft, the applicant was there,
 * and a timeline whose first line tells them they started filling in a form is
 * padding.
 */
async function loadTimeline(
  db: Queryable,
  applicationId: number,
): Promise<readonly TimelineEntry[]> {
  const rows = await db
    .selectFrom("application_state_transitions")
    .select(["to_state", "transition_code", "reason", "occurred_at"])
    .where("application_id", "=", applicationId)
    .orderBy("occurred_at", "asc")
    .orderBy("id", "asc")
    .execute();

  // Which transitions carry a reason the applicant is meant to read. Keyed on
  // the transition code rather than on whether `reason` is set, because the
  // same column holds an officer's note to a colleague on
  // `return_for_verification` — and showing the applicant that would disclose
  // internal handling they were never told about.
  const APPLICANT_FACING = new Set(["raise_deficiency", "reject"]);

  const entries: TimelineEntry[] = [];

  for (const row of rows) {
    const stage = publicStage(row.to_state as ApplicationState);
    if (stage === "draft") continue;

    const note = APPLICANT_FACING.has(row.transition_code)
      ? (row.reason?.trim() ?? null) || null
      : null;

    const previous = entries.at(-1);
    if (previous?.stage === stage) {
      // Same stage reached again. Keep the earlier timestamp, but do not lose
      // a reason: a second deficiency round is a new thing the applicant has
      // to read, even though the stage has not changed.
      if (note !== null) {
        entries.push({
          stage,
          label: PUBLIC_STAGE_LABELS[stage],
          at: row.occurred_at,
          note,
        });
      }
      continue;
    }

    entries.push({
      stage,
      label: PUBLIC_STAGE_LABELS[stage],
      at: row.occurred_at,
      note,
    });
  }

  return entries;
}

/**
 * What is owed and what has been receipted.
 *
 * Shown to the applicant because the alternative is a telephone call. A firm
 * that posted a pay order three weeks ago has one question — has it been
 * taken in? — and the receipt number answers it without anybody at the Chamber
 * stopping what they are doing.
 */
async function loadFees(
  db: Queryable,
  applicationId: number,
): Promise<readonly TrackerFee[]> {
  const rows = await db
    .selectFrom("payments")
    .select([
      "fee_kind",
      "amount",
      "currency",
      "state",
      "receipt_no",
      "received_at",
    ])
    .where("application_id", "=", applicationId)
    .orderBy("id", "asc")
    .execute();

  return rows.map((row) => ({
    feeKind: row.fee_kind,
    label: FEE_LABELS[row.fee_kind],
    amount: row.amount,
    currency: row.currency,
    // A waived fee is settled: there is nothing left for the applicant to do
    // about it, which is the only thing this flag is asked.
    settled: row.state === "receipted" || row.state === "waived",
    receiptNo: row.receipt_no,
    // The instant it was taken in, formatted by the page. `received_at` is a
    // timestamp and not a civil date, so unlike `valid_until` it is not a
    // value that must survive a timezone unchanged.
    receivedAt: row.received_at,
    dishonoured: row.state === "dishonoured",
  }));
}

/**
 * The membership this application produced, if it produced one.
 *
 * The number and the expiry, which is what the grant email promised the
 * website would show. `MAX(valid_until)` rather than the first year, because
 * a renewal adds a year row and the date the member needs is the latest one.
 */
async function loadMembership(
  db: Queryable,
  applicationId: number,
): Promise<TrackerMembership | null> {
  const row = await db
    .selectFrom("memberships")
    .select([
      "id",
      "membership_no",
      "membership_class",
      "status",
      "granted_on",
    ])
    .where("granted_by_application_id", "=", applicationId)
    .executeTakeFirst();

  if (!row) return null;

  const year = await db
    .selectFrom("membership_years")
    .select(["label", "valid_until"])
    .where("membership_id", "=", Number(row.id))
    .orderBy("valid_until", "desc")
    .executeTakeFirst();

  return {
    membershipNo: row.membership_no,
    membershipClass: row.membership_class,
    status: row.status,
    grantedOn: String(row.granted_on).slice(0, 10),
    validUntil:
      year?.valid_until === undefined
        ? null
        : String(year.valid_until).slice(0, 10),
    yearLabel: year?.label ?? null,
  };
}
