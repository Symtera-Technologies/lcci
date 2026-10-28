import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import {
  claimStep,
  consumeRecoveryCode,
  countRecoveryCodes,
  currentStep,
  issueRecoveryCodes,
  newTotpSecret,
  openTotpSecret,
  sealTotpSecret,
  totpCode,
} from "@/server/auth/totp";
import { enrolTotp, signInWithPassword, verifySecondFactor } from "@/server/auth/staff";
import { hashPassword } from "@/server/crypto";
import { reset as resetLimit } from "@/server/rate-limit";
import {
  createUser,
  databaseAvailable,
  inParallel,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * Staff two-factor sign-in, against the database.
 *
 * Three things only a real database can show: that a correct code cannot be
 * presented twice inside its own 30-second window, that a recovery code is
 * single-use under concurrent presentation, and that the sealed secret
 * survives a round trip through a VARBINARY column with its AAD intact.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping staff MFA tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

const TABLES = ["staff_recovery_codes", "staff_totp_used", "login_throttle", "audit_log", "users"];

const PASSWORD = "correct horse battery staple 42";

/**
 * Clear the sliding window as well as the tables.
 *
 * The password attempt limit lives in `rate_limit_events` keyed on the email
 * address, and every test in this file signs in as the same officer — so
 * without this the fourth test reads "locked" and the assertion that fails is
 * nowhere near the thing that is actually exhausted.
 */
async function freshLimits(email: string): Promise<void> {
  await resetLimit("staffPasswordAccount", email);
}

async function makeStaff(email: string): Promise<number> {
  const userId = await createUser(email);
  await getDb()
    .updateTable("users")
    .set({ password_hash: hashPassword(PASSWORD) })
    .where("id", "=", userId)
    .execute();
  await freshLimits(email);
  return userId;
}

function request(requestId = "01JTESTREQUESTID0000000000") {
  return { ip: "203.0.113.10", userAgent: "vitest", requestId };
}

describe.skipIf(!available)("the sealed TOTP secret", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("round-trips through the column with its AAD intact", async () => {
    const userId = await makeStaff("officer@lcci.test");
    const { secret } = newTotpSecret();

    await getDb()
      .updateTable("users")
      .set({ totp_secret_enc: sealTotpSecret(userId, secret), mfa_mode: "totp" })
      .where("id", "=", userId)
      .execute();

    const row = await getDb()
      .selectFrom("users")
      .select(["totp_secret_enc"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();

    expect(openTotpSecret(userId, row.totp_secret_enc)!.equals(secret)).toBe(true);
  });

  it("refuses to open under another user's id", async () => {
    const userId = await makeStaff("officer@lcci.test");
    const otherId = await makeStaff("second@lcci.test");
    const { secret } = newTotpSecret();
    const sealed = sealTotpSecret(userId, secret);

    // The AAD binds the ciphertext to `users:<id>:totp_secret_enc`, so a row
    // copied between accounts does not decrypt — which is the point of an AAD
    // rather than a bare ciphertext column.
    expect(() => openTotpSecret(otherId, sealed)).toThrow();
  });
});

describe.skipIf(!available)("a TOTP code inside its own window", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("can be claimed once and not again", async () => {
    const userId = await makeStaff("officer@lcci.test");
    const step = currentStep();

    expect(await claimStep(userId, step)).toBe(true);
    expect(await claimStep(userId, step)).toBe(false);
  });

  it("is claimed exactly once when presented several times at the same instant", async () => {
    const userId = await makeStaff("officer@lcci.test");
    const step = currentStep();

    const results = await inParallel(6, () => claimStep(userId, step));
    const won = results.filter((result) => result.ok && result.value === true);

    expect(won).toHaveLength(1);
  });

  it("does not stop another account using the same step", async () => {
    const first = await makeStaff("officer@lcci.test");
    const second = await makeStaff("second@lcci.test");
    const step = currentStep();

    expect(await claimStep(first, step)).toBe(true);
    expect(await claimStep(second, step)).toBe(true);
  });
});

describe.skipIf(!available)("enrolment and second factor", () => {
  let userId = 0;

  beforeEach(async () => {
    await resetTables(TABLES);
    userId = await makeStaff("officer@lcci.test");
  });

  it("enrols, issues ten recovery codes, and burns the step used to enrol", async () => {
    const { secret, base32 } = newTotpSecret();
    const step = currentStep();

    const result = await enrolTotp({
      userId,
      secretBase32: base32,
      code: totpCode(secret, step),
      ...request(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recoveryCodes).toHaveLength(10);
    expect(await countRecoveryCodes(userId)).toBe(10);

    // The enrolling code is spent, so the same six digits cannot then be used
    // to sign in during the remainder of that window.
    expect(await claimStep(userId, step)).toBe(false);

    const row = await getDb()
      .selectFrom("users")
      .select(["mfa_mode"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    expect(row.mfa_mode).toBe("totp");
  });

  it("refuses enrolment when the code does not match the secret offered", async () => {
    const { base32 } = newTotpSecret();
    const other = newTotpSecret().secret;

    const result = await enrolTotp({
      userId,
      secretBase32: base32,
      code: totpCode(other, currentStep()),
      ...request(),
    });

    expect(result.ok).toBe(false);
    expect(await countRecoveryCodes(userId)).toBe(0);
  });

  it("accepts the authenticator code once and calls the second presentation a replay", async () => {
    const { secret, base32 } = newTotpSecret();
    await enrolTotp({
      userId,
      secretBase32: base32,
      code: totpCode(secret, currentStep()),
      ...request(),
    });

    // The next window, not this one: enrolment just burned the current step,
    // and a code for a spent step is correctly refused as a replay — which is
    // exactly what the second half of this test asserts.
    const code = totpCode(secret, currentStep() + 1);

    const first = await verifySecondFactor({ userId, code, ...request() });
    expect(first.ok).toBe(true);

    const second = await verifySecondFactor({ userId, code, ...request() });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("replayed");
  });

  it("takes a recovery code in place of the authenticator, once", async () => {
    const { secret, base32 } = newTotpSecret();
    const enrolled = await enrolTotp({
      userId,
      secretBase32: base32,
      code: totpCode(secret, currentStep()),
      ...request(),
    });
    if (!enrolled.ok) throw new Error("enrolment failed");

    const code = enrolled.recoveryCodes[0]!;

    const first = await verifySecondFactor({ userId, code, ...request() });
    expect(first.ok).toBe(true);
    expect(await countRecoveryCodes(userId)).toBe(9);

    const again = await verifySecondFactor({ userId, code, ...request() });
    expect(again.ok).toBe(false);
  });

  it("spends a recovery code exactly once when presented concurrently", async () => {
    const codes = await issueRecoveryCodes(userId);
    const code = codes[3]!;

    const results = await inParallel(5, () =>
      consumeRecoveryCode(userId, code, null),
    );
    const consumed = results.filter(
      (result) => result.ok && result.value.consumed,
    );

    expect(consumed).toHaveLength(1);
    expect(await countRecoveryCodes(userId)).toBe(9);
  });

  it("replaces the whole set when codes are reissued", async () => {
    const first = await issueRecoveryCodes(userId);
    await issueRecoveryCodes(userId);

    expect(await countRecoveryCodes(userId)).toBe(10);
    // An old sheet stops working the moment a new one is printed, which is the
    // only safe reading of "generate a fresh set".
    expect(
      (await consumeRecoveryCode(userId, first[0]!, null)).consumed,
    ).toBe(false);
  });
});

describe.skipIf(!available)("the password step", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("accepts the right password and says whether 2FA is already enrolled", async () => {
    const userId = await makeStaff("officer@lcci.test");

    const first = await signInWithPassword({
      email: "officer@lcci.test",
      password: PASSWORD,
      ...request(),
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.user.hasTotp).toBe(false);

    const { secret, base32 } = newTotpSecret();
    await enrolTotp({
      userId,
      secretBase32: base32,
      code: totpCode(secret, currentStep()),
      ...request(),
    });

    const second = await signInWithPassword({
      email: "officer@lcci.test",
      password: PASSWORD,
      ...request(),
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.user.hasTotp).toBe(true);
  });

  it("refuses the wrong password, and an address with no account, identically", async () => {
    await makeStaff("officer@lcci.test");

    const wrong = await signInWithPassword({
      email: "officer@lcci.test",
      password: "not the password",
      ...request(),
    });
    const absent = await signInWithPassword({
      email: "nobody@lcci.test",
      password: PASSWORD,
      ...request(),
    });

    expect(wrong.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!wrong.ok && !absent.ok) expect(wrong.reason).toBe(absent.reason);
  });

  it("refuses a portal account at the staff door", async () => {
    // Members sign in by OTP and have no password hash at all; the staff form
    // must not become a second, weaker way into a member account.
    await createUser("member@example.com.pk", "portal");

    const result = await signInWithPassword({
      email: "member@example.com.pk",
      password: PASSWORD,
      ...request(),
    });

    expect(result.ok).toBe(false);
  });

  it("locks the account after the attempt budget is spent", async () => {
    await makeStaff("officer@lcci.test");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await signInWithPassword({
        email: "officer@lcci.test",
        password: "wrong",
        ...request(),
      });
    }

    const result = await signInWithPassword({
      email: "officer@lcci.test",
      password: PASSWORD,
      ...request(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("locked");
  });
});
