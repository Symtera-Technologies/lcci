import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { hashOtpCode, hmacHex } from "@/server/crypto";
import { verifyAuditChain } from "@/server/audit";
import { setMailer, type OutboundMessage } from "@/server/mail/mailer";
import { reset as resetLimit } from "@/server/rate-limit";
import { issueSignInCode, verifySignInCode } from "@/server/auth/otp";
import { isLocked } from "@/server/auth/throttle";
import {
  createUser,
  databaseAvailable,
  inParallel,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * Member sign-in, against a real database.
 *
 * The two claims here that no unit test can make are the ones the plan calls
 * out by name. **Replay**: fire one code twice at once and exactly one
 * consumption happens — a `SELECT` then `UPDATE` would let both through, and
 * under Passenger's several workers that is not a theoretical race.
 * **Enumeration**: an unregistered identifier produces the same answer, writes
 * no challenge and sends no mail, and the test asserts all three rather than
 * trusting the code's own comment.
 *
 * Everything else is the boring half that is nonetheless where the bugs live:
 * a second code killing the first, an expired code, a correct code for an
 * account suspended since it was issued, and the attempt budget.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping sign-in tests: ${await skipReason()}`);
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

const MEMBER_EMAIL = "member@example.test";
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

/**
 * Clear the request limiter between issues.
 *
 * `otpRequestIdentifier` allows three per hour with sixty seconds between
 * them, which is right in production and would make every test after the first
 * assert on a spacing refusal. Resetting the bucket is honest here because
 * three separate tests *are* three separate hours as far as the behaviour
 * under test is concerned — and one test below deliberately does not reset, so
 * the limit itself is still covered.
 */
async function freshLimits(identifier = MEMBER_EMAIL): Promise<void> {
  await resetLimit("otpRequestIdentifier", identifier);
  await resetLimit("otpRequestIp", "203.0.113.9");
  await resetLimit("otpVerifyIdentifier", identifier);
}

const ISSUE = { ip: "203.0.113.9", userAgent: "vitest" } as const;

async function challengeRows(identifier = MEMBER_EMAIL) {
  return getDb()
    .selectFrom("otp_challenges")
    .selectAll()
    .where("identifier_hash", "=", hmacHex(`otp:login:${identifier}`))
    .orderBy("id", "asc")
    .execute();
}

describe.skipIf(!available)("member sign-in by emailed code", () => {
  let memberId = 0;

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
    memberId = await createUser(MEMBER_EMAIL, "portal");
    await freshLimits();
  });

  it("issues a code, stores only its hash, and emails it", async () => {
    const result = await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });

    expect(result.accepted).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(MEMBER_EMAIL);
    expect(sent[0].stream).toBe("transactional");

    const code = lastCode();
    const rows = await challengeRows();
    expect(rows).toHaveLength(1);

    // The point of the salt: the stored value is useless without the row it
    // came from, so a leaked table is not a set of live credentials.
    expect(rows[0].code_hash).not.toContain(code);
    expect(rows[0].code_hash).toBe(hashOtpCode(code, rows[0].salt));
    expect(rows[0].consumed_at).toBeNull();
    expect(rows[0].user_id).toBe(memberId);
    expect(rows[0].purpose).toBe("login");
    // Not bound to a browser for this flow: the code is read on a phone and
    // typed on a laptop more often than not.
    expect(rows[0].browser_nonce_hash).toBeNull();
  });

  it("accepts the code once and consumes it", async () => {
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const code = lastCode();

    const first = await verifySignInCode({ identifier: MEMBER_EMAIL, code, ...ISSUE });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.user.id).toBe(memberId);

    const rows = await challengeRows();
    expect(rows[0].consumed_at).not.toBeNull();

    // The same code again. Not "invalid because wrong" — invalid because dead.
    const second = await verifySignInCode({ identifier: MEMBER_EMAIL, code, ...ISSUE });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("invalid");
  });

  it("consumes a code exactly once under concurrent replay", async () => {
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const code = lastCode();

    // Six at once rather than two: with two, a broken implementation passes
    // often enough to look flaky rather than wrong.
    const results = await inParallel(6, () =>
      verifySignInCode({ identifier: MEMBER_EMAIL, code, ...ISSUE }),
    );

    const accepted = results.filter((r) => r.ok && r.value.ok);
    expect(accepted).toHaveLength(1);

    const rows = await challengeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].consumed_at).not.toBeNull();

    // A replay must not be charged to the throttle: the usual cause is a
    // double-submitted form, and locking an honest member out for clicking
    // twice is worse than the replay the dead code already prevents.
    const lock = await isLocked({ identifier: MEMBER_EMAIL, ip: ISSUE.ip });
    expect(lock.locked).toBe(false);
  });

  it("kills the previous code when a new one is issued", async () => {
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const firstCode = lastCode();

    await freshLimits();
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const secondCode = lastCode();
    expect(secondCode).not.toBe(firstCode);

    const stale = await verifySignInCode({
      identifier: MEMBER_EMAIL,
      code: firstCode,
      ...ISSUE,
    });
    expect(stale.ok).toBe(false);

    const fresh = await verifySignInCode({
      identifier: MEMBER_EMAIL,
      code: secondCode,
      ...ISSUE,
    });
    expect(fresh.ok).toBe(true);
  });

  it("refuses an expired code", async () => {
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const code = lastCode();

    await getDb()
      .updateTable("otp_challenges")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("identifier_hash", "=", hmacHex(`otp:login:${MEMBER_EMAIL}`))
      .execute();

    const result = await verifySignInCode({ identifier: MEMBER_EMAIL, code, ...ISSUE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("refuses a correct code for an account suspended since it was issued", async () => {
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const code = lastCode();

    // The code proves possession of the inbox. It does not prove the account
    // is still allowed in, which is why the user row is re-read after
    // consumption rather than trusted from the challenge.
    await getDb()
      .updateTable("users")
      .set({ status: "suspended" })
      .where("id", "=", memberId)
      .execute();

    const result = await verifySignInCode({ identifier: MEMBER_EMAIL, code, ...ISSUE });
    expect(result.ok).toBe(false);
  });

  it("spends the attempt budget and then refuses even the right code", async () => {
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifySignInCode({ identifier: MEMBER_EMAIL, code: wrong, ...ISSUE });
    }

    const rows = await challengeRows();
    expect(rows[0].attempts).toBe(5);

    const result = await verifySignInCode({ identifier: MEMBER_EMAIL, code, ...ISSUE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["too-many", "locked"]).toContain(result.reason);

    // Five wrong codes is also five throttle failures, which is the lock
    // threshold. Both mechanisms fire, and they are deliberately separate: the
    // attempt counter kills one code, the lock slows the next request.
    const lock = await isLocked({ identifier: MEMBER_EMAIL, ip: ISSUE.ip });
    expect(lock.locked).toBe(true);
    expect(lock.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("treats an unregistered identifier identically, and writes nothing", async () => {
    const unknown = "nobody@example.test";
    await freshLimits(unknown);

    const result = await issueSignInCode({ identifier: unknown, ...ISSUE });

    // Same shape of answer as a registered address.
    expect(result.accepted).toBe(true);
    expect(result.retryAfterSeconds).toBe(0);

    expect(sent).toHaveLength(0);
    expect(await challengeRows(unknown)).toHaveLength(0);

    // But it is not invisible: the sweep across identifiers that enumeration
    // requires is exactly what this event makes findable.
    const events = await getDb()
      .selectFrom("audit_log")
      .select(["action", "entity_id"])
      .where("action", "=", "user.sign_in_code_unknown_identifier")
      .execute();
    expect(events).toHaveLength(1);
    // The hash, not the address. An audit log kept for seven years should not
    // accumulate the email addresses of people who have no account.
    expect(events[0].entity_id).toBe(hmacHex(`otp:login:${unknown}`));
    expect(events[0].entity_id).not.toContain("@");
  });

  it("does not issue a code to a staff account", async () => {
    await createUser(STAFF_EMAIL, "staff");
    await freshLimits(STAFF_EMAIL);

    const result = await issueSignInCode({ identifier: STAFF_EMAIL, ...ISSUE });

    expect(result.accepted).toBe(true);
    expect(sent).toHaveLength(0);
    expect(await challengeRows(STAFF_EMAIL)).toHaveLength(0);
  });

  it("refuses a second request inside the spacing window", async () => {
    // No `freshLimits` between these, which is the point. The sixty-second
    // spacing means request two is already refused — and refused for spacing,
    // which the copy distinguishes from "too many".
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    const second = await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });

    expect(second.accepted).toBe(false);
    expect(second.tooSoon).toBe(true);
    expect(second.retryAfterSeconds).toBeGreaterThan(0);

    // And the refusal cost nothing: no second challenge, no second email.
    expect(sent).toHaveLength(1);
    expect(await challengeRows()).toHaveLength(1);
  });

  it("records sign-in in an unbroken audit chain", async () => {
    await issueSignInCode({ identifier: MEMBER_EMAIL, ...ISSUE });
    await verifySignInCode({ identifier: MEMBER_EMAIL, code: lastCode(), ...ISSUE });

    const actions = await getDb()
      .selectFrom("audit_log")
      .select(["action"])
      .orderBy("id", "asc")
      .execute();

    expect(actions.map((row) => row.action)).toEqual([
      "user.sign_in_code_issued",
      "user.signed_in",
    ]);

    const chain = await verifyAuditChain();
    expect(chain.brokenAtId).toBeNull();
    expect(chain.checked).toBeGreaterThan(0);

    const user = await getDb()
      .selectFrom("users")
      .select(["last_login_at", "failed_logins"])
      .where("id", "=", memberId)
      .executeTakeFirstOrThrow();
    expect(user.last_login_at).not.toBeNull();
    expect(user.failed_logins).toBe(0);
  });
});
