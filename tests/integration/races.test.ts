import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { getDb, retryOnDeadlock } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { writeAudit, verifyAuditChain } from "@/server/audit";
import { systemActor } from "@/server/actor";
import { consume, reset } from "@/server/rate-limit";
import { drain, enqueue, MAX_ATTEMPTS } from "@/server/mail/outbox";
import { setMailer, type Mailer, type OutboundMessage } from "@/server/mail/mailer";
import { runJob } from "@/server/jobs/runner";
import {
  createUser,
  databaseAvailable,
  inParallel,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * The races.
 *
 * Everything here is a claim the unit tests cannot make, because every one of
 * them is about two callers hitting one row and only the database can
 * arbitrate that. Passenger runs several worker processes, so none of these is
 * hypothetical: two overlapping cron ticks and two officers in the same queue
 * are the normal operating condition of this host, not an edge case.
 *
 * What is deliberately *not* here, and why: the two-simultaneous-approvals
 * race and OTP replay, both of which the plan lists. Their tables —
 * `applications`, `number_sequences` and the OTP consumption path — belong to
 * Track A and do not exist yet. Writing those tests now would mean writing
 * them against nothing.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping race tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

/** Collects what was "sent", so a double send is countable. */
class RecordingMailer implements Mailer {
  readonly name = "recording";
  readonly sent: string[] = [];
  failNext = 0;

  async send(message: OutboundMessage) {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("provider rejected the message (HTTP 500)");
    }
    this.sent.push(message.subject);
    return { providerId: `test-${this.sent.length}` };
  }
}

describe.skipIf(!available)("the outbox claim", () => {
  let mailer: RecordingMailer;

  beforeEach(async () => {
    await resetTables(["email_outbox"]);
    mailer = new RecordingMailer();
    setMailer(mailer);
  });

  it("sends each message exactly once under overlapping drains", async () => {
    // The failure this prevents: cPanel cron has no overlap protection, so two
    // ticks will eventually run at the same time. With a SELECT-then-UPDATE
    // claim they both read the same rows and every recipient gets the message
    // twice — which for twenty thousand renewal reminders is forty thousand
    // emails and a blocked sending domain.
    for (let i = 0; i < 12; i += 1) {
      await getDb()
        .insertInto("email_outbox")
        .values({
          to_address: `member${i}@example.org`,
          template: "mail-test",
          payload_json: JSON.stringify({ note: `row-${i}` }),
          channel: "email",
        })
        .execute();
    }

    const results = await inParallel(4, () => drain(20));

    const sentTotal = results.reduce(
      (total, result) => total + (result.ok ? result.value.sent : 0),
      0,
    );

    expect(sentTotal).toBe(12);
    expect(mailer.sent.length).toBe(12);
    expect(new Set(mailer.sent).size).toBe(12);

    const states = await sql<{ state: string; n: number }>`
      SELECT state, COUNT(*) AS n FROM email_outbox GROUP BY state
    `.execute(getDb());
    expect(states.rows).toEqual([{ state: "sent", n: 12 }]);
  });

  it("claims nothing twice even when a drain overlaps itself repeatedly", async () => {
    for (let i = 0; i < 30; i += 1) {
      await getDb()
        .insertInto("email_outbox")
        .values({
          to_address: `m${i}@example.org`,
          template: "mail-test",
          payload_json: JSON.stringify({ note: `n${i}` }),
          channel: "email",
        })
        .execute();
    }

    // Small batches and many concurrent callers: the shape most likely to
    // expose a claim that is not atomic.
    const results = await inParallel(8, () => drain(5));
    const claimed = results.reduce(
      (total, result) => total + (result.ok ? result.value.claimed : 0),
      0,
    );

    // Every claim was distinct, so the total claimed never exceeds the rows.
    expect(claimed).toBeLessThanOrEqual(30);
    expect(new Set(mailer.sent).size).toBe(mailer.sent.length);
  });

  it("backs a failure off and retries it rather than losing it", async () => {
    mailer.failNext = 1;

    await getDb()
      .insertInto("email_outbox")
      .values({
        to_address: "bounces@example.org",
        template: "mail-test",
        payload_json: JSON.stringify({ note: "will-fail-once" }),
        channel: "email",
      })
      .execute();

    const first = await drain(5);
    expect(first.failed).toBe(1);
    expect(first.sent).toBe(0);

    const row = await getDb()
      .selectFrom("email_outbox")
      .select(["state", "attempts", "next_attempt_at", "last_error", "locked_by"])
      .executeTakeFirstOrThrow();

    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.locked_by).toBeNull();
    // Scheduled into the future, so the very next tick does not immediately
    // reproduce the same provider rejection.
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(row.last_error).toContain("provider rejected");

    // Not due yet, so a drain now must leave it alone.
    const second = await drain(5);
    expect(second.claimed).toBe(0);
  });

  it("gives up after the cap instead of retrying forever", async () => {
    await getDb()
      .insertInto("email_outbox")
      .values({
        to_address: "permanent@example.invalid",
        template: "mail-test",
        payload_json: JSON.stringify({ note: "dead-letter" }),
        channel: "email",
        attempts: MAX_ATTEMPTS - 1,
      })
      .execute();

    mailer.failNext = 1;
    await drain(5);

    const row = await getDb()
      .selectFrom("email_outbox")
      .select(["state", "attempts"])
      .executeTakeFirstOrThrow();

    expect(row.state).toBe("dead");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
  });

  it("stores the template and payload, not a rendered body", async () => {
    // So that fixing a typo in an email does not require fixing it in a
    // thousand queued rows, and so the queue holds as little as possible.
    await enqueue({
      to: "someone@example.org",
      template: "mail-test",
      payload: { note: "queued" },
    });

    const row = await getDb()
      .selectFrom("email_outbox")
      .select(["template", "payload_json", "state"])
      .executeTakeFirstOrThrow();

    expect(row.template).toBe("mail-test");
    expect(row.state).toBe("pending");
    expect(row.payload_json).toEqual({ note: "queued" });
  });
});

describe.skipIf(!available)("the audit hash chain", () => {
  beforeEach(async () => {
    await resetTables(["audit_log", "users"]);
  });

  it("links rows and verifies clean", async () => {
    const userId = await createUser("officer@example.org");
    const actor = { ...systemActor("test-request"), userId, roleCode: "reviewer" };

    for (let i = 0; i < 25; i += 1) {
      await writeAudit(actor, {
        entityType: "document",
        entityId: `doc-${i}`,
        action: "document.reviewed",
        summary: `Reviewed document ${i}.`,
        after: { outcome: "accepted", index: i },
      });
    }

    const verification = await verifyAuditChain(0, 100);
    expect(verification.brokenAtId).toBeNull();
    expect(verification.checked).toBe(25);
  });

  it("detects an edited row", async () => {
    // The whole point of the chain on a host where anyone with cPanel access
    // can reach the database. It does not prevent tampering; it makes it
    // detectable.
    const userId = await createUser("officer2@example.org");
    const actor = { ...systemActor("test-request"), userId, roleCode: "reviewer" };

    for (let i = 0; i < 5; i += 1) {
      await writeAudit(actor, {
        entityType: "application",
        entityId: 100 + i,
        action: "application.verified",
        summary: `Verified application ${100 + i}.`,
      });
    }

    const target = await getDb()
      .selectFrom("audit_log")
      .select("id")
      .orderBy("id", "asc")
      .offset(2)
      .limit(1)
      .executeTakeFirstOrThrow();

    await sql`
      UPDATE audit_log SET summary = 'Rejected, actually.' WHERE id = ${target.id}
    `.execute(getDb());

    const verification = await verifyAuditChain(0, 100);
    expect(verification.brokenAtId).toBe(target.id);
  });

  it("detects a deleted row", async () => {
    const userId = await createUser("officer3@example.org");
    const actor = { ...systemActor("test-request"), userId, roleCode: "reviewer" };

    for (let i = 0; i < 5; i += 1) {
      await writeAudit(actor, {
        entityType: "payment",
        entityId: 200 + i,
        action: "payment.receipted",
        summary: `Receipted payment ${200 + i}.`,
      });
    }

    const target = await getDb()
      .selectFrom("audit_log")
      .select("id")
      .orderBy("id", "asc")
      .offset(2)
      .limit(1)
      .executeTakeFirstOrThrow();

    await sql`DELETE FROM audit_log WHERE id = ${target.id}`.execute(getDb());

    const verification = await verifyAuditChain(0, 100);
    expect(verification.brokenAtId).not.toBeNull();
  });

  it("gives every concurrent writer a distinct predecessor", async () => {
    // `FOR UPDATE` on the chain's tail. Without it two transactions read the
    // same previous hash and both claim to follow it, which is not a chain —
    // and the corruption would be introduced by correct-looking code under
    // ordinary load.
    const userId = await createUser("officer4@example.org");
    const actor = { ...systemActor("test-request"), userId, roleCode: "reviewer" };

    await inParallel(8, (index) =>
      writeAudit(actor, {
        entityType: "application",
        entityId: 300 + index,
        action: "application.submitted",
        summary: `Concurrent write ${index}.`,
      }),
    );

    const hashes = await sql<{ prev_hash: string | null; row_hash: string }>`
      SELECT prev_hash, row_hash FROM audit_log ORDER BY id ASC
    `.execute(getDb());

    // Exactly one genesis row, and it must be the first. Filtering the nulls
    // away and checking only what is left is how this assertion used to pass
    // while the chain was entirely broken: every writer read "no predecessor",
    // every row was a genesis row, and a set of nothing has no duplicates in
    // it. Counting them is what makes the test's own title true.
    const prevHashes = hashes.rows.map((row) => row.prev_hash);
    expect(prevHashes.length).toBe(8);
    expect(prevHashes.filter((hash) => hash === null)).toHaveLength(1);
    expect(prevHashes[0]).toBeNull();

    const linked = prevHashes.filter((hash): hash is string => hash !== null);
    expect(new Set(linked).size).toBe(linked.length);

    const verification = await verifyAuditChain(0, 100);
    expect(verification.brokenAtId).toBeNull();
  });
});

describe.skipIf(!available)("the rate limiter", () => {
  beforeEach(async () => {
    await resetTables(["rate_limit_counters", "rate_limit_events"]);
  });

  it("counts correctly when every request arrives at once", async () => {
    // A fixed window implemented as INSERT ... ON DUPLICATE KEY UPDATE, which
    // is atomic across workers. A read-modify-write would undercount here and
    // the limit would simply not apply under the load it exists for.
    const subject = `ip:${randomUUID()}`;
    const results = await inParallel(12, () => consume("publicFormIp", subject));

    const allowed = results.filter((r) => r.ok && r.value.allowed).length;
    expect(allowed).toBe(5);
  });

  it("enforces minimum spacing before volume on the OTP request limit", async () => {
    const subject = `identifier:${randomUUID()}`;

    const first = await consume("otpRequestIdentifier", subject);
    expect(first.allowed).toBe(true);

    // A second request immediately after is refused on spacing, not on
    // volume — which is what stops a form being hammered while leaving a
    // member who genuinely needs a second code able to ask a minute later.
    const second = await consume("otpRequestIdentifier", subject);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.retryAfterSeconds).toBeLessThanOrEqual(60);

    // A spacing refusal must not consume allowance, or three rapid clicks
    // would exhaust an hour's worth of codes.
    const events = await sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM rate_limit_events
    `.execute(getDb());
    expect(Number(events.rows[0].n)).toBe(1);
  });

  it("does not store the subject in a form that can be read back", async () => {
    // The bucket key is an HMAC of the subject, so this table is not an IP log
    // — and the IPv4 space is small enough that an unpeppered hash would be.
    const subject = "ip:203.0.113.42";
    await consume("publicFormIp", subject);

    const rows = await sql<{ bucket: string }>`
      SELECT bucket FROM rate_limit_counters
    `.execute(getDb());

    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].bucket).not.toContain("203.0.113.42");
  });

  it("clears a subject when reset", async () => {
    const subject = `ip:${randomUUID()}`;
    for (let i = 0; i < 5; i += 1) await consume("publicFormIp", subject);
    expect((await consume("publicFormIp", subject)).allowed).toBe(false);

    await reset("publicFormIp", subject);
    expect((await consume("publicFormIp", subject)).allowed).toBe(true);
  });
});

describe.skipIf(!available)("the job runner", () => {
  beforeEach(async () => {
    await resetTables(["job_runs", "email_outbox"]);
    setMailer(new RecordingMailer());
  });

  it("lets one of several simultaneous ticks run", async () => {
    const results = await inParallel(4, () => runJob("email-outbox"));

    const ran = results.filter((r) => r.ok && r.value.status === "ran").length;
    const skipped = results.filter((r) => r.ok && r.value.status === "skipped").length;

    expect(ran).toBe(1);
    expect(skipped).toBe(3);
  });

  it("records the run and leaves the job idle", async () => {
    await runJob("health");

    const row = await getDb()
      .selectFrom("job_runs")
      .select(["job", "state", "run_id", "started_at", "finished_at", "last_summary"])
      .where("job", "=", "health")
      .executeTakeFirstOrThrow();

    expect(row.state).toBe("idle");
    expect(row.finished_at).not.toBeNull();
    // On a host with no monitoring stack, this column read by the admin panel
    // *is* the monitoring.
    expect(row.last_summary).toMatchObject({ dbOk: true, envOk: true });
  });

  it("takes over a job a previous run died holding", async () => {
    // A worker killed by the shared plan's CPU limiter leaves the row
    // `running` with a cold heartbeat. If that could block the next run, one
    // kill would stop the job permanently and the symptom would be silence.
    await getDb()
      .insertInto("job_runs")
      .values({
        job: "health",
        state: "running",
        run_id: "ORPHANEDRUNID00000000000AB",
        started_at: new Date(Date.now() - 3 * 3600_000),
        heartbeat_at: new Date(Date.now() - 3 * 3600_000),
      })
      .execute();

    const outcome = await runJob("health");
    expect(outcome.status).toBe("ran");

    const row = await getDb()
      .selectFrom("job_runs")
      .select(["state", "run_id"])
      .where("job", "=", "health")
      .executeTakeFirstOrThrow();

    expect(row.state).toBe("idle");
    expect(row.run_id).not.toBe("ORPHANEDRUNID00000000000AB");
  });

  it("marks a failing job failed and keeps the error out of the summary", async () => {
    setMailer({
      name: "exploding",
      async send() {
        throw new Error("provider is down");
      },
    });

    await getDb()
      .insertInto("email_outbox")
      .values({
        to_address: "x@example.org",
        template: "mail-test",
        payload_json: JSON.stringify({ note: "boom" }),
        channel: "email",
      })
      .execute();

    // A send failure is handled inside the job, not thrown out of it, so the
    // job itself still succeeds — the message is what failed, and it is
    // retried.
    const outcome = await runJob("email-outbox");
    expect(outcome.status).toBe("ran");

    const row = await getDb()
      .selectFrom("email_outbox")
      .select(["state", "attempts"])
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
  });
});

describe.skipIf(!available)("the document aggregate cap", () => {
  beforeEach(async () => {
    await resetTables(["documents", "applications", "users"]);
  });

  it("holds when files are uploaded in parallel", async () => {
    // The wizard uploads one file per request as each is selected, so parallel
    // uploads are the normal case. The cap is read with SELECT ... FOR UPDATE
    // inside the inserting transaction; checked beforehand in a separate
    // statement, every request would see a total under the limit and all would
    // be allowed.
    const userId = await createUser("applicant@example.org", "portal");

    // A real application row, not a made-up id. `documents.application_id` has
    // referenced `applications` since migration 0008, so a fabricated id now
    // fails the foreign key and every insert is refused — which this test
    // would have reported as the cap working perfectly.
    const application = await getDb()
      .insertInto("applications")
      .values({ created_by: userId, state: "DRAFT" })
      .executeTakeFirstOrThrow();
    const applicationId = Number(application.insertId);

    const sizeEach = 5 * 1024 * 1024;
    const capBytes = 24 * 1024 * 1024;

    const insertOne = async (index: number) => {
      // Through `retryOnDeadlock`, as the upload route does. Eight callers
      // contending on one gap means InnoDB will pick victims, and a victim is
      // a transaction to re-run — not a refusal. Without the retry this test
      // reported three accepted files out of a capacity of four, under load,
      // which is exactly what an applicant uploading four scans at once would
      // have seen.
      return retryOnDeadlock(async (tx) => {
        const existing = await sql<{ bytes: string | number | null }>`
          SELECT COALESCE(SUM(byte_size), 0) AS bytes
            FROM documents
           WHERE application_id = ${applicationId} AND deleted_at IS NULL
           FOR UPDATE
        `.execute(tx);

        const bytes = Number(existing.rows[0]?.bytes ?? 0);
        if (bytes + sizeEach > capBytes) return "refused";

        await tx
          .insertInto("documents")
          .values({
            id: randomUUID(),
            application_id: applicationId,
            membership_id: null,
            document_type_code: "cnic_director",
            subject_kind: "director",
            subject_id: null,
            original_filename: `scan-${index}.jpg`,
            storage_key: `aa/${randomUUID()}.jpg`,
            mime_type: "image/jpeg",
            byte_size: sizeEach,
            sha256: "0".repeat(64),
            pixel_width: 1240,
            pixel_height: 1754,
            page_count: null,
            issued_on: null,
            cipher_version: 1,
            uploaded_by: userId,
            uploaded_at: new Date(),
          })
          .execute();

        return "accepted";
      });
    };

    const results = await inParallel(8, insertOne);
    const accepted = results.filter((r) => r.ok && r.value === "accepted").length;

    // 24 MB cap, 5 MB each: four fit, the fifth would make 25 MB.
    expect(accepted).toBe(4);

    const total = await sql<{ bytes: string | number }>`
      SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM documents
    `.execute(getDb());
    expect(Number(total.rows[0].bytes)).toBeLessThanOrEqual(capBytes);
  });
});
