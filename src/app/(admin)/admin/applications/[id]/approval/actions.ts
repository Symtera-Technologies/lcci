"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import {
  MIN_REASON_LENGTH,
  approveApplication,
  rejectApplication,
  returnForVerification,
  waiveConflict,
} from "@/membership/approval";

/**
 * The approver's three decisions, and the super-admin's one exception.
 *
 * All four are `irreversible`, which adds the `SameSite=Strict` sentinel on
 * top of the Origin check. A grant issues a number that can never be reused, a
 * refusal is what the applicant is told, and a waiver turns off a control the
 * printed form's separate signatures exist to create. None of them is a thing
 * a cross-site request should be able to start even holding a session cookie.
 *
 * Note what is absent: no "approve all". A queue action that grants several
 * memberships at once would mean one click standing for several judgements,
 * and the approval block on page 2 is signed per application for a reason.
 */

const approve = z.object({
  applicationId: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive(),
  // Optional, and deliberately so. A clear file needs no explanation, and
  // demanding one trains approvers to type "ok" — which is worse than silence
  // because it looks like a reason.
  note: z.string().trim().max(600).optional(),
  /**
   * Typed confirmation, not a checkbox.
   *
   * The one place in this admin that asks for it. A checkbox beside "Grant
   * membership" is clicked past; typing the application's own reference means
   * the approver has looked at which file they are on. The alternative —
   * discovering afterwards that a number was issued to the wrong firm — cannot
   * be undone, only cancelled, and the number is gone either way.
   */
  confirm: z
    .string()
    .trim()
    .min(1, "Type the application reference to confirm."),
});

export const approveApplicationAction = withAction(
  {
    name: "application.approve",
    audience: "staff",
    permission: "application.approve",
    schema: approve,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await approveApplication(actor, {
      applicationId: input.applicationId,
      version: input.version,
      note: input.note === undefined || input.note === "" ? null : input.note,
      confirm: input.confirm,
    });

    const path = `/admin/applications/${input.applicationId}/approval`;
    revalidatePath(path);
    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath("/admin/applications");

    if (!result.ok) {
      return {
        ...fail(
          result.message,
          result.refusal === "confirm_mismatch"
            ? { confirm: "This does not match the application's reference." }
            : undefined,
        ),
        // The failed guards, verbatim from the same table the server enforced
        // them with, so the message cannot drift from the reason.
        data:
          result.reasons.length > 0
            ? { reasons: result.reasons.join("\n") }
            : undefined,
      };
    }

    const waived =
      result.waived.length > 0
        ? ` Separation of duties was waived for ${result.waived.join(" and ")}, which is on the record.`
        : "";

    const sla =
      result.slaOutcome === "breached"
        ? " The processing deadline was missed, which is recorded against the application."
        : "";

    return ok(
      `Membership ${result.membershipNo} granted, valid until ${result.validUntil} ` +
        `(${result.label}). The grant email is queued.${waived}${sla}`,
    );
  },
);

const refuse = z.object({
  applicationId: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive(),
  reason: z
    .string()
    .trim()
    .min(MIN_REASON_LENGTH, "Say why, in a sentence the applicant can act on.")
    .max(600),
});

export const rejectApplicationAction = withAction(
  {
    name: "application.reject",
    audience: "staff",
    permission: "application.reject",
    schema: refuse,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await rejectApplication(actor, input);

    revalidatePath(`/admin/applications/${input.applicationId}/approval`);
    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath("/admin/applications");

    if (!result.ok) return fail(result.message, fieldFor(result.refusal));

    return ok(
      "Refusal recorded. The applicant is not told automatically yet — status " +
        "emails are still to be built, so somebody must contact them.",
    );
  },
);

export const returnForVerificationAction = withAction(
  {
    name: "application.return_for_verification",
    audience: "staff",
    permission: "application.approve",
    schema: refuse,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await returnForVerification(actor, input);

    revalidatePath(`/admin/applications/${input.applicationId}/approval`);
    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath("/admin/applications");

    if (!result.ok) return fail(result.message, fieldFor(result.refusal));

    return ok(
      "Sent back for verification. The processing clock keeps running: the file " +
        "is in the Chamber's own hands, and pausing it would be the Chamber " +
        "excusing its own delay.",
    );
  },
);

const waiver = z.object({
  applicationId: z.coerce.number().int().positive(),
  guard: z.enum(["not_the_verifier", "not_the_cashier"], {
    error: "Choose which separation-of-duties guard is being waived.",
  }),
  grantedFor: z.coerce.number().int().positive(),
  reason: z
    .string()
    .trim()
    .min(MIN_REASON_LENGTH, "Say why this exception is being made.")
    .max(600),
});

export const waiveConflictAction = withAction(
  {
    name: "application.waive_conflict",
    audience: "staff",
    // `role.manage`, not `application.approve`. The whole point is that the
    // person who will approve cannot clear their own way.
    permission: "role.manage",
    schema: waiver,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await waiveConflict(actor, input);

    revalidatePath(`/admin/applications/${input.applicationId}/approval`);

    if (!result.ok) {
      return fail(
        result.message,
        result.refusal === "reason_required"
          ? { reason: "A reason is required." }
          : undefined,
      );
    }

    return ok(
      "Waiver recorded. It applies to this one person, this one guard and this " +
        "one application, and it is in the audit log.",
    );
  },
);

function fieldFor(refusal: string): Record<string, string> | undefined {
  switch (refusal) {
    case "reason_required":
      return { reason: "A reason is required." };
    default:
      return undefined;
  }
}
