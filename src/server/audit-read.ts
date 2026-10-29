import "server-only";

import { getDb, sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import { canonicalJson, rowHashInput } from "@/server/audit";
import { sha256Hex } from "@/server/crypto";
import { requirePermission, type ActorContext } from "@/server/actor";

/**
 * Reading the audit log back.
 *
 * A separate module from `audit.ts`, and the dependency points this way on
 * purpose: this file imports the writer's `canonicalJson` and `rowHashInput`
 * rather than describing the hash a second time. A reader with its own copy of
 * the serialisation would drift from the writer on the first field added, and
 * the symptom would be a screen reporting tampering that never happened —
 * which is worse than no screen, because the next real break would be assumed
 * to be the same false alarm.
 *
 * **One request, not one row, is the unit worth reading.** A single approval
 * writes a decision event, a membership-created event, a number-allocated
 * event and an SLA-stopped event. `request_id` exists precisely so those four
 * are not four unrelated rows in a table of millions, and a viewer that lists
 * rows flat throws away the one column that makes the log legible. So the page
 * is returned grouped.
 *
 * **Three integrity checks, three different meanings.** They are not
 * interchangeable and the difference decides what a clean screen is worth:
 *
 * - Recomputing a row's own hash detects that the row's *content* was changed.
 * - Checking that each row's `prev_hash` is its predecessor's `row_hash`
 *   detects that a row between them was *deleted*.
 * - Comparing the newest row against `audit_chain_head` detects rows deleted
 *   from the *end* — which linkage alone cannot see, since removing the last
 *   row leaves every surviving link correct. It is also the easiest tampering
 *   to attempt, being one's own last action.
 *
 * Only the first survives filtering: once rows are selected rather than read
 * in sequence, consecutive results are not meant to be adjacent, so a filtered
 * page can say its rows are unaltered and must not claim none is missing.
 */

/**
 * Which of three things the actor is.
 *
 * `deleted` exists because of a trap in the schema. `actor_user_id` is
 * `ON DELETE SET NULL`, and a null `actor_user_id` is also how the log records
 * the system actor — so reading "no user" as "the system" would quietly
 * reattribute a dismissed officer's approvals to a cron job, which is the
 * opposite of what this table is for. The role tells them apart: a cron job has
 * no role, and `actor_role_code` is snapshotted on the row rather than joined,
 * so it survives the account it belonged to.
 *
 * The residual ambiguity is a human who held no role at all and whose account
 * was later deleted. That row cannot be attributed by anything the log stores,
 * and it reads as the system — worth knowing, and not worth a column, since the
 * only events a role-less account can produce are its own refusals.
 */
export type ActorKind = "system" | "user" | "deleted";

/** Who performed the event, as the log recorded it. */
export interface AuditActor {
  readonly kind: ActorKind;
  readonly userId: number | null;
  /**
   * Looked up now, for display. The *role* is read from the row because the
   * hat someone wore is a historical fact; a name is not — it is only a label,
   * and a married name or a corrected spelling should show as it reads today.
   * Null once the account is gone.
   */
  readonly name: string | null;
  readonly roleCode: string | null;
}

function actorOf(row: {
  actor_user_id: number | null;
  actor_role_code: string | null;
  actor_name: string | null;
}): AuditActor {
  const kind: ActorKind =
    row.actor_user_id !== null
      ? "user"
      : row.actor_role_code !== null
        ? "deleted"
        : "system";

  return {
    kind,
    userId: row.actor_user_id,
    name: row.actor_name ?? null,
    roleCode: row.actor_role_code,
  };
}

export type RowIntegrity = "intact" | "altered";

export interface AuditEntry {
  readonly id: number;
  readonly occurredAt: Date;
  readonly requestId: string;
  readonly actor: AuditActor;
  /** Set where staff acted for an applicant, e.g. keying in a postal form. */
  readonly onBehalfOf: { readonly userId: number; readonly name: string | null } | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  /** Written once at the time, never recomputed. Safe to show in a list. */
  readonly summary: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly context: unknown;
  readonly formRevisionId: number | null;
  readonly prevHash: string | null;
  readonly rowHash: string;
  readonly integrity: RowIntegrity;
}

/** The events one HTTP request wrote, in the order it wrote them. */
export interface AuditRequestGroup {
  readonly requestId: string;
  /** The earliest event of this group on this page. */
  readonly occurredAt: Date;
  readonly actor: AuditActor;
  readonly entries: readonly AuditEntry[];
}

export type Linkage =
  /** `brokenAfterId` names the older of the two rows that do not join up. */
  | { readonly kind: "checked"; readonly brokenAfterId: number | null }
  /** A filtered page. Adjacency was never claimed, so nothing was checked. */
  | { readonly kind: "not_checked" };

export interface AuditPage {
  readonly groups: readonly AuditRequestGroup[];
  /** Pass back as `before` to read the next page. Null at the end. */
  readonly nextCursor: number | null;
  /** Ids whose recomputed hash does not match the one stored on the row. */
  readonly altered: readonly number[];
  readonly linkage: Linkage;
  readonly filtered: boolean;
}

export interface AuditFilters {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorUserId?: number;
  readonly action?: string;
  readonly requestId?: string;
  /** Inclusive, as a civil date. */
  readonly from?: string;
  /** Inclusive: the whole of this day is included. */
  readonly to?: string;
  /** Keyset cursor: return rows older than this id. */
  readonly before?: number;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/**
 * One page of the log, newest first, grouped by request.
 *
 * Keyset paging rather than `OFFSET`, because this table holds seven years of
 * events and `OFFSET 50000` reads fifty thousand rows to discard them. There
 * is no total count for the same reason: a filtered `COUNT(*)` over a
 * seven-year table costs more than the page it would annotate, and nothing on
 * a forensic screen is decided by knowing the number is 11,284.
 *
 * `ORDER BY id DESC` is chronological order here, which is a property of this
 * table rather than a general one. Rows are appended while holding the chain
 * head's lock, so ids are issued in the same sequence as the events — unlike
 * the applications queue, where id order and submission order genuinely differ.
 * Paging on the id is then exact, where paging on `occurred_at(3)` could repeat
 * or skip rows written inside one millisecond.
 */
export async function auditPage(
  actor: ActorContext,
  filters: AuditFilters = {},
  db: Queryable = getDb(),
): Promise<AuditPage> {
  requirePermission(actor, "audit.read");

  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  const filtered =
    filters.entityType !== undefined ||
    filters.entityId !== undefined ||
    filters.actorUserId !== undefined ||
    filters.action !== undefined ||
    filters.requestId !== undefined ||
    filters.from !== undefined ||
    filters.to !== undefined;

  let query = db
    .selectFrom("audit_log as al")
    .leftJoin("users as actor", "actor.id", "al.actor_user_id")
    .leftJoin("users as behalf", "behalf.id", "al.on_behalf_of_user_id")
    .select([
      "al.id",
      "al.occurred_at",
      "al.request_id",
      "al.actor_user_id",
      "al.actor_role_code",
      "al.on_behalf_of_user_id",
      "al.entity_type",
      "al.entity_id",
      "al.action",
      "al.summary",
      "al.before_json",
      "al.after_json",
      "al.context_json",
      "al.form_revision_id",
      "al.prev_hash",
      "al.row_hash",
      "actor.full_name as actor_name",
      "behalf.full_name as behalf_name",
    ])
    .orderBy("al.id", "desc")
    // One more than asked for, so the cursor is decided by what exists rather
    // than by a second count query.
    .limit(limit + 1);

  if (filters.entityType !== undefined) {
    query = query.where("al.entity_type", "=", filters.entityType);
  }
  if (filters.entityId !== undefined) {
    query = query.where("al.entity_id", "=", filters.entityId);
  }
  if (filters.actorUserId !== undefined) {
    query = query.where("al.actor_user_id", "=", filters.actorUserId);
  }
  if (filters.action !== undefined) {
    query = query.where("al.action", "=", filters.action);
  }
  if (filters.requestId !== undefined) {
    query = query.where("al.request_id", "=", filters.requestId);
  }
  if (filters.from !== undefined) {
    query = query.where(sql<boolean>`DATE(al.occurred_at) >= ${filters.from}`);
  }
  if (filters.to !== undefined) {
    // `DATE(...)` on both bounds, so "to 5 November" includes the whole of the
    // fifth. A reader who types one date into both boxes means that day, and a
    // half-open comparison against a `DATETIME(3)` would return nothing.
    query = query.where(sql<boolean>`DATE(al.occurred_at) <= ${filters.to}`);
  }
  if (filters.before !== undefined) {
    query = query.where("al.id", "<", filters.before);
  }

  const rows = await query.execute();
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].id : null;

  const altered: number[] = [];

  const entries: AuditEntry[] = page.map((row) => {
    const before = row.before_json === null ? null : canonicalJson(row.before_json);
    const after = row.after_json === null ? null : canonicalJson(row.after_json);
    const context = row.context_json === null ? null : canonicalJson(row.context_json);

    const recomputed = sha256Hex(
      rowHashInput({
        prevHash: row.prev_hash,
        occurredAt: row.occurred_at.toISOString(),
        requestId: row.request_id,
        actorUserId: row.actor_user_id,
        actorRoleCode: row.actor_role_code,
        entityType: row.entity_type,
        entityId: row.entity_id,
        action: row.action,
        summary: row.summary,
        before,
        after,
        context,
      }),
    );

    const integrity: RowIntegrity = recomputed === row.row_hash ? "intact" : "altered";
    if (integrity === "altered") altered.push(row.id);

    return {
      id: row.id,
      occurredAt: row.occurred_at,
      requestId: row.request_id,
      actor: actorOf(row),
      onBehalfOf:
        row.on_behalf_of_user_id === null
          ? null
          : { userId: row.on_behalf_of_user_id, name: row.behalf_name ?? null },
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      summary: row.summary,
      before: row.before_json,
      after: row.after_json,
      context: row.context_json,
      formRevisionId: row.form_revision_id,
      prevHash: row.prev_hash,
      rowHash: row.row_hash,
      integrity,
    };
  });

  return {
    groups: groupByRequest(entries),
    nextCursor,
    altered,
    linkage: filtered ? { kind: "not_checked" } : checkLinkage(entries),
    filtered,
  };
}

/**
 * Walk the page and find the first pair that does not join up.
 *
 * The entries arrive newest first, so each one should be the *predecessor* of
 * the one before it: `entries[i].row_hash === entries[i - 1].prev_hash`. A
 * mismatch means something that sat between them is gone.
 *
 * This is only meaningful on an unfiltered page, and it is also the reason a
 * gap in the ids proves nothing on its own — a rolled-back transaction burns
 * an auto-increment value, so missing ids are ordinary. The hashes are the only
 * evidence of adjacency, and they are self-proving.
 */
function checkLinkage(entries: readonly AuditEntry[]): Linkage {
  for (let i = 1; i < entries.length; i += 1) {
    const newer = entries[i - 1];
    const older = entries[i];
    if (newer.prevHash !== older.rowHash) {
      return { kind: "checked", brokenAfterId: older.id };
    }
  }
  return { kind: "checked", brokenAfterId: null };
}

/**
 * Collapse consecutive entries sharing a request into one group.
 *
 * Consecutive only. The same request cannot reappear later in the log — a
 * request writes its events and ends — so grouping by adjacency keeps the page
 * in time order, where grouping by key would hoist a request to wherever its
 * first row happened to land and quietly reorder the page.
 */
function groupByRequest(entries: readonly AuditEntry[]): AuditRequestGroup[] {
  const groups: AuditRequestGroup[] = [];
  let current: AuditEntry[] = [];

  const flush = () => {
    if (current.length === 0) return;
    // The page runs newest first; within a request the events read in the
    // order they were written, which is how a four-event approval makes sense.
    const ordered = [...current].reverse();
    groups.push({
      requestId: ordered[0].requestId,
      occurredAt: ordered[0].occurredAt,
      actor: ordered[0].actor,
      entries: ordered,
    });
    current = [];
  };

  for (const entry of entries) {
    if (current.length > 0 && current[0].requestId !== entry.requestId) flush();
    current.push(entry);
  }
  flush();

  return groups;
}

export type TailVerdict = "intact" | "rows_missing" | "empty";

export interface LastSweep {
  readonly at: Date | null;
  readonly state: string;
  readonly broken: boolean;
  readonly brokenAtId: number | null;
}

export interface AuditIntegrity {
  readonly headId: number | null;
  readonly headHash: string | null;
  readonly headUpdatedAt: Date;
  readonly newestId: number | null;
  /**
   * Whether the newest row in the table is still the one the head names.
   *
   * `rows_missing` is the finding this check exists for: linkage cannot see a
   * deletion from the end of the chain, because every surviving link remains
   * correct. It is also the only verdict here that a stale head could produce
   * innocently, and there is no innocent way for the head to go stale — it is
   * advanced in the same transaction as the row it points at.
   */
  readonly tail: TailVerdict;
  /** What the weekly `audit-verify` job last found, or null if it never ran. */
  readonly lastSweep: LastSweep | null;
}

/**
 * The chain's head, and what the weekly sweep last reported.
 *
 * The page cannot walk seven years of events on a request, so the honest
 * division is: this screen verifies the rows it is showing, and reports the
 * last full sweep rather than pretending to have done one. A reader seeing
 * "last verified eleven days ago" on a weekly job knows something else is
 * wrong, which is a finding the sweep itself cannot deliver.
 */
export async function auditIntegrity(
  actor: ActorContext,
  db: Queryable = getDb(),
): Promise<AuditIntegrity> {
  requirePermission(actor, "audit.read");

  const head = await db
    .selectFrom("audit_chain_head")
    .select(["head_hash", "head_id", "updated_at"])
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();

  const newest = await db
    .selectFrom("audit_log")
    .select(["id", "row_hash"])
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();

  const tail: TailVerdict =
    newest === undefined
      ? "empty"
      : head.head_id === newest.id && head.head_hash === newest.row_hash
        ? "intact"
        : "rows_missing";

  const sweep = await db
    .selectFrom("job_runs")
    .select(["state", "finished_at", "last_summary"])
    .where("job", "=", "audit-verify")
    .executeTakeFirst();

  return {
    headId: head.head_id,
    headHash: head.head_hash,
    headUpdatedAt: head.updated_at,
    newestId: newest?.id ?? null,
    tail,
    lastSweep:
      sweep === undefined
        ? null
        : {
            at: sweep.finished_at,
            state: sweep.state,
            broken: readBoolean(sweep.last_summary, "broken"),
            brokenAtId: readNumber(sweep.last_summary, "brokenAtId"),
          },
  };
}

function summaryField(summary: unknown, key: string): unknown {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return undefined;
  }
  return (summary as Record<string, unknown>)[key];
}

function readBoolean(summary: unknown, key: string): boolean {
  return summaryField(summary, key) === true;
}

function readNumber(summary: unknown, key: string): number | null {
  const value = summaryField(summary, key);
  return typeof value === "number" ? value : null;
}

/**
 * The entity types the log actually holds, for the filter bar.
 *
 * `DISTINCT` on the leading column of `idx_audit_entity`, which MySQL answers
 * from the index rather than the table. The cardinality is a handful — an
 * entity type is a kind of thing this system records, not a row — so this stays
 * cheap as the log grows. If that ever stops being true the answer is a lookup
 * table written by the writer, not a bigger query here.
 */
export async function auditEntityTypes(
  actor: ActorContext,
  db: Queryable = getDb(),
): Promise<string[]> {
  requirePermission(actor, "audit.read");

  const rows = await db
    .selectFrom("audit_log")
    .select("entity_type")
    .distinct()
    .orderBy("entity_type", "asc")
    .execute();

  return rows.map((row) => row.entity_type);
}
