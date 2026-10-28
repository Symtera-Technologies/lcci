/**
 * Create a staff account for local development.
 *
 *   npm run dev:staff -- officer@lcci.test "Officer Name" membership_officer
 *   npm run dev:staff                       (defaults, below)
 *
 * Why this exists: staff sign in with a password and an authenticator app, and
 * accounts are created by a super administrator through the admin — which is
 * itself behind a staff sign-in. Without a way to make the first account, the
 * entire backend is unreachable on a fresh database.
 *
 * It prints the generated password once and does not store it anywhere else.
 * It deliberately does **not** enrol two-factor: the account lands on
 * `/admin/setup-2fa` at first sign-in and can reach nothing until it enrols,
 * which is the gate working as designed and is also the only way to exercise
 * that page.
 */

import process from "node:process";
import { getDb } from "@/db/client";
import { closePool } from "@/db/pool";
import { env } from "@/server/env";
import { hashPassword, newToken } from "@/server/crypto";
import { ROLE_CODES, type RoleCode } from "@/server/permissions";

const DEFAULT_EMAIL = "officer@lcci.test";
const DEFAULT_NAME = "Development Officer";
const DEFAULT_ROLE: RoleCode = "membership_officer";

function isRole(value: string): value is RoleCode {
  return (ROLE_CODES as readonly string[]).includes(value);
}

async function main(): Promise<number> {
  if (env.isProduction) {
    console.error(
      "Refusing to run: NODE_ENV is production.\n" +
        "A real staff account is created by a super administrator, with a " +
        "password its holder chooses and an audit trail. This script is neither.",
    );
    return 1;
  }

  const [emailArg, nameArg, roleArg] = process.argv.slice(2);
  const email = (emailArg ?? DEFAULT_EMAIL).trim().toLowerCase();
  const fullName = (nameArg ?? DEFAULT_NAME).trim();
  const role = roleArg ?? DEFAULT_ROLE;

  if (!email.includes("@") || email.length > 190) {
    console.error(`Not an email address: ${email}`);
    return 1;
  }
  if (!isRole(role)) {
    console.error(`Unknown role "${role}". One of: ${ROLE_CODES.join(", ")}`);
    return 1;
  }

  const db = getDb();

  // Long and random rather than memorable. A development password that looks
  // like a password is a development password that reaches production.
  const password = newToken().slice(0, 24);

  const existing = await db
    .selectFrom("users")
    .select(["id", "user_type"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (existing && existing.user_type !== "staff") {
    console.error(`${email} already exists as a ${existing.user_type} account.`);
    return 1;
  }

  let userId: number;

  if (existing) {
    await db
      .updateTable("users")
      .set({
        full_name: fullName,
        password_hash: hashPassword(password),
        status: "active",
      })
      .where("id", "=", existing.id)
      .execute();
    userId = existing.id;
  } else {
    const inserted = await db
      .insertInto("users")
      .values({
        user_type: "staff",
        email,
        full_name: fullName,
        password_hash: hashPassword(password),
        status: "active",
        email_verified_at: new Date(),
      })
      .executeTakeFirst();
    userId = Number(inserted.insertId ?? 0);
  }

  // Replace the grants rather than adding to them, so re-running with a
  // different role does what the command line says.
  await db.deleteFrom("user_roles").where("user_id", "=", userId).execute();
  await db
    .insertInto("user_roles")
    .values({ user_id: userId, role_code: role, scope_kind: "global", scope_value: "" })
    .execute();

  console.log(
    `Staff account #${userId} <${email}> as ${role}.\n` +
      `Password: ${password}\n` +
      `Sign in at http://localhost:9000/admin/sign-in — you will be sent ` +
      `straight to two-factor enrolment, which is the gate working correctly.`,
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
