import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Test environment.
 *
 * `src/server/env.ts` validates at module load and logs loudly when a value is
 * missing, which is correct on a real host and noise in a test run. These
 * values make the module load cleanly without pointing at anything real: the
 * database credentials are never connected to, because nothing in the suite
 * touches MySQL.
 *
 * The upload root is a genuine temporary directory outside the project, which
 * is the one value the env module actually checks on disk — it asserts the
 * path exists, is a directory, is writable, and is not inside the application
 * root. A fake string would fail those checks and a path inside the repo
 * would defeat the point of the assertion.
 */

process.env.SITE_ORIGIN ??= "https://lcci.test";
process.env.DB_HOST ??= "127.0.0.1";
process.env.DB_USER ??= "lcci_test";
process.env.DB_PASSWORD ??= "not-a-real-password";
process.env.DB_NAME ??= "lcci_test";

// 32 zero bytes, base64. Deterministic so that a sealed value is reproducible
// across runs; obviously never a key any real environment would hold.
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");
process.env.IP_HASH_PEPPER ??= "test-pepper";
process.env.CRON_SECRET ??= "test-cron-secret";

process.env.PRIVATE_UPLOAD_ROOT ??= mkdtempSync(
  path.join(os.tmpdir(), "lcci-uploads-test-"),
);
