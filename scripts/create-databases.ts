/**
 * Create the two development databases, and report what the server actually is.
 *
 *   npm run db:create
 *
 * Two databases, not one:
 *
 *   $DB_NAME          what `next dev` and `npm run migrate` use
 *   ${DB_NAME}_test   what `npm run test:db` uses
 *
 * The suffix is not a convention this script invents — `tests/integration/
 * setup.ts` derives it and `helpers.ts` refuses to run against a name that
 * lacks it. The integration suite truncates every table it touches and then
 * asserts on row counts, so pointing it at the development database would
 * silently destroy whatever was being worked on. This script creates both so
 * that neither has to be remembered.
 *
 * It connects without selecting a database, so it deliberately does not use
 * `src/db/pool.ts` — that pool exists to serve requests against a schema that,
 * the first time this runs, is not there yet.
 *
 * Creating a database is not part of the deploy and never will be. On the
 * shared host this is done once, by hand, in cPanel, and the credentials are
 * issued by cPanel rather than chosen. This script is for development
 * machines, and `CREATE DATABASE IF NOT EXISTS` keeps it safe to re-run.
 */

import process from "node:process";
import mysql from "mysql2/promise";

/**
 * Both are resolved here rather than through `src/server/env.ts`.
 *
 * Not to avoid the validation — it would pass — but because this script's job
 * is to make the environment that module describes true, and reading the
 * contract through the thing that enforces it reads backwards. These four
 * values are all it needs.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * MySQL identifiers cannot be bound as parameters, so the name is checked
 * rather than escaped. Deliberately narrower than MySQL allows: a database
 * name arriving here has come from a file somebody edited by hand, and the
 * useful answer to anything surprising in it is to refuse.
 */
function assertSafeName(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(
      `Refusing to create "${name}": a database name must be lowercase ` +
        "letters, digits and underscores, starting with a letter.",
    );
  }
}

async function main(): Promise<number> {
  const host = process.env.DB_HOST ?? "127.0.0.1";
  const port = Number(process.env.DB_PORT ?? 3306);
  const user = required("DB_USER");
  const database = required("DB_NAME");
  const password = process.env.DB_PASSWORD ?? "";

  const names = [database, `${database}_test`];
  for (const name of names) assertSafeName(name);

  let connection: mysql.Connection;
  try {
    connection = await mysql.createConnection({
      host,
      port,
      user,
      password,
      // No `database`: the point of this script is that it may not exist.
      multipleStatements: false,
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.error(`Could not connect to MySQL at ${host}:${port} as "${user}".`);
    console.error("");
    if (code === "ER_ACCESS_DENIED_ERROR") {
      console.error("  The server rejected the credentials.");
      console.error("  Check DB_USER and DB_PASSWORD in .env.local.");
    } else if (code === "ECONNREFUSED") {
      console.error("  Nothing is listening. Is the server running?");
    } else {
      console.error(`  ${(error as Error).message}`);
    }
    return 1;
  }

  try {
    for (const name of names) {
      // utf8mb4 and utf8mb4_unicode_ci to match every CREATE TABLE in
      // migrations/. A database created with the server's default charset
      // would give new tables a different collation from the migrated ones,
      // and the failure surfaces much later as an "Illegal mix of collations"
      // error on a join.
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${name}\`` +
          " CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
      );
      console.log(`  ${name}  ready`);
    }

    /**
     * The three facts the plan asks for on day one, recorded here because this
     * is the first thing that connects.
     *
     * `VERSION()` matters because cPanel ships MariaDB far more often than
     * MySQL 8, and the two diverge on exactly what this schema uses — JSON
     * columns, `VALUES()` in an upsert, index hints. `max_user_connections` is
     * the number `DB_POOL_SIZE` has to divide into once Passenger spawns
     * several workers, each with its own pool.
     */
    const [[server]] = await connection.query<
      ({ version: string; connections: string; wait: string } & mysql.RowDataPacket)[]
    >(
      "SELECT VERSION() AS version," +
        " @@max_user_connections AS connections," +
        " @@wait_timeout AS wait",
    );

    console.log("");
    console.log(`  server    ${server.version}`);
    console.log(
      `  flavour   ${/mariadb/i.test(server.version) ? "MariaDB" : "MySQL"}`,
    );
    console.log(
      "  max_user_connections  " +
        (server.connections === "0" ? "0 (unlimited)" : server.connections),
    );
    console.log(`  wait_timeout          ${server.wait}s`);
    console.log("");
    console.log("Next: npm run migrate");

    return 0;
  } finally {
    await connection.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
