/**
 * Print the current authenticator code for a staff account.
 *
 *   npm run dev:totp -- officer@lcci.test
 *   npm run dev:totp                       (defaults to officer@lcci.test)
 *
 * Why this exists: staff sign in with a password **and** an authenticator app,
 * by design and with no email fallback — the inbox must not be the root
 * credential for the accounts that approve memberships and read every CNIC. On
 * a development machine that means the whole backend is unreachable unless the
 * secret enrolled in the database can be turned into a six-digit code, and
 * that is all this does.
 *
 * It refuses outright in production, where the code belongs on its holder's
 * phone and nowhere else — a tool that prints a second factor on the server is
 * a tool that abolishes the second factor.
 */

import process from "node:process";
import { getDb } from "@/db/client";
import { closePool } from "@/db/pool";
import { env } from "@/server/env";
import { currentStep, openTotpSecret, totpCode, STEP_SECONDS } from "@/server/auth/totp";

const DEFAULT_EMAIL = "officer@lcci.test";

async function main(): Promise<number> {
  if (env.isProduction) {
    console.error(
      "Refusing to run: NODE_ENV is production.\n" +
        "The second factor exists so that knowing the password is not enough. " +
        "Printing it from the server would mean the password is enough after all.",
    );
    return 1;
  }

  const email = process.argv[2] ?? DEFAULT_EMAIL;

  const user = await getDb()
    .selectFrom("users")
    .select(["id", "email", "user_type", "totp_secret_enc"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (!user) {
    console.error(`No account for <${email}>. Create one with: npm run dev:staff`);
    return 1;
  }

  if (user.user_type !== "staff") {
    console.error(
      `<${email}> is a portal account. Members sign in with an emailed code and ` +
        "have no authenticator and no password at all.",
    );
    return 1;
  }

  const secret = openTotpSecret(Number(user.id), user.totp_secret_enc);

  if (!secret) {
    console.error(
      `<${email}> has not enrolled an authenticator yet.\n` +
        "Sign in at http://localhost:9000/admin/sign-in — the password step " +
        "sends the account straight to /admin/setup-2fa, which is the gate " +
        "working correctly. Enrol there, then run this again.",
    );
    return 1;
  }

  const step = currentStep();
  const secondsLeft = STEP_SECONDS - Math.floor((Date.now() / 1000) % STEP_SECONDS);

  console.log(`${totpCode(secret, step)}   (valid for ~${secondsLeft}s)`);

  // The next one too, because a code read with four seconds left is a code
  // that will be refused by the time it is typed.
  console.log(`${totpCode(secret, step + 1)}   (the one after)`);

  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
