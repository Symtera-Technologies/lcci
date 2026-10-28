/**
 * Create a member account for local development.
 *
 *   npm run dev:member -- someone@example.test "Someone Ahmed"
 *   npm run dev:member                           (defaults, below)
 *
 * Why this exists: members authenticate by emailed code and nothing else, so
 * until there is a row in `users` with `user_type = 'portal'` there is no way
 * to reach `/membership/apply` at all — the proxy redirects to the sign-in
 * page and the sign-in page, correctly, declines to invent an account. The
 * wizard was built and server-tested before this script existed and could not
 * be opened in a browser once.
 *
 * It is not a migration and not a fixture. Real members arrive by applying, or
 * by the legacy import; this is a development convenience, which is why it
 * refuses to run against a production build rather than being clever about it.
 *
 * No password is set, because members do not have one. `password_hash` stays
 * NULL and that is the whole point of the design: there is no reset flow to
 * staff, no temporary credential to email during the legacy import, and no
 * reused password to arrive here already breached.
 */

import process from "node:process";
import { getDb } from "@/db/client";
import { closePool } from "@/db/pool";
import { env } from "@/server/env";

const DEFAULT_EMAIL = "member@lcci.test";
const DEFAULT_NAME = "Development Member";

async function main(): Promise<number> {
  if (env.isProduction) {
    console.error(
      "Refusing to run: NODE_ENV is production.\n" +
        "Real member accounts are created by applying for membership or by the " +
        "legacy import, both of which are audited. This script is neither.",
    );
    return 1;
  }

  const [emailArg, nameArg] = process.argv.slice(2);
  const email = (emailArg ?? DEFAULT_EMAIL).trim().toLowerCase();
  const fullName = (nameArg ?? DEFAULT_NAME).trim();

  if (!email.includes("@") || email.length > 190) {
    console.error(`Not an email address: ${email}`);
    return 1;
  }

  const db = getDb();

  const existing = await db
    .selectFrom("users")
    .select(["id", "user_type", "status"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (existing) {
    if (existing.user_type !== "portal") {
      console.error(
        `${email} already exists as a ${existing.user_type} account. ` +
          "Staff sign in with a password and an authenticator app, not a code; " +
          "pick a different address.",
      );
      return 1;
    }

    // Reactivating is the common case: a suspended test account is otherwise a
    // confusing "that code is not right" at the end of a working sign-in flow.
    await db
      .updateTable("users")
      .set({ status: "active", full_name: fullName })
      .where("id", "=", existing.id)
      .execute();

    console.log(`Updated member #${existing.id} <${email}> — status active.`);
    return 0;
  }

  const inserted = await db
    .insertInto("users")
    .values({
      user_type: "portal",
      email,
      full_name: fullName,
      // NULL. See the header.
      password_hash: null,
      status: "active",
      // Marked verified: the address is about to prove itself by receiving a
      // code, and an unverified flag here would only gate a flow that does not
      // exist yet.
      email_verified_at: new Date(),
    })
    .executeTakeFirst();

  console.log(
    `Created member #${Number(inserted.insertId ?? 0)} <${email}>.\n` +
      `Sign in at http://localhost:9000/membership/sign-in — with no mail ` +
      `provider configured, the page prints the code.`,
  );
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
