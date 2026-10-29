/**
 * Can this machine reach the database, and does it hold anything to render?
 *
 *   npm run db:check
 *
 * Written for the one failure that costs the most time on this host. The
 * public pages are statically prerendered and read their content from MySQL,
 * so `next build` connects to the database — and when it cannot, Next reports
 * the driver's own error:
 *
 *   Error occurred prerendering page "/"
 *   Error: connect ECONNREFUSED 127.0.0.1:3306
 *
 * which says nothing about why building a homepage needs MySQL, nothing about
 * which setting is wrong, and takes a full build to produce. This answers the
 * same question in a second, before the build, and names the fix.
 *
 * Read-only, and safe in production: it connects, asks the server's version,
 * and counts rows. Nothing here writes.
 */

import process from "node:process";
import { getDb, sql } from "@/db/client";
import { closePool } from "@/db/pool";
import { env, envProblems } from "@/server/env";

interface Diagnosis {
  readonly summary: string;
  readonly fix: readonly string[];
}

/**
 * Turn a driver error into something that names the next action.
 *
 * Each of these corresponds to a different mistake with the same symptom, and
 * the distinction is what decides whether the answer is a socket path, a
 * grant, or a database that was never created.
 */
function diagnose(error: unknown): Diagnosis {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);

  if (code === "ECONNREFUSED") {
    return {
      summary: `Nothing is listening at ${target()}.`,
      fix: [
        "On shared cPanel this usually means MySQL listens on a unix socket",
        "and refuses TCP. mysql2 does NOT read `localhost` as \"use the",
        "socket\" the way PHP does — it resolves it to 127.0.0.1 and dials",
        "TCP — so copying `localhost` out of the cPanel panel produces exactly",
        "this error. Find the socket and set DB_SOCKET:",
        "",
        "    mysqladmin variables | grep '  socket' ",
        "    # or: grep -r '^socket' /etc/my.cnf",
        "    # then in .env:  DB_SOCKET=/var/lib/mysql/mysql.sock",
        "",
        "If MySQL is on another host, set DB_HOST and DB_PORT instead.",
      ],
    };
  }

  if (code === "ER_ACCESS_DENIED_ERROR") {
    return {
      summary: "The server answered and refused these credentials.",
      fix: [
        "Check DB_USER and DB_PASSWORD. On cPanel the user is prefixed with",
        "the account name (`acct_lcci`, not `lcci`), and the user must be",
        "added to the database under MySQL Databases with all privileges —",
        "creating both and never associating them is the usual cause.",
      ],
    };
  }

  if (code === "ER_BAD_DB_ERROR") {
    return {
      summary: `The server answered but has no database named ${env.db.database}.`,
      fix: [
        "Check DB_NAME. On cPanel it is prefixed too (`acct_lcci`).",
      ],
    };
  }

  if (code === "ENOENT") {
    return {
      summary: `No socket at ${env.db.socket}.`,
      fix: [
        "DB_SOCKET points at a path that does not exist. Confirm it with",
        "`mysqladmin variables | grep '  socket'`, or clear DB_SOCKET to use",
        "TCP instead.",
      ],
    };
  }

  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH") {
    return {
      summary: `No route to ${target()} within the connect timeout.`,
      fix: [
        "A firewall or a wrong DB_HOST. If this is a build machine reaching a",
        "remote database, remote MySQL access has to be allowed for this",
        "machine's IP — on cPanel that is Remote MySQL, per address.",
      ],
    };
  }

  return { summary: message, fix: [`Driver code: ${code || "none"}`] };
}

function target(): string {
  return env.db.socket
    ? `socket ${env.db.socket}`
    : `${env.db.host}:${String(env.db.port)}`;
}

async function main(): Promise<number> {
  // Printed before connecting, because half the time the answer is visible
  // here: a default that was never overridden.
  console.log(`database : ${env.db.database}`);
  console.log(`user     : ${env.db.user || "(not set)"}`);
  console.log(`target   : ${target()}`);
  console.log(`pool     : ${String(env.db.connectionLimit)} per process`);
  console.log("");

  const missing = envProblems;
  if (missing.length > 0) {
    console.error("Environment is incomplete:");
    for (const problem of missing) console.error(`  - ${problem}`);
    console.error("");
    console.error(
      "`next build` loads .env and .env.local from the application root. " +
        "Variables set in cPanel's Node.js app screen belong to the running " +
        "application and are NOT exported into an SSH shell, so a build run " +
        "over SSH sees only the files.",
    );
    return 1;
  }

  try {
    const version = await sql<{ v: string }>`SELECT VERSION() AS v`.execute(getDb());
    console.log(`connected: ${version.rows[0]?.v ?? "unknown"}`);
  } catch (error) {
    const { summary, fix } = diagnose(error);
    console.error(`FAILED: ${summary}`);
    console.error("");
    for (const line of fix) console.error(line);
    return 1;
  }

  // Connecting is necessary and not sufficient. A build against an empty
  // database succeeds and ships a homepage with no content, which is the
  // quieter and worse failure of the two.
  try {
    const counts = await sql<{ status: string; n: number }>`
      SELECT status, COUNT(*) AS n FROM content_items GROUP BY status
    `.execute(getDb());

    if (counts.rows.length === 0) {
      console.log("");
      console.log("WARNING: content_items is empty.");
      console.log(
        "A build against this database produces a site with empty sections " +
          "and no error. Run `npm run migrate` if the tables are missing, " +
          "then `npm run seed:content`.",
      );
      return 1;
    }

    console.log("");
    for (const row of counts.rows) {
      console.log(`${row.status.padEnd(10)} ${String(row.n)}`);
    }

    const live = counts.rows.find((row) => row.status === "published");
    if (!live || Number(live.n) === 0) {
      console.log("");
      console.log("WARNING: nothing is published, so every section will render empty.");
      return 1;
    }
  } catch (error) {
    const { summary, fix } = diagnose(error);
    console.error("");
    console.error(`Connected, but reading content_items failed: ${summary}`);
    for (const line of fix) console.error(line);
    console.error("Has `npm run migrate` been run against this database?");
    return 1;
  }

  console.log("");
  console.log("OK — this machine can build the public pages.");
  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
