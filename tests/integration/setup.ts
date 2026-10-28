import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Environment for the database-backed tests.
 *
 * Deliberately different from `tests/setup.ts`, which stubs the database
 * credentials to nonsense because the unit tests must never reach a server.
 * These tests need the real thing, so this reads `.env.local` — the same file
 * `next dev` reads — rather than inventing a second place to configure a
 * connection.
 *
 * Runs before any module under test is imported, which matters because
 * `src/server/env.ts` validates at load.
 */

function loadEnvFile(file: string): void {
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // The real environment wins, so `DB_NAME=something npm run test:db` works
    // without editing a file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(process.cwd(), ".env.local"));

// NODE_ENV is set to "test" by Vitest and is read-only in its types, so it is
// deliberately not touched here. `env.isProduction` therefore reads false,
// which is what these tests want.
process.env.SITE_ORIGIN ??= "http://localhost:9000";

// Never the configured production upload root: these tests write files, and a
// test run must not be able to put anything into the real document store.
process.env.PRIVATE_UPLOAD_ROOT = mkdtempSync(
  path.join(tmpdir(), "lcci-integration-uploads-"),
);

// Fixed rather than random, so a failure is reproducible. Not secret: nothing
// here encrypts anything anyone keeps.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.IP_HASH_PEPPER ??= Buffer.alloc(32, 9).toString("base64");
process.env.CRON_SECRET ??= "integration-test-cron-secret";

/**
 * A separate database from the development one, always.
 *
 * These tests truncate tables. Pointing them at the database `next dev` uses
 * would mean a test run silently destroying whatever was being worked on, and
 * pointing them at a production database would mean something much worse — so
 * the name is forced to end in `_test` unless it is explicitly overridden, and
 * the guard in `helpers.ts` refuses to run against a name that does not.
 */
process.env.DB_NAME = process.env.TEST_DB_NAME ?? `${process.env.DB_NAME ?? "lcci"}_test`;
