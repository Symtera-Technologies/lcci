import { afterAll, expect, it } from "vitest";
import { env } from "@/server/env";
import { databaseAvailable, safeDatabaseName, skipReason, teardown } from "./helpers";

/**
 * Fail loudly when there is nothing to test against.
 *
 * The rest of this directory skips itself when no database is reachable, which
 * is right — but a run that reports "31 skipped" and exits zero is a run that
 * tested nothing while looking like it passed, and the reader cannot tell a
 * missing password from a broken suite.
 *
 * So this one test always runs. `npm run test:db` either exercised the
 * database or says, in one message, exactly why it did not.
 *
 * `ALLOW_NO_DB=1` opts out, for the one legitimate case: a CI job that runs
 * both suites and should not fail the whole build because no MySQL was
 * provisioned for it.
 */

afterAll(teardown);

it("has a database to test against", async () => {
  if (process.env.ALLOW_NO_DB === "1") {
    console.warn("[integration] ALLOW_NO_DB=1 — database tests will skip");
    return;
  }

  const available = await databaseAvailable();

  expect(
    available,
    [
      "",
      "No usable database, so every test in tests/integration/ will skip.",
      "",
      `  host:     ${env.db.host}:${env.db.port}`,
      `  user:     ${env.db.user || "(not set)"}`,
      `  database: ${env.db.database}`,
      `  reason:   ${await skipReason()}`,
      "",
      safeDatabaseName(env.db.database)
        ? "Set DB_USER, DB_PASSWORD and DB_NAME in .env.local, create the database,"
        : `The database name must end in _test, so a run cannot truncate "${env.db.database}".`,
      "then run `npm run migrate`. Or set ALLOW_NO_DB=1 to allow an empty run.",
      "",
    ].join("\n"),
  ).toBe(true);
});
