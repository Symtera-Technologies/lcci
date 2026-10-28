/**
 * Validation for the application form.
 *
 * Two layers, and keeping them apart is the single most important decision in
 * this file.
 *
 * **Autosave accepts almost anything.** The committed behaviour is that a
 * half-finished form survives a reload, which means the save path cannot
 * require a valid turnover, a complete CNIC or a parseable date. Every field
 * is an optional string; the domain layer then decides, field by field,
 * whether a value parses into its typed column or belongs in `wizard_scratch`
 * until the applicant comes back to it. A schema that rejected "approx 60m"
 * would throw on the applicant's third keystroke and lose their work.
 *
 * **Submission is strict.** Completeness is enforced once, at the submit
 * transition, against the schemas at the bottom of this file. That is the only
 * place the form is required to make sense, and it is a place where failing is
 * useful: the applicant is told what is missing and nothing is lost.
 *
 * Messages are written to be read by the person who has to fix the field, and
 * they resolve through the message catalogue so Urdu is a translation task
 * rather than a rewrite.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/** Collapse whitespace and trim. Applied before every length check. */
const tidy = (value: unknown): unknown =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;

/** An optional free-text field, empty string normalised to undefined. */
function optionalText(max: number) {
  return z.preprocess(
    (value) => {
      const cleaned = tidy(value);
      return cleaned === "" ? undefined : cleaned;
    },
    z.string().max(max).optional(),
  );
}

function requiredText(max: number, message: string) {
  return z.preprocess(
    (value) => {
      const cleaned = tidy(value);
      return cleaned === "" ? undefined : cleaned;
    },
    z.string({ error: message }).min(1, message).max(max),
  );
}

/**
 * A CNIC: thirteen digits.
 *
 * Accepted with or without the conventional dashes, because applicants type it
 * both ways, and normalised to the dashed form for display. The first digit is
 * the province code and is non-zero on every real CNIC, which catches the most
 * common paste error — a leading zero from a spreadsheet that stored it as a
 * number.
 *
 * Deliberately not a checksum: NADRA does not publish one, and a check digit
 * invented here would reject valid cards.
 */
export const CNIC_PATTERN = /^[1-8]\d{4}-?\d{7}-?\d$/;

export function normaliseCnic(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 13) return value.trim();
  return `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;
}

const cnicMessage = "Enter a 13-digit CNIC, for example 42201-1234567-8.";

/**
 * Why every optional field puts `.optional()` on the *inner* schema.
 *
 * `z.preprocess(fn, inner).optional()` looks equivalent and is not. The outer
 * `.optional()` only short-circuits on an `undefined` *input*, and a blank box
 * in a form submits `""`, not undefined — so the preprocess runs, maps `""` to
 * undefined, and hands undefined to an inner schema that still requires a
 * string. The result is an optional field that rejects being left empty, which
 * is to say a form nobody with no fax number can submit. Putting the
 * `.optional()` inside means the preprocess's own `undefined` is the one being
 * accepted.
 */
function cnicField(required: boolean) {
  const inner = z
    .string({ error: cnicMessage })
    .regex(/^[1-8]\d{12}$/, cnicMessage)
    .transform(normaliseCnic);

  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed.replace(/[\s-]/g, "");
  }, required ? inner : inner.optional());
}

/**
 * A Pakistani phone number, kept permissive on purpose.
 *
 * Landlines, mobiles, international dialling and the local habit of writing
 * `042-111-222-333` all have to get through. The real validator for a mobile
 * number is the OTP that arrives on it; rejecting an unusual but working
 * number here would block a genuine applicant for no gain. So this checks that
 * there are enough digits to be a number at all, and nothing more.
 */
function phoneField(required: boolean, message = "Enter a telephone number.") {
  const inner = z
    .string({ error: message })
    .max(30)
    .refine((value) => value.replace(/\D/g, "").length >= 7, message);

  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, required ? inner : inner.optional());
}

/** Money as typed: digits, with optional separators and decimals. */
function moneyField(required: boolean, message: string) {
  const inner = z.string({ error: message }).regex(/^\d{1,14}(\.\d{1,2})?$/, message);

  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const stripped = value.replace(/[\s,]/g, "").replace(/^Rs\.?/i, "");
    return stripped === "" ? undefined : stripped;
  }, required ? inner : inner.optional());
}

/** A civil date as "YYYY-MM-DD", validated as a real calendar date. */
function dateField(required: boolean, message: string) {
  const inner = z
    .string({ error: message })
    .regex(/^\d{4}-\d{2}-\d{2}$/, message)
    .refine((value) => {
        // `new Date("2027-02-31")` rolls over to 3 March rather than failing,
        // so the parsed date is compared back against the input.
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    }, message);

  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }, required ? inner : inner.optional());
}

const emailMessage = "Enter an email address we can reach you at.";

function emailField(required: boolean) {
  // 190 characters, matching the column, which is sized to fit a unique index
  // under the 767-byte prefix limit.
  const inner = z.string({ error: emailMessage }).email(emailMessage).max(190);

  return z.preprocess((value) => {
    const cleaned = typeof value === "string" ? value.trim().toLowerCase() : value;
    return cleaned === "" ? undefined : cleaned;
  }, required ? inner : inner.optional());
}

/** A checkbox as it arrives from a form: present means on. */
const checkbox = z.preprocess(
  (value) => value === "on" || value === "true" || value === true || value === "1",
  z.boolean(),
);

/* -------------------------------------------------------------------------- */
/* Autosave — the permissive layer                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every field the wizard can send, all optional, all raw strings.
 *
 * No coercion and no format checks: this exists to accept a partially typed
 * form without losing any of it. The only limit is length, because a column
 * has one and a 10 MB paste into the address box should be refused rather
 * than silently truncated.
 */
export const autosaveSchema = z.object({
  applicationId: z.coerce.number().int().positive(),
  step: z.coerce.number().int().min(1).max(3).optional(),

  membershipClass: z.string().max(40).optional(),
  processingTier: z.string().max(40).optional(),
  companyStatus: z.string().max(40).optional(),

  firmName: z.string().max(200).optional(),
  representativeName: z.string().max(160).optional(),
  representativeCnic: z.string().max(40).optional(),
  representativePassport: z.string().max(40).optional(),
  representativeDob: z.string().max(40).optional(),
  representativeBirthplace: z.string().max(120).optional(),
  representativeNationality: z.string().max(80).optional(),

  postalAddress: z.string().max(400).optional(),
  premisesTenure: z.string().max(20).optional(),
  email: z.string().max(190).optional(),
  officePhone1: z.string().max(30).optional(),
  officePhone2: z.string().max(30).optional(),
  fax: z.string().max(30).optional(),
  representativeMobile1: z.string().max(30).optional(),
  representativeMobile2: z.string().max(30).optional(),

  paidUpCapital: z.string().max(40).optional(),
  annualTurnover: z.string().max(40).optional(),
  employeeCount: z.string().max(20).optional(),

  ntn: z.string().max(40).optional(),
  strnRegistered: z.string().max(10).optional(),
  strn: z.string().max(40).optional(),

  businessSector: z.string().max(120).optional(),
  businessSubSector: z.string().max(120).optional(),
  mainCommodity: z.string().max(200).optional(),
  businessTypes: z.union([z.string().max(30), z.array(z.string().max(30))]).optional(),

  bankName: z.string().max(160).optional(),
  bankBranch: z.string().max(160).optional(),
});

export type AutosaveInput = z.output<typeof autosaveSchema>;

/**
 * The fields autosave can write into typed columns, and how to read them.
 *
 * Anything that fails its parse goes to `wizard_scratch` instead, keyed by the
 * same name, so the applicant sees exactly what they typed when they return
 * and the typed column stays null until it means something.
 */
export const TYPED_FIELD_PARSERS = {
  representativeCnic: cnicField(false),
  representativeDob: dateField(false, "Not yet a complete date."),
  email: emailField(false),
  paidUpCapital: moneyField(false, "Not yet a number."),
  annualTurnover: moneyField(false, "Not yet a number."),
  employeeCount: z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      const stripped = value.replace(/[\s,]/g, "");
      return stripped === "" ? undefined : stripped;
    },
    z.coerce.number().int().min(0).max(1_000_000).optional(),
  ),
} as const;

/* -------------------------------------------------------------------------- */
/* Submission — the strict layer                                              */
/* -------------------------------------------------------------------------- */

/**
 * Written as literals rather than derived from the `fees.ts` arrays.
 *
 * `z.enum(ARRAY as [string, ...string[]])` compiles, and quietly widens the
 * parsed output to `string` — so `step1Schema`'s result would no longer be
 * assignable to the `MembershipClass` column it is about to be written to, and
 * the first place that mistake would surface is a runtime insert. The literals
 * keep the union, and `tests/membership-validation.test.ts` asserts these
 * stay in step with `MEMBERSHIP_CLASSES` and `PROCESSING_TIERS`.
 */
const classEnum = z.enum(["corporate", "associate"], {
  error: "Choose a membership class.",
});
const tierEnum = z.enum(["regular", "urgent", "executive"], {
  error: "Choose a processing tier.",
});

/**
 * Step 1 — the firm, its representative, and the numbers.
 *
 * Fields 1 to 16 of the printed form, minus the people and the documents.
 */
export const step1Schema = z.object({
  membershipClass: classEnum,
  processingTier: tierEnum,
  companyStatus: z.enum(
    ["proprietorship", "partnership", "corporation", "company"],
    { error: "Choose the status of the concern." },
  ),

  firmName: requiredText(200, "Enter the name of the firm or company."),
  representativeName: requiredText(160, "Enter the representative's full name."),
  representativeCnic: cnicField(true),
  representativePassport: optionalText(40),
  representativeDob: dateField(true, "Enter the representative's date of birth."),
  representativeBirthplace: requiredText(120, "Enter the place of birth."),
  representativeNationality: requiredText(80, "Enter the nationality."),

  postalAddress: requiredText(400, "Enter the postal address of the business."),
  premisesTenure: z.enum(["owned", "rented"], {
    error: "State whether the premises are owned or rented.",
  }),
  email: emailField(true),
  officePhone1: phoneField(true, "Enter an office telephone number."),
  officePhone2: phoneField(false),
  fax: phoneField(false),
  representativeMobile1: phoneField(true, "Enter the representative's mobile number."),
  representativeMobile2: phoneField(false),

  paidUpCapital: moneyField(true, "Enter the paid-up capital in rupees."),
  annualTurnover: moneyField(true, "Enter the annual turnover in rupees."),
  employeeCount: z.coerce
    .number({ error: "Enter the number of employees." })
    .int("Enter a whole number of employees.")
    .min(1, "Enter the number of employees.")
    .max(1_000_000),

  ntn: requiredText(40, "Enter the National Tax Number."),
  strnRegistered: checkbox,
  strn: optionalText(40),

  businessSector: requiredText(120, "Enter the business sector."),
  businessSubSector: optionalText(120),
  mainCommodity: requiredText(200, "Enter the main commodity or product."),
  // At least one: the form's eight checkboxes are a multi-select and an
  // application that ticks none has not answered the question.
  businessTypes: z
    .array(z.string().max(30))
    .min(1, "Choose at least one type of business."),

  bankName: requiredText(160, "Enter the name of the bank."),
  bankBranch: requiredText(160, "Enter the bank branch."),
})
  .refine(
    (value) => value.strnRegistered === false || (value.strn ?? "").length > 0,
    {
      path: ["strn"],
      message: "Enter the sales tax registration number, or clear the checkbox.",
    },
  );

export type Step1Input = z.output<typeof step1Schema>;

/** One director or partner. */
export const directorSchema = z.object({
  fullName: requiredText(160, "Enter this person's full name."),
  designation: requiredText(120, "Enter their designation."),
  membershipNo: optionalText(30),
  cell: phoneField(true, "Enter a mobile number for this person."),
  cnic: cnicField(true),
  passport: optionalText(40),
  ntn: optionalText(40),
  isForeignNational: checkbox,
  attests: checkbox,
});

/** One endorsing member: the proposer or the seconder. */
export const endorserSchema = z.object({
  firmName: requiredText(200, "Enter the endorsing member's firm name."),
  membershipNo: requiredText(30, "Enter their LCCI membership number."),
  representativeName: requiredText(160, "Enter their representative's name."),
  mobile: phoneField(true, "Enter a mobile number for the endorsing member."),
  email: emailField(false),
});

/**
 * Step 2 — the people.
 *
 * Directors are unbounded: the printed form fits five and says "use photocopy
 * of this page" for more, while the document list says "CNIC of ALL
 * directors". Whether there is a policy maximum is a question for LCCI.
 *
 * Exactly one director must attest. The printed form has a director other than
 * the representative sign the declaration, and one person doing both is not an
 * attestation — so this is checked here as well as by a workflow guard, because
 * telling the applicant at step 2 is far kinder than refusing at submission.
 */
export const step2Schema = z
  .object({
    directors: z.array(directorSchema).min(1, "Add at least one director or partner."),
    endorsementMode: z.enum(["in_app", "signed_sheet"], {
      error: "Choose how the proposer and seconder will endorse.",
    }),
    proposer: endorserSchema,
    seconder: endorserSchema,
  })
  .refine((value) => value.directors.filter((d) => d.attests).length === 1, {
    path: ["directors"],
    message: "Exactly one director or partner must attest to the declaration.",
  })
  .refine(
    (value) =>
      value.proposer.membershipNo.trim() !== value.seconder.membershipNo.trim(),
    {
      path: ["seconder", "membershipNo"],
      message: "The proposer and seconder must be two different members.",
    },
  );

export type Step2Input = z.output<typeof step2Schema>;

/**
 * Step 3 — documents and the declaration.
 *
 * Documents arrive as ids, never as files. Each file was uploaded to
 * `/api/portal/uploads` as it was chosen and the action carries only the
 * resulting opaque identifiers — which is what keeps `serverActions.
 * bodySizeLimit` at its 1 MB default for the whole application, including the
 * public newsletter form.
 */
export const step3Schema = z.object({
  // UUIDs, because that is what the documents table uses as its only public
  // identifier. Twenty is the per-application file cap.
  documentIds: z
    .array(z.string().uuid("That is not a document reference."))
    .max(20, "An application may carry at most 20 documents."),
  declarationAccepted: checkbox,
  attestingDirectorIndex: z.coerce.number().int().min(0),
})
  .refine((value) => value.declarationAccepted, {
    path: ["declarationAccepted"],
    message: "The declaration must be accepted before the form can be submitted.",
  });

export type Step3Input = z.output<typeof step3Schema>;

/**
 * Which step a field belongs to, for placing an error when the whole form is
 * validated at once.
 *
 * Used by the submit transition: it validates everything, and if step 1 is
 * incomplete the applicant has to be sent back to step 1 rather than told
 * "something is wrong" on step 3.
 */
export function stepForField(field: string): 1 | 2 | 3 {
  if (field.startsWith("directors") || field.startsWith("proposer") || field.startsWith("seconder") || field === "endorsementMode") {
    return 2;
  }
  if (field.startsWith("document") || field.startsWith("declaration") || field.startsWith("attesting")) {
    return 3;
  }
  return 1;
}
