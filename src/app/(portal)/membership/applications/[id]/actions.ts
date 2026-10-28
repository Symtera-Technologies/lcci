"use server";

import { z } from "zod";
import { withAction, ok, fail } from "@/server/action";
import { recordApplicantResponse } from "@/membership/deficiency";

/**
 * The applicant's one action on this page: "I have attended to everything."
 *
 * It carries no payload beyond the application id. Everything the applicant
 * actually did — the replacement scans — travelled to
 * `/api/portal/uploads` as it happened, each one authorised against the open
 * deficiency by `authorizeUpload`. This action only declares that they are
 * finished, and `recordApplicantResponse` decides whether that is true by
 * looking at the documents on the application rather than at anything posted
 * here.
 *
 * `irreversible`, because it hands the application back to the Chamber: the
 * clock restarts, a new snapshot round is written and a new checklist round
 * opens. There is no undo, and the sentinel-cookie check that `irreversible`
 * adds is what closes the `Origin`-absent gap in Next's own server-action CSRF
 * protection for exactly this class of request.
 */
export const respondToDeficiencyAction = withAction(
  {
    name: "membership.respond_to_deficiency",
    audience: "member",
    irreversible: true,
    schema: z.object({ applicationId: z.coerce.number().int().positive() }),
    rateLimit: { name: "applicationSubmit", subject: "actor" },
  },
  async ({ actor, input }) => {
    const result = await recordApplicantResponse(actor!, input.applicationId);

    if (result.ok) {
      return ok(
        `Thank you. Your application is back with the Chamber${
          result.dueDate ? `, now due by ${result.dueDate}` : ""
        }.`,
      );
    }

    // The outstanding list is the whole value of the refusal, so it goes in
    // the sentence rather than into a field error: these items have no inputs
    // on the page to attach to — they are documents that have not arrived.
    return fail(
      result.outstanding.length > 0
        ? `${result.message} Still needed: ${result.outstanding.join("; ")}.`
        : result.message,
    );
  },
);
