import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { getDb, withAdvisoryLock } from "@/db/client";
import { migrationStatus, runMigrations } from "@/db/migrate";
import { env } from "@/server/env";
import { databaseAvailable, inParallel, skipReason, teardown } from "./helpers";

/**
 * The migrations, actually executing.
 *
 * `tests/migrations.test.ts` reads the SQL as text and checks its shape —
 * naming, gapless versions, InnoDB, utf8mb4, no CHECK constraints. None of
 * that proves a single statement parses. This does, and it is the only test in
 * the project that can.
 *
 * It also records what the server is, which the plan asks for as the first
 * thing to establish about a host: MySQL and MariaDB disagree about enough to
 * matter, and the answer belongs in the test output rather than in somebody's
 * memory of an SSH session.
 */

const available = await databaseAvailable();
const reason = available ? "" : await skipReason();

if (!available) {
  console.warn(`[integration] skipping database tests: ${reason}`);
}

afterAll(teardown);

describe.skipIf(!available)("the server we are actually talking to", () => {
  it("reports its version, engine and limits", async () => {
    const facts = await sql<{
      version: string;
      engine: string;
      max_user_connections: number;
      max_connections: number;
      sql_mode: string;
      time_zone: string;
      charset: string;
      collation: string;
    }>`
      SELECT VERSION() AS version,
             @@default_storage_engine AS engine,
             @@max_user_connections AS max_user_connections,
             @@max_connections AS max_connections,
             @@sql_mode AS sql_mode,
             @@time_zone AS time_zone,
             @@character_set_database AS charset,
             @@collation_database AS collation
    `.execute(getDb());

    const row = facts.rows[0];
    // Printed, not just asserted: this is the record of what the code was
    // verified against, and the one number that decides the pool size.
    console.log("[integration] server facts", row);

    expect(row).toBeDefined();
    expect(row.charset).toBe("utf8mb4");
  });

  it("stores DATE columns as strings, so 31 March cannot become 30 March", async () => {
    // `dateStrings: ["DATE"]` on the pool. Without it the driver hands back a
    // Date at local midnight, and a membership certificate printed from a
    // timezone west of UTC says the wrong expiry year.
    const result = await sql<{ d: unknown }>`SELECT CAST('2027-03-31' AS DATE) AS d`.execute(
      getDb(),
    );
    expect(typeof result.rows[0].d).toBe("string");
    expect(result.rows[0].d).toBe("2027-03-31");
  });

  it("does not turn DECIMAL into a float", async () => {
    // `decimalNumbers: false`. Money is a string on the way out, because
    // 10650.00 parsed as a double and written back is how a fee stops matching
    // the pay order it was drawn for.
    const result = await sql<{ amount: unknown }>`
      SELECT CAST('10650.00' AS DECIMAL(14,2)) AS amount
    `.execute(getDb());
    expect(typeof result.rows[0].amount).toBe("string");
  });

  it("is in UTC as far as the driver is concerned", async () => {
    const now = await sql<{ t: Date }>`SELECT NOW(3) AS t`.execute(getDb());
    const drift = Math.abs(now.rows[0].t.getTime() - Date.now());
    // Within five minutes. A larger gap means the pool's `timezone: "Z"` is
    // fighting the server's own zone, which silently shifts every timestamp in
    // the audit log and every SLA deadline.
    expect(drift).toBeLessThan(5 * 60_000);
  });
});

describe.skipIf(!available)("the migration runner", () => {
  beforeAll(async () => {
    const outcome = await runMigrations("integration-test");
    console.log(
      `[integration] applied ${outcome.applied.length} migration(s): ${outcome.applied.join(", ") || "none"}`,
    );
  });

  it("applies every migration on disk", async () => {
    const status = await migrationStatus();
    const unapplied = status.filter((entry) => entry.state !== "applied");
    expect(
      unapplied.map((entry) => `${entry.version}:${entry.state}`),
      "every migration on disk must be applied and match its checksum",
    ).toEqual([]);
  });

  it("creates every table the schema types describe", async () => {
    const tables = await sql<{ name: string }>`
      SELECT TABLE_NAME AS name
        FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ${env.db.database}
    `.execute(getDb());

    const present = new Set(tables.rows.map((row) => row.name));

    for (const expected of [
      "schema_migrations",
      "users",
      "roles",
      "permissions",
      "role_permissions",
      "user_roles",
      "sessions",
      "otp_challenges",
      "login_throttle",
      "staff_totp_used",
      "companies",
      "company_users",
      "documents",
      "document_access_log",
      "audit_log",
      "email_outbox",
      "job_runs",
      "rate_limit_counters",
      "rate_limit_events",
      "csp_reports",
    ]) {
      expect(present.has(expected), expected).toBe(true);
    }
  });

  it("uses InnoDB and utf8mb4 on every table it created", async () => {
    // Asserted against the live schema rather than the SQL text, because a
    // server default can override what a CREATE TABLE asks for.
    const tables = await sql<{ name: string; engine: string; collation: string }>`
      SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation
        FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ${env.db.database}
         AND TABLE_TYPE = 'BASE TABLE'
    `.execute(getDb());

    expect(tables.rows.length).toBeGreaterThan(15);
    for (const row of tables.rows) {
      expect(row.engine, row.name).toBe("InnoDB");
      expect(row.collation, row.name).toBe("utf8mb4_unicode_ci");
    }
  });

  it("is idempotent: a second run applies nothing", async () => {
    const second = await runMigrations("integration-test");
    expect(second.applied).toEqual([]);
  });

  it("seeded the RBAC vocabulary", async () => {
    const counts = await sql<{ permissions: number; roles: number; grants: number }>`
      SELECT (SELECT COUNT(*) FROM permissions) AS permissions,
             (SELECT COUNT(*) FROM roles) AS roles,
             (SELECT COUNT(*) FROM role_permissions) AS grants
    `.execute(getDb());

    const row = counts.rows[0];
    expect(Number(row.permissions)).toBeGreaterThan(30);
    expect(Number(row.roles)).toBe(7);
    expect(Number(row.grants)).toBeGreaterThan(50);
  });

  it("granted the super-admin every permission", async () => {
    // The seed does this with `SELECT code FROM permissions` rather than a
    // list, so that it stays correct as permissions are added. This is the
    // assertion that the SELECT form actually worked.
    const result = await sql<{ missing: number }>`
      SELECT COUNT(*) AS missing
        FROM permissions p
       WHERE NOT EXISTS (
               SELECT 1 FROM role_permissions rp
                WHERE rp.role_code = 'super_admin'
                  AND rp.permission_code = p.code
             )
    `.execute(getDb());

    expect(Number(result.rows[0].missing)).toBe(0);
  });

  it("kept verification, receipting and approval on separate roles", async () => {
    // The grant-level half of separation of duties, checked against the rows
    // rather than the constant. A well-meaning edit to the seed that puts
    // `application.approve` on `membership_officer` so a short-staffed office
    // can get on with it would pass every unit test and fail here.
    const conflicts = await sql<{ role_code: string; a: string; b: string }>`
      SELECT a.role_code, a.permission_code AS a, b.permission_code AS b
        FROM role_permissions a
        JOIN role_permissions b ON b.role_code = a.role_code
       WHERE a.role_code <> 'super_admin'
         AND (
              (a.permission_code = 'application.verify'  AND b.permission_code = 'application.approve')
           OR (a.permission_code = 'payment.receipt'     AND b.permission_code = 'application.approve')
         )
    `.execute(getDb());

    expect(
      conflicts.rows,
      `roles holding both: ${conflicts.rows.map((r) => r.role_code).join(", ")}`,
    ).toEqual([]);
  });
});

describe.skipIf(!available)("GET_LOCK single-flight", () => {
  it("lets exactly one caller in", async () => {
    // The cron mutual exclusion, under real contention. Five callers, a zero
    // timeout, one winner — and the four losers must return rather than wait,
    // because waiting holds a connection from a three-connection pool for the
    // duration of someone else's job.
    const name = `lcci:test:${Date.now()}`;
    let concurrent = 0;
    let peak = 0;

    const results = await inParallel(5, async () =>
      withAdvisoryLock(name, 0, async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 150));
        concurrent -= 1;
        return "ran";
      }),
    );

    const acquired = results.filter(
      (result) => result.ok && result.value.acquired,
    ).length;

    expect(peak).toBe(1);
    expect(acquired).toBe(1);
  });

  it("releases the lock when the body throws", async () => {
    const name = `lcci:test:throw:${Date.now()}`;

    await expect(
      withAdvisoryLock(name, 0, async () => {
        throw new Error("job blew up");
      }),
    ).rejects.toThrow("job blew up");

    // If the first call leaked the lock, this one cannot get it — and the
    // real-world symptom would be "cron silently stopped working".
    const second = await withAdvisoryLock(name, 0, async () => "ok");
    expect(second.acquired).toBe(true);
  });
});
