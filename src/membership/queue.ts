import "server-only";

import { getDb, sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import type {
  ApplicationState,
  MembershipClass,
  ProcessingTier,
} from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { ForbiddenError } from "@/server/actor";
import { publicStage, type PublicStage } from "@/membership/workflow";

/**
 * The verification queue.
 *
 * Read-only, and the one place the office's working list is defined. Three
 * decisions shape it.
 *
 * **Ordered by SLA pressure, not arrival.** The processing tiers are a paid
 * promise in working days — Rs 20,000 buys an answer in three — so a queue
 * sorted by submission date puts a breaching Executive application below a
 * fortnight of Regular ones. Breached first, then by due date, then by
 * arrival as the tie-break.
 *
 * **Breach is evaluated on read.** `sla_clocks.due_date` is a materialised
 * civil date, so `due_date < CURDATE()` is a comparison rather than a
 * calculation, and nothing needs a timer to make yesterday's deadline show as
 * late. Exactly the pattern `getActiveNotice()` already uses for notice expiry.
 *
 * **Scoping is a SQL predicate.** Every filter, including "mine", becomes a
 * `WHERE` clause. A post-fetch `.filter()` has already read the rows, and will
 * leak them through a count, an export or a log line — the count at the top of
 * this page being the obvious one.
 */

/** Which applications an officer is looking at. Internal states, not stages. */
export const QUEUE_SCOPES = {
  /**
   * The default: everything the office still has to act on.
   *
   * `AWAITING_APPLICANT` is deliberately **excluded**. The chamber is not the
   * one holding those up, their SLA clock is paused, and leaving them in the
   * working list is how a queue of thirty real tasks hides inside two hundred
   * rows nobody can act on. They have their own scope.
   */
  open: {
    label: "To action",
    states: [
      "SUBMITTED",
      "UNDER_VERIFICATION",
      "VERIFIED",
      "PENDING_APPROVAL",
    ] as ApplicationState[],
  },
  awaiting: {
    label: "With the applicant",
    states: ["AWAITING_APPLICANT"] as ApplicationState[],
  },
  decided: {
    label: "Decided",
    states: [
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
      "CLOSED_NO_RESPONSE",
    ] as ApplicationState[],
  },
  /**
   * Drafts, which staff can see but must not be mistaken for work.
   *
   * A draft is a form somebody is still filling in; nobody at the chamber has
   * been asked for anything. It is here because "where did my application go"
   * is answered by finding the draft, and nowhere else.
   */
  drafts: {
    label: "Drafts",
    states: ["DRAFT", "DRAFT_EXPIRED", "WITHDRAWAL_REQUESTED"] as ApplicationState[],
  },
} as const satisfies Record<string, { label: string; states: ApplicationState[] }>;

export type QueueScope = keyof typeof QUEUE_SCOPES;

export function isQueueScope(value: unknown): value is QueueScope {
  return typeof value === "string" && value in QUEUE_SCOPES;
}

export interface QueueFilters {
  readonly scope: QueueScope;
  readonly tier?: ProcessingTier;
  /** Only applications whose due date has passed. */
  readonly breachedOnly?: boolean;
  /** Only applications assigned to this actor. */
  readonly mine?: boolean;
  /** Only applications nobody has picked up. */
  readonly unassigned?: boolean;
  /** Firm name or public reference, matched as a prefix. */
  readonly search?: string;
  readonly page?: number;
}

export interface QueueRow {
  readonly id: number;
  readonly publicRef: string | null;
  readonly state: ApplicationState;
  readonly stage: PublicStage;
  readonly firmName: string | null;
  readonly membershipClass: MembershipClass | null;
  readonly processingTier: ProcessingTier | null;
  readonly submittedAt: Date | null;
  /** A civil date string, because it is quoted to the applicant. */
  readonly dueDate: string | null;
  readonly breached: boolean;
  readonly slaState: string | null;
  readonly assignedToName: string | null;
  readonly assignedToId: number | null;
  readonly documentCount: number;
}

export interface QueuePage {
  readonly rows: readonly QueueRow[];
  readonly total: number;
  readonly page: number;
  readonly pageCount: number;
  /** Count per scope, for the tabs, under the same non-scope filters. */
  readonly scopeCounts: Record<QueueScope, number>;
}

/**
 * Twenty-five, which is about one screen at a readable row height.
 *
 * Not a thousand with client-side paging: this list is read on a Pakistani
 * mobile connection as often as on a desk, and the row count is what decides
 * whether that works.
 */
export const PAGE_SIZE = 25;

interface QueueCountRow {
  state: ApplicationState;
  n: number;
}

/**
 * The queue, as one page of rows plus the counts for the tabs.
 *
 * `actor` first, and `application.read` checked here rather than only at the
 * route, because a server action or a future export is just as much a caller
 * as the page is. Authorising in the component that renders the table
 * authorises the table.
 */
export async function loadQueue(
  actor: ActorContext,
  filters: QueueFilters,
  db: Queryable = getDb(),
): Promise<QueuePage> {
  if (!actor.permissions.has("application.read")) {
    throw new ForbiddenError("application.read");
  }

  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const states = QUEUE_SCOPES[filters.scope].states;

  // One builder for the row query and the counts, so a filter cannot be
  // applied to the list and forgotten on the count — which shows up as
  // "29 applications" above a table of four.
  const base = (query: ReturnType<typeof queryRoot>) => {
    let q = query;
    if (filters.tier) q = q.where("applications.processing_tier", "=", filters.tier);
    if (filters.mine && actor.userId) {
      q = q.where("applications.assigned_to", "=", actor.userId);
    }
    if (filters.unassigned) q = q.where("applications.assigned_to", "is", null);
    if (filters.breachedOnly) {
      q = q.where(sql<boolean>`sla_clocks.due_date < CURDATE()`);
    }
    if (filters.search) {
      // Wildcards are stripped rather than escaped, so "Shalimar%Textiles"
      // searches for that literal run of characters and finds nothing — which
      // is the honest answer, and what must never happen is a `%` reaching
      // LIKE as a wildcard. Stripping leaves one case worth handling out
      // loud: a term that was *only* wildcards becomes the empty string, and
      // `LIKE '%'` would then match every row while looking like a filter.
      const stripped = filters.search.replace(/[%_\\]/g, "");
      if (stripped !== "") {
        const term = `${stripped}%`;
        q = q.where((eb) =>
          eb.or([
            eb("application_company.firm_name", "like", term),
            eb("applications.public_ref", "like", term),
          ]),
        );
      }
    }
    return q;
  };

  function queryRoot() {
    return db
      .selectFrom("applications")
      .leftJoin(
        "application_company",
        "application_company.application_id",
        "applications.id",
      )
      // The clock is the ordering key, so a left join: an application with no
      // clock (a draft) must still appear rather than vanishing from its tab.
      .leftJoin("sla_clocks", (join) =>
        join
          .onRef("sla_clocks.application_id", "=", "applications.id")
          .on("sla_clocks.state", "!=", "stopped"),
      )
      .leftJoin("users", "users.id", "applications.assigned_to");
  }

  const rows = await base(queryRoot())
    .where("applications.state", "in", states)
    .select([
      "applications.id",
      "applications.public_ref",
      "applications.state",
      "applications.membership_class",
      "applications.processing_tier",
      "applications.submitted_at",
      "applications.assigned_to",
      "application_company.firm_name",
      "sla_clocks.due_date",
      "sla_clocks.state as sla_state",
      "users.full_name as assigned_name",
    ])
    .select(
      // A correlated count rather than a join: joining documents and grouping
      // would multiply the row set and make every other column need an
      // aggregate. At twenty-five rows the subquery is free.
      //
      // "Live" is the same definition the submit transition uses — not
      // deleted and not superseded. A re-upload after a deficiency supersedes
      // rather than overwriting, so a plain `COUNT(*)` would climb every time
      // an applicant replaced a document and the officer would read it as
      // more evidence than there is.
      sql<number>`(
        SELECT COUNT(*) FROM documents d
         WHERE d.application_id = applications.id
           AND d.deleted_at IS NULL
           AND d.review_state <> 'superseded'
      )`.as("document_count"),
    )
    .select(sql<number>`(sla_clocks.due_date < CURDATE())`.as("breached"))
    .orderBy(sql`sla_clocks.due_date < CURDATE()`, "desc")
    // Nulls last: an application with no clock has no deadline, so it sorts
    // below everything that does rather than above it. MySQL sorts NULL first
    // on ASC, hence the explicit test.
    .orderBy(sql`sla_clocks.due_date IS NULL`, "asc")
    .orderBy("sla_clocks.due_date", "asc")
    .orderBy("applications.id", "asc")
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)
    .execute();

  // Counts for every tab under the same non-scope filters, in one query. Four
  // separate counts would be four round trips on a three-connection pool.
  const counted = await base(queryRoot())
    .select(["applications.state"])
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .groupBy("applications.state")
    .execute();

  const perState = new Map<string, number>();
  for (const row of counted as QueueCountRow[]) {
    perState.set(row.state, Number(row.n));
  }

  const scopeCounts = Object.fromEntries(
    (Object.keys(QUEUE_SCOPES) as QueueScope[]).map((scope) => [
      scope,
      QUEUE_SCOPES[scope].states.reduce(
        (sum, state) => sum + (perState.get(state) ?? 0),
        0,
      ),
    ]),
  ) as Record<QueueScope, number>;

  const total = scopeCounts[filters.scope];

  return {
    rows: rows.map((row) => ({
      id: row.id,
      publicRef: row.public_ref,
      state: row.state,
      stage: publicStage(row.state),
      firmName: row.firm_name,
      membershipClass: row.membership_class,
      processingTier: row.processing_tier,
      submittedAt: row.submitted_at,
      dueDate: row.due_date ?? null,
      breached: Number(row.breached ?? 0) === 1,
      slaState: row.sla_state ?? null,
      assignedToName: row.assigned_name ?? null,
      assignedToId: row.assigned_to,
      documentCount: Number(row.document_count ?? 0),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    scopeCounts,
  };
}

/**
 * How late, or how long left, in whole days.
 *
 * Calendar days rather than working days, and said so where it is shown.
 * Working days would need the calendar table per row, and the number an
 * officer wants at a glance is "is this late and by how much" — the
 * working-day arithmetic that set the deadline has already happened.
 */
export function daysFromDue(dueDate: string | null, today = new Date()): number | null {
  if (!dueDate) return null;
  const due = new Date(`${dueDate}T00:00:00Z`);
  const now = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  return Math.round((due.getTime() - now.getTime()) / 86_400_000);
}
