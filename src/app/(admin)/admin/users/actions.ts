"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { ForbiddenError } from "@/server/actor";
import {
  createStaff,
  resetStaffPassword,
  StaffAdminError,
  updateStaff,
} from "@/server/auth/staff-admin";

/**
 * The staff account actions.
 *
 * All three carry `irreversible: true`, which adds the `SameSite=Strict`
 * sentinel check on top of the `Origin` check. None of them is literally
 * irreversible — a role can be re-granted — but each is an administrative
 * change to who can do what, which is exactly the shape of request worth
 * forging, and `Origin` alone has a documented hole for a request that carries
 * no `Origin` header at all.
 *
 * `StaffAdminError` is caught here rather than in the wrapper, because its
 * field errors are specific to these forms. `ForbiddenError` the wrapper
 * already handles, with one exception worth keeping: the "not your own
 * account" refusal is a sentence the administrator needs to read, so it is let
 * through as the message it is.
 */

/** A checkbox list arrives as a string when one is ticked, an array when more. */
const roleList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value],
  );

const STATUSES = ["invited", "active", "suspended", "disabled"] as const;

const createSchema = z.object({
  email: z.string({ error: "Enter an email address." }).trim().max(190),
  full_name: z.string({ error: "Enter a name." }).trim().max(160),
  roles: roleList,
  department_scope: z.string().trim().max(40).optional(),
  // An unticked checkbox submits nothing at all, so absence is false.
  require_2fa: z.union([z.string(), z.undefined()]).transform((v) => v !== undefined),
});

export const createStaffAction = withAction(
  {
    name: "admin.createStaff",
    audience: "staff",
    permission: "user.manage",
    irreversible: true,
    schema: createSchema,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Your session has ended. Sign in again.");

    let created: { userId: number; temporaryPassword: string };

    try {
      created = await createStaff(actor, {
        email: input.email,
        fullName: input.full_name,
        roles: input.roles,
        departmentScope: input.department_scope || null,
        requireTwoFactor: input.require_2fa,
      });
    } catch (error) {
      if (error instanceof StaffAdminError) {
        return fail(error.message, error.fieldErrors);
      }
      throw error;
    }

    revalidatePath("/admin/users");

    // The temporary password is returned in the action result and rendered
    // into a `no-store` response — never carried through a redirect, which
    // would put a live credential in the Apache access log, in `Referer` on
    // every asset the next page loads, and in the browser history of a shared
    // secretariat machine. Same reasoning as the recovery codes.
    return ok("Account created.", {
      userId: String(created.userId),
      temporaryPassword: created.temporaryPassword,
    });
  },
);

const updateSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  full_name: z.string({ error: "Enter a name." }).trim().max(160),
  roles: roleList,
  department_scope: z.string().trim().max(40).optional(),
  status: z.enum(STATUSES),
  require_2fa: z.union([z.string(), z.undefined()]).transform((v) => v !== undefined),
});

export const updateStaffAction = withAction(
  {
    name: "admin.updateStaff",
    audience: "staff",
    permission: "user.manage",
    irreversible: true,
    schema: updateSchema,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Your session has ended. Sign in again.");

    try {
      await updateStaff(actor, input.user_id, {
        fullName: input.full_name,
        roles: input.roles,
        departmentScope: input.department_scope || null,
        status: input.status,
        requireTwoFactor: input.require_2fa,
      });
    } catch (error) {
      if (error instanceof StaffAdminError) {
        return fail(error.message, error.fieldErrors);
      }
      if (error instanceof ForbiddenError) {
        return fail(error.message);
      }
      throw error;
    }

    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${input.user_id}`);

    return ok("Saved. Every session this account had open has been signed out.");
  },
);

const resetSchema = z.object({
  user_id: z.coerce.number().int().positive(),
});

export const resetPasswordAction = withAction(
  {
    name: "admin.resetStaffPassword",
    audience: "staff",
    permission: "user.manage",
    irreversible: true,
    rateLimit: { name: "staffReauth", subject: "actor" },
    schema: resetSchema,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Your session has ended. Sign in again.");

    let password: string;

    try {
      password = await resetStaffPassword(actor, input.user_id);
    } catch (error) {
      if (error instanceof StaffAdminError) return fail(error.message);
      if (error instanceof ForbiddenError) return fail(error.message);
      throw error;
    }

    revalidatePath(`/admin/users/${input.user_id}`);

    return ok("A new password has been set.", { temporaryPassword: password });
  },
);
