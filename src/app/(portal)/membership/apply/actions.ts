"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { withAction, ok, fail, type ActionState } from "@/server/action";
import {
  acceptDeclaration,
  saveDirectors,
  saveEndorsers,
  saveParticulars,
  type DirectorInput,
  type EndorserInput,
} from "@/membership/applications";
import { SubmitBlockedError, submitApplication } from "@/membership/submit";

/**
 * The wizard's server actions.
 *
 * All five go through `withAction`, which is what supplies the `Origin` check
 * Next's own server-action CSRF protection lets through when the header is
 * absent, the rate limit, the member check and the error-as-value contract.
 * None of them accepts a file: documents stream to `/api/portal/uploads` as
 * they are chosen and only their ids travel here, which is what keeps
 * `serverActions.bodySizeLimit` at its 1 MB default for the whole application
 * — including the unauthenticated newsletter form on the homepage.
 */

const applicationRef = z.object({
  applicationId: z.coerce.number().int().positive(),
});

/* -------------------------------------------------------------------------- */
/* Step 1 — particulars                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Save whatever is typed so far.
 *
 * The same action serves the debounced autosave and the "Save and continue"
 * button, because they do the same thing: a partial save that never rejects.
 * Completeness is reported by the page on reload, not by this action refusing
 * — a form that refuses to save until it is correct is a form that loses work.
 */
export const saveParticularsAction = withAction(
  {
    name: "membership.save_particulars",
    audience: "member",
    schema: z.object({}).passthrough(),
    rateLimit: { name: "wizardAutosave", subject: "actor" },
  },
  async ({ actor, formData }) => {
    const result = await saveParticulars(actor!, formDataToRecord(formData));

    return result.pending.length === 0
      ? ok("Saved.")
      : ok(`Saved. ${result.pending.length} field(s) still need attention.`);
  },
);

/* -------------------------------------------------------------------------- */
/* Step 2 — the people                                                        */
/* -------------------------------------------------------------------------- */

export const saveDirectorsAction = withAction(
  {
    name: "membership.save_directors",
    audience: "member",
    schema: applicationRef,
    rateLimit: { name: "wizardAutosave", subject: "actor" },
  },
  async ({ input, actor, formData }) => {
    const directors = groupIndexed(formData, "directors").map(
      (row): DirectorInput => ({
        id: row.id ? Number(row.id) : null,
        fullName: row.fullName,
        designation: row.designation,
        membershipNo: row.membershipNo,
        cell: row.cell,
        cnic: row.cnic,
        passport: row.passport,
        ntn: row.ntn,
        isForeignNational: row.isForeignNational,
      }),
    );

    await saveDirectors(actor!, { applicationId: input.applicationId, directors });
    return ok("Directors saved.");
  },
);

export const saveEndorsersAction = withAction(
  {
    name: "membership.save_endorsers",
    audience: "member",
    schema: applicationRef.extend({
      endorsementMode: z.string().max(20).optional(),
    }),
    rateLimit: { name: "wizardAutosave", subject: "actor" },
  },
  async ({ input, actor, formData }) => {
    const endorsers: EndorserInput[] = (["proposer", "seconder"] as const).map(
      (role) => ({
        role,
        firmName: text(formData, `${role}.firmName`),
        membershipNo: text(formData, `${role}.membershipNo`),
        representativeName: text(formData, `${role}.representativeName`),
        mobile: text(formData, `${role}.mobile`),
        email: text(formData, `${role}.email`),
      }),
    );

    await saveEndorsers(actor!, {
      applicationId: input.applicationId,
      endorsementMode: input.endorsementMode,
      endorsers,
    });

    return ok("Proposer and seconder saved.");
  },
);

/* -------------------------------------------------------------------------- */
/* Step 3 — declaration and submission                                        */
/* -------------------------------------------------------------------------- */

export const acceptDeclarationAction = withAction(
  {
    name: "membership.accept_declaration",
    audience: "member",
    schema: applicationRef.extend({
      attestingDirectorId: z.coerce.number().int().positive({
        message: "Choose which director or partner attests to the representation.",
      }),
      declarationAccepted: z.literal("on", {
        error: "The declaration must be accepted before the form can be submitted.",
      }),
    }),
    rateLimit: { name: "wizardAutosave", subject: "actor" },
  },
  async ({ input, actor }) => {
    await acceptDeclaration(actor!, {
      applicationId: input.applicationId,
      attestingDirectorId: input.attestingDirectorId,
      accepted: true,
    });

    return ok("Declaration recorded.");
  },
);

/**
 * Submit.
 *
 * `irreversible` adds the `SameSite=Strict` sentinel check on top of the
 * `Origin` check: submission allocates a reference, creates payment rows and
 * starts a clock the Chamber is held to, and none of that should be reachable
 * by a request that arrived cross-site holding a session cookie.
 *
 * On success it redirects rather than returning a message, so a reload of the
 * result page cannot re-post the submission.
 */
export const submitAction = withAction(
  {
    name: "membership.submit",
    audience: "member",
    schema: applicationRef,
    rateLimit: { name: "applicationSubmit", subject: "actor" },
    irreversible: true,
  },
  async ({ input, actor }): Promise<ActionState> => {
    let publicRef: string;

    try {
      const result = await submitApplication(actor!, input.applicationId);
      publicRef = result.publicRef;
    } catch (error) {
      if (error instanceof SubmitBlockedError) {
        // The guard messages explain the refusal; the field errors place it.
        // Both are returned, because "not every required document has been
        // uploaded" is useless without knowing which.
        return fail(
          error.reasons[0] ?? "This application is not ready to submit.",
          flattenFieldErrors(error.fieldErrors),
        );
      }
      throw error;
    }

    // Outside the try: `redirect` works by throwing, and catching it here
    // would turn a successful submission into a generic error message.
    redirect(`/membership/apply/submitted?ref=${encodeURIComponent(publicRef)}`);
  },
);

/* -------------------------------------------------------------------------- */
/* Form shapes                                                                */
/* -------------------------------------------------------------------------- */

/** One value per key, files dropped. Files never travel through an action. */
function formDataToRecord(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) continue;

    if (key in out) {
      const existing = out[key];
      if (Array.isArray(existing)) existing.push(value);
      else out[key] = [existing, value];
    } else {
      out[key] = value;
    }
  }

  return out;
}

function text(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/**
 * Collect `directors.0.fullName`-style fields into an ordered array.
 *
 * The dotted-index naming is what lets `fieldErrorsFrom` and `stepForField`
 * place an error on the right row of a repeatable section — zod reports
 * `directors.2.cnic` and the input is called `directors.2.cnic`, so the error
 * lands where the applicant is looking rather than at the top of the page.
 *
 * Indexes are sorted numerically and then compacted, so removing the middle
 * row of three does not leave a hole that shifts everyone's documents.
 */
function groupIndexed(
  formData: FormData,
  prefix: string,
): Record<string, string>[] {
  const rows = new Map<number, Record<string, string>>();

  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;

    const match = new RegExp(`^${prefix}\\.(\\d+)\\.(\\w+)$`).exec(key);
    if (!match) continue;

    const index = Number(match[1]);
    const row = rows.get(index) ?? {};
    row[match[2]] = value;
    rows.set(index, row);
  }

  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
}

/** One message per field, which is what the field components render. */
function flattenFieldErrors(
  errors: Record<string, string[]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, messages] of Object.entries(errors)) {
    if (messages.length > 0) out[field] = messages[0];
  }
  return out;
}
