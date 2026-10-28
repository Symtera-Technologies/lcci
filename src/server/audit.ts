import "server-only";

import { getDb, sql } from "@/db/client";
import type { Db, Queryable } from "@/db/client";
import { sha256Hex } from "@/server/crypto";
import { logError } from "@/server/log";
import type { ActorContext } from "@/server/actor";

/**
 * The audit writer — the only way anything reaches `audit_log`.
 *
 * One function rather than scattered inserts, for three reasons that each
 * showed up as a requirement: the hash chain needs the previous row's hash and
 * cannot be computed by a caller; `actor_role_code` must be snapshotted rather
 * than joined, which a caller would forget; and the canonical serialisation
 * has to be identical at write time and at verification time, or the chain
 * reports tampering that never happened.
 *
 * The application's MySQL user holds INSERT and not UPDATE or DELETE on this
 * table — see the note in `migrations/0003_audit.sql`. That is what makes the
 * chain worth having: altering history requires database credentials, not
 * merely a compromise of this process.
 */

export interface AuditEvent {
  /** `application`, `membership`, `document`, `press_release`, `user`, ... */
  entityType: string;
  entityId: string | number;
  /** `application.verification_completed`, `press_release.published`, ... */
  action: string;
  /** Human-readable, written once. Never recomputed from current data. */
  summary: string;
  before?: unknown;
  after?: unknown;
  context?: unknown;
  formRevisionId?: number | null;
}

/**
 * Canonical JSON with sorted keys.
 *
 * The hash is only meaningful if the same event always serialises the same
 * way, and `JSON.stringify` preserves insertion order — so two code paths
 * building the same event with fields in a different order would hash
 * differently and the chain would look broken. Sorting removes the question.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("base64"));

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

/** The fields that go into a row's hash, in a fixed order. */
export function rowHashInput(row: {
  prevHash: string | null;
  occurredAt: string;
  requestId: string;
  actorUserId: number | null;
  actorRoleCode: string | null;
  entityType: string;
  entityId: string;
  action: string;
  summary: string;
  before: string | null;
  after: string | null;
  context: string | null;
}): string {
  return [
    row.prevHash ?? "",
    row.occurredAt,
    row.requestId,
    row.actorUserId ?? "",
    row.actorRoleCode ?? "",
    row.entityType,
    row.entityId,
    row.action,
    row.summary,
    row.before ?? "",
    row.after ?? "",
    row.context ?? "",
  ].join("\u0000");
}

function serialise(value: unknown): string | null {
  if (value === undefined) return null;
  return canonicalJson(value);
}

/**
 * Write one audit event.
 *
 * Pass the transaction when the event belongs to a state change: an approval
 * that commits but whose audit row is lost is exactly the gap this table
 * exists to close, so the event and the change land together or neither does.
 *
 * Reading the previous hash inside the same transaction serialises concurrent
 * writers on the chain's tail, which is correct — a chain with two rows
 * claiming the same predecessor is not a chain. The cost is real but small at
 * this volume, and autosave events are coalesced precisely so that the chain
 * is not the bottleneck for the one high-frequency writer in the system.
 */
export async function writeAudit(
  actor: ActorContext,
  event: AuditEvent,
  db: Queryable = getDb(),
): Promise<void> {
  /**
   * Always inside a transaction, even when the caller did not supply one.
   *
   * `FOR UPDATE` only holds a lock for the length of the enclosing
   * transaction, and in autocommit the transaction is the single statement —
   * so the lock is taken and dropped before the matching INSERT runs, and
   * serialises nothing whatsoever. The default `db = getDb()` meant every
   * caller that did not pass a transaction of its own got exactly that: code
   * that looked correct, carried a comment saying it was correct, and left the
   * chain open to two writers claiming the same predecessor under ordinary
   * concurrent load.
   *
   * A caller that already has a transaction keeps it, so the event and the
   * state change it records still land together or not at all.
   */
  if (!db.isTransaction) {
    await (db as Db).transaction().execute((tx) => writeAudit(actor, event, tx));
    return;
  }

  const occurredAt = new Date();
  const entityId = String(event.entityId);
  const before = serialise(event.before);
  const after = serialise(event.after);
  const context = serialise(event.context);

  /**
   * Lock the head pointer, not the log's last row.
   *
   * `SELECT ... FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE` locks
   * nothing when the log is empty — there is no row there to lock — so every
   * concurrent writer reads "no predecessor" and every one of them writes a
   * genesis row. An empty log is the state of a fresh install and of any
   * restore, which is to say the chain was weakest at exactly the moments it
   * most needed to hold.
   *
   * `audit_chain_head` always has its one row, so this always excludes.
   */
  const head = await sql<{ head_hash: string | null }>`
    SELECT head_hash FROM audit_chain_head WHERE id = 1 FOR UPDATE
  `.execute(db);

  if (head.rows.length === 0) {
    // Migration 0006 seeds this row and nothing deletes it. If it is gone, the
    // chain cannot be appended to safely, and guessing would mean writing a
    // second genesis row into a log that already has one.
    throw new Error("audit_chain_head row is missing; cannot append to the chain");
  }

  const prevHash = head.rows[0].head_hash;

  const rowHash = sha256Hex(
    rowHashInput({
      prevHash,
      occurredAt: occurredAt.toISOString(),
      requestId: actor.requestId,
      actorUserId: actor.userId,
      actorRoleCode: actor.roleCode,
      entityType: event.entityType,
      entityId,
      action: event.action,
      summary: event.summary,
      before,
      after,
      context,
    }),
  );

  const inserted = await db
    .insertInto("audit_log")
    .values({
      occurred_at: occurredAt,
      request_id: actor.requestId,
      actor_user_id: actor.userId,
      actor_role_code: actor.roleCode,
      actor_ip_hash: actor.ipHash,
      actor_user_agent_hash: actor.userAgentHash,
      on_behalf_of_user_id: actor.onBehalfOfUserId,
      entity_type: event.entityType.slice(0, 40),
      entity_id: entityId.slice(0, 64),
      action: event.action.slice(0, 60),
      summary: event.summary.slice(0, 400),
      before_json: before,
      after_json: after,
      context_json: context,
      form_revision_id: event.formRevisionId ?? null,
      prev_hash: prevHash,
      row_hash: rowHash,
    })
    .executeTakeFirstOrThrow();

  // Advance the head in the same transaction, so a rollback takes the pointer
  // back with the row it pointed at. `head_id` is kept alongside the hash so a
  // verifier can confirm the pointer still refers to the log's last row rather
  // than to one that has since been deleted.
  await sql`
    UPDATE audit_chain_head
       SET head_hash = ${rowHash},
           head_id = ${Number(inserted.insertId ?? 0)},
           updated_at = ${occurredAt}
     WHERE id = 1
  `.execute(db);
}

/**
 * Write an audit event without letting a failure take down the action.
 *
 * For events that are worth recording but must not break the request if the
 * audit insert fails: a denied permission, a document view. State changes do
 * NOT use this — they pass the transaction to `writeAudit` so the change and
 * its record are atomic.
 */
export async function tryWriteAudit(
  actor: ActorContext,
  event: AuditEvent,
): Promise<void> {
  try {
    await writeAudit(actor, event);
  } catch (error) {
    logError("audit write failed", error, {
      action: event.action,
      entityType: event.entityType,
      requestId: actor.requestId,
    });
  }
}

export interface ChainVerification {
  checked: number;
  /** The id of the first row whose hash does not follow its predecessor. */
  brokenAtId: number | null;
  lastHash: string | null;
}

/**
 * Walk the chain and report the first break.
 *
 * Run weekly from cron, alerting on a break. A break does not prove tampering
 * — a partially applied restore looks identical — but it does prove the table
 * is no longer a record you can rely on, which is the thing worth knowing.
 *
 * Paged, because this table grows to seven years of events and a full read is
 * not something a shared-plan worker can do in one request.
 */
export async function verifyAuditChain(
  afterId = 0,
  limit = 1000,
): Promise<ChainVerification> {
  const rows = await getDb()
    .selectFrom("audit_log")
    .select([
      "id",
      "occurred_at",
      "request_id",
      "actor_user_id",
      "actor_role_code",
      "entity_type",
      "entity_id",
      "action",
      "summary",
      "before_json",
      "after_json",
      "context_json",
      "prev_hash",
      "row_hash",
    ])
    .where("id", ">", afterId)
    .orderBy("id", "asc")
    .limit(limit)
    .execute();

  let expectedPrev: string | null | undefined;

  for (const row of rows) {
    // The first row of a page inherits its predecessor from the row itself;
    // from then on the chain must be self-consistent.
    if (expectedPrev !== undefined && row.prev_hash !== expectedPrev) {
      return { checked: rows.length, brokenAtId: row.id, lastHash: expectedPrev };
    }

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
        // MySQL returns JSON columns already parsed, so they are re-serialised
        // through the same canonical function used at write time. This is why
        // `canonicalJson` sorts keys: the driver does not promise key order.
        before: row.before_json === null ? null : canonicalJson(row.before_json),
        after: row.after_json === null ? null : canonicalJson(row.after_json),
        context: row.context_json === null ? null : canonicalJson(row.context_json),
      }),
    );

    if (recomputed !== row.row_hash) {
      return { checked: rows.length, brokenAtId: row.id, lastHash: row.prev_hash };
    }

    expectedPrev = row.row_hash;
  }

  return {
    checked: rows.length,
    brokenAtId: null,
    lastHash: expectedPrev ?? null,
  };
}
