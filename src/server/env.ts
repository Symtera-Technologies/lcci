import "server-only";

import { existsSync, accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/**
 * Environment contract — read once, validated once, at module load.
 *
 * Everything the server needs from the environment is resolved here and
 * nowhere else, so there is a single list of what has to be set on the host
 * and a single place that explains what each value is for.
 *
 * The assertions deliberately throw. Under Passenger a throw at module load is
 * a 503 and a line in the error log, which is the correct outcome for a
 * misconfigured deployment: the alternative is an app that boots happily and
 * writes applicants' identity documents into a directory Apache serves to
 * anyone who guesses the URL. A missing upload root is not a degraded mode.
 *
 * Builds are a deliberate exception. `next build` evaluates server modules to
 * collect metadata and runs off-box, where no database or upload directory
 * exists, so during a build the checks downgrade to a recorded problem. Any
 * request that actually needs a value then fails on `requireEnv()`.
 */

const PHASE_BUILD = process.env.NEXT_PHASE === "phase-production-build";

/** Problems found at load. Empty in a correctly configured runtime. */
const problems: string[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    problems.push(`${name} is not set`);
    return "";
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    problems.push(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return parsed;
}

/**
 * The private upload root.
 *
 * Four separate checks, because each one corresponds to a mistake that has a
 * different cause and the same consequence:
 *
 * - unset, so files would land wherever the process happens to be;
 * - inside the application root, where `docs/DEPLOYMENT.md`'s release step
 *   (`rm -rf .next` then `cp -r .next/standalone/. .`) can delete them, and
 *   where one added `--delete` takes applicants' CNICs with it;
 *   `public/` is the worst case of this and is called out by name, because
 *   everything under it is served with no auth, no logging and no
 *   `Content-Disposition` — and `nosniff` does not help when the file really
 *   is a JPEG;
 * - missing, because the directory is created once by hand and never by the
 *   deploy, so its absence means this host was never prepared;
 * - not writable, which is the same mistake wearing a permissions mask.
 */
function uploadRoot(): string {
  const raw = process.env.PRIVATE_UPLOAD_ROOT;
  if (!raw || raw.trim() === "") {
    problems.push(
      "PRIVATE_UPLOAD_ROOT is not set. It must be an absolute path OUTSIDE the " +
        "application root — uploads hold CNICs, passports and bank certificates.",
    );
    return "";
  }

  // `turbopackIgnore` because this path is resolved at runtime from the
  // environment and must not be traced into the bundle. That is the entire
  // design: the document store lives outside the application root so that
  // `rm -rf .next` and the release copy cannot reach it. A statically scoped
  // path — which is what the build would prefer — would put applicant identity
  // documents one careless `--delete` away from deletion.
  const resolved = path.resolve(/*turbopackIgnore: true*/ raw.trim());
  // Ignored for the same reason, and this one matters more: without it the
  // build traces the whole project — `public/` included — into the server
  // output, which on a plan that already OOMs during `next build` is the
  // difference between a deploy and a failure. Nothing is read here; the two
  // paths are only compared, to refuse an upload root inside the app root.
  const appRoot = path.resolve(/*turbopackIgnore: true*/ process.cwd());

  if (resolved === appRoot || resolved.startsWith(appRoot + path.sep)) {
    problems.push(
      `PRIVATE_UPLOAD_ROOT (${resolved}) resolves inside the application root ` +
        `(${appRoot}). Identity documents must live outside the deploy path.`,
    );
    return resolved;
  }

  if (PHASE_BUILD) return resolved;

  if (!existsSync(resolved)) {
    problems.push(
      `PRIVATE_UPLOAD_ROOT (${resolved}) does not exist. Create it by hand with ` +
        "mode 700; the release script must never create it.",
    );
    return resolved;
  }

  if (!statSync(resolved).isDirectory()) {
    problems.push(`PRIVATE_UPLOAD_ROOT (${resolved}) is not a directory.`);
    return resolved;
  }

  try {
    accessSync(resolved, constants.W_OK | constants.X_OK);
  } catch {
    problems.push(`PRIVATE_UPLOAD_ROOT (${resolved}) is not writable by this process.`);
  }

  return resolved;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProduction: process.env.NODE_ENV === "production",

  /**
   * The canonical public origin, e.g. `https://lcci.com.pk`.
   *
   * Load-bearing twice over: it is the `Origin` every state-changing server
   * action is compared against, and it is the domain OTP mail must come from.
   * Sending login codes from a domain other than the one in the address bar
   * teaches members to accept LCCI mail from varied domains, which is the
   * condition phishing needs. See open question 15 in the plan.
   */
  siteOrigin: required("SITE_ORIGIN").replace(/\/+$/, ""),

  db: {
    host: optional("DB_HOST", "127.0.0.1"),
    port: int("DB_PORT", 3306),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
    /**
     * Per-process pool size, NOT per-application.
     *
     * Passenger spawns several worker processes and each gets its own pool, so
     * the real connection count is this number times the worker count. Shared
     * cPanel MySQL commonly caps `max_user_connections` at 10-30, and
     * exceeding it surfaces as intermittent ER_CON_COUNT_ERROR under exactly
     * the load you most want to work. Treat this as a deployment constant
     * measured against the host, not a default to tune for throughput.
     */
    connectionLimit: int("DB_POOL_SIZE", 3),
  },

  /** Where uploaded documents live. Never under `public/`, never in the app root. */
  uploadRoot: uploadRoot(),

  /**
   * Master key for envelope-encrypting document bytes and the few encrypted
   * columns (CNIC, passport, NTN, bank account, TOTP secret). 32 bytes, base64.
   *
   * This protects against filesystem exposure — a backup tarball leaving the
   * server, cPanel's own backup store, another tenant reading a stray path —
   * and NOT against application compromise, because the app can obviously
   * decrypt what it encrypts. That is still most of the realistic threat model
   * on shared hosting, where no disk encryption is available at all.
   */
  encryptionKey: required("ENCRYPTION_KEY"),

  /** Pepper for hashing IPs before they become log or rate-limit keys. */
  ipPepper: required("IP_HASH_PEPPER"),

  /** Shared secret the cPanel cron job presents as a bearer token. */
  cronSecret: required("CRON_SECRET"),
} as const;

/** True when every required value is present and every path check passed. */
export const envIsValid = problems.length === 0;

/** The problems found at load, for the health route and the boot log. */
export const envProblems: readonly string[] = problems;

/**
 * Assert the environment before doing work that depends on it.
 *
 * Called at the top of the database pool, the document store and the cron
 * route rather than at module load, so that an off-box `next build` — which
 * has no database and no upload directory — still completes, while any real
 * request that needs a value fails loudly instead of half-working.
 */
export function requireEnv(): void {
  if (envIsValid) return;
  throw new Error(
    `Environment is not usable:\n  - ${problems.join("\n  - ")}\n` +
      "See .env.example for what each value is and why it is required.",
  );
}

if (!envIsValid && !PHASE_BUILD) {
  // Written once, at load, so a misconfigured host says why in its error log
  // instead of only failing on the first request that happens to need a value.
  console.error(
    `[lcci] environment is not usable:\n  - ${problems.join("\n  - ")}`,
  );
}
