/**
 * Check, before `next build` starts, that this environment can produce a build.
 *
 * Wired as npm's `prebuild`, so it runs on every `npm run build` and nobody has
 * to remember it.
 *
 * It exists because the three ways a build of this app fails all fail *badly*.
 * The public pages are statically prerendered and read their content from
 * MySQL, so a build needs a reachable database as much as it needs the source
 * — and when it does not have one, Next reports:
 *
 *     Error occurred prerendering page "/"
 *     Error: connect ECONNREFUSED 127.0.0.1:3306
 *
 * after thirty seconds of compilation, naming a page that does not obviously
 * touch a database and a port nobody set in this repo. A placeholder left in
 * `.env.production.local` is worse: `TypeError: Invalid URL` from
 * `next.config.compiled.js`, with no mention of which variable was wrong.
 *
 * So this fails fast and says which variable, which host, and what to do.
 * Nothing here is a substitute for `src/server/env.ts`, which is the contract
 * the *server* validates at load; this is the subset a *build* needs, checked
 * where the person who can fix it is still watching.
 *
 * **It never prints a secret.** Variable names, and the host and port it tried.
 */

import process from "node:process";
import { loadEnvConfig } from "@next/env";
import mysql from "mysql2/promise";

/**
 * Resolve the environment exactly as `next build` will.
 *
 * Next layers .env.production.local, .env.local, .env.production and .env with
 * a specific precedence, and getting that order wrong here would be worse than
 * not checking at all: the preflight would pass on one set of values while the
 * build failed on another. So Next's own loader does it rather than a
 * hand-written list of --env-file flags.
 *
 * `false` means "not dev", which is what selects the .production files.
 */
loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

/** What a half-filled template looks like in this project and most others. */
const PLACEHOLDERS = ["FILL_ME", "CHANGE_ME", "TODO", "xxx"];

interface Problem {
  readonly what: string;
  readonly fix: string;
}

const problems: Problem[] = [];

function placeholderValue(value: string): boolean {
  const normalised = value.trim().toUpperCase();
  return PLACEHOLDERS.some((p) => normalised === p.toUpperCase());
}

/**
 * The two origins, which are a pair and are routinely half-set.
 *
 * `SITE_ORIGIN` is read by `next.config.ts` for the server-action origin check;
 * `NEXT_PUBLIC_SITE_URL` is read by `src/app/layout.tsx` for `metadataBase` and
 * is inlined into the client bundle. Setting one and not the other produces a
 * site whose canonical URLs point somewhere else entirely, which no test
 * catches and no page looks wrong because of.
 */
function checkOrigins(): void {
  for (const name of ["SITE_ORIGIN", "NEXT_PUBLIC_SITE_URL"]) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;

    if (placeholderValue(raw)) {
      problems.push({
        what: `${name} is still the template placeholder ${JSON.stringify(raw)}.`,
        fix: "Set it to the canonical public origin, scheme included, e.g. https://lcci.com.pk.",
      });
      continue;
    }

    try {
      new URL(raw);
    } catch {
      problems.push({
        what: `${name} is not a valid URL: ${JSON.stringify(raw)}.`,
        fix: "It needs the scheme — https://lcci.com.pk, not lcci.com.pk.",
      });
    }
  }
}

/** Names already reported as placeholders, so nothing is said about them twice. */
const flagged = new Set<string>();

/** Values the build reads that must not be left as a template placeholder. */
function checkPlaceholders(): void {
  for (const name of [
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "PRIVATE_UPLOAD_ROOT",
  ]) {
    const raw = process.env[name]?.trim();
    if (raw && placeholderValue(raw)) {
      flagged.add(name);
      problems.push({
        what: `${name} is still the template placeholder ${JSON.stringify(raw)}.`,
        fix: "Fill it in before building; .env.production.local is read before .env.local.",
      });
    }
  }
}

/**
 * Can this machine reach a database holding the published content?
 *
 * A connection and one trivial statement, not a schema check: the migration
 * runner owns whether the schema is right, and duplicating that here would be
 * a second answer to the same question. All this decides is whether the
 * prerender is about to fail on a socket.
 */
async function checkDatabase(): Promise<void> {
  const host = process.env.DB_HOST?.trim() || "127.0.0.1";
  const port = Number.parseInt(process.env.DB_PORT?.trim() || "3306", 10);
  const user = process.env.DB_USER?.trim();
  const database = process.env.DB_NAME?.trim();

  // Already reported above; saying it twice makes the list look longer than
  // the number of things to fix, which is how people stop reading these.
  if (flagged.has("DB_USER") || flagged.has("DB_NAME") || flagged.has("DB_HOST")) {
    return;
  }

  if (!user || !database) {
    problems.push({
      what: "DB_USER or DB_NAME is not set, so the build cannot read site content.",
      fix: "Set the DB_* variables to a database holding the published content.",
    });
    return;
  }

  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection({
      host,
      port,
      user,
      password: process.env.DB_PASSWORD ?? "",
      database,
      connectTimeout: 10_000,
    });
    await connection.query("SELECT 1");
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "unknown";

    problems.push({
      what: `Cannot reach MySQL at ${host}:${port} (${code}).`,
      fix:
        "The public pages are statically prerendered and read their content " +
        "from MySQL, so the build needs a reachable database — the same one " +
        "the server will use, or a copy of it. Either open an SSH tunnel to " +
        "the target, restore a dump locally and point DB_* at it, or run the " +
        "build on a machine that already has a seeded database.",
    });
  } finally {
    await connection?.end().catch(() => {});
  }
}

async function main(): Promise<number> {
  checkOrigins();
  checkPlaceholders();
  await checkDatabase();

  if (problems.length === 0) return 0;

  console.error("");
  console.error("This build cannot succeed yet:");
  console.error("");
  for (const problem of problems) {
    console.error(`  - ${problem.what}`);
    console.error(`    ${problem.fix}`);
    console.error("");
  }
  console.error(
    `Next reads .env.production.local, then .env.local, then .env — the first ` +
      `one that sets a variable wins. See docs/DEPLOYMENT.md section 2.`,
  );
  console.error("");

  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("Build preflight failed unexpectedly:", error);
    process.exitCode = 1;
  });
