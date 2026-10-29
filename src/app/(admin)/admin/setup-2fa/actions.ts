"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { clientIp, getRequestId, getSession } from "@/server/auth/dal";
import { enrolTotp } from "@/server/auth/staff";
import { satisfyMfa } from "@/server/auth/session";

/**
 * Confirm an authenticator app.
 *
 * It carries `allowBeforeMfa`, and then refuses most of what that admits. The
 * exemption exists for one case: an account an administrator has required
 * two-factor on has a session that owes a second factor and no authenticator
 * to produce one with, so without the exemption it could never confirm the
 * enrolment that is the only thing standing between it and the backend.
 *
 * An account that owes a *code* is turned away here, in the handler. The
 * wrapper's exemption is all-or-nothing and the distinction is not, and this
 * is the control — the page's matching check only spares the holder a form
 * that would refuse them. Without it, a stolen password alone would be enough
 * to pair a new authenticator over the real holder's and own the second
 * factor.
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

    if (session.session.mfaSatisfiedAt === null && session.user.twoFactorEnabled) {
      return fail(
        "Enter the code from your current authenticator app first. You can " +
          "pair a different app once you are signed in.",
      );
    }

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

    // Load-bearing for exactly one case, and a no-op for every other. Turning
    // two-factor on by choice happens inside an already-trusted session, and
    // `satisfyMfa` is guarded on `mfa_satisfied_at IS NULL`, so it finds
    // nothing to promote. The case that needs it is the account an
    // administrator required two-factor on: its session has owed a second
    // factor since the password, and having just produced a code from the
    // secret it paired a moment ago is that factor. Without this the holder
    // would confirm enrolment and be bounced straight back here.
    await satisfyMfa(session.session.id);

    // So that `/admin/security` reads "On" the moment the holder follows the
    // link out of the recovery-codes screen, rather than serving them the
    // render it had before they enrolled.
    revalidatePath("/admin/security");

    return ok("Authenticator enrolled.", {
      recoveryCodes: result.recoveryCodes.join("\n"),
    });
  },
);
