/**
 * Print the authenticator code for a base32 secret given on the command line.
 *
 *   npm run dev:totp-secret -- "KPEE LNVG 3LF5 ..."
 *
 * Why this exists alongside `dev-totp.ts`: enrolment generates a fresh secret
 * on every render of `/admin/setup-2fa` and stores it only when the form is
 * confirmed, so there is nothing in the database to read until the code has
 * already been accepted. On a development machine that makes enrolling a
 * second staff account — a cashier, to check that the separation of duties is
 * real rather than asserted — impossible without this.
 *
 * Refuses in production, where the code belongs on its holder's phone: a tool
 * that turns a displayed secret into a code on the server is a tool that
 * abolishes the second factor.
 */

import process from "node:process";
import { env } from "@/server/env";
import { base32Decode, currentStep, totpCode, STEP_SECONDS } from "@/server/auth/totp";

function main(): number {
  if (env.isProduction) {
    console.error("Refusing to run: NODE_ENV is production.");
    return 1;
  }

  const raw = process.argv.slice(2).join("");
  if (raw.trim() === "") {
    console.error('Pass the base32 secret, for example: npm run dev:totp-secret -- "ABCD EFGH"');
    return 1;
  }

  const secret = base32Decode(raw);
  const step = currentStep();
  const secondsLeft = STEP_SECONDS - Math.floor((Date.now() / 1000) % STEP_SECONDS);

  console.log(`${totpCode(secret, step)}   (valid for ~${secondsLeft}s)`);
  console.log(`${totpCode(secret, step + 1)}   (the one after)`);

  return 0;
}

process.exit(main());
