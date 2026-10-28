import "server-only";

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "@/db/pool";
import { withAdvisoryLock } from "@/db/client";

/**
 * Migration runner.
 *
 * Forward-only, numbered `.sql` files in `migrations/`, applied in filename
 * order, recorded in `schema_migrations` with a SHA-256 of the file.
 *
 * Why plain SQL files rather than a migration DSL: this project controls
 * collation, ENGINE, FULLTEXT indexes and a set of MySQL-vs-MariaDB
 * divergences by hand, and — the part that matters operationally — when SSH to
 * a shared cPanel account is unavailable, a `.sql` file can be pasted into
 * phpMyAdmin. A generated migration cannot.
 *
 * Three rules this enforces:
 *
 * - **Checksums are verified.** Editing an already-applied migration is a hard
 *   error, because it is how environments silently diverge: the file says one
 *   thing and the database contains another, and nothing reports it.
 * - **One advisory lock.** Passenger spawns several worker processes, and two
 *   of them starting a migration is a corrupted schema.
 * - **Never at boot.** `runMigrations` is called by the CLI script and by an
 *   authenticated admin route, never from module load. A failed migration
 *   during spawn is an unbootable app with no console to read it.
 *
 * DDL is not transactional in MySQL or MariaDB, so each file performs one
 * logical change. A failure is then diagnosable and the forward fix obvious,
 * instead of leaving half a schema behind.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const LOCK_NAME = "lcci:migrate";

/** `0001_name.sql` — the number orders, the name documents. */
const FILENAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  state: "applied" | "pending" | "checksum-mismatch" | "missing-file";
  appliedAt?: Date;
  appliedBy?: string;
}

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
  skippedLocked: boolean;
}

function checksum(sql: string): string {
  // Normalised so a CRLF checkout and an LF checkout agree. On a Windows dev
  // machine deploying to Linux, they will not otherwise.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });

  const files: MigrationFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;

    const match = FILENAME.exec(entry.name);
    if (!match) {
      throw new Error(
        `migrations/${entry.name} does not match NNNN_lower_snake_case.sql. ` +
          "The filename carries the version, so it is part of the contract.",
      );
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, entry.name), "utf8");
    files.push({
      version: match[1],
      name: match[2],
      filename: entry.name,
      sql,
      checksum: checksum(sql),
    });
  }

  files.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.version)) {
      throw new Error(`Two migrations share version ${file.version}.`);
    }
    seen.add(file.version);
  }

  return files;
}

/**
 * The bootstrap table, created outside the migration sequence.
 *
 * It cannot be migration 0001, because the runner has to read it in order to
 * know whether 0001 has run.
 */
async function ensureLedger(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(20)  NOT NULL,
      name       VARCHAR(120) NOT NULL,
      checksum   CHAR(64)     NOT NULL,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      applied_by VARCHAR(80)  NOT NULL,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

interface LedgerRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
  applied_by: string;
}

async function readLedger(): Promise<Map<string, LedgerRow>> {
  const [rows] = await getPool().query(
    "SELECT version, name, checksum, applied_at, applied_by FROM schema_migrations",
  );
  const map = new Map<string, LedgerRow>();
  for (const row of rows as LedgerRow[]) map.set(row.version, row);
  return map;
}

/**
 * Split a migration file into statements.
 *
 * mysql2 refuses multiple statements on one connection by default, and
 * enabling `multipleStatements` for the pool would weaken every other query in
 * the application for the sake of this one caller. So the file is split here.
 *
 * The splitter is deliberately simple — it respects string literals, backtick
 * identifiers and comments, and it does not attempt to parse `BEGIN ... END`
 * bodies. That is a real limitation, so it is explicit: this project writes no
 * stored procedures, triggers or functions, and if one is ever needed it gets
 * its own loader rather than a cleverer regex.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: '"' | "'" | "`" | null = null;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      current += ch;
      if (ch === "\\" && quote !== "`") {
        // Escape sequence inside a string literal: take the next byte whole.
        if (next !== undefined) {
          current += next;
          i += 2;
          continue;
        }
      } else if (ch === quote) {
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-" && (sql[i + 2] === " " || sql[i + 2] === "\n")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      current += "\n";
      continue;
    }

    if (ch === "#") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      current += "\n";
      continue;
    }

    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += " ";
      continue;
    }

    if (ch === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

export async function migrationStatus(): Promise<MigrationStatus[]> {
  await ensureLedger();
  const [files, ledger] = await Promise.all([loadMigrationFiles(), readLedger()]);

  const statuses: MigrationStatus[] = files.map((file) => {
    const applied = ledger.get(file.version);
    if (!applied) return { version: file.version, name: file.name, state: "pending" };
    return {
      version: file.version,
      name: file.name,
      state: applied.checksum === file.checksum ? "applied" : "checksum-mismatch",
      appliedAt: applied.applied_at,
      appliedBy: applied.applied_by,
    };
  });

  // A row in the ledger with no file on disk means someone applied a migration
  // from a different checkout. Worth reporting rather than ignoring.
  const known = new Set(files.map((f) => f.version));
  for (const [version, row] of ledger) {
    if (!known.has(version)) {
      statuses.push({
        version,
        name: row.name,
        state: "missing-file",
        appliedAt: row.applied_at,
        appliedBy: row.applied_by,
      });
    }
  }

  statuses.sort((a, b) => a.version.localeCompare(b.version));
  return statuses;
}

/**
 * Apply every pending migration, in order, under the advisory lock.
 *
 * `appliedBy` records who ran it — a username over SSH, or the admin user id
 * when run from the authenticated route.
 */
export async function runMigrations(appliedBy: string): Promise<MigrationResult> {
  const outcome = await withAdvisoryLock(LOCK_NAME, 10, async () => {
    await ensureLedger();
    const [files, ledger] = await Promise.all([loadMigrationFiles(), readLedger()]);

    for (const file of files) {
      const applied = ledger.get(file.version);
      if (applied && applied.checksum !== file.checksum) {
        throw new Error(
          `migrations/${file.filename} has changed since it was applied ` +
            `(${applied.applied_at.toISOString()} by ${applied.applied_by}).\n` +
            "Applied migrations are immutable. Write a new migration instead — " +
            "editing this one means the file and the database disagree and " +
            "nothing will tell you which is right.",
        );
      }
    }

    const pending = files.filter((file) => !ledger.has(file.version));
    const done: string[] = [];

    for (const file of pending) {
      const statements = splitStatements(file.sql);
      if (statements.length === 0) {
        throw new Error(`migrations/${file.filename} contains no statements.`);
      }

      const connection = await getPool().getConnection();
      try {
        for (const [index, statement] of statements.entries()) {
          try {
            await connection.query(statement);
          } catch (error) {
            const code =
              error && typeof error === "object" && "code" in error
                ? String((error as { code: unknown }).code)
                : "unknown";
            // The statement is included because it is our own DDL, not user
            // input: there are no bound parameters in a migration, so nothing
            // here can leak an applicant's data into a log.
            //
            // The position, and the warning that follows it, matter as much as
            // the statement. MySQL cannot roll back DDL, so every statement
            // before this one has already taken effect while no ledger row was
            // written — the database is left in a state that is neither
            // "applied" nor "pending", and the next run fails with
            // ER_TABLE_EXISTS on the first CREATE without explaining why.
            // Saying so here is the difference between a five-minute repair
            // and an hour spent reading SHOW TABLES.
            throw new Error(
              `migrations/${file.filename} failed (${code}) at statement ` +
                `${index + 1} of ${statements.length}:\n${statement}\n\n` +
                (index > 0
                  ? `Statements 1-${index} have ALREADY been applied and cannot be ` +
                    `rolled back, so this database is partly migrated with no ledger ` +
                    `row for ${file.version}. Undo what those statements created, or ` +
                    `finish the file by hand and insert the ledger row, before ` +
                    `re-running.`
                  : "Nothing was applied, so this database is unchanged."),
              { cause: error },
            );
          }
        }

        await connection.query(
          "INSERT INTO schema_migrations (version, name, checksum, applied_by) VALUES (?, ?, ?, ?)",
          [file.version, file.name, file.checksum, appliedBy.slice(0, 80)],
        );
      } finally {
        connection.release();
      }

      done.push(file.filename);
    }

    return { applied: done, alreadyApplied: ledger.size, skippedLocked: false };
  });

  if (!outcome.acquired) {
    return { applied: [], alreadyApplied: 0, skippedLocked: true };
  }
  return outcome.value;
}
