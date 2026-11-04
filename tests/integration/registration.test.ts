import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { hashOtpCode, hmacHex } from "@/server/crypto";
import { verifyAuditChain } from "@/server/audit";
import { setMailer, type OutboundMessage } from "@/server/mail/mailer";
import { reset as resetLimit } from "@/server/rate-limit";
import { completeRegistration, startRegistration } from "@/server/auth/registration";
import { issueSignInCode, verifySignInCode } from "@/server/auth/otp";
import {
  createUser,
  databaseAvailable,
  inParallel,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * Opening a membership account, against a real database.
 *
 * The claims here that no unit test can make are the four this flow actually
 * rests on.
 *
 * **An account exists before anyone has proved the inbox, and cannot be used.**
 * The row is written at `status = 'invited'` so the unique index on `email`
 * decides a concurrent race, and every other path in the system requires
 * `active`. Asserted by trying to sign in with it.
 *
 * **Registering a known address signs that account in and creates nothing.**
 * This is the enumeration defence, and it is behaviour rather than a comment:
 * the answer, the mail and the row count all have to come out the same whether
 * the address was known or not.
 *
 * **The two code namespaces do not meet.** A registration code must not open
 * the sign-in form and a sign-in code must not activate a dormant account.
 * They differ only by `purpose` and a hash prefix, which is exactly the kind
 * of separation a refactor collapses by accident.
 *
 * **Registration and sign-in share one rate-limit bucket.** If they did not,
 * the published "three codes an hour" would be six the moment this flow
 * landed. There is no way to test that without issuing from both.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping registration tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  setMailer(null);
  await teardown();
});

const TABLES = [
  "otp_challenges",
  "sessions",
  "login_throttle",
  "rate_limit_events",
  "rate_limit_counters",
  "email_outbox",
  "audit_log",
  "users",
];

const NEW_EMAIL = "newfirm@example.test";
const STAFF_EMAIL = "officer@example.test";

/** Collects what the mailer was asked to send, so a test can read the code. */
const sent: OutboundMessage[] = [];

function lastCode(): string {
  const message = sent.at(-1);
  if (!message) throw new Error("no message was sent");
  const match = /\b(\d{6})\b/.exec(message.text);
  if (!match) throw new Error(`no six-digit code in: ${message.text}`);
  return match[1];
}

const FACTS = { ip: "203.0.113.9", userAgent: "vitest" } as const;

interface Details {
  fullName: string;
  mobile: string;
}

const DETAILS: Details = {
  fullName: "Owais Talib",
  mobile: "+923001234567",
};

function register(email = NEW_EMAIL, overrides: Partial<Details> = {}) {
  return startRegistration({ ...DETAILS, ...overrides, email, ...FACTS });
}

/**
 * Clear the request limiter between issues.
 *
 * Three per hour with sixty seconds between them is right in production and
 * would make every test after the first assert on a spacing refusal. Resetting
 * is honest here because three separate tests *are* three separate hours as
 * far as the behaviour under test goes — and the last test in this file
 * deliberately does not reset, so the sharing of the bucket is still covered.
 */
async function freshLimits(email = NEW_EMAIL): Promise<void> {
  await resetLimit("otpRequestIdentifier", email);
  await resetLimit("otpRequestIp", FACTS.ip);
  await resetLimit("otpVerifyIdentifier", email);
}

async function challengeRows(email = NEW_EMAIL, purpose = "email_verify") {
  return getDb()
    .selectFrom("otp_challenges")
    .selectAll()
    .where("identifier_hash", "=", hmacHex(`otp:${purpose}:${email}`))
    .orderBy("id", "asc")
    .execute();
}

async function userRow(email = NEW_EMAIL) {
  return getDb()
    .selectFrom("users")
    .selectAll()
    .where("email", "=", email)
    .executeTakeFirst();
}

async function userCount(): Promise<number> {
  const row = await getDb()
    .selectFrom("users")
    .select((eb) => eb.fn.countAll<number>().as("total"))
    .executeTakeFirstOrThrow();
  return Number(row.total);
}

async function auditActions(): Promise<string[]> {
  const rows = await getDb()
    .selectFrom("audit_log")
    .select(["action"])
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => row.action);
}

describe.skipIf(!available)("opening a membership account", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    sent.length = 0;
    setMailer({
      name: "console",
      async send(message) {
        sent.push(message);
        return { providerId: "test" };
      },
    });
    await freshLimits();
  });

  /* --- The new firm ---------------------------------------------------- */

  it("creates an unverified account, stores only the code's hash, and emails it", async () => {
    const result = await register();

    expect(result.accepted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(NEW_EMAIL);
    expect(sent[0].stream).toBe("transactional");

    const user = await userRow();
    expect(user).toBeDefined();
    expect(user?.user_type).toBe("portal");
    // The whole safety of writing a row for an address nobody has proved yet.
    expect(user?.status).toBe("invited");
    expect(user?.email_verified_at).toBeNull();
    expect(user?.password_hash).toBeNull();
    expect(user?.full_name).toBe(DETAILS.fullName);
    expect(user?.mobile_e164).toBe(DETAILS.mobile);

    const code = lastCode();
    const rows = await challengeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("email_verify");
    expect(rows[0].user_id).toBe(user?.id);
    // The point of the salt: the stored value is useless without the row it
    // came from, so a leaked table is not a set of live credentials.
    expect(rows[0].code_hash).not.toContain(code);
    expect(rows[0].code_hash).toBe(hashOtpCode(code, rows[0].salt));
    expect(rows[0].consumed_at).toBeNull();
  });

  it("will not let the unverified account sign in", async () => {
    await register();
    await freshLimits();

    // The sign-in path requires `status = 'active'`, so from its point of view
    // this address does not exist: no challenge, no mail, same answer.
    const before = sent.length;
    const result = await issueSignInCode({ identifier: NEW_EMAIL, ...FACTS });

    expect(result.accepted).toBe(true);
    expect(sent).toHaveLength(before);
    expect(await challengeRows(NEW_EMAIL, "login")).toHaveLength(0);
  });

  it("activates the account when the code comes back", async () => {
    await register();
    const before = await userRow();

    const result = await completeRegistration({
      email: NEW_EMAIL,
      code: lastCode(),
      ...FACTS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.user.userType).toBe("portal");

    const after = await userRow();
    expect(after?.status).toBe("active");
    expect(after?.email_verified_at).not.toBeNull();
    expect(after?.last_login_at).not.toBeNull();

    // The status moved, so every session minted before it must die. There are
    // none for an account that has never signed in, and the invariant is
    // honoured anyway — an invariant kept only where it is observable is one
    // somebody will be surprised by later.
    expect(after?.role_version).toBe((before?.role_version ?? 0) + 1);

    // And the session this call is about to mint carries the *new* number. A
    // value computed in TypeScript against a `+ 1` in SQL would be a session
    // invalid the instant it was issued.
    expect(result.user.roleVersion).toBe(after?.role_version);

    const rows = await challengeRows();
    expect(rows[0].consumed_at).not.toBeNull();
  });

  it("lets the new member sign in afterwards, by the ordinary front door", async () => {
    await register();
    await completeRegistration({ email: NEW_EMAIL, code: lastCode(), ...FACTS });

    // End to end: the account this flow created is an ordinary member account,
    // and nothing about how it was made is special after the fact.
    await freshLimits();
    await issueSignInCode({ identifier: NEW_EMAIL, ...FACTS });
    const signIn = await verifySignInCode({
      identifier: NEW_EMAIL,
      code: lastCode(),
      ...FACTS,
    });

    expect(signIn.ok).toBe(true);
  });

  it("consumes the code exactly once under concurrent replay", async () => {
    await register();
    const code = lastCode();

    // Six at once rather than two: with two, a broken implementation passes
    // often enough to look flaky rather than wrong.
    const results = await inParallel(6, () =>
      completeRegistration({ email: NEW_EMAIL, code, ...FACTS }),
    );

    const accepted = results.filter((r) => r.ok && r.value.ok);
    expect(accepted).toHaveLength(1);

    // One activation, not six. `role_version` is the witness: it is guarded on
    // the status it leaves, so a second winner would show up here as a second
    // increment and every session minted by the first would already be dead.
    const user = await userRow();
    expect(user?.status).toBe("active");
    expect(user?.role_version).toBe(2);
  });

  /* --- The address that already has an account -------------------------- */

  it("signs an existing member in rather than saying the address is taken", async () => {
    const existing = "member@example.test";
    const memberId = await createUser(existing, "portal", "Existing Member");
    await freshLimits(existing);

    const before = await userCount();
    const result = await register(existing);
    expect(result.accepted).toBe(true);

    // No second account, and the answer is the same shape as for a new one.
    expect(await userCount()).toBe(before);
    expect(sent).toHaveLength(1);

    const confirmed = await completeRegistration({
      email: existing,
      code: lastCode(),
      ...FACTS,
    });

    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.user.id).toBe(memberId);
    // Not an account creation, and the log says so: this reads as a sign-in,
    // which is what it is.
    expect(confirmed.created).toBe(false);
    expect(await auditActions()).toContain("user.signed_in");
    expect(await auditActions()).not.toContain("user.registered");
  });

  it("does not rename an active member from an unauthenticated form", async () => {
    const existing = "member@example.test";
    await createUser(existing, "portal", "Existing Member");
    await freshLimits(existing);

    await register(existing, { fullName: "Somebody Else", mobile: "+923009999999" });

    // Anyone who knows the address could otherwise rewrite the name and the
    // mobile number of a real member's account without ever proving the inbox.
    const user = await userRow(existing);
    expect(user?.full_name).toBe("Existing Member");
    expect(user?.mobile_e164).toBeNull();
  });

  it("takes the latest details for an account nobody has confirmed yet", async () => {
    await register();
    const firstCode = lastCode();

    await freshLimits();
    await register(NEW_EMAIL, { fullName: "Second Attempt", mobile: "+923217654321" });

    // Nobody has ever authenticated as this row, so the details from the
    // attempt that is still live are the ones to keep.
    const user = await userRow();
    expect(user?.full_name).toBe("Second Attempt");
    expect(user?.mobile_e164).toBe("+923217654321");
    expect(await userCount()).toBe(1);

    // And the first code is dead, so there is only ever one live code per
    // address and the attempt budget cannot be doubled by asking twice.
    const stale = await completeRegistration({
      email: NEW_EMAIL,
      code: firstCode,
      ...FACTS,
    });
    expect(stale.ok).toBe(false);
  });

  /* --- The addresses that get nothing ----------------------------------- */

  it("sends nothing to a staff address, and says the same thing", async () => {
    await createUser(STAFF_EMAIL, "staff");
    await freshLimits(STAFF_EMAIL);
    const before = await userCount();

    const result = await register(STAFF_EMAIL);

    // An emailed code must never become a second way into an account whose
    // first way is a password and an authenticator.
    expect(result.accepted).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await challengeRows(STAFF_EMAIL)).toHaveLength(0);
    expect(await userCount()).toBe(before);

    // Not invisible, though: the refusal is findable by somebody who can act
    // on it.
    expect(await auditActions()).toContain("user.registration_refused_staff_address");
  });

  it("will not let a suspended member re-register their way back in", async () => {
    const suspended = "lapsed@example.test";
    const id = await createUser(suspended, "portal", "Suspended Member");
    await getDb()
      .updateTable("users")
      .set({ status: "suspended" })
      .where("id", "=", id)
      .execute();
    await freshLimits(suspended);

    const result = await register(suspended);

    expect(result.accepted).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await challengeRows(suspended)).toHaveLength(0);
    expect((await userRow(suspended))?.status).toBe("suspended");
    expect(await auditActions()).toContain("user.registration_refused_account_closed");
  });

  it("refuses a correct code for an account suspended since it was issued", async () => {
    await register();
    const code = lastCode();

    // The code proves possession of the inbox. It does not prove the account
    // is allowed in, which is why the row is re-read after consumption rather
    // than trusted from the challenge.
    await getDb()
      .updateTable("users")
      .set({ status: "disabled" })
      .where("email", "=", NEW_EMAIL)
      .execute();

    const result = await completeRegistration({ email: NEW_EMAIL, code, ...FACTS });
    expect(result.ok).toBe(false);
    expect((await userRow())?.status).toBe("disabled");
  });

  /* --- The two namespaces ----------------------------------------------- */

  it("keeps a registration code out of the sign-in form", async () => {
    await register();
    await completeRegistration({ email: NEW_EMAIL, code: lastCode(), ...FACTS });

    // A live registration code for an account that is now active.
    await freshLimits();
    await register();
    const registrationCode = lastCode();

    const result = await verifySignInCode({
      identifier: NEW_EMAIL,
      code: registrationCode,
      ...FACTS,
    });

    // The two differ only by `purpose` and a hash prefix, which is exactly the
    // separation a refactor collapses by accident.
    expect(result.ok).toBe(false);
  });

  it("keeps a sign-in code out of the registration form", async () => {
    const existing = "member@example.test";
    await createUser(existing, "portal", "Existing Member");
    await freshLimits(existing);

    await issueSignInCode({ identifier: existing, ...FACTS });
    const loginCode = lastCode();

    const result = await completeRegistration({
      email: existing,
      code: loginCode,
      ...FACTS,
    });
    expect(result.ok).toBe(false);
  });

  /* --- The limits, and the log ------------------------------------------ */

  it("shares one request bucket with sign-in, so three an hour means three", async () => {
    const existing = "member@example.test";
    await createUser(existing, "portal", "Existing Member");
    await freshLimits(existing);

    // Deliberately no reset between these two. Separate buckets would give an
    // attacker three codes an hour from each endpoint instead of three in
    // total — the published figure would be false by a factor of two.
    const signIn = await issueSignInCode({ identifier: existing, ...FACTS });
    expect(signIn.accepted).toBe(true);

    const registration = await register(existing);
    expect(registration.accepted).toBe(false);
    expect(registration.tooSoon).toBe(true);
    expect(registration.retryAfterSeconds).toBeGreaterThan(0);

    // And the refusal cost nothing: no second code, no second message.
    expect(sent).toHaveLength(1);
    expect(await challengeRows(existing)).toHaveLength(0);
  });

  it("records the whole thing in an unbroken audit chain", async () => {
    await register();
    await completeRegistration({ email: NEW_EMAIL, code: lastCode(), ...FACTS });

    expect(await auditActions()).toEqual([
      "user.registration_code_issued",
      "user.registered",
    ]);

    const chain = await verifyAuditChain();
    expect(chain.brokenAtId).toBeNull();
    expect(chain.checked).toBeGreaterThan(0);
  });
});
