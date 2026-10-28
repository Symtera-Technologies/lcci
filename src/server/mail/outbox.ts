import "server-only";

import { after } from "next/server";
import { getDb, sql } from "@/db/client";
import type { Queryable } from "@/db/client";
import { newUlid } from "@/server/crypto";
import { log, logError } from "@/server/log";
import { getMailer } from "@/server/mail/mailer";
import { renderTemplate, type TemplateName, type TemplatePayload } from "@/server/mail/templates";

/**
 * The outbox — a queue built from one table and a cron tick.
 *
 * There is no daemon available on this host, so the usual answer (a worker
 * process draining Redis) is not on offer. What is on offer is a table, an
 * atomic claim and a five-minute cron hit. That is enough, and it is about two
 * hundred lines.
 *
 * The shape that makes it feel instant rather than batched: `enqueue` writes
 * the row and then, inside `after()`, drains a few rows immediately. The happy
 * path therefore delivers within a second of the request, and the cron sweep
 * only ever handles what failed. A queue whose normal case waits for the next
 * tick would make every status email arrive up to five minutes late for no
 * reason at all.
 *
 * `after()` works here *specifically because* Passenger keeps the process alive
 * between requests. The same code on a platform that freezes a function after
 * its response would drop the send. Worth stating, because it is exactly the
 * kind of thing a future reader will "fix" into an inline await — which is the
 * one thing this module exists to avoid.
 */

export interface EnqueueInput<T extends TemplateName> {
  to: string;
  template: T;
  payload: TemplatePayload<T>;
  /** Links the message to what caused it, for the admin's own timeline. */
  entityType?: string;
  entityId?: string | number;
}

/**
 * Queue a message, and try to send it once the response has flushed.
 *
 * Use this for everything except the sign-in code. It never awaits the
 * provider on the request path: a slow API handshake inside a Passenger worker
 * is a request timeout, and a request timeout on a state transition means the
 * transition is rolled back while the user is told nothing useful.
 *
 * Takes an optional `db` so it can be called inside the transaction that
 * caused it. Queuing the grant email in the same transaction as the approval
 * is the only way the two cannot disagree — an approval that commits without
 * its email, or an email promising an approval that rolled back, are both
 * worse than either succeeding alone.
 */
export async function enqueue<T extends TemplateName>(
  input: EnqueueInput<T>,
  db: Queryable = getDb(),
): Promise<number> {
  const id = await insertRow(input, db, "pending");

  if (id > 0) scheduleDrain();
  return id;
}

/**
 * Send one message now, and report whether it left.
 *
 * The *only* intended caller is the sign-in code. The login page must not say
 * "a code is on its way" if the provider rejected the message, so this send is
 * awaited and its failure surfaces to the user. One blocking HTTPS call on a
 * login POST is an acceptable cost; a silently dropped sign-in code is not —
 * it is indistinguishable, from the member's side, from the site being broken.
 *
 * The row is written first and claimed as `sending`, so a message that fails
 * here is retried by the sweep rather than lost. A code that arrives a minute
 * late is worth more than no code at all.
 */
export async function sendNow<T extends TemplateName>(
  input: EnqueueInput<T>,
): Promise<{ sent: boolean }> {
  const db = getDb();
  const id = await insertRow(input, db, "sending");

  try {
    await deliver(id, input.template, input.payload, input.to);
    return { sent: true };
  } catch (error) {
    logError("immediate send failed", error, { template: input.template });
    await markFailed(id, error);
    return { sent: false };
  }
}

async function insertRow<T extends TemplateName>(
  input: EnqueueInput<T>,
  db: Queryable,
  state: "pending" | "sending",
): Promise<number> {
  const inserted = await db
    .insertInto("email_outbox")
    .values({
      // The column is VARCHAR(190); a longer address is not a real one, and
      // truncating here beats a strict-mode insert error on a login attempt.
      to_address: input.to.slice(0, 190),
      template: input.template,
      payload_json: JSON.stringify(input.payload),
      // `channel` is the delivery medium, not the provider stream — SMS and
      // WhatsApp are [TBC] in spec 8.1 and would add values here. The stream
      // is a property of the template and is read at send time.
      channel: "email",
      entity_type: input.entityType ?? null,
      entity_id: input.entityId === undefined ? null : String(input.entityId),
      state,
      ...(state === "sending" ? { locked_at: new Date(), locked_by: newUlid() } : {}),
    })
    .executeTakeFirst();

  return Number(inserted.insertId ?? 0);
}

/**
 * Ask for a drain after the response.
 *
 * `after()` throws outside a request scope, which happens whenever a cron job
 * calls a domain function that enqueues. That is not an error: the row is
 * queued either way and the sweep will take it, which is the correct outcome
 * and the reason the failure is swallowed rather than logged.
 */
function scheduleDrain(): void {
  try {
    after(async () => {
      try {
        await drain(5);
      } catch (error) {
        logError("inline drain failed", error);
      }
    });
  } catch {
    // Not in a request. The cron tick will handle it.
  }
}

/* -------------------------------------------------------------------------- */
/* Draining                                                                   */
/* -------------------------------------------------------------------------- */

export interface DrainResult {
  claimed: number;
  sent: number;
  failed: number;
  /** True when more rows are still due; the next tick continues from here. */
  more: boolean;
}

/**
 * Five retries, then the row is `dead`.
 *
 * The cap matters more than the curve. On a five-minute tick an uncapped retry
 * is 288 attempts a day against a provider that charges per request and counts
 * every rejection against the domain's reputation — so one permanently bad
 * address would quietly degrade delivery for everyone else.
 */
export const MAX_ATTEMPTS = 6;

/** 10m, 20m, 40m, 80m, 160m — roughly five hours before giving up. */
export function backoffMs(attempts: number): number {
  return Math.min(4 * 60 * 60 * 1000, 5 * 60_000 * 2 ** attempts);
}

/**
 * Claim a slice and send it.
 *
 * The claim is a conditional UPDATE followed by a SELECT on `locked_by`, never
 * a SELECT and then an UPDATE. cPanel cron has no overlap protection, so two
 * ticks *will* run concurrently at some point; with the read-then-write shape
 * both would claim the same rows and every recipient would receive the message
 * twice. The UPDATE's own atomicity is the whole mechanism.
 *
 * Bounded and resumable by construction: a small batch, and `more` telling the
 * caller to come back. No job on this host may take time proportional to its
 * backlog, because the shared plan kills long requests — so twenty thousand
 * renewal reminders drain over many ticks rather than one request that dies at
 * minute two having sent four thousand of them with no record of which.
 */
export async function drain(batch = 20, runId = newUlid()): Promise<DrainResult> {
  const db = getDb();
  const now = new Date();

  // `LIMIT` cannot be a bound parameter in a MySQL UPDATE, so the batch size
  // is interpolated — after being forced to an integer, because this is the
  // one value in the module that reaches SQL as a literal.
  const limit = Math.max(1, Math.min(200, Math.trunc(batch)));

  await sql`
    UPDATE email_outbox
       SET state = 'sending', locked_at = ${now}, locked_by = ${runId}
     WHERE state IN ('pending', 'failed')
       AND next_attempt_at <= ${now}
       AND attempts < ${MAX_ATTEMPTS}
     ORDER BY next_attempt_at ASC
     LIMIT ${sql.raw(String(limit))}
  `.execute(db);

  const claimed = await db
    .selectFrom("email_outbox")
    .select(["id", "to_address", "template", "payload_json"])
    .where("locked_by", "=", runId)
    .where("state", "=", "sending")
    .execute();

  let sent = 0;
  let failed = 0;

  for (const row of claimed) {
    try {
      await deliver(row.id, row.template, row.payload_json, row.to_address);
      sent += 1;
    } catch (error) {
      await markFailed(row.id, error);
      failed += 1;
    }
  }

  return { claimed: claimed.length, sent, failed, more: await anyDue() };
}

async function anyDue(): Promise<boolean> {
  const row = await getDb()
    .selectFrom("email_outbox")
    .select(({ fn }) => fn.countAll<number>().as("waiting"))
    .where("state", "in", ["pending", "failed"])
    .where("next_attempt_at", "<=", new Date())
    .where("attempts", "<", MAX_ATTEMPTS)
    .executeTakeFirst();

  return Number(row?.waiting ?? 0) > 0;
}

async function deliver(
  id: number,
  template: string,
  payload: unknown,
  to: string,
): Promise<void> {
  const { stream, ...rendered } = renderTemplate(template, payload);

  await getMailer().send({ to, stream, ...rendered });

  await getDb()
    .updateTable("email_outbox")
    .set({
      state: "sent",
      sent_at: new Date(),
      locked_at: null,
      locked_by: null,
      last_error: null,
    })
    .where("id", "=", id)
    .execute();

  // Template name and stream only. Not the recipient, and not the body: the
  // body of a sign-in code email is a credential.
  log.info("email sent", { template, channel: stream });
}

/**
 * Record a failure and schedule the retry.
 *
 * A read followed by a write, which everywhere else in this system would be a
 * race — and is not one here, for a specific reason: the row reached this
 * function because *this* run's conditional UPDATE claimed it, so no other
 * worker owns it. The claim is what makes the arithmetic safe, which is worth
 * saying out loud, because the pattern is wrong in almost every other place it
 * appears in this codebase.
 *
 * Keeping the curve in TypeScript rather than in the UPDATE is deliberate: the
 * backoff is then one testable function instead of an expression that only a
 * live database can evaluate.
 */
async function markFailed(id: number, error: unknown): Promise<void> {
  // Only the first line of our own message, and nothing from the provider's
  // response body: a rejection commonly echoes the recipient address back, and
  // this column is read by whoever is debugging mail — which is not the same
  // set of people as those entitled to a member's address.
  const reason =
    error instanceof Error
      ? (error.message.split("\n", 1)[0] ?? "").slice(0, 500)
      : "unknown";

  const existing = await getDb()
    .selectFrom("email_outbox")
    .select("attempts")
    .where("id", "=", id)
    .executeTakeFirst();

  if (!existing) return;

  const attempts = existing.attempts + 1;
  const dead = attempts >= MAX_ATTEMPTS;

  await getDb()
    .updateTable("email_outbox")
    .set({
      state: dead ? "dead" : "failed",
      attempts,
      last_error: reason,
      next_attempt_at: new Date(Date.now() + backoffMs(attempts)),
      locked_at: null,
      locked_by: null,
    })
    .where("id", "=", id)
    .execute();

  if (dead) {
    logError("email gave up after repeated failures", error, { count: attempts });
  }
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Drop payloads from old sent rows, keeping the send metadata.
 *
 * The queue is where email payloads accumulate, and some of them name people.
 * Keeping "sent this template to this address on this date" is operationally
 * useful indefinitely; keeping the rendered contents is not, and the retention
 * decision for the rest of the system (open question 7) should not have to
 * cover a queue table as well.
 */
export async function prunePayloads(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);

  const result = await sql`
    UPDATE email_outbox
       SET payload_json = JSON_OBJECT('pruned', TRUE)
     WHERE state IN ('sent', 'dead')
       AND sent_at IS NOT NULL
       AND sent_at < ${cutoff}
       AND JSON_EXTRACT(payload_json, '$.pruned') IS NULL
     LIMIT 500
  `.execute(getDb());

  return Number(result.numAffectedRows ?? 0);
}
