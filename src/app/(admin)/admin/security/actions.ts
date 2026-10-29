"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import { clientIp, getRequestId } from "@/server/auth/dal";
import { disableTotp } from "@/server/auth/staff";

/**
 * Turn two-factor sign-in off for one's own account.
 *
 * Three properties, all of them deliberate:
 *
 * **`irreversible: true`.** Not because the setting cannot be turned back on —
 * it can, in a minute — but because what cannot be undone is the window in
 * between, and because that flag is what demands the `SameSite=Strict`
 * sentinel cookie. The sentinel closes the gap Next leaves open for a request
 * carrying no `Origin` header at all, which is exactly the shape a
 * cross-site attempt to weaken somebody's account would take.
 *
 * **The password, re-entered.** The attacker worth designing against here is
 * not a stranger: it is whoever reaches an unlocked secretariat machine with a
 * signed-in session on it. A session cookie must not be enough to remove a
 * factor, so the domain layer verifies the password and throttles the attempt
 * on the same subject pair as the sign-in form.
 *
 * **No permission.** This is the holder's own account, and every staff account
 * must be able to manage its own sign-in. Gating it on a grant would mean an
 * officer who turned two-factor on could not turn it off without a super
 * administrator, which is how shared logins get invented.
 */

const disableSchema = z.object({
  password: z
    .string({ error: "Enter your password to confirm." })
    .min(1, "Enter your password to confirm."),
});

export const disableTwoFactorAction = withAction(
  {
    name: "auth.disableTwoFactor",
    audience: "staff",
    irreversible: true,
    rateLimit: { name: "staffReauth", subject: "actor" },
    schema: disableSchema,
  },
  async ({ input, actor }) => {
    const [headerList, requestId] = await Promise.all([headers(), getRequestId()]);

    if (!actor?.userId) return fail("Your session has ended. Sign in again.");

    const result = await disableTotp({
      userId: actor.userId,
      password: input.password,
      ip: clientIp(headerList),
      userAgent: headerList.get("user-agent"),
      requestId,
    });

    if (!result.ok) {
      if (result.reason === "wrong-password") {
        // Two different sentences on purpose. The field error says what is
        // wrong with the field; the message goes into a `role="status"` live
        // region, and repeating the same words there has a screen reader
        // announce the same correction twice and tells a sighted reader
        // nothing they cannot already see. What they both want to know is
        // that the setting did not change.
        return fail("Two-factor sign-in is still on.", {
          password: "That password is not right.",
        });
      }
      if (result.reason === "required") {
        // Reachable without the UI, so it has to answer properly rather than
        // fall through to "already off". The page hides the control; this is
        // what actually refuses it.
        return fail(
          "An administrator requires two-factor sign-in on this account, so it " +
            "cannot be turned off here. Ask them if that needs to change.",
        );
      }
      if (result.reason === "locked") {
        return fail(
          "Too many incorrect passwords. This account is locked for a while; " +
            "telephone the secretariat if you need it cleared sooner.",
        );
      }
      return fail("Two-factor sign-in is already off for this account.");
    }

    // Load-bearing, not hygiene. Without it the action returns and only the
    // client component that submitted it re-renders: the status pill beside it
    // still read "On", the prose still described entering a six-digit code and
    // still offered ten recovery codes, all of it next to a message saying
    // two-factor was now off. A security setting whose own screen contradicts
    // itself is worse than no screen, because the reader cannot tell which
    // half to believe. `force-dynamic` does not help — it governs caching, not
    // whether a page re-renders after an action that revalidates nothing.
    revalidatePath("/admin/security");

    // No redirect: there is nothing to carry in a URL, and the revalidated
    // page plus the result message say the same thing in agreement.
    return ok("Two-factor sign-in is now off. Your password alone signs you in.");
  },
);
