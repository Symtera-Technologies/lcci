import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest configuration.
 *
 * `environment: "node"` throughout: nothing under test here renders. The
 * subjects are the pure parts of the server — the route policy, the SQL
 * splitter, the workflow state machine, request-header parsing, filename
 * sanitisation, magic-byte sniffing. Components are verified in the browser,
 * which is where their failures actually live.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // The database-backed tests are their own project, run by `npm run
    // test:db`. Excluded here so `npm test` stays hermetic and keeps passing
    // on a machine with no MySQL — an off-box build runner, or a laptop.
    exclude: ["tests/integration/**"],
    // Runs before the modules under test are imported, which matters because
    // src/server/env.ts validates at module load.
    setupFiles: ["tests/setup.ts"],
    // The route-inventory test walks src/app, so tests must run from the
    // project root regardless of where the runner was invoked.
    root: path.resolve(import.meta.dirname),
    /**
     * Raised from the 5 s default because of scrypt.
     *
     * `hashPassword` asks for N=2^15, which is ~64 MB of working memory per
     * call. The call itself measures ~200 ms once the process is warm, but the
     * *first* one in a fresh worker has been observed at over five seconds on
     * Windows — first-touch of that allocation, not the KDF. Lowering the cost
     * factor to satisfy a test harness would be setting a security parameter
     * from the wrong end, so the timeout moves instead.
     */
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` throws when imported from a client bundle. Under Vitest
      // there is no bundler to make that distinction, and the package's own
      // entry point is designed to fail, so it is stubbed out.
      "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts"),
    },
  },
});
