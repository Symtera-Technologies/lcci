"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { clientIp, getRequestId } from "@/server/auth/dal";
import { completeRegistration, startRegistration } from "@/server/auth/registration";
import { createSession } from "@/server/auth/session";
import { safeDestination } from "@/server/auth/destination";
import { toE164 } from "@/lib/phone";
import { t } from "@/server/i18n";

/**
 * Opening an account, as the form sees it.
 *
 * Thin, like the sign-in actions beside it and for the same reason: every
 * decision with a security consequence is in `src/server/auth/registration.ts`,
 * so there is one place to read and one place to change. What is here is the
 * form contract, the copy and the one thing that cannot live in the domain
 * layer — minting the cookie, which needs the request's own response.
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
/* Step one: who you are, and where to send the code                          */
/* -------------------------------------------------------------------------- */

const NAME_MESSAGE = "Enter your own name, as the person applying.";
const EMAIL_MESSAGE = "Enter an email address we can reach you at.";

const startSchema = z.object({
  fullName: z
    .string({ error: NAME_MESSAGE })
    .trim()
    .min(2, NAME_MESSAGE)
    // 160, matching the column. Not a judgement about names: it is the width
    // of the box the value has to fit in.
    .max(160, "That is longer than the register can hold."),

  email: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z
      .string({ error: EMAIL_MESSAGE })
      .email(EMAIL_MESSAGE)
      .max(190, "That is longer than any registered email address."),
  ),

  // Validated as text here and normalised in the handler, so the refusal can
  // name the field and show the shape rather than being one more line in a
  // summary. 40 characters is room for a country code, spaces and dashes; the
  // stored form is at most sixteen.
  mobile: z
    .string({ error: "Enter a mobile number." })
    .trim()
    .max(40, "That is longer than any telephone number."),

  next: z.string().optional(),
});

/**
 * Begin a registration: create the account if it is new, and send the code.
 *
 * Public because it has to be — this is the door, and a visitor who has no
 * account is the only visitor it is for.
 *
 * Returns `ok` with one message in every case that is not an outright
 * refusal: new address, address already on the register, an officer's address,
 * mail provider down. The *only* refusals are "too many" and "too soon",
 * neither of which says anything about the address.
 *
 * No `rateLimit` option, deliberately, exactly as on the sign-in action. The
 * limits that apply here are keyed on the normalised address and are consumed
 * inside `startRegistration` where that normalisation lives — and they are the
 * same buckets sign-in uses, so consuming a third, differently-keyed one here
 * would make the published "three codes an hour" untrue in both directions.
 */
export const startRegistrationAction = withAction(
  {
    name: "auth.startRegistration",
    audience: "public",
    schema: startSchema,
  },
  async ({ input }) => {
    const mobile = toE164(input.mobile);
    if (mobile === null) {
      return fail("Check the mobile number and try again.", {
        mobile:
          "Enter the number as 0300 1234567, or with its country code as " +
          "+92 300 1234567.",
      });
    }

    const facts = await requestFacts();

    const result = await startRegistration({
      fullName: input.fullName,
      email: input.email,
      mobile,
      ip: facts.ip,
      userAgent: facts.userAgent,
      requestId: facts.requestId,
    });

    if (!result.accepted) {
      return fail(
        result.tooSoon
          ? `A code was just sent. Wait ${result.retryAfterSeconds} seconds before asking for another.`
          : "Too many codes have been requested for that address. Try again in an hour.",
      );
    }

    // Appended to the message rather than carried in a field of its own, so
    // there is no slot on `ActionState` that could ever render in production.
    // `startRegistration` returns it only when there is no mail provider and
    // this is not a production build.
    return ok(
      result.devCode
        ? `${t("auth.register.sent")} (Development build, no mail provider: the code is ${result.devCode}.)`
        : t("auth.register.sent"),
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Step two: the code                                                         */
/* -------------------------------------------------------------------------- */

const confirmSchema = z.object({
  email: z.preprocess(
    (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
    z.string().max(190),
  ),
  code: z.preprocess(
    // Read off a phone and retyped; spaces and dashes in between are the
    // applicant's formatting, not a wrong code.
    (value) => (typeof value === "string" ? value.replace(/[\s-]/g, "") : value),
    z
      .string({ error: "Enter the six-digit code from the email." })
      .regex(/^\d{6}$/, "The code is six digits."),
  ),
  next: z.string().optional(),
  remember: z.string().optional(),
});

/**
 * Confirm the address, activate the account and sign in.
 *
 * Not `irreversible`, for the reason the sign-in action gives: that flag adds
 * the `SameSite=Strict` sentinel check, and the sentinel is a cookie this flow
 * is in the business of setting — requiring it here would mean nobody could
 * ever open an account.
 *
 * Redirects on success rather than returning a message, so the form is gone
 * before the applicant's finger leaves the button and a reload cannot
 * resubmit a code that is now dead. The destination is the wizard, which is
 * what `DEFAULT_DESTINATION` already is: the only reason to open an account
 * here is to apply.
 */
export const confirmRegistrationAction = withAction(
  {
    name: "auth.confirmRegistration",
    audience: "public",
    schema: confirmSchema,
  },
  async ({ input }) => {
    const facts = await requestFacts();

    const result = await completeRegistration({
      email: input.email,
      code: input.code,
      ip: facts.ip,
      userAgent: facts.userAgent,
      requestId: facts.requestId,
    });

    if (!result.ok) {
      if (result.reason === "locked") {
        return fail(
          `Too many failed attempts. This address is paused for ` +
            `${Math.ceil(result.retryAfterSeconds / 60)} minutes.`,
        );
      }
      return fail(
        result.reason === "too-many" ? t("auth.code.tooMany") : t("auth.code.invalid"),
        // On the field as well as in the message: a code box is the one input
        // where the message and the thing to fix are the same.
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
      // to satisfy, and leaving this false would make every new member's
      // session look half-authenticated to anything that checks.
      mfaSatisfied: true,
      remember: input.remember === "on",
    });

    // Outside any try/catch: `redirect` throws, and catching it would turn a
    // successful registration into an error message.
    redirect(safeDestination(input.next));
  },
);
