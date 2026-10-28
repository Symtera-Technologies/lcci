"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import {
  beginVerification,
  completeChecklist,
  markVerified,
  saveChecklist,
  type SaveItemInput,
} from "@/membership/verification";
import { raiseDeficiency, type DeficiencyItemInput } from "@/membership/deficiency";
import type { DocumentSubjectKind } from "@/db/schema";

/**
 * The five things the checklist screen can do.
 *
 * Each goes through `withAction`, so each gets the Origin check, the permission
 * check and errors-as-values without restating any of it. Three of them are
 * marked `irreversible`, which adds the `SameSite=Strict` sentinel check on top
 * of the Origin check: signing a round off, returning an application to an
 * applicant and marking it verified are all one-way doors in the record, and a
 * request that arrived cross-site must not open one even if it managed to
 * present a session cookie.
 *
 * Saving progress is not one of those. It is a working surface the officer
 * revises freely until they sign it, and treating it as irreversible would add
 * friction to the only thing on this page that is genuinely undoable.
 *
 * Every one of them ends in `revalidatePath` rather than a redirect, because
 * the officer is already where they want to be and carries a selected document
 * in the query string — a redirect would either lose it or have to rebuild it.
 */

const target = z.object({
  applicationId: z.coerce.number().int().positive(),
});

/* -------------------------------------------------------------------------- */
/* Opening a round                                                            */
/* -------------------------------------------------------------------------- */

export const startVerificationAction = withAction(
  {
    name: "application.begin_verification",
    audience: "staff",
    permission: "application.verify",
    schema: target,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await beginVerification(actor, input.applicationId);
    revalidatePath(`/admin/applications/${input.applicationId}/checklist`);
    revalidatePath(`/admin/applications/${input.applicationId}`);

    return ok(
      `Verification round ${result.round} is open. Work through the thirteen items.`,
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Saving and signing off                                                     */
/* -------------------------------------------------------------------------- */

const checklistSubmission = target.extend({
  intent: z.enum(["save", "complete"]),
});

/**
 * Read the thirteen items out of the form.
 *
 * Done by hand rather than through a zod schema, because the keys are per item
 * — `answer.cnic_readable`, `note.cnic_readable` — and a schema over dynamic
 * keys would be a `record` that validated nothing useful. The codes come from
 * the form's own hidden list and are then checked against the *definitions*
 * inside `saveChecklist`, so a submitted code that is not part of this form
 * revision is refused there rather than trusted here.
 *
 * An item with no answer is left out entirely instead of defaulting. On a
 * defect row an absent answer would otherwise record "no defect found" by
 * omission — a judgement nobody made, on the two items where it matters most.
 */
function readItems(formData: FormData): readonly SaveItemInput[] {
  const codes = formData
    .getAll("code")
    .filter((value): value is string => typeof value === "string");

  const items: SaveItemInput[] = [];

  for (const code of codes) {
    const answer = formData.get(`answer.${code}`);
    if (typeof answer !== "string" || answer === "") continue;
    if (answer !== "yes" && answer !== "no" && answer !== "na") continue;

    const note = formData.get(`note.${code}`);

    items.push({
      itemCode: code,
      marked: answer === "yes",
      notApplicable: answer === "na",
      note: typeof note === "string" ? note : null,
      documentIds: formData
        .getAll(`doc.${code}`)
        .filter((value): value is string => typeof value === "string"),
    });
  }

  return items;
}

export const submitChecklistAction = withAction(
  {
    name: "application.save_checklist",
    audience: "staff",
    permission: "application.verify",
    schema: checklistSubmission,
  },
  async ({ input, actor, formData }) => {
    if (!actor) return fail("Sign in again to continue.");

    const items = readItems(formData);

    const saved = await saveChecklist(actor, {
      applicationId: input.applicationId,
      items,
    });

    const path = `/admin/applications/${input.applicationId}/checklist`;

    if (saved.noOpenRound) {
      revalidatePath(path);
      return fail(
        "There is no open verification round. Reload the page — this round may already be signed off.",
      );
    }

    // Refusals are reported against the items they belong to, so the officer
    // sees "item 4" rather than one message at the top of thirteen rows.
    if (saved.refusals.length > 0) {
      revalidatePath(path);
      return fail(
        saved.savedCount > 0
          ? `Saved ${saved.savedCount} item(s). ${saved.refusals.length} could not be saved.`
          : "Nothing was saved.",
        Object.fromEntries(
          saved.refusals.map((refusal) => [`answer.${refusal.itemCode}`, refusal.message]),
        ),
      );
    }

    if (input.intent === "save") {
      revalidatePath(path);
      return ok(
        saved.savedCount === 0
          ? "Nothing to save yet."
          : `Saved ${saved.savedCount} item(s). Nothing is signed off until you complete the round.`,
      );
    }

    const completed = await completeChecklist(actor, input.applicationId);

    revalidatePath(path);
    revalidatePath(`/admin/applications/${input.applicationId}`);

    if (!completed.ok) {
      return fail(completed.message ?? "This round could not be signed off.");
    }

    return ok(
      completed.outcome === "clear"
        ? "Round signed off: every item clear. You can now mark the application verified."
        : "Round signed off with findings. Return the application to the applicant with an itemised list.",
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Leaving verification                                                       */
/* -------------------------------------------------------------------------- */

export const markVerifiedAction = withAction(
  {
    name: "application.mark_verified",
    audience: "staff",
    permission: "application.verify",
    schema: target,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await markVerified(actor, input.applicationId);

    if (!result.ok) {
      return fail(result.reasons.join(" "));
    }

    revalidatePath(`/admin/applications/${input.applicationId}/checklist`);
    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath("/admin/applications");

    return ok("Marked verified. It now needs the fee receipted before approval.");
  },
);

/* -------------------------------------------------------------------------- */
/* Returning it to the applicant                                              */
/* -------------------------------------------------------------------------- */

const deficiencySubmission = target.extend({
  summary: z.string().max(1000).optional(),
  respondByWorkingDays: z.coerce.number().int().min(1).max(60).optional(),
});

const SUBJECT_KINDS: readonly DocumentSubjectKind[] = [
  "company",
  "representative",
  "director",
  "endorser",
  "payment",
];

/**
 * Read the deficiency rows out of the composer.
 *
 * Parallel arrays rather than indexed names, because the form is rendered
 * server-side with a fixed set of rows — the failed checklist items, plus a few
 * blanks — and `FormData.getAll` returns them in document order. A row whose
 * instruction is empty is dropped: the composer offers more rows than most
 * returns need, and an officer who fills three of six has said what they mean.
 *
 * The instruction is the one field that cannot be blank, and it is the one that
 * reaches the applicant verbatim. Everything else on a row only narrows what
 * the item unlocks.
 */
function readDeficiencyItems(formData: FormData): readonly DeficiencyItemInput[] {
  const read = (name: string) =>
    formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));

  const instructions = read("item.instruction");
  const kinds = read("item.kind");
  const types = read("item.documentType");
  // One select, not two. "Whose document is it" is a single question to the
  // officer — company, or this partner — so the form asks it once and sends
  // `company` or `director:12`, and the split happens here rather than making
  // the screen explain our `subject_kind`/`subject_id` pair.
  const subjects = read("item.subjectKindAndId");
  const fieldNames = read("item.fieldName");
  const itemCodes = read("item.checklistItem");

  const items: DeficiencyItemInput[] = [];

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = (instructions[index] ?? "").trim();
    if (instruction === "") continue;

    const rawKind = kinds[index] ?? "other";
    const kind =
      rawKind === "document" || rawKind === "field" || rawKind === "other"
        ? rawKind
        : "other";

    const documentTypeCode = (types[index] ?? "").trim();
    const [subjectKind = "", rawSubjectId = ""] = (subjects[index] ?? "")
      .trim()
      .split(":");
    const subjectId = Number(rawSubjectId);
    const fieldName = (fieldNames[index] ?? "").trim();
    const checklistItemCode = (itemCodes[index] ?? "").trim();

    // A row claiming to be a document row without naming a type would unlock
    // nothing and tell the upload gate nothing, so it degrades to an
    // instruction the applicant reads rather than being silently dropped.
    const effectiveKind =
      kind === "document" && documentTypeCode === ""
        ? "other"
        : kind === "field" && fieldName === ""
          ? "other"
          : kind;

    items.push({
      kind: effectiveKind,
      documentTypeCode: effectiveKind === "document" ? documentTypeCode : null,
      subjectKind:
        effectiveKind === "document" && SUBJECT_KINDS.includes(subjectKind as DocumentSubjectKind)
          ? (subjectKind as DocumentSubjectKind)
          : null,
      subjectId:
        effectiveKind === "document" && Number.isSafeInteger(subjectId) && subjectId > 0
          ? subjectId
          : null,
      fieldName: effectiveKind === "field" ? fieldName : null,
      checklistItemCode: checklistItemCode === "" ? null : checklistItemCode,
      instruction,
    });
  }

  return items;
}

export const raiseDeficiencyAction = withAction(
  {
    name: "application.raise_deficiency",
    audience: "staff",
    permission: "application.raise_deficiency",
    schema: deficiencySubmission,
    irreversible: true,
  },
  async ({ input, actor, formData }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await raiseDeficiency(actor, {
      applicationId: input.applicationId,
      summary: input.summary ?? null,
      respondByWorkingDays: input.respondByWorkingDays,
      items: readDeficiencyItems(formData),
    });

    if (!result.ok) {
      return fail(result.message);
    }

    revalidatePath(`/admin/applications/${input.applicationId}/checklist`);
    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath("/admin/applications");

    return ok(
      `Returned to the applicant: ${result.itemCount} item(s), to be answered ` +
        `by ${result.respondBy}. The processing clock is paused until they reply.`,
    );
  },
);
