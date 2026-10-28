"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { clientIp, getRequestId, getSession } from "@/server/auth/dal";
import { enrolTotp } from "@/server/auth/staff";
import { satisfyMfa } from "@/server/auth/session";

/**
 * Confirm an authenticator app.
 *
 * `allowBeforeMfa`, because this is the one page an account with no second
 * factor is allowed to reach, and the action it submits has to be reachable
 * from it. Every other staff action stays blocked until the factor exists.
 *
 * It does **not** redirect on success. The ten recovery codes are shown once
 * and are stored as scrypt digests, so there is no way to display them again —
 * and carrying them through a redirect would mean putting ten single-use
 * secrets in a URL, which is the Apache access log, `Referer` on every asset
 * the page loads, and the browser history of a shared secretariat machine. So
 * they come back in the action result, rendered into a `no-store` response,
 * with a visible way to generate a fresh set if the moment is missed.
 */

const enrolSchema = z.object({
  // The secret the page displayed, returned with a code generated from it.
  // Base32, with the spacing it was shown in for transcription.
  secret: z
    .string({ error: "Start again from the setup page." })
    .trim()
    .regex(/^[A-Z2-7\s]{16,80}$/i, "Start again from the setup page."),
  code: z.preprocess(
    (value) => (typeof value === "string" ? value.replace(/[\s-]/g, "") : value),
    z
      .string({ error: "Enter the six digits your app is showing." })
      .regex(/^\d{6}$/, "Enter the six digits your app is showing."),
  ),
});

export const enrolAction = withAction(
  {
    name: "auth.enrolTotp",
    audience: "staff",
    allowBeforeMfa: true,
    schema: enrolSchema,
  },
  async ({ input, actor }) => {
    const [headerList, requestId, session] = await Promise.all([
      headers(),
      getRequestId(),
      getSession(),
    ]);

    if (!actor?.userId || !session) return fail("Your session has ended. Sign in again.");

    const result = await enrolTotp({
      userId: actor.userId,
      secretBase32: input.secret,
      code: input.code,
      ip: clientIp(headerList),
      userAgent: headerList.get("user-agent"),
      requestId,
    });

    if (!result.ok) {
      return fail(
        "That code does not match. Check the time on your phone — an " +
          "authenticator is only ever as right as the clock it runs on — then " +
          "try the next code your app shows.",
        { code: "That code does not match." },
      );
    }

    // First enrolment promotes the session in place, so somebody who has just
    // proved they hold the factor is not thrown back to the sign-in form at
    // the moment they succeed. A *re*-enrolment has already revoked every
    // session inside `enrolTotp`, and this then finds nothing to promote.
    await satisfyMfa(session.session.id);

    return ok("Authenticator enrolled.", {
      recoveryCodes: result.recoveryCodes.join("\n"),
    });
  },
);
