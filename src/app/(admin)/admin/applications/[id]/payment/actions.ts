"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, ok, withAction } from "@/server/action";
import {
  markDishonoured,
  receiptPayment,
  recordBankMatchVerdict,
} from "@/membership/payments";

/**
 * The three things the cashier's desk can do.
 *
 * All three are `irreversible`, which adds the `SameSite=Strict` sentinel check
 * on top of the Origin check `withAction` performs anyway. Receipting allocates
 * a receipt number that finance will reconcile against, revising a verdict
 * changes what approval is guarded on, and a dishonour takes a membership away
 * — none of them is a thing a cross-site request should be able to start even
 * if it manages to present a session cookie.
 *
 * Note what is *not* here: no "save draft receipt". The cashier block on page 2
 * of the printed form is filled in once, at the counter, with the instrument in
 * hand. A half-filled receipt is not a state the paper process has and not one
 * worth inventing.
 */

const money = z
  .string()
  .trim()
  .regex(
    /^\d{1,12}(\.\d{1,2})?$/,
    "Enter an amount, for example 10650 or 10650.00",
  );

const civilDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date as YYYY-MM-DD");

const receipt = z.object({
  applicationId: z.coerce.number().int().positive(),
  paymentId: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive(),
  method: z.enum(["pay_order", "cheque", "cash", "online"], {
    error: "Say whether this is a pay order or a cheque.",
  }),
  receivedOn: civilDate,

  draweeBankName: z
    .string()
    .trim()
    .min(2, "Name the bank on the instrument")
    .max(160),
  draweeBranch: z.string().trim().max(160).optional(),
  instrumentNo: z.string().trim().min(1, "Enter the instrument number").max(40),
  instrumentDate: civilDate,
  instrumentAmount: money,
  instrumentCurrency: z.enum(["PKR", "USD"], { error: "Choose the currency." }),
  accountTitle: z.string().trim().max(200).optional(),

  certificateBankName: z.string().trim().max(160).optional(),
  certificateBranch: z.string().trim().max(160).optional(),
  certificateAccountTitle: z.string().trim().max(200).optional(),
  certificateIssuedOn: z.union([civilDate, z.literal("")]).optional(),

  // Required, and deliberately with no default. The comparison is the
  // cashier's physical act; a form that pre-selected "match" would be
  // recording a judgement nobody made on the one field approval is guarded on.
  //
  // The message is written out because this is the field most likely to be
  // left alone, and zod's own wording for an unanswered enum is
  // `Invalid option: expected one of "match"|"mismatch"` — which is the
  // schema talking to itself in front of a cashier.
  bankMatchVerdict: z.enum(["match", "mismatch"], {
    error:
      "Say whether the pay order is drawn on the account the certificate is for.",
  }),
  bankMatchNote: z.string().trim().max(400).optional(),
  varianceReason: z.string().trim().max(300).optional(),
  // Only ever filled in after the near-duplicate refusal has been shown, which
  // is why the form does not render it until then: a field asking "is this a
  // different instrument?" on a blank form is a question about nothing.
  duplicateNote: z.string().trim().max(400).optional(),
});

export const receiptPaymentAction = withAction(
  {
    name: "payment.receipt",
    audience: "staff",
    permission: "payment.receipt",
    schema: receipt,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await receiptPayment(actor, {
      paymentId: input.paymentId,
      version: input.version,
      method: input.method,
      receivedOn: input.receivedOn,
      instrument: {
        draweeBankName: input.draweeBankName,
        draweeBranch: input.draweeBranch ?? null,
        instrumentNo: input.instrumentNo,
        instrumentDate: input.instrumentDate,
        instrumentAmount: input.instrumentAmount,
        instrumentCurrency: input.instrumentCurrency,
        accountTitle: input.accountTitle ?? null,
        certificateBankName: input.certificateBankName ?? null,
        certificateBranch: input.certificateBranch ?? null,
        certificateAccountTitle: input.certificateAccountTitle ?? null,
        certificateIssuedOn:
          input.certificateIssuedOn === undefined ||
          input.certificateIssuedOn === ""
            ? null
            : input.certificateIssuedOn,
      },
      bankMatchVerdict: input.bankMatchVerdict,
      bankMatchNote: input.bankMatchNote ?? null,
      varianceReason: input.varianceReason ?? null,
      duplicateNote: input.duplicateNote ?? null,
    });

    const path = `/admin/applications/${input.applicationId}/payment`;

    if (!result.ok) {
      revalidatePath(path);
      // Each refusal is reported against the field the cashier has to change,
      // so a shortfall lands on the amount and a duplicate on the instrument
      // number rather than as one sentence above a twelve-field form.
      //
      // And the typing comes back with it. A refused receipt writes nothing —
      // deliberately, so no receipt number is burned — which means the server
      // has nowhere to re-read these twelve fields from on the next render.
      // Without this the first refusal empties the form, and the cashier
      // retypes an instrument they have already transcribed once. `data` is
      // the one channel for a value the server must hand back and cannot
      // store.
      return {
        ...fail(result.message, fieldFor(result.refusal)),
        data: submitted(input),
      };
    }

    revalidatePath(path);
    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath("/admin/payments");
    revalidatePath("/admin/applications");

    return ok(
      result.bankMatchSystem === "match"
        ? `Receipt ${result.receiptNo} issued. The comparison agrees with you.`
        : `Receipt ${result.receiptNo} issued. The comparison read the two sides as ` +
            `${result.bankMatchSystem}, which is recorded beside your verdict.`,
    );
  },
);

/**
 * The cashier's own input, to be rendered back into the form.
 *
 * `attempt` is not a value: it is what the form keys its fields on, so React
 * remounts them with these defaults. Without a changing key, a change of
 * `defaultValue` updates the attribute and leaves the live input alone, and
 * the restore silently does nothing.
 */
function submitted(input: z.infer<typeof receipt>): Record<string, string> {
  return {
    attempt: String(Date.now()),
    method: input.method,
    receivedOn: input.receivedOn,
    draweeBankName: input.draweeBankName,
    draweeBranch: input.draweeBranch ?? "",
    instrumentNo: input.instrumentNo,
    instrumentDate: input.instrumentDate,
    instrumentAmount: input.instrumentAmount,
    instrumentCurrency: input.instrumentCurrency,
    accountTitle: input.accountTitle ?? "",
    certificateBankName: input.certificateBankName ?? "",
    certificateBranch: input.certificateBranch ?? "",
    certificateAccountTitle: input.certificateAccountTitle ?? "",
    certificateIssuedOn: input.certificateIssuedOn ?? "",
    bankMatchVerdict: input.bankMatchVerdict,
    bankMatchNote: input.bankMatchNote ?? "",
    varianceReason: input.varianceReason ?? "",
    duplicateNote: input.duplicateNote ?? "",
  };
}

function fieldFor(refusal: string): Record<string, string> | undefined {
  switch (refusal) {
    case "duplicate_instrument":
      return { instrumentNo: "This instrument has already been receipted." };
    case "possible_duplicate":
      return {
        duplicateNote: "Say that you have checked, and it will be receipted.",
      };
    case "variance_unexplained":
      return {
        varianceReason: "Say why the Chamber is accepting this amount.",
      };
    case "override_unexplained":
      return { bankMatchNote: "A note is required here." };
    case "method_unsupported":
      return { method: "Only a pay order or a cheque can be receipted." };
    default:
      return undefined;
  }
}

const verdict = z.object({
  applicationId: z.coerce.number().int().positive(),
  payOrderId: z.coerce.number().int().positive(),
  verdict: z.enum(["match", "mismatch"], {
    error: "Choose the revised verdict.",
  }),
  note: z.string().trim().min(1, "Say what changed").max(400),
});

export const reviseBankMatchAction = withAction(
  {
    name: "payment.revise_bank_match",
    audience: "staff",
    permission: "payment.receipt",
    schema: verdict,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await recordBankMatchVerdict(actor, {
      payOrderId: input.payOrderId,
      verdict: input.verdict,
      note: input.note,
    });

    revalidatePath(`/admin/applications/${input.applicationId}/payment`);
    revalidatePath(`/admin/applications/${input.applicationId}`);

    if (!result.ok) return fail(result.message);

    return ok(
      input.verdict === "match"
        ? "Recorded as a match. Approval is no longer blocked on the instrument."
        : "Recorded as a mismatch. Approval is blocked until the applicant supplies a corrected instrument.",
    );
  },
);

const dishonour = z.object({
  applicationId: z.coerce.number().int().positive(),
  paymentId: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1, "Enter the bank's reason").max(300),
});

export const markDishonouredAction = withAction(
  {
    name: "payment.dishonour",
    audience: "staff",
    permission: "payment.receipt",
    schema: dishonour,
    irreversible: true,
  },
  async ({ input, actor }) => {
    if (!actor) return fail("Sign in again to continue.");

    const result = await markDishonoured(actor, {
      paymentId: input.paymentId,
      version: input.version,
      reason: input.reason,
    });

    revalidatePath(`/admin/applications/${input.applicationId}/payment`);
    revalidatePath(`/admin/applications/${input.applicationId}`);
    revalidatePath("/admin/payments");

    if (!result.ok) return fail(result.message);

    return ok(
      result.suspendedMembershipNo
        ? `Recorded, and membership ${result.suspendedMembershipNo} is suspended: the fee ` +
            "that paid for it was returned. Reinstating it needs a replacement instrument, " +
            "which is not built yet."
        : "Recorded. The fee is outstanding again and approval is blocked.",
    );
  },
);
