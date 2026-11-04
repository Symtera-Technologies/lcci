"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { ok, withAction } from "@/server/action";
import { clientIp } from "@/server/auth/dal";
import { log } from "@/server/log";
import { recordEnquiry } from "@/server/enquiries";
import { CONTACT_TOPIC_CODES } from "@/content/contact-topics";

/**
 * The contact form's one action.
 *
 * Public, so everything that protects it has to be in the wrapper rather than
 * in a session: `withAction` requires a present and matching `Origin` — which
 * closes the gap Next leaves for a request carrying none — and consumes the
 * `publicFormIp` limit, five an hour, before any of this runs.
 *
 * That limit is the real spam control today, and it is worth being plain
 * about what it is not. It stops a script hammering one address and it stops
 * a bored person refreshing; it does not stop a distributed submission flood,
 * and nothing available on this host does. Turnstile is the documented next
 * step and `src/server/csp.ts` already carries its origins in the policy, so
 * adding it is a component and a verify call rather than a redesign.
 */

/**
 * A single trimmed line.
 *
 * Trimming before length-checking matters more than it looks on a form filled
 * in on a phone: a trailing space from a predictive keyboard should not be
 * the difference between a valid name and an error, and leading whitespace
 * should not be how a 120-character limit is defeated.
 */
function line(max: number) {
  return z.string().trim().max(max);
}

/** A field someone may leave blank, stored as NULL rather than as "". */
function optionalLine(max: number) {
  return line(max)
    .optional()
    .transform((value) => (value && value !== "" ? value : null));
}

const enquiry = z.object({
  name: line(120).min(2, "Please give your name."),

  email: z
    .string()
    .trim()
    .max(190, "That address is too long.")
    // Deliberately the same permissive shape the newsletter field has used
    // since the site launched, and for the same stated reason: the mail
    // server is the real validator. A stricter pattern here would reject
    // genuine addresses — Pakistani corporate domains include some unusual
    // ones — and the cost of a wrong address is an acknowledgement that
    // bounces, not a lost enquiry, because the chamber's copy is a separate
    // message to a known mailbox.
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "That does not look like an email address."),

  phone: optionalLine(40),
  organisation: optionalLine(190),

  topic: z.enum(CONTACT_TOPIC_CODES as [string, ...string[]], {
    error: "Choose what this is about.",
  }),

  message: line(4000)
    .min(20, "Please write a little more, so we can route this to the right desk.")
    .max(4000, "Please keep this under 4,000 characters."),

  /**
   * The honeypot.
   *
   * Named for something a form-filling bot expects to find and a person never
   * sees. It is hidden from sight, from the tab order and from screen readers,
   * so anything in it was put there by a script.
   *
   * Optional and unconstrained here on purpose: a schema that *rejected* a
   * filled honeypot would tell the script which field gave it away. The check
   * happens in the handler, which pretends to succeed instead.
   */
  website: z.string().optional(),
});

export const sendEnquiry = withAction(
  {
    name: "contact.enquiry",
    audience: "public",
    schema: enquiry,
    rateLimit: { name: "publicFormIp", subject: "ip" },
  },
  async ({ input }) => {
    if (input.website && input.website.trim() !== "") {
      // Answered as though it worked. Telling a bot it was caught is how the
      // next version of it stops filling the field, and the cost of being
      // wrong about a real person is one lost message against a form that
      // would otherwise fill the chamber's inbox with Viagra.
      log.warn("contact form honeypot filled", { outcome: "denied" });
      return ok("Thank you — your message is with the chamber.");
    }

    const headerList = await headers();

    const result = await recordEnquiry(
      {
        name: input.name,
        email: input.email,
        phone: input.phone,
        organisation: input.organisation,
        topic: input.topic,
        message: input.message,
      },
      {
        ip: clientIp(headerList),
        userAgent: headerList.get("user-agent"),
      },
    );

    // The reference comes back in `data` so the page can show it once. It is
    // not carried through a redirect: a reference in the query string lands
    // in the Apache access log and in the `Referer` of every asset the next
    // page loads, and this one is quoted in correspondence.
    return ok(
      result.notified
        ? "Thank you — your message is with the chamber."
        : // Still true, and still the committed row. The chamber will see it
          // on the enquiries screen even if the mail did not go, and saying
          // "something went wrong" would invite a second copy of the same
          // message with no way to tell which to answer.
          "Thank you — your message has been recorded.",
      { reference: result.reference },
    );
  },
);
