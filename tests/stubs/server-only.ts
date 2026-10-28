/**
 * Stub for the `server-only` guard.
 *
 * The real package exports a module that throws when it is pulled into a
 * client bundle. Vitest has no client bundle, so importing the real thing
 * would fail every test that touches a server module. See vitest.config.ts.
 */
export {};
