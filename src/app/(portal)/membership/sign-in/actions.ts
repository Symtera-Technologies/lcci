"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { clientIp, getRequestId, isSameSiteRequest } from "@/server/auth/dal";
import { issueSignInCode, verifySignInCode } from "@/server/auth/otp";
import { createSession, revokeCurrentSession } from "@/server/auth/session";
import { safeDestination } from "@/server/auth/destination";
import { t } from "@/server/i18n";

/**
 * The sign-in actions.
 *
 * Thin on purpose: every decision that has a security consequence lives in
 * `src/server/auth/otp.ts`, so there is one place to read and one place to
 * change. What is here is the form contract, the redirect target and the
 * copy — and the one thing that cannot live in the domain layer, which is
 * minting the cookie, because that needs the request's own response.
 */

async function requestFacts(): Promise<{
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
/* Step one: ask for a code                                                   */
/* -------------------------------------------------------------------------- */

const requestSchema = z.object({
  identifier: z
    .string({ error: "Enter your email address or membership number." })
    // Long enough for any real address, short enough that the column and the
    // mail header are never the thing that fails.
    .max(190, "That is longer than any registered email address.")
    .trim(),
  next: z.string().optional(),
});

/**
 * Request a sign-in code.
 *
 * Returns `ok` with the same message in every case that is not an outright
 * refusal — registered, unregistered, staff address, mail provider down. The
 * action is public because it has to be: this is the door.
 *
 * No `rateLimit` option, deliberately. The limits that apply here are keyed on
 * the normalised identifier and the address and are consumed inside
 * `issueSignInCode`, where the normalisation lives; consuming a third one here
 * on a differently-keyed subject would make the published "three per hour"
 * untrue in both directions.
 */
export const requestCodeAction = withAction(
  {
    name: "auth.requestSignInCode",
    audience: "public",
    schema: requestSchema,
  },
  async ({ input }) => {
    const facts = await requestFacts();

    const result = await issueSignInCode({
      identifier: input.identifier,
      ip: facts.ip,
      userAgent: facts.userAgent,
      requestId: facts.requestId,
    });

    if (!result.accepted) {
      return fail(
        result.tooSoon
          ? `A code was just sent. Wait ${result.retryAfterSeconds} seconds before asking for another.`
          : "Too many sign-in codes have been requested. Try again in an hour.",
      );
    }

    // The dev code is appended rather than carried in a field of its own, so
    // there is no slot on `ActionState` that could ever be rendered in
    // production. `issueSignInCode` returns it only when there is no mail
    // provider and this is not a production build.
    return ok(
      result.devCode
        ? `${t("auth.signIn.sent")} (Development build, no mail provider: the code is ${result.devCode}.)`
        : t("auth.signIn.sent"),
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Step two: enter it                                                         */
/* -------------------------------------------------------------------------- */

const verifySchema = z.object({
  identifier: z.string().max(190).trim(),
  code: z.preprocess(
    // Members read the code off a phone and retype it; spaces and dashes in
    // between are the member's formatting, not a wrong code.
    (value) => (typeof value === "string" ? value.replace(/[\s-]/g, "") : value),
    z
      .string({ error: "Enter the six-digit code from the email." })
      .regex(/^\d{6}$/, "The code is six digits."),
  ),
  next: z.string().optional(),
  remember: z.string().optional(),
});

/**
 * Check a code and sign the member in.
 *
 * Not `irreversible`: that flag adds the `SameSite=Strict` sentinel check, and
 * the sentinel is a cookie this flow is in the business of setting — requiring
 * it here would mean nobody could ever sign in for the first time.
 *
 * On success this redirects rather than returning a message, so the form is
 * gone before the member's finger leaves the button and a reload cannot
 * resubmit a code that is now dead.
 */
export const verifyCodeAction = withAction(
  {
    name: "auth.verifySignInCode",
    audience: "public",
    schema: verifySchema,
  },
  async ({ input }) => {
    const facts = await requestFacts();

    const result = await verifySignInCode({
      identifier: input.identifier,
      code: input.code,
      ip: facts.ip,
      userAgent: facts.userAgent,
      requestId: facts.requestId,
    });

    if (!result.ok) {
      if (result.reason === "locked") {
        return fail(
          `Too many failed attempts. Sign-in for this account is paused for ` +
            `${Math.ceil(result.retryAfterSeconds / 60)} minutes.`,
        );
      }
      return fail(
        result.reason === "too-many" ? t("auth.code.tooMany") : t("auth.code.invalid"),
        // Placed on the field as well as in the message, because a code box is
        // the one input where the message and the thing to fix are the same.
        { code: t("auth.code.invalid") },
      );
    }

    await createSession({
      userId: result.user.id,
      userType: result.user.userType,
      roleVersion: result.user.roleVersion,
      ip: facts.ip,
      userAgent: facts.userAgent,
      // The emailed code *is* the factor for a member. There is no second one
      // to satisfy, and leaving this false would make every member session
      // look half-authenticated to anything that checks.
      mfaSatisfied: true,
      remember: input.remember === "on",
    });

    // Outside any try/catch, like the wizard's submit: `redirect` throws, and
    // catching it would turn a successful sign-in into an error message.
    redirect(safeDestination(input.next));
  },
);

/* -------------------------------------------------------------------------- */
/* Out again                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Sign out.
 *
 * A POST, never a GET. A sign-out link that works on GET is a link anyone can
 * put in an `<img src>` on any page, and the result is a member quietly logged
 * out mid-form — harmless as attacks go, infuriating as a bug report.
 *
 * Not wrapped in `withAction`: that contract is `(prev, formData)` for
 * `useActionState`, and this is a plain `<form action>` on a server component
 * with no state to render. The CSRF defence is the `SameSite=Strict` sentinel
 * cookie, which a cross-site POST cannot carry by construction — the same
 * check `withAction` applies to irreversible actions, and the one that closes
 * Next's documented `Origin`-absent gap.
 */
export async function signOut(): Promise<void> {
  if (!(await isSameSiteRequest())) {
    // Nothing is revoked and nothing is said. A request that did not come from
    // this site gets the sign-in page, which is where it claimed to be going.
    redirect("/membership/sign-in");
  }

  await revokeCurrentSession();
  redirect("/membership/sign-in?signedOut=1");
}
