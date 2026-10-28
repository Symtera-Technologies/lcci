import { sql } from "kysely";
import { getDb } from "@/db/client";
import { getPool, closePool } from "@/db/pool";
import { env } from "@/server/env";

/**
 * Shared machinery for the database-backed tests.
 *
 * Two jobs: decide whether a database is reachable at all, and make it safe to
 * truncate tables. The second matters more than it sounds — these tests empty
 * tables, and the one thing that must be impossible is doing that to the
 * development database somebody is mid-change on, or to production.
 */

/**
 * Is a usable database present?
 *
 * Checked once, and the whole suite skips rather than fails when the answer is
 * no. That is deliberate: `npm test` has to pass on a machine with no MySQL —
 * a laptop, an off-box build runner — or the hermetic unit tests stop being
 * run at all. `npm run test:db` is the opt-in.
 */
export async function databaseAvailable(): Promise<boolean> {
  if (!safeDatabaseName(env.db.database)) return false;

  try {
    await sql`SELECT 1`.execute(getDb());
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse any database whose name does not mark it as disposable.
 *
 * A name check rather than a prompt, because the destructive step is a
 * `DELETE` inside a test and there is nobody watching it run.
 *
 * `_test$` and nothing else. An earlier version also allowed `lcci_dev`, which
 * was precisely backwards: the development database is the one thing this
 * guard exists to protect. `setup.ts` honours `TEST_DB_NAME` verbatim, so that
 * exemption was reachable — `TEST_DB_NAME=lcci_dev npm run test:db` would have
 * emptied every table somebody was working against, and the first sign would
 * have been an empty admin queue.
 */
export function safeDatabaseName(name: string): boolean {
  return /_test$/.test(name);
}

/** Why the suite skipped, for a message that is more use than "0 tests". */
export async function skipReason(): Promise<string> {
  if (!safeDatabaseName(env.db.database)) {
    return `refusing to run against database "${env.db.database}": the name must end in _test`;
  }
  try {
    await sql`SELECT 1`.execute(getDb());
    return "";
  } catch (error) {
    if (!(error instanceof Error)) return "cannot connect";
    /**
     * Flattened, not truncated to the first line.
     *
     * `env.ts` throws a header line followed by one bullet per unusable value,
     * so taking `[0]` yields "Environment is not usable:" — the one part of
     * the message that carries no information. This test exists to say exactly
     * what is wrong, so every line comes through, joined to keep the one-line
     * shape the diagnostic's layout depends on.
     */
    return error.message
      .split("\n")
      .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
      .filter((line) => line !== "")
      .join(" — ");
  }
}

/**
 * Empty the tables a test writes to, children before parents.
 *
 * `TRUNCATE` cannot be used on a table another references, so these are
 * `DELETE`s with foreign key checks suspended for the duration — which is also
 * the only way to clear a cycle like `documents.supersedes_document_id`
 * pointing back at `documents`.
 *
 * Also resets the auto-increment counters, because a test that asserts on an
 * id is a test that passes once.
 */
export async function resetTables(tables: readonly string[]): Promise<void> {
  if (!safeDatabaseName(env.db.database)) {
    throw new Error(`refusing to truncate tables in "${env.db.database}"`);
  }

  const connection = await getPool().getConnection();
  try {
    await connection.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const table of tables) {
      if (!/^[a-z_]{2,40}$/.test(table)) throw new Error(`odd table name: ${table}`);
      await connection.query(`DELETE FROM \`${table}\``);
      await connection.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = 1`);

      /**
       * The chain head is a pointer into `audit_log` and must not outlive it.
       *
       * Left behind, it points at a hash whose row is gone, so the next write
       * chains off a predecessor that does not exist and the verifier reports
       * the chain broken at the first row — a failure that looks exactly like
       * the tampering the chain is built to detect, in a suite where that is
       * the most expensive possible false positive.
       */
      if (table === "audit_log") {
        await connection.query(
          "UPDATE audit_chain_head SET head_hash = NULL, head_id = NULL WHERE id = 1",
        );
      }
    }
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
    connection.release();
  }
}

/** Close the pool so the test process exits instead of hanging on sockets. */
export async function teardown(): Promise<void> {
  await closePool();
}

/**
 * Run several operations genuinely at the same time.
 *
 * `Promise.all` over functions that each take their own connection, which is
 * the closest a single Node process gets to Passenger's several worker
 * processes hitting one row. Not a perfect model — one event loop still
 * serialises the JavaScript between awaits — but it is enough to make a
 * read-then-write race lose, which is the thing being tested.
 */
export async function inParallel<T>(
  count: number,
  work: (index: number) => Promise<T>,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const started = Array.from({ length: count }, (_, index) =>
    work(index).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    ),
  );
  return Promise.all(started);
}

/** Insert a staff user and return its id, for the rows that need an actor. */
export async function createUser(
  email: string,
  userType: "staff" | "portal" = "staff",
): Promise<number> {
  const result = await getDb()
    .insertInto("users")
    .values({
      user_type: userType,
      email,
      full_name: "Integration Test",
      status: "active",
    })
    .executeTakeFirst();

  return Number(result.insertId ?? 0);
}
