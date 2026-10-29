import "server-only";

import { getDb } from "@/db/client";
import type { Transaction } from "kysely";
import type { Database } from "@/db/schema";
import { ForbiddenError, type ActorContext } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { hashPassword, newToken } from "@/server/crypto";
import { ROLE_SEED, type RoleCode } from "@/server/permissions";
import { invalidateUserSessions } from "@/server/auth/session";

/**
 * Staff account administration — creating colleagues, and managing them.
 *
 * Every function here takes an `ActorContext` and checks `user.manage` itself.
 * The pages check it too, but a server action is a publicly addressable
 * endpoint and the page that renders a button only protects the button.
 *
 * **Three rules this module exists to keep.**
 *
 * *One, a role change takes effect at once.* Every write that alters what an
 * account can do bumps `role_version`, which kills every session that account
 * has open. Narrowing someone's access while they are signed in and leaving
 * the old permissions live until their session happens to expire is the whole
 * failure mode `role_version` was added for.
 *
 * *Two, nobody edits their own account here.* Not vanity — it is the only
 * thing standing between "an administrator may manage accounts" and "an
 * administrator may quietly lift the two-factor requirement somebody else
 * imposed on them". Your own settings live at `/admin/security`, where you can
 * turn two-factor on but not off if it is required of you.
 *
 * *Three, the last super administrator cannot be disarmed.* Removing the last
 * `super_admin`, or suspending the account holding it, locks the chamber out
 * of its own backend with no route back in but a hand-edit in phpMyAdmin.
 * Checked inside the transaction, because two administrators demoting each
 * other at the same moment both pass a check made before it.
 *
 * Portal accounts are deliberately out of scope. A member is not an account
 * somebody administers — they have no password and no roles — and the one
 * thing staff may do to a membership is suspend it, which lives in the
 * membership domain with its own audit trail.
 */

export class StaffAdminError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>, message = "Please check the form.") {
    super(message);
    this.name = "StaffAdminError";
    this.fieldErrors = fieldErrors;
  }
}

export interface StaffSummary {
  readonly id: number;
  readonly email: string;
  readonly fullName: string;
  readonly status: "invited" | "active" | "suspended" | "disabled";
  readonly roles: readonly RoleCode[];
  readonly twoFactorEnabled: boolean;
  readonly twoFactorRequired: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
}

export interface StaffDetail extends StaffSummary {
  readonly requiredByName: string | null;
  readonly requiredAt: Date | null;
  readonly departmentScopes: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every staff account, with its roles.
 *
 * Two queries rather than one join, and then stitched. A join multiplies each
 * user by their role count, so a single-query version has to deduplicate the
 * user rows anyway — and there are about fifteen staff accounts, so paging and
 * cleverness would both be answers to a problem this table does not have.
 */
export async function listStaff(actor: ActorContext): Promise<StaffSummary[]> {
  assertMayManage(actor);
  const db = getDb();

  const users = await db
    .selectFrom("users")
    .select([
      "id",
      "email",
      "full_name",
      "status",
      "mfa_mode",
      "totp_secret_enc",
      "mfa_required",
      "last_login_at",
      "created_at",
    ])
    .where("user_type", "=", "staff")
    .orderBy("full_name", "asc")
    .execute();

  if (users.length === 0) return [];

  const grants = await db
    .selectFrom("user_roles")
    .select(["user_id", "role_code"])
    .where(
      "user_id",
      "in",
      users.map((user) => user.id),
    )
    .execute();

  const byUser = new Map<number, RoleCode[]>();
  for (const grant of grants) {
    const list = byUser.get(grant.user_id) ?? [];
    list.push(grant.role_code as RoleCode);
    byUser.set(grant.user_id, list);
  }

  return users.map((user) => ({
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    status: user.status,
    roles: (byUser.get(user.id) ?? []).sort(),
    twoFactorEnabled: user.mfa_mode === "totp" && user.totp_secret_enc !== null,
    twoFactorRequired: user.mfa_required === 1,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
  }));
}

/** One staff account, or null. */
export async function getStaff(
  actor: ActorContext,
  userId: number,
): Promise<StaffDetail | null> {
  assertMayManage(actor);
  const db = getDb();

  const row = await db
    .selectFrom("users")
    .leftJoin(
      (eb) => eb.selectFrom("users").select(["id", "full_name"]).as("requirer"),
      (join) => join.onRef("requirer.id", "=", "users.mfa_required_by"),
    )
    .select([
      "users.id",
      "users.email",
      "users.full_name",
      "users.status",
      "users.mfa_mode",
      "users.totp_secret_enc",
      "users.mfa_required",
      "users.mfa_required_at",
      "users.last_login_at",
      "users.created_at",
      "requirer.full_name as required_by_name",
    ])
    .where("users.id", "=", userId)
    .where("users.user_type", "=", "staff")
    .executeTakeFirst();

  if (!row) return null;

  const grants = await db
    .selectFrom("user_roles")
    .select(["role_code", "scope_kind", "scope_value"])
    .where("user_id", "=", userId)
    .execute();

  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    status: row.status,
    roles: grants.map((g) => g.role_code as RoleCode).sort(),
    twoFactorEnabled: row.mfa_mode === "totp" && row.totp_secret_enc !== null,
    twoFactorRequired: row.mfa_required === 1,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    requiredByName: row.required_by_name ?? null,
    requiredAt: row.mfa_required_at,
    departmentScopes: grants
      .filter((g) => g.scope_kind === "department" && g.scope_value)
      .map((g) => g.scope_value as string),
  };
}

/* -------------------------------------------------------------------------- */
/* Creating                                                                   */
/* -------------------------------------------------------------------------- */

export interface CreateStaffInput {
  readonly email: string;
  readonly fullName: string;
  readonly roles: readonly string[];
  readonly departmentScope?: string | null;
  readonly requireTwoFactor: boolean;
}

export interface CreateStaffResult {
  readonly userId: number;
  /**
   * Generated here and returned once.
   *
   * Shown on screen exactly like the recovery codes, and for the same reason:
   * it is a scrypt digest in the database the moment this returns, so there is
   * no second chance to display it. Emailing it instead would put a live
   * credential in an inbox and make the mail system the root credential for an
   * account that can read every CNIC in the system.
   */
  readonly temporaryPassword: string;
}

/**
 * Create a staff account.
 *
 * Lands as `invited` rather than `active`, which is not cosmetic: the account
 * cannot sign in until somebody activates it, so an address typed wrong — or a
 * colleague who leaves before starting — does not leave a live credential
 * behind. `signInWithPassword` filters on `status = 'active'`.
 *
 * The password is generated, never chosen by the administrator. An
 * administrator who picks a colleague's first password knows it, and a
 * "temporary" password that is never changed is the normal outcome; generating
 * it at least means the only person who ever sees it is the one it is handed
 * to. Changing it afterwards is not built yet, which the screens say plainly
 * rather than implying otherwise.
 */
export async function createStaff(
  actor: ActorContext,
  input: CreateStaffInput,
): Promise<CreateStaffResult> {
  assertMayManage(actor);

  const email = input.email.trim().toLowerCase();
  const fullName = input.fullName.trim();
  const roles = validateRoles(input.roles);
  const errors: Record<string, string> = {};

  if (!email.includes("@") || email.length > 190) {
    errors.email = "Enter a valid email address.";
  }
  if (fullName.length < 2 || fullName.length > 160) {
    errors.fullName = "Enter the colleague's full name.";
  }
  if (roles.length === 0) {
    errors.roles = "Choose at least one role.";
  }
  if (Object.keys(errors).length > 0) throw new StaffAdminError(errors);

  const clash = await getDb()
    .selectFrom("users")
    .select(["id", "user_type"])
    .where("email", "=", email)
    .executeTakeFirst();

  if (clash) {
    throw new StaffAdminError({
      email:
        clash.user_type === "staff"
          ? "A staff account already uses that address."
          : "A member account already uses that address.",
    });
  }

  const password = newToken().slice(0, 20);
  const db = getDb();
  let userId = 0;

  await db.transaction().execute(async (tx) => {
    const inserted = await tx
      .insertInto("users")
      .values({
        user_type: "staff",
        email,
        full_name: fullName,
        password_hash: hashPassword(password),
        status: "invited",
        // Explicit. The column default is 'otp_email', which describes a
        // member's emailed code and is meaningless for an account that has a
        // password and no emailed-code path at all.
        mfa_mode: "none",
        mfa_required: input.requireTwoFactor ? 1 : 0,
        mfa_required_by: input.requireTwoFactor ? actor.userId : null,
        mfa_required_at: input.requireTwoFactor ? new Date() : null,
      })
      .executeTakeFirst();

    userId = Number(inserted.insertId ?? 0);
    await writeRoles(tx, userId, roles, input.departmentScope ?? null);
  });

  await writeAudit(actor, {
    entityType: "user",
    entityId: userId,
    action: "staff.account_created",
    summary: `Created the staff account ${fullName} <${email}> as ${roles.join(", ")}.`,
    context: {
      email,
      fullName,
      roles,
      departmentScope: input.departmentScope ?? null,
      twoFactorRequired: input.requireTwoFactor,
      status: "invited",
    },
  });

  return { userId, temporaryPassword: password };
}

/* -------------------------------------------------------------------------- */
/* Managing                                                                   */
/* -------------------------------------------------------------------------- */

export interface UpdateStaffInput {
  readonly fullName: string;
  readonly roles: readonly string[];
  readonly departmentScope?: string | null;
  readonly status: "invited" | "active" | "suspended" | "disabled";
  readonly requireTwoFactor: boolean;
}

/**
 * Change a colleague's name, roles, status, or two-factor requirement.
 *
 * One function rather than four, because the four are one form and a partial
 * save is worse than none: an administrator who demotes somebody and suspends
 * them wants both or neither, and `role_version` should be bumped once, not
 * four times with three windows in between where the account holds a
 * half-applied set of permissions.
 *
 * Every path through here bumps `role_version` and revokes sessions, including
 * a name change. That is a shade heavier than necessary — a renamed colleague
 * need not be signed out — but the alternative is deciding, per field, whether
 * this particular edit is security-relevant, and getting that judgement wrong
 * silently leaves stale permissions live. A staff member signing in again is
 * cheap; a revoked role that keeps working is not.
 */
export async function updateStaff(
  actor: ActorContext,
  userId: number,
  input: UpdateStaffInput,
): Promise<void> {
  assertMayManage(actor);

  if (actor.userId === userId) {
    // The rule that makes the requirement mean anything. Without it an
    // administrator required to use two-factor simply opens their own row and
    // unrequires it, and so could anyone who borrowed their session.
    throw new ForbiddenError(
      "user.manage",
      "You cannot change your own account here. Your sign-in settings are under “Your sign-in”.",
    );
  }

  const fullName = input.fullName.trim();
  const roles = validateRoles(input.roles);
  const errors: Record<string, string> = {};

  if (fullName.length < 2 || fullName.length > 160) {
    errors.fullName = "Enter the colleague's full name.";
  }
  if (roles.length === 0) {
    errors.roles = "Choose at least one role.";
  }
  if (Object.keys(errors).length > 0) throw new StaffAdminError(errors);

  const db = getDb();

  const before = await db
    .selectFrom("users")
    .select(["id", "email", "full_name", "status", "mfa_required"])
    .where("id", "=", userId)
    .where("user_type", "=", "staff")
    .executeTakeFirst();

  if (!before) throw new StaffAdminError({}, "That staff account no longer exists.");

  const wasRequired = before.mfa_required === 1;
  const nowActive = input.status === "active";

  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("users")
      .set({
        full_name: fullName,
        status: input.status,
        mfa_required: input.requireTwoFactor ? 1 : 0,
        // Re-stamped only when the requirement is newly imposed, so the
        // screen can keep saying who first asked for it rather than naming
        // whoever last saved an unrelated field.
        mfa_required_by: input.requireTwoFactor
          ? wasRequired
            ? undefined
            : actor.userId
          : null,
        mfa_required_at: input.requireTwoFactor
          ? wasRequired
            ? undefined
            : new Date()
          : null,
      })
      .where("id", "=", userId)
      .execute();

    await tx.deleteFrom("user_roles").where("user_id", "=", userId).execute();
    await writeRoles(tx, userId, roles, input.departmentScope ?? null);

    // Inside the transaction, after the write. Two administrators demoting
    // each other simultaneously both pass a check made beforehand; this one
    // reads the state the transaction is about to commit, so exactly one of
    // them loses.
    await assertSuperAdminSurvives(tx);
  });

  await bumpRoleVersion(userId);

  await writeAudit(actor, {
    entityType: "user",
    entityId: userId,
    action: "staff.account_updated",
    summary: `Updated the staff account ${fullName} <${before.email}>.`,
    context: {
      roles,
      departmentScope: input.departmentScope ?? null,
      status: input.status,
      statusWas: before.status,
      twoFactorRequired: input.requireTwoFactor,
      twoFactorRequiredWas: wasRequired,
      // The operationally interesting bit when reading the log back: whether
      // this edit was the one that imposed or lifted the requirement.
      requirementChanged: wasRequired !== input.requireTwoFactor,
      canSignIn: nowActive,
    },
  });
}

/**
 * Hand a colleague a fresh password.
 *
 * Returned once, exactly like creation. Every session of theirs is revoked,
 * because the realistic reason for calling this is that the old password is
 * compromised or lost, and leaving live sessions open would make the reset
 * cosmetic.
 */
export async function resetStaffPassword(
  actor: ActorContext,
  userId: number,
): Promise<string> {
  assertMayManage(actor);

  if (actor.userId === userId) {
    throw new ForbiddenError(
      "user.manage",
      "Ask another administrator to reset your own password.",
    );
  }

  const row = await getDb()
    .selectFrom("users")
    .select(["id", "email", "full_name"])
    .where("id", "=", userId)
    .where("user_type", "=", "staff")
    .executeTakeFirst();

  if (!row) throw new StaffAdminError({}, "That staff account no longer exists.");

  const password = newToken().slice(0, 20);

  await getDb()
    .updateTable("users")
    .set({ password_hash: hashPassword(password) })
    .where("id", "=", userId)
    .execute();

  await bumpRoleVersion(userId);

  await writeAudit(actor, {
    entityType: "user",
    entityId: userId,
    action: "staff.password_reset",
    summary: `Set a new password for ${row.full_name} <${row.email}>; every session was revoked.`,
  });

  return password;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function assertMayManage(actor: ActorContext): void {
  if (actor.userType !== "staff" || !actor.permissions.has("user.manage")) {
    throw new ForbiddenError("user.manage");
  }
}

function validateRoles(roles: readonly string[]): RoleCode[] {
  const known = new Set(Object.keys(ROLE_SEED));
  return [...new Set(roles.filter((role) => known.has(role)))] as RoleCode[];
}

/**
 * Write the role grants, with the scope each role actually takes.
 *
 * The scope comes from `ROLE_SEED` rather than from the form, because it is a
 * property of the role: `department_editor` is scoped by department and
 * `cashier` is not, and letting a form say otherwise would produce a grant
 * whose `scope_kind` the authorisation code does not expect.
 */
async function writeRoles(
  tx: Transaction<Database>,
  userId: number,
  roles: readonly RoleCode[],
  departmentScope: string | null,
): Promise<void> {
  if (roles.length === 0) return;

  await tx
    .insertInto("user_roles")
    .values(
      roles.map((role) => {
        const scoped = ROLE_SEED[role].scope === "department" && departmentScope;
        return {
          user_id: userId,
          role_code: role,
          scope_kind: scoped ? ("department" as const) : ("global" as const),
          scope_value: scoped ? departmentScope : "",
        };
      }),
    )
    .execute();
}

/** At least one active account must still hold `super_admin`. */
async function assertSuperAdminSurvives(tx: Transaction<Database>): Promise<void> {
  const remaining = await tx
    .selectFrom("user_roles")
    .innerJoin("users", "users.id", "user_roles.user_id")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("user_roles.role_code", "=", "super_admin")
    .where("users.status", "=", "active")
    .executeTakeFirst();

  if (!remaining || Number(remaining.count) === 0) {
    throw new StaffAdminError(
      {
        roles:
          "Somebody must keep super administrator. Grant it to another active account first.",
      },
      "That would leave the chamber with no super administrator.",
    );
  }
}

/**
 * Bump `role_version`, which kills every session of that account.
 *
 * Outside the transaction on purpose: `invalidateUserSessions` is the thing
 * that makes it bite, and a failure to revoke must not roll back a role change
 * that was the point of the request. The version comparison in
 * `validateSessionToken` already refuses every existing session the moment the
 * integer moves, so the revocation is belt to that braces.
 */
async function bumpRoleVersion(userId: number): Promise<void> {
  await invalidateUserSessions(userId);
}
