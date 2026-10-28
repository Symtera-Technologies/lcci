import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * The database-backed tests, as a separate project.
 *
 * Separate from `vitest.config.mts` for two reasons that both come down to
 * keeping `npm test` trustworthy.
 *
 * The unit suite is hermetic: its setup file stubs the database credentials to
 * nonsense precisely so that nothing under test can reach a server, and it
 * must keep passing on a machine with no MySQL — a laptop, an off-box build
 * runner. Loading real credentials into it would quietly undo that.
 *
 * And these tests cannot run in parallel with each other. They truncate shared
 * tables and then assert on row counts, so two files running at once would
 * each see the other's rows and fail in ways that look like race-condition
 * bugs in the code being tested — which is the worst possible false positive
 * for a suite whose entire subject is race conditions. Hence
 * `fileParallelism: false` and a single fork.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    root: path.resolve(import.meta.dirname),

    // One file at a time, one worker. See above.
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,

    /**
     * Generous, because these tests deliberately contend.
     *
     * Several of them run eight concurrent callers against a three-connection
     * pool and wait on row locks, which is the point — but it means a test
     * that would finish in milliseconds against an idle server can take
     * seconds here.
     */
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
});
