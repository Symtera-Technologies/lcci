"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, withAction } from "@/server/action";
import { clientIp, getRequestId, getSession, isSameSiteRequest } from "@/server/auth/dal";
import { signInWithPassword, verifySecondFactor } from "@/server/auth/staff";
import { createSession, revokeCurrentSession, satisfyMfa } from "@/server/auth/session";

/**
 * Staff sign-in, in two steps.
 *
 * The step is never held in the client. After the password a real session
 * exists with `mfa_satisfied_at` NULL, so the page re-renders into the code
 * form from the session itself — which means a refresh, a second tab and the
 * back button all show the correct step, and there is no half-authenticated
 * state living anywhere but the sessions table.
 */

async function facts(): Promise<{
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}> {
  const [headerList, requestId] = await Promise.all([headers(), getRequestId()]);
  return {
    ip: clientIp(headerList),
    userAgent: headerList.get("user-agent"),
    requestId,
  };
}

/* -------------------------------------------------------------------------- */
/* Step one: the password                                                     */
/* -------------------------------------------------------------------------- */

const passwordSchema = z.object({
  email: z
    .string({ error: "Enter your chamber email address." })
    .trim()
    .max(190)
    .refine((value) => value.includes("@"), "Enter your chamber email address."),
  // No maximum length and no complexity rules at the door. The rules belong
  // where a password is *set*; applying them here would reject a correct
  // password that predates the current policy and tell the holder it is wrong.
  password: z.string({ error: "Enter your password." }).min(1, "Enter your password."),
});

export const passwordAction = withAction(
  {
    name: "auth.staffPassword",
    audience: "public",
    schema: passwordSchema,
  },
  async ({ input }) => {
    const request = await facts();

    const result = await signInWithPassword({
      email: input.email,
      password: input.password,
      ip: request.ip,
      userAgent: request.userAgent,
      requestId: request.requestId,
    });

    if (!result.ok) {
      if (result.reason === "locked") {
        return fail(
          `Too many failed attempts. This account is locked for ` +
            `${Math.ceil(result.retryAfterSeconds / 60)} minutes. ` +
            `Telephone the secretariat if you need it cleared sooner.`,
        );
      }
      return fail("That email address and password do not match.");
    }

    // The session is created here, before the second factor, and is useless
    // until promoted: `requireStaff` refuses every route except this one and
    // enrolment while `mfa_satisfied_at` is NULL.
    await createSession({
      userId: result.user.id,
      userType: "staff",
      roleVersion: result.user.roleVersion,
      ip: request.ip,
      userAgent: request.userAgent,
      mfaSatisfied: false,
    });

    redirect(result.user.hasTotp ? "/admin/sign-in" : "/admin/setup-2fa");
  },
);

/* -------------------------------------------------------------------------- */
/* Step two: the authenticator                                                */
/* -------------------------------------------------------------------------- */

const secondFactorSchema = z.object({
  code: z
    .string({ error: "Enter the code from your authenticator app." })
    .trim()
    // Wide enough for a six-digit code or a recovery code, and the domain
    // layer decides which by shape. A radio button asking the user to say
    // which kind they are holding is a question they should not have to answer.
    .min(6, "Enter the six-digit code, or one of your recovery codes.")
    .max(40),
});

export const secondFactorAction = withAction(
  {
    name: "auth.staffSecondFactor",
    audience: "staff",
    // The whole point of this action is to satisfy the factor it would
    // otherwise be blocked by.
    allowBeforeMfa: true,
    schema: secondFactorSchema,
  },
  async ({ input, actor }) => {
    const request = await facts();
    const session = await getSession();
    if (!actor?.userId || !session) return fail("Your session has ended. Sign in again.");

    const result = await verifySecondFactor({
      userId: actor.userId,
      code: input.code,
      ip: request.ip,
      userAgent: request.userAgent,
      requestId: request.requestId,
    });

    if (!result.ok) {
      if (result.reason === "locked") {
        return fail(
          `Too many failed attempts. This account is locked for ` +
            `${Math.ceil(result.retryAfterSeconds / 60)} minutes.`,
        );
      }
      if (result.reason === "not-enrolled") {
        redirect("/admin/setup-2fa");
      }
      if (result.reason === "replayed") {
        return fail(
          "That code has already been used. Wait for your app to show the next one.",
        );
      }
      return fail("That code is not right. Check your authenticator app and try again.");
    }

    if (!(await satisfyMfa(session.session.id))) {
      // Already promoted — a double submission, or a second tab. Nothing to
      // do, and the destination is the same.
      redirect("/admin");
    }

    redirect("/admin");
  },
);

/* -------------------------------------------------------------------------- */
/* Out again                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Sign out.
 *
 * A POST guarded by the `SameSite=Strict` sentinel, like the member one. Also
 * the escape hatch from a half-authenticated session: someone who has entered
 * their password and cannot produce a code must be able to abandon the attempt
 * rather than being stuck on a form with no way out.
 */
export async function signOutStaff(): Promise<void> {
  if (!(await isSameSiteRequest())) redirect("/admin/sign-in");
  await revokeCurrentSession();
  redirect("/admin/sign-in?signedOut=1");
}
