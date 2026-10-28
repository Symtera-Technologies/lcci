import { describe, expect, it } from "vitest";
import {
  CNIC_PATTERN,
  TYPED_FIELD_PARSERS,
  autosaveSchema,
  normaliseCnic,
  step1Schema,
  step2Schema,
  step3Schema,
  stepForField,
} from "@/membership/validation";
import {
  CORPORATE_TURNOVER_THRESHOLD,
  MEMBERSHIP_CLASSES,
  PROCESSING_TIERS,
  assessClass,
  decimalToNumber,
  requiresItdSurcharge,
} from "@/membership/fees";
import {
  DECLARATION_CLAUSES,
  ENDORSEMENT_DECLARATION,
  applicantDeclarationText,
} from "@/membership/declaration";
import { render } from "@/membership/numbering";

/**
 * The two validation layers, and why there are two.
 *
 * Autosave accepts anything short enough to store; submission accepts only a
 * complete, correct form. The pair is what lets the schema keep every
 * particulars column nullable — which is what lets an applicant type "approx
 * 60m" into a DECIMAL-backed turnover box and not lose the other fifty-nine
 * fields to a parse error.
 */

const VALID_STEP1 = {
  membershipClass: "corporate",
  processingTier: "regular",
  companyStatus: "partnership",
  firmName: "Shalimar Textiles",
  representativeName: "A. Representative",
  representativeCnic: "35202-1234567-1",
  representativePassport: "",
  representativeDob: "1980-04-15",
  representativeBirthplace: "Lahore",
  representativeNationality: "Pakistani",
  postalAddress: "11 Shara-e-Aiwan-e-Sanat-o-Tijarat, Lahore",
  premisesTenure: "rented",
  email: "office@example.com.pk",
  officePhone1: "042-37654321",
  officePhone2: "",
  fax: "",
  representativeMobile1: "0300-1234567",
  representativeMobile2: "",
  paidUpCapital: "5000000",
  annualTurnover: "60000000",
  employeeCount: "42",
  ntn: "1234567-8",
  strnRegistered: "on",
  strn: "17-00-9999-999-99",
  businessSector: "Textiles",
  businessSubSector: "Home textiles",
  mainCommodity: "Bed linen",
  businessTypes: ["exporter", "manufacturer"],
  bankName: "Habib Bank Limited",
  bankBranch: "Gulberg III, Lahore",
};

/* -------------------------------------------------------------------------- */
/* Autosave                                                                   */
/* -------------------------------------------------------------------------- */

describe("autosave", () => {
  it("accepts a half-typed form", () => {
    const result = autosaveSchema.safeParse({
      applicationId: "7",
      firmName: "Shal",
      annualTurnover: "approx 60m",
      representativeDob: "198",
      email: "office@",
    });

    expect(result.success).toBe(true);
  });

  it("still refuses a value too long for its column", () => {
    // The one limit autosave keeps: a 10 MB paste into the address box should
    // be refused rather than silently truncated by MySQL.
    const result = autosaveSchema.safeParse({
      applicationId: 1,
      postalAddress: "x".repeat(401),
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ["annualTurnover", "approx 60m"],
    ["paidUpCapital", "five million"],
    ["representativeDob", "15/04/1980"],
    ["email", "office@"],
    ["representativeCnic", "35202-123"],
    ["employeeCount", "about forty"],
  ] as const)("routes %s=%j to scratch rather than its column", (field, value) => {
    // Each of these is accepted by autosave and rejected by its typed parser,
    // which is precisely the pair of answers that sends the raw text to
    // `wizard_scratch` instead of to a column that cannot hold it.
    expect(autosaveSchema.safeParse({ applicationId: 1, [field]: value }).success).toBe(true);

    const parser = TYPED_FIELD_PARSERS[field as keyof typeof TYPED_FIELD_PARSERS];
    expect(parser.safeParse(value).success).toBe(false);
  });

  it("writes a value through to its column once it parses", () => {
    expect(TYPED_FIELD_PARSERS.annualTurnover.safeParse("60,000,000").success).toBe(true);
    expect(TYPED_FIELD_PARSERS.representativeDob.safeParse("1980-04-15").success).toBe(true);
    expect(TYPED_FIELD_PARSERS.employeeCount.safeParse("42").success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* CNIC                                                                       */
/* -------------------------------------------------------------------------- */

describe("the CNIC", () => {
  it("accepts the printed form with or without dashes", () => {
    expect(CNIC_PATTERN.test("35202-1234567-1")).toBe(true);
    expect(CNIC_PATTERN.test("3520212345671")).toBe(true);
  });

  it("normalises to one stored shape", () => {
    expect(normaliseCnic("35202-1234567-1")).toBe(normaliseCnic("3520212345671"));
  });

  it("rejects a leading digit no province uses", () => {
    // The first digit is the province code, 1 to 8. A CNIC starting 9 is a
    // typo, and catching it here saves a deficiency round.
    expect(CNIC_PATTERN.test("95202-1234567-1")).toBe(false);
  });

  it("rejects a rolled-over date", () => {
    // `new Date("2027-02-31")` silently becomes 3 March, so the parsed date is
    // compared back against the input.
    expect(TYPED_FIELD_PARSERS.representativeDob.safeParse("1981-02-31").success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 1                                                                     */
/* -------------------------------------------------------------------------- */

describe("step 1", () => {
  it("accepts a complete form", () => {
    expect(step1Schema.safeParse(VALID_STEP1).success).toBe(true);
  });

  it("requires an STRN when the concern says it is registered", () => {
    const result = step1Schema.safeParse({ ...VALID_STEP1, strnRegistered: "on", strn: "" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "strn")).toBe(true);
  });

  it("allows an empty STRN when the concern is not registered", () => {
    const result = step1Schema.safeParse({ ...VALID_STEP1, strnRegistered: "", strn: "" });
    expect(result.success).toBe(true);
  });

  it("requires at least one type of business", () => {
    const result = step1Schema.safeParse({ ...VALID_STEP1, businessTypes: [] });
    expect(result.success).toBe(false);
  });

  it("accepts a phone number written the way people write them", () => {
    for (const number of ["042-111-222-333", "+92 42 3765 4321", "0300 1234567"]) {
      expect(step1Schema.safeParse({ ...VALID_STEP1, officePhone1: number }).success).toBe(true);
    }
  });

  it("accepts every optional field left blank", () => {
    // The regression this guards: `z.preprocess(fn, inner).optional()` only
    // short-circuits on an `undefined` input, and a blank box submits `""`.
    // Written the wrong way round, every optional field rejected being left
    // empty — so an applicant with no fax number could fill the form in
    // perfectly and never be allowed to submit it.
    const blanks = {
      ...VALID_STEP1,
      officePhone2: "",
      representativeMobile2: "",
      fax: "",
      representativePassport: "",
      businessSubSector: "",
      strnRegistered: "",
      strn: "",
    };

    const result = step1Schema.safeParse(blanks);
    expect(
      result.success,
      result.success ? "" : JSON.stringify(result.error.issues.map((i) => i.path.join("."))),
    ).toBe(true);
  });

  it("leaves a blank optional field undefined rather than empty string", () => {
    const parsed = step1Schema.parse({ ...VALID_STEP1, fax: "" });
    expect(parsed.fax).toBeUndefined();
  });

  it("keeps its enums narrow enough to assign to the column", () => {
    // `z.enum(ARRAY as [string, ...string[]])` compiles and widens the output
    // to `string`, and the first place that shows up is a runtime insert. The
    // literals keep the union; this asserts the two lists stay in step.
    const parsed = step1Schema.parse(VALID_STEP1);
    expect(MEMBERSHIP_CLASSES).toContain(parsed.membershipClass);
    expect(PROCESSING_TIERS).toContain(parsed.processingTier);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 2                                                                     */
/* -------------------------------------------------------------------------- */

const DIRECTOR = {
  fullName: "B. Partner",
  designation: "Managing Partner",
  membershipNo: "",
  cell: "0300-7654321",
  cnic: "35202-7654321-2",
  passport: "",
  ntn: "",
  isForeignNational: "",
  attests: "",
};

const ENDORSER = {
  firmName: "Ravi Trading Co",
  membershipNo: "L-1001",
  representativeName: "C. Member",
  mobile: "0321-1112223",
  email: "",
};

const VALID_STEP2 = {
  directors: [
    { ...DIRECTOR, attests: "on" },
    { ...DIRECTOR, fullName: "D. Partner", cnic: "35202-1111111-3" },
  ],
  endorsementMode: "in_app",
  proposer: ENDORSER,
  seconder: { ...ENDORSER, membershipNo: "L-1002" },
};

describe("step 2", () => {
  it("accepts two partners, one attesting", () => {
    expect(step2Schema.safeParse(VALID_STEP2).success).toBe(true);
  });

  it("requires exactly one attester", () => {
    const none = step2Schema.safeParse({
      ...VALID_STEP2,
      directors: VALID_STEP2.directors.map((director) => ({ ...director, attests: "" })),
    });
    expect(none.success).toBe(false);

    const both = step2Schema.safeParse({
      ...VALID_STEP2,
      directors: VALID_STEP2.directors.map((director) => ({ ...director, attests: "on" })),
    });
    expect(both.success).toBe(false);
  });

  it("refuses the same member as proposer and seconder", () => {
    const result = step2Schema.safeParse({
      ...VALID_STEP2,
      seconder: { ...ENDORSER, membershipNo: " L-1001 " },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an endorser with no email address", () => {
    // Only needed when they endorse online; a paper endorsement has no email
    // to send a link to.
    const result = step2Schema.safeParse({
      ...VALID_STEP2,
      endorsementMode: "signed_sheet",
      proposer: { ...ENDORSER, email: "" },
      seconder: { ...ENDORSER, membershipNo: "L-1002", email: "" },
    });
    expect(result.success).toBe(true);
  });

  it("takes an unbounded board", () => {
    // The printed form fits five and says "use photocopy of this page" for
    // more. That is a property of the paper, not a rule.
    const nine = Array.from({ length: 9 }, (_, index) => ({
      ...DIRECTOR,
      fullName: `Partner ${index}`,
      attests: index === 0 ? "on" : "",
    }));
    expect(step2Schema.safeParse({ ...VALID_STEP2, directors: nine }).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Step 3                                                                     */
/* -------------------------------------------------------------------------- */

describe("step 3", () => {
  it("refuses an unticked declaration", () => {
    const result = step3Schema.safeParse({
      documentIds: [],
      declarationAccepted: "",
      attestingDirectorIndex: "0",
    });
    expect(result.success).toBe(false);
  });

  it("caps an application at twenty documents", () => {
    const ids = Array.from({ length: 21 }, () => "11111111-2222-4333-8444-555555555555");
    const result = step3Schema.safeParse({
      documentIds: ids,
      declarationAccepted: "on",
      attestingDirectorIndex: "0",
    });
    expect(result.success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Placing an error                                                           */
/* -------------------------------------------------------------------------- */

describe("stepForField", () => {
  it.each([
    ["firmName", 1],
    ["bankBranch", 1],
    ["annualTurnover", 1],
    ["directors.2.cnic", 2],
    ["proposer.membershipNo", 2],
    ["seconder.mobile", 2],
    ["endorsementMode", 2],
    ["documentIds", 3],
    ["declarationAccepted", 3],
    ["attestingDirectorId", 3],
  ] as const)("sends %s to step %i", (field, step) => {
    expect(stepForField(field)).toBe(step);
  });
});

/* -------------------------------------------------------------------------- */
/* Class and fee reasoning                                                    */
/* -------------------------------------------------------------------------- */

describe("class assessment", () => {
  it("is advisory, never enforcing", () => {
    // An applicant who files as Corporate on Rs 12m has already drawn a pay
    // order for the wrong amount. The schema does not refuse it; verification
    // raises it. `agrees` is the whole output.
    const assessment = assessClass("corporate", {
      annualTurnover: 12_000_000,
      isBodyCorporate: false,
      isMultinational: false,
      strnRegistered: true,
    });
    expect(assessment.suggested).toBe("associate");
    expect(assessment.agrees).toBe(false);
    expect(assessment.reason).toBeTruthy();
  });

  it("makes a body corporate Corporate whatever its turnover", () => {
    const assessment = assessClass("associate", {
      annualTurnover: 1_000,
      isBodyCorporate: true,
      isMultinational: false,
      strnRegistered: false,
    });
    expect(assessment.suggested).toBe("corporate");
  });

  it("holds the threshold at the figure the form prints", () => {
    expect(CORPORATE_TURNOVER_THRESHOLD).toBe(50_000_000);
  });

  it("charges the surcharge for a foreign representative or a foreign partner", () => {
    expect(
      requiresItdSurcharge({ representativeIsForeign: true, anyDirectorIsForeign: false }),
    ).toBe(true);
    expect(
      requiresItdSurcharge({ representativeIsForeign: false, anyDirectorIsForeign: true }),
    ).toBe(true);
    expect(
      requiresItdSurcharge({ representativeIsForeign: false, anyDirectorIsForeign: false }),
    ).toBe(false);
  });

  it("reads a DECIMAL string without losing it", () => {
    expect(decimalToNumber("60000000.00")).toBe(60_000_000);
    expect(decimalToNumber("")).toBeNull();
    expect(decimalToNumber(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The declaration                                                            */
/* -------------------------------------------------------------------------- */

describe("the declaration", () => {
  it("carries all three clauses from the controlled form", () => {
    const text = applicantDeclarationText();
    expect(DECLARATION_CLAUSES).toHaveLength(3);
    for (const clause of DECLARATION_CLAUSES) {
      expect(text).toContain(clause);
    }
  });

  it("includes the undertaking and the photograph declaration", () => {
    const text = applicantDeclarationText();
    expect(text).toContain("abide by the");
    expect(text).toContain("photograph & signature affixed");
  });

  it("keeps the endorsers' wording separate from the applicant's", () => {
    expect(applicantDeclarationText()).not.toContain(ENDORSEMENT_DECLARATION);
  });
});

/* -------------------------------------------------------------------------- */
/* Numbering                                                                  */
/* -------------------------------------------------------------------------- */

describe("reference rendering", () => {
  it("substitutes the placeholders a sequence pattern uses", () => {
    expect(render("LCCI-APP-{yyyy}-{seq}", { yyyy: "2026", seq: "00042" })).toBe(
      "LCCI-APP-2026-00042",
    );
  });

  it("leaves an unknown placeholder alone rather than evaluating it", () => {
    // Patterns are reference data an administrator can edit, so the set of
    // placeholders is closed on purpose.
    expect(render("X-{nope}", { yyyy: "2026" })).toBe("X-{nope}");
  });
});
