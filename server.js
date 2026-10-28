/**
 * Passenger entry point for cPanel's Node.js application manager.
 *
 * cPanel starts this file directly — there is no `next start` in the loop — so
 * it has to boot the standalone server itself. Passenger supplies the port on
 * `process.env.PORT`; binding to anything else makes the app unreachable.
 *
 * Deploy sequence (see docs/DEPLOYMENT.md):
 *   1. build off-box (shared cPanel will not survive `next build`)
 *   2. upload .next/standalone, .next/static and public
 *   3. touch tmp/restart.txt
 */

const path = require("path");

const dir = path.join(__dirname, ".next", "standalone");

process.env.NODE_ENV = "production";
process.chdir(dir);

// The standalone build emits its own server; starting that keeps us on the
// code path Next tests, rather than re-implementing request handling here.
require(path.join(dir, "server.js"));
