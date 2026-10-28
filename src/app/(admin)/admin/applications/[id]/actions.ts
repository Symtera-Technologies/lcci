"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { claimApplication, releaseApplication } from "@/membership/assignment";

/**
 * Assignment, the only thing the review screen writes.
 *
 * Verification, deficiencies, receipting and approval are A5 to A7 and get
 * their own actions with their own guards; this screen shows what those moves
 * would be blocked by rather than making them. Keeping it that way means the
 * read-only screen can be put in front of officers now without a half-built
 * transition button on it.
 *
 * `revalidatePath` rather than a redirect: the officer is already on the page
 * they want and carries a selected document in the query string, so a redirect
 * would either lose that or need to reconstruct it.
 */

const target = z.object({
  applicationId: z.coerce.number().int().positive(),
});

export const claimAction = withAction(
  {
    name: "application.claim",
    audience: "staff",
    permission: "application.assign",
    schema: target,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await claimApplication(actor, input.applicationId);
    if (!result.ok) {
      return fail(
        result.reason === "taken"
          ? "Another officer picked this up first. Reload to see who has it."
          : "That application no longer exists.",
      );
    }

    revalidatePath(`/admin/applications/${input.applicationId}`);
    return ok(
      result.alreadyMine
        ? "This application was already assigned to you."
        : "Assigned to you.",
    );
  },
);

export const releaseAction = withAction(
  {
    name: "application.release",
    audience: "staff",
    permission: "application.assign",
    schema: target,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await releaseApplication(actor, input.applicationId);
    if (!result.ok) {
      return fail("This application is not assigned to you.");
    }

    revalidatePath(`/admin/applications/${input.applicationId}`);
    return ok("Released.");
  },
);
