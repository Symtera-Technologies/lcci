import { describe, expect, it } from "vitest";
import {
  affirmativeLabel,
  checklistOutcome,
  disagreements,
  failedItems,
  markFor,
  negativeLabel,
  outcomeFor,
  suggestNotApplicable,
  systemOpinion,
  type ChecklistFacts,
  type ItemDocumentTypes,
} from "@/membership/checklist";
import type { ChecklistItemOutcome, ChecklistPolarity } from "@/db/schema";

/**
 * The polarity trap, and the rest of the checklist's arithmetic.
 *
 * This module is pure on purpose, so it can be tested as arithmetic rather
 * than through a form and a database. The case that matters most is the first
 * one: items 1 and 13 of the printed form are **defects** — "Incomplete form"
 * and "Signatures do not match with CNIC" — where a tick blocks, while a tick
 * on the other eleven clears. Flattening all thirteen into "checked = good"
 * silently inverts two of them and lets a form with a signature mismatch
 * through as clear. That is the single easiest way to get this module quietly,
 * dangerously wrong, which is why it is the first test in the file.
 */

/** The thirteen codes in printed order, with their polarity. */
const ITEMS: readonly { code: string; ordinal: number; polarity: ChecklistPolarity }[] = [
  { code: "incomplete_form", ordinal: 1, polarity: "defect" },
  { code: "letterhead_signed", ordinal: 2, polarity: "compliance" },
  { code: "cnic_readable", ordinal: 3, polarity: "compliance" },
  { code: "ntn_title", ordinal: 4, polarity: "compliance" },
  { code: "bank_certificate", ordinal: 5, polarity: "compliance" },
  { code: "partnership_deed", ordinal: 6, polarity: "compliance" },
  { code: "secp_documents", ordinal: 7, polarity: "compliance" },
  { code: "utility_bill", ordinal: 8, polarity: "compliance" },
  { code: "photographs", ordinal: 9, polarity: "compliance" },
  { code: "endorser_standing", ordinal: 10, polarity: "compliance" },
  { code: "company_stamp", ordinal: 11, polarity: "compliance" },
  { code: "pay_order", ordinal: 12, polarity: "compliance" },
  { code: "signature_mismatch", ordinal: 13, polarity: "defect" },
];

/**
 * A whole round, decided by ticking a named set of boxes.
 *
 * "Ticked" means `marked = true` — the physical act on the printed form,
 * before any interpretation. Which is exactly the input that has to be
 * interpreted differently for items 1 and 13.
 */
function round(ticked: readonly string[]) {
  return ITEMS.map((item) => ({
    code: item.code,
    ordinal: item.ordinal,
    polarity: item.polarity,
    outcome: outcomeFor(item.polarity, {
      marked: ticked.includes(item.code),
      notApplicable: false,
    }),
  }));
}

describe("polarity", () => {
  it("makes a round deficient when only items 1 and 13 are ticked", () => {
    const items = round(["incomplete_form", "signature_mismatch"]);

    expect(checklistOutcome(items)).toBe("deficient");

    // Every one of the thirteen fails here, which is the point: the two
    // ticked ones fail *because* they are ticked and the other eleven fail
    // because they are not. A single notion of "checked" cannot produce that.
    expect(failedItems(items)).toHaveLength(13);
  });

  it("makes a round deficient when every box is ticked", () => {
    // The sharpest form of the trap. An implementation that read a tick as
    // "good" would call this the cleanest possible round, when what it
    // actually records is an incomplete form whose signatures do not match
    // the CNIC.
    const items = round(ITEMS.map((item) => item.code));

    expect(checklistOutcome(items)).toBe("deficient");
    expect(failedItems(items).map((item) => item.code)).toEqual([
      "incomplete_form",
      "signature_mismatch",
    ]);
  });

  it("makes a round clear when all eleven compliance items are ticked and neither defect is", () => {
    const items = round(
      ITEMS.filter((item) => item.polarity === "compliance").map((item) => item.code),
    );

    expect(checklistOutcome(items)).toBe("clear");
    expect(failedItems(items)).toEqual([]);
  });

  it("fails an unticked compliance item", () => {
    expect(outcomeFor("compliance", { marked: false, notApplicable: false })).toBe("fail");
    expect(outcomeFor("compliance", { marked: true, notApplicable: false })).toBe("pass");
  });

  it("fails a ticked defect item", () => {
    expect(outcomeFor("defect", { marked: true, notApplicable: false })).toBe("fail");
    expect(outcomeFor("defect", { marked: false, notApplicable: false })).toBe("pass");
  });

  it("treats not applicable as clearing, in both polarities", () => {
    // An item that does not apply cannot be a reason to refuse. A Partnership
    // has no SECP filings, and the officer must be able to say so without the
    // round turning deficient.
    expect(outcomeFor("compliance", { marked: false, notApplicable: true })).toBe(
      "not_applicable",
    );
    expect(outcomeFor("defect", { marked: true, notApplicable: true })).toBe(
      "not_applicable",
    );

    const items = ITEMS.map((item) => ({
      outcome: outcomeFor(item.polarity, { marked: false, notApplicable: true }),
    }));
    expect(checklistOutcome(items)).toBe("clear");
  });

  it("round-trips an outcome back to the tick that produced it", () => {
    // `markFor` is what re-renders a saved round, so a tick that comes back
    // inverted would show the officer the opposite of what they recorded.
    for (const polarity of ["compliance", "defect"] as const) {
      for (const marked of [true, false]) {
        const outcome = outcomeFor(polarity, { marked, notApplicable: false });
        expect(markFor(polarity, outcome)).toBe(marked);
      }
    }
  });

  it("labels the answers in each item's own terms", () => {
    // What the officer actually reads. "Satisfactory" against "Signatures do
    // not match with CNIC" would ask the opposite of what it appears to ask.
    expect(affirmativeLabel("compliance")).toBe("Satisfactory");
    expect(negativeLabel("compliance")).toBe("Deficient");
    expect(affirmativeLabel("defect")).toBe("Defect found");
    expect(negativeLabel("defect")).toBe("No defect");
  });
});

describe("disagreements", () => {
  const item = (
    outcome: ChecklistItemOutcome,
    systemVerdict: "pass" | "fail" | "unknown",
  ) => ({ outcome, systemVerdict });

  it("reports an officer passing what the system failed", () => {
    expect(disagreements([item("pass", "fail")])).toHaveLength(1);
    expect(disagreements([item("fail", "pass")])).toHaveLength(1);
  });

  it("does not report agreement, an unknown verdict, or not applicable", () => {
    expect(
      disagreements([
        item("pass", "pass"),
        item("fail", "fail"),
        // Most of the thirteen are judgements no machine can make, and
        // counting every one as an override would make the audit field noise.
        item("fail", "unknown"),
        item("pass", "unknown"),
        // An item that does not apply was not overridden; it was excused.
        item("not_applicable", "fail"),
      ]),
    ).toEqual([]);
  });
});

describe("systemOpinion", () => {
  const TYPES: ItemDocumentTypes = new Map([
    ["cnic_readable", ["cnic"]],
    ["bank_certificate", ["bank_certificate"]],
    ["secp_documents", ["moa_aoa", "incorporation_certificate"]],
    ["company_stamp", []],
    ["signature_mismatch", []],
  ]);

  function facts(overrides: Partial<ChecklistFacts> = {}): ChecklistFacts {
    return {
      formComplete: true,
      documents: [],
      hasProposer: true,
      hasSeconder: true,
      endorsersInGoodStanding: true,
      bankCertificateAgeDays: null,
      bankCertificateMaxAgeDays: null,
      ...overrides,
    };
  }

  it("fails a required document that is missing, and says which", () => {
    const opinion = systemOpinion(
      "cnic_readable",
      facts({
        documents: [
          {
            documentTypeCode: "cnic",
            required: true,
            requiredCount: 2,
            suppliedCount: 1,
          },
        ],
      }),
      TYPES,
    );

    expect(opinion.verdict).toBe("fail");
    expect(opinion.because).toBeTruthy();
  });

  it("never passes a document that is merely present", () => {
    // The point of the whole module. Presence is all the machine can see;
    // legibility, the signature and the stamp are the officer's judgement, so
    // the advice is `unknown` and the officer is not told the item is fine.
    const opinion = systemOpinion(
      "cnic_readable",
      facts({
        documents: [
          {
            documentTypeCode: "cnic",
            required: true,
            requiredCount: 1,
            suppliedCount: 1,
          },
        ],
      }),
      TYPES,
    );

    expect(opinion.verdict).toBe("unknown");
  });

  it("fails a bank certificate older than its type allows", () => {
    const opinion = systemOpinion(
      "bank_certificate",
      facts({
        documents: [
          {
            documentTypeCode: "bank_certificate",
            required: true,
            requiredCount: 1,
            suppliedCount: 1,
          },
        ],
        bankCertificateAgeDays: 120,
        bankCertificateMaxAgeDays: 90,
      }),
      TYPES,
    );

    expect(opinion.verdict).toBe("fail");
    expect(opinion.because).toMatch(/\b120\b/);
  });

  it("has no opinion on the items that are purely physical", () => {
    // A company stamp and a signature comparison are acts on paper. The
    // machine saying "pass" here would be inventing a verdict.
    expect(systemOpinion("company_stamp", facts(), TYPES).verdict).toBe("unknown");
    expect(systemOpinion("signature_mismatch", facts(), TYPES).verdict).toBe("unknown");
  });

  it("is unknown for an item code it does not recognise", () => {
    // A code added by a later revision of the controlled form. Unadvised is
    // the only safe default; advised by nothing in particular is not.
    expect(systemOpinion("something_rev_02_added", facts(), TYPES).verdict).toBe("unknown");
  });
});

describe("suggestNotApplicable", () => {
  const TYPES: ItemDocumentTypes = new Map([
    ["secp_documents", ["moa_aoa", "incorporation_certificate"]],
    ["company_stamp", []],
  ]);

  it("suggests it where the frozen matrix asks for none of the item's documents", () => {
    // All thirteen items are always shown — the form is ISO-controlled — so
    // this is how a Partnership's SECP row arrives pre-answered rather than
    // hidden.
    expect(
      suggestNotApplicable(
        "secp_documents",
        {
          formComplete: true,
          documents: [
            {
              documentTypeCode: "moa_aoa",
              required: false,
              requiredCount: 0,
              suppliedCount: 0,
            },
            {
              documentTypeCode: "incorporation_certificate",
              required: false,
              requiredCount: 0,
              suppliedCount: 0,
            },
          ],
          hasProposer: true,
          hasSeconder: true,
          endorsersInGoodStanding: true,
          bankCertificateAgeDays: null,
          bankCertificateMaxAgeDays: null,
        },
        TYPES,
      ),
    ).toBe(true);
  });

  it("does not suggest it for an item with no documents at all", () => {
    // The stamp, the signature comparison, the completeness of the form: no
    // document decides them, so "not applicable" is never the default answer.
    expect(
      suggestNotApplicable(
        "company_stamp",
        {
          formComplete: true,
          documents: [],
          hasProposer: true,
          hasSeconder: true,
          endorsersInGoodStanding: true,
          bankCertificateAgeDays: null,
          bankCertificateMaxAgeDays: null,
        },
        TYPES,
      ),
    ).toBe(false);
  });
});
