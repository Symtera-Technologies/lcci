import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { ForbiddenError, type ActorContext } from "@/server/actor";
import { newUlid } from "@/server/crypto";
import type { PermissionCode } from "@/server/permissions";
import {
  createStaff,
  getStaff,
  listStaff,
  resetStaffPassword,
  StaffAdminError,
  updateStaff,
} from "@/server/auth/staff-admin";
import { signInWithPassword } from "@/server/auth/staff";
import { reset as resetLimit } from "@/server/rate-limit";
import { databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * Staff account administration, and the two-factor requirement in particular.
 *
 * The behaviour under test is not "a checkbox writes a column". It is the
 * three refusals that make the requirement mean anything — an administrator
 * cannot lift it from their own account, the account holder cannot turn it off
 * for themselves, and the password alone does not complete a sign-in while it
 * is outstanding — plus the one that stops the chamber locking itself out.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping staff admin tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

const TABLES = ["user_roles", "sessions", "staff_recovery_codes", "audit_log", "users"];

function actor(
  userId: number | null,
  permissions: readonly PermissionCode[] = ["user.manage"],
): ActorContext {
  return {
    userId,
    userType: "staff",
    roleCode: "super_admin",
    roleCodes: ["super_admin"],
    permissions: new Set(permissions),
    departmentScopes: [],
    requestId: newUlid(),
    ipHash: null,
    userAgentHash: null,
    onBehalfOfUserId: null,
  };
}

/**
 * A super administrator to act as, and to be the one this suite's checks keep
 * alive. Every test needs one, because `assertSuperAdminSurvives` is checked
 * on every update and an empty table would make every save fail for the wrong
 * reason.
 */
async function anAdmin(): Promise<number> {
  const admin = await createStaff(actor(null), {
    email: "boss@lcci.test",
    fullName: "The Boss",
    roles: ["super_admin"],
    requireTwoFactor: false,
  });
  await getDb()
    .updateTable("users")
    .set({ status: "active" })
    .where("id", "=", admin.userId)
    .execute();
  return admin.userId;
}

describe.skipIf(!available)("creating a staff account", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("lands as invited, with roles and a password that is not stored in clear", async () => {
    const result = await createStaff(actor(null), {
      email: "Officer@LCCI.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });

    expect(result.temporaryPassword).toHaveLength(20);

    const row = await getDb()
      .selectFrom("users")
      .select(["email", "status", "mfa_mode", "mfa_required", "password_hash"])
      .where("id", "=", result.userId)
      .executeTakeFirstOrThrow();

    // Lower-cased, because the address is the sign-in identifier.
    expect(row.email).toBe("officer@lcci.test");
    expect(row.status).toBe("invited");
    // Explicit, not the column default of 'otp_email', which describes a
    // member's emailed code and is meaningless for a staff account.
    expect(row.mfa_mode).toBe("none");
    expect(row.mfa_required).toBe(0);
    expect(row.password_hash).not.toContain(result.temporaryPassword);
  });

  it("cannot sign in until somebody activates it", async () => {
    const created = await createStaff(actor(null), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });
    await resetLimit("staffPasswordAccount", "officer@lcci.test");

    const invited = await signInWithPassword({
      email: "officer@lcci.test",
      password: created.temporaryPassword,
      ip: null,
      userAgent: null,
    });
    expect(invited.ok).toBe(false);

    await getDb()
      .updateTable("users")
      .set({ status: "active" })
      .where("id", "=", created.userId)
      .execute();
    await resetLimit("staffPasswordAccount", "officer@lcci.test");

    const active = await signInWithPassword({
      email: "officer@lcci.test",
      password: created.temporaryPassword,
      ip: null,
      userAgent: null,
    });
    expect(active.ok).toBe(true);
  });

  it("records who required two-factor, and when", async () => {
    const adminId = await anAdmin();

    const created = await createStaff(actor(adminId), {
      email: "cashier@lcci.test",
      fullName: "A Cashier",
      roles: ["cashier"],
      requireTwoFactor: true,
    });

    const detail = await getStaff(actor(adminId), created.userId);
    expect(detail?.twoFactorRequired).toBe(true);
    expect(detail?.requiredByName).toBe("The Boss");
    expect(detail?.requiredAt).toBeInstanceOf(Date);
  });

  it("refuses an address already in use, and names the field", async () => {
    await createStaff(actor(null), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });

    await expect(
      createStaff(actor(null), {
        email: "officer@lcci.test",
        fullName: "Another Officer",
        roles: ["cashier"],
        requireTwoFactor: false,
      }),
    ).rejects.toThrow(StaffAdminError);
  });

  it("refuses an account with no role at all", async () => {
    await expect(
      createStaff(actor(null), {
        email: "nobody@lcci.test",
        fullName: "No Body",
        roles: [],
        requireTwoFactor: false,
      }),
    ).rejects.toThrow(StaffAdminError);
  });

  it("drops a role code that is not in the vocabulary", async () => {
    const created = await createStaff(actor(null), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer", "pretend_role"],
      requireTwoFactor: false,
    });

    const detail = await getStaff(actor(null), created.userId);
    expect(detail?.roles).toEqual(["membership_officer"]);
  });

  it("refuses an actor without user.manage", async () => {
    await expect(
      createStaff(actor(null, ["application.read"]), {
        email: "officer@lcci.test",
        fullName: "An Officer",
        roles: ["membership_officer"],
        requireTwoFactor: false,
      }),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe.skipIf(!available)("the two-factor requirement", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  /**
   * The gate, as the sign-in action sees it.
   *
   * `twoFactorRequired` true with `twoFactorEnabled` false is what makes
   * `passwordAction` create an untrusted session and send the holder to
   * enrolment. If this pair ever came back the other way the password alone
   * would sign them in and the requirement would be decoration.
   */
  it("leaves the password incomplete when it is required and not set up", async () => {
    const adminId = await anAdmin();
    const created = await createStaff(actor(adminId), {
      email: "cashier@lcci.test",
      fullName: "A Cashier",
      roles: ["cashier"],
      requireTwoFactor: true,
    });
    await getDb()
      .updateTable("users")
      .set({ status: "active" })
      .where("id", "=", created.userId)
      .execute();
    await resetLimit("staffPasswordAccount", "cashier@lcci.test");

    const result = await signInWithPassword({
      email: "cashier@lcci.test",
      password: created.temporaryPassword,
      ip: null,
      userAgent: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.twoFactorEnabled).toBe(false);
      expect(result.user.twoFactorRequired).toBe(true);
    }
  });

  it("can be imposed and lifted on an existing account", async () => {
    const adminId = await anAdmin();
    const created = await createStaff(actor(adminId), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });

    await updateStaff(actor(adminId), created.userId, {
      fullName: "An Officer",
      roles: ["membership_officer"],
      status: "active",
      requireTwoFactor: true,
    });
    expect((await getStaff(actor(adminId), created.userId))?.twoFactorRequired).toBe(true);

    await updateStaff(actor(adminId), created.userId, {
      fullName: "An Officer",
      roles: ["membership_officer"],
      status: "active",
      requireTwoFactor: false,
    });

    const after = await getStaff(actor(adminId), created.userId);
    expect(after?.twoFactorRequired).toBe(false);
    // Lifted means lifted: no stale author left behind to be shown on a
    // screen as though the requirement were still in force.
    expect(after?.requiredByName).toBeNull();
    expect(after?.requiredAt).toBeNull();
  });

  /**
   * An unrelated save must not re-attribute a requirement.
   *
   * Otherwise the settings screen tells the holder that whoever last fixed a
   * typo in their name is the person demanding two-factor of them, which sends
   * them to ask the wrong colleague.
   */
  it("keeps the original author when another field is saved", async () => {
    const firstAdmin = await anAdmin();
    const second = await createStaff(actor(firstAdmin), {
      email: "deputy@lcci.test",
      fullName: "The Deputy",
      roles: ["super_admin"],
      requireTwoFactor: false,
    });
    await getDb()
      .updateTable("users")
      .set({ status: "active" })
      .where("id", "=", second.userId)
      .execute();

    const officer = await createStaff(actor(firstAdmin), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: true,
    });

    await updateStaff(actor(second.userId), officer.userId, {
      fullName: "An Officer Renamed",
      roles: ["membership_officer"],
      status: "active",
      requireTwoFactor: true,
    });

    const detail = await getStaff(actor(firstAdmin), officer.userId);
    expect(detail?.fullName).toBe("An Officer Renamed");
    expect(detail?.requiredByName).toBe("The Boss");
  });

  it("refuses an administrator editing their own account", async () => {
    const adminId = await anAdmin();

    await expect(
      updateStaff(actor(adminId), adminId, {
        fullName: "The Boss",
        roles: ["super_admin"],
        status: "active",
        requireTwoFactor: false,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses an administrator resetting their own password", async () => {
    const adminId = await anAdmin();
    await expect(resetStaffPassword(actor(adminId), adminId)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe.skipIf(!available)("managing an account", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
  });

  it("replaces the role set rather than adding to it", async () => {
    const adminId = await anAdmin();
    const created = await createStaff(actor(adminId), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });

    await updateStaff(actor(adminId), created.userId, {
      fullName: "An Officer",
      roles: ["cashier"],
      status: "active",
      requireTwoFactor: true,
    });

    expect((await getStaff(actor(adminId), created.userId))?.roles).toEqual(["cashier"]);
  });

  it("scopes a department role and leaves an unscoped one global", async () => {
    const adminId = await anAdmin();
    const created = await createStaff(actor(adminId), {
      email: "editor@lcci.test",
      fullName: "An Editor",
      roles: ["department_editor", "cashier"],
      departmentScope: "info",
      requireTwoFactor: false,
    });

    const grants = await getDb()
      .selectFrom("user_roles")
      .select(["role_code", "scope_kind", "scope_value"])
      .where("user_id", "=", created.userId)
      .orderBy("role_code", "asc")
      .execute();

    // The scope comes from the role's own definition, not from the form: a
    // cashier is global whatever department is selected alongside.
    expect(grants).toEqual([
      { role_code: "cashier", scope_kind: "global", scope_value: "" },
      { role_code: "department_editor", scope_kind: "department", scope_value: "info" },
    ]);
  });

  it("bumps role_version so every open session dies", async () => {
    const adminId = await anAdmin();
    const created = await createStaff(actor(adminId), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });

    const before = await getDb()
      .selectFrom("users")
      .select(["role_version"])
      .where("id", "=", created.userId)
      .executeTakeFirstOrThrow();

    await updateStaff(actor(adminId), created.userId, {
      fullName: "An Officer",
      roles: ["cashier"],
      status: "active",
      requireTwoFactor: false,
    });

    const after = await getDb()
      .selectFrom("users")
      .select(["role_version"])
      .where("id", "=", created.userId)
      .executeTakeFirstOrThrow();

    expect(after.role_version).toBeGreaterThan(before.role_version);
  });

  /**
   * The chamber must not be able to lock itself out.
   *
   * Demoting the last super administrator, or suspending them, leaves no route
   * into the backend but a hand-edit in phpMyAdmin.
   */
  it("will not remove the last super administrator", async () => {
    const adminId = await anAdmin();
    const other = await createStaff(actor(adminId), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });

    await expect(
      updateStaff(actor(other.userId), adminId, {
        fullName: "The Boss",
        roles: ["membership_officer"],
        status: "active",
        requireTwoFactor: false,
      }),
    ).rejects.toThrow(StaffAdminError);

    // And nothing moved: the refusal is inside the transaction.
    expect((await getStaff(actor(adminId), adminId))?.roles).toEqual(["super_admin"]);
  });

  it("will not suspend the last super administrator either", async () => {
    const adminId = await anAdmin();
    const other = await createStaff(actor(adminId), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });

    await expect(
      updateStaff(actor(other.userId), adminId, {
        fullName: "The Boss",
        roles: ["super_admin"],
        status: "suspended",
        requireTwoFactor: false,
      }),
    ).rejects.toThrow(StaffAdminError);
  });

  it("allows the demotion once somebody else holds the role", async () => {
    const adminId = await anAdmin();
    const deputy = await createStaff(actor(adminId), {
      email: "deputy@lcci.test",
      fullName: "The Deputy",
      roles: ["super_admin"],
      requireTwoFactor: false,
    });
    await getDb()
      .updateTable("users")
      .set({ status: "active" })
      .where("id", "=", deputy.userId)
      .execute();

    await updateStaff(actor(deputy.userId), adminId, {
      fullName: "The Boss",
      roles: ["membership_officer"],
      status: "active",
      requireTwoFactor: false,
    });

    expect((await getStaff(actor(deputy.userId), adminId))?.roles).toEqual([
      "membership_officer",
    ]);
  });

  it("sets a new password, revokes sessions, and returns it once", async () => {
    const adminId = await anAdmin();
    const created = await createStaff(actor(adminId), {
      email: "officer@lcci.test",
      fullName: "An Officer",
      roles: ["membership_officer"],
      requireTwoFactor: false,
    });
    await getDb()
      .updateTable("users")
      .set({ status: "active" })
      .where("id", "=", created.userId)
      .execute();

    const fresh = await resetStaffPassword(actor(adminId), created.userId);
    expect(fresh).toHaveLength(20);
    expect(fresh).not.toBe(created.temporaryPassword);

    await resetLimit("staffPasswordAccount", "officer@lcci.test");
    const old = await signInWithPassword({
      email: "officer@lcci.test",
      password: created.temporaryPassword,
      ip: null,
      userAgent: null,
    });
    expect(old.ok).toBe(false);

    await resetLimit("staffPasswordAccount", "officer@lcci.test");
    const now = await signInWithPassword({
      email: "officer@lcci.test",
      password: fresh,
      ip: null,
      userAgent: null,
    });
    expect(now.ok).toBe(true);
  });

  it("lists staff with their two-factor state, and no members", async () => {
    const adminId = await anAdmin();
    await createStaff(actor(adminId), {
      email: "cashier@lcci.test",
      fullName: "A Cashier",
      roles: ["cashier"],
      requireTwoFactor: true,
    });
    await getDb()
      .insertInto("users")
      .values({
        user_type: "portal",
        email: "member@lcci.test",
        full_name: "A Member",
        status: "active",
      })
      .execute();

    const listed = await listStaff(actor(adminId));

    expect(listed.map((person) => person.email)).toEqual([
      "cashier@lcci.test",
      "boss@lcci.test",
    ]);
    expect(listed[0]).toMatchObject({
      roles: ["cashier"],
      twoFactorRequired: true,
      twoFactorEnabled: false,
      status: "invited",
    });
  });
});
