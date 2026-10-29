import { describe, expect, it } from "vitest";
import {
  amountAgrees,
  canonicalBankName,
  canonicalInstrumentNo,
  canonicalTitle,
  certificateAgeDays,
  instrumentFingerprint,
  shortfallPaisa,
  squash,
  systemBankMatch,
  CERTIFICATE_MAX_AGE_DAYS,
} from "@/membership/bank-match";

/**
 * The money control, as arithmetic.
 *
 * Two properties carry the weight here, and both are the kind of thing that
 * breaks silently.
 *
 * The **fingerprint** is a uniqueness guarantee stored in an index, so it has
 * to mean the same thing in five years as it does today. The tests below pin
 * what it ignores (case, punctuation, spacing) and — more importantly — what it
 * must *not* ignore: the alias list, leading zeros, and the date.
 *
 * The **advisory comparison** must never be confidently wrong. "Mismatch" is
 * the only verdict that stops a cashier, so everything inconclusive has to come
 * back `uncertain` rather than being rounded to a finding.
 */

describe("normalisation", () => {
  it("removes only case, punctuation and spacing", () => {
    // Punctuation becomes a *space*, not nothing — which is what makes
    // "Smith&Co" two words. The cost is that "H.B.L." arrives as three
    // tokens, which is why the fingerprint tightens and the comparison
    // rejoins initials rather than either of them using this directly.
    expect(squash("H.B.L.")).toBe("H B L");
    expect(squash("  Habib   Bank  Limited ")).toBe("HABIB BANK LIMITED");
    expect(squash("Smith & Co")).toBe("SMITH AND CO");
    // "Smith and Co" and "Smith & Co" are the same firm written two ways, and
    // a cashier typing one while the certificate prints the other is routine.
    expect(squash("Smith and Co")).toBe(squash("Smith & Co"));
  });

  it("resolves the bank aliases a cashier actually types", () => {
    const canonical = canonicalBankName("Habib Bank Limited");
    expect(canonicalBankName("HBL")).toBe(canonical);
    expect(canonicalBankName("H.B.L.")).toBe(canonical);
    expect(canonicalBankName("habib bank ltd")).toBe(canonical);
  });

  it("does not collapse two genuinely different banks", () => {
    expect(canonicalBankName("HBL")).not.toBe(canonicalBankName("UBL"));
    expect(canonicalBankName("Bank Alfalah")).not.toBe(canonicalBankName("Bank AL Habib"));
  });

  it("ignores the legal suffixes a business name is written with", () => {
    const canonical = canonicalTitle("Mall Road Exports");
    expect(canonicalTitle("M/s Mall Road Exports (Pvt) Limited")).toBe(canonical);
    expect(canonicalTitle("MALL ROAD EXPORTS CO.")).toBe(canonical);
  });

  it("keeps the leading zeros on an instrument number", () => {
    // The bank printed them, and 000412 is not 412.
    expect(canonicalInstrumentNo("000412")).toBe("000412");
    expect(canonicalInstrumentNo("PO-000412 / A")).toBe("PO000412A");
    expect(canonicalInstrumentNo("000412")).not.toBe(canonicalInstrumentNo("412"));
  });

  it("does not let a name of nothing but noise words become empty", () => {
    // An empty canonical form would compare equal to every other empty one, so
    // two unrelated firms would "match" on their account titles.
    expect(canonicalTitle("The Company Limited")).not.toBe("");
    expect(canonicalTitle("The Company Limited")).not.toBe(canonicalTitle("Messrs Co Pvt"));
  });
});

describe("instrumentFingerprint", () => {
  const base = {
    bankName: "Habib Bank Limited",
    instrumentNo: "000412",
    instrumentDate: "2026-10-01",
  };

  it("is stable across the punctuation and spacing of the same instrument", () => {
    expect(
      instrumentFingerprint({
        ...base,
        bankName: "  habib bank   limited ",
        instrumentNo: "PO 000412",
      }),
    ).toBe(
      instrumentFingerprint({ ...base, instrumentNo: "po-000412" }),
    );
  });

  it("separates the same number at a different bank or on a different date", () => {
    expect(instrumentFingerprint({ ...base, bankName: "United Bank Limited" })).not.toBe(
      instrumentFingerprint(base),
    );
    expect(instrumentFingerprint({ ...base, instrumentDate: "2026-10-02" })).not.toBe(
      instrumentFingerprint(base),
    );
    // Two banks can legitimately issue instrument 000412 on the same day, which
    // is exactly why the bank is part of the triple.
    expect(instrumentFingerprint({ ...base, instrumentNo: "412" })).not.toBe(
      instrumentFingerprint(base),
    );
  });

  it("deliberately does not run the bank name through the alias list", () => {
    // The load-bearing decision in the module. The fingerprint backs a UNIQUE
    // index over rows that are already in the table, so if it depended on an
    // editable alias list then adding one alias would silently re-partition
    // every future insert — and the same pay order typed before and after that
    // release would produce two fingerprints and no collision.
    //
    // The cost is this: "HBL" and "Habib Bank Ltd" do not collide. It is
    // asserted rather than regretted, so that anyone who "fixes" it has to
    // delete a test that explains why not to.
    expect(instrumentFingerprint({ ...base, bankName: "HBL" })).not.toBe(
      instrumentFingerprint(base),
    );
  });

  it("cannot be confused by a separator inside one of the parts", () => {
    // Joining on a hyphen would make ("A-B", "1", d) and ("A", "B-1", d) the
    // same string. The unit separator cannot appear in any of the three.
    expect(
      instrumentFingerprint({
        bankName: "A",
        instrumentNo: "B1",
        instrumentDate: "2026-10-01",
      }),
    ).not.toBe(
      instrumentFingerprint({
        bankName: "AB",
        instrumentNo: "1",
        instrumentDate: "2026-10-01",
      }),
    );
  });

  it("is stable across dotted and undotted initials", () => {
    // The reason the fingerprint tightens rather than squashing: a bank name
    // typed "H.B.L." must hash as the same instrument as "HBL", or a duplicate
    // pay order slips through on a dot.
    const dotted = instrumentFingerprint({ ...base, bankName: "H.B.L." });
    expect(instrumentFingerprint({ ...base, bankName: "HBL" })).toBe(dotted);
    expect(instrumentFingerprint({ ...base, bankName: "h b l" })).toBe(dotted);
  });

  it("is a 64-character hex digest", () => {
    expect(instrumentFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("systemBankMatch", () => {
  const instrument = {
    bankName: "HBL",
    branch: "Gulberg III, Lahore",
    accountTitle: "Mall Road Exports",
  };

  it("matches where every comparable field agrees, through the aliases", () => {
    const advice = systemBankMatch(instrument, {
      bankName: "Habib Bank Limited",
      branch: "Gulberg III Lahore",
      accountTitle: "M/s Mall Road Exports (Pvt) Ltd",
    });

    expect(advice.verdict).toBe("match");
  });

  it("calls two different institutions a mismatch, and says which", () => {
    const advice = systemBankMatch(instrument, {
      bankName: "United Bank Limited",
      branch: "Gulberg III, Lahore",
      accountTitle: "Mall Road Exports",
    });

    expect(advice.verdict).toBe("mismatch");
    expect(advice.reasons.join(" ")).toMatch(/UNITED BANK/);
  });

  it("is uncertain, not a mismatch, when only the branch differs", () => {
    // A pay order is issued *at* a branch, which need not be the branch the
    // account is held at. Treating that as a finding would make the control
    // fire on a large share of legitimate applications, and a control that
    // fires constantly is a control nobody reads.
    const advice = systemBankMatch(instrument, {
      bankName: "Habib Bank Limited",
      branch: "Mall Road, Lahore",
      accountTitle: "Mall Road Exports",
    });

    expect(advice.verdict).toBe("uncertain");
  });

  it("is uncertain, not a mismatch, when only the account title differs", () => {
    const advice = systemBankMatch(instrument, {
      bankName: "Habib Bank Limited",
      branch: "Gulberg III, Lahore",
      accountTitle: "Shahdara Trading Company",
    });

    expect(advice.verdict).toBe("uncertain");
    expect(advice.reasons.join(" ")).toMatch(/SHAHDARA TRADING/);
  });

  it("is uncertain when the certificate side was never captured", () => {
    const advice = systemBankMatch(instrument, {
      bankName: null,
      branch: null,
      accountTitle: null,
    });

    expect(advice.verdict).toBe("uncertain");
    expect(advice.reasons[0]).toMatch(/nothing to compare/);
  });

  it("treats a blank string as absent rather than as a value", () => {
    // An empty input would otherwise canonicalise to "" on one side and
    // compare unequal to everything, turning a field the cashier simply left
    // alone into a finding.
    const advice = systemBankMatch(instrument, {
      bankName: "Habib Bank Limited",
      branch: "   ",
      accountTitle: "Mall Road Exports",
    });

    expect(advice.verdict).toBe("uncertain");
    expect(advice.fields.find((f) => f.field === "branch")?.agrees).toBeNull();
  });

  it("reports every field it could compare, for the record", () => {
    const advice = systemBankMatch(instrument, {
      bankName: "Habib Bank Limited",
      branch: "Gulberg III Lahore",
      accountTitle: "Mall Road Exports",
    });

    expect(advice.fields.map((f) => f.field)).toEqual([
      "bank",
      "branch",
      "account_title",
    ]);
    expect(advice.fields.every((f) => f.agrees === true)).toBe(true);
  });
});

describe("amounts", () => {
  it("compares the published fee amounts exactly", () => {
    expect(amountAgrees("10650.00", "10650")).toBe(true);
    expect(amountAgrees("10650.00", "10650.00")).toBe(true);
    expect(amountAgrees("10650.00", "10650.01")).toBe(false);
    // The Associate regular fee presented against the Corporate regular one:
    // the self-declared-class problem, as the cashier meets it.
    expect(amountAgrees("10650.00", "4450.00")).toBe(false);
  });

  it("does not round a decimal through a float", () => {
    // 0.1 + 0.2 arithmetic has no business anywhere near a fee comparison.
    expect(amountAgrees("0.30", "0.30")).toBe(true);
    expect(shortfallPaisa("10650.00", "4450.00")).toBe(620_000n);
    expect(shortfallPaisa("4450.00", "10650.00")).toBe(-620_000n);
    expect(shortfallPaisa("10650.00", "10650.00")).toBe(0n);
  });

  it("scales a one-digit fraction correctly", () => {
    // "10.5" is ten rupees fifty paisa, not ten rupees five.
    expect(amountAgrees("10.50", "10.5")).toBe(true);
    expect(amountAgrees("10.05", "10.5")).toBe(false);
  });
});

describe("certificateAgeDays", () => {
  const on = new Date("2026-10-28T09:00:00Z");

  it("counts whole days from the issue date", () => {
    expect(certificateAgeDays("2026-10-28", on)).toBe(0);
    expect(certificateAgeDays("2026-10-01", on)).toBe(27);
  });

  it("reads three months as 92 days", () => {
    // The longest three consecutive months, so the reading never refuses a
    // certificate the strict calendar reading would allow — and a cashier can
    // reproduce it without a calendar.
    expect(CERTIFICATE_MAX_AGE_DAYS).toBe(92);
    expect(certificateAgeDays("2026-07-28", on)).toBe(92);
    expect(certificateAgeDays("2026-07-27", on)).toBe(93);
  });

  it("returns null for a date it cannot read", () => {
    expect(certificateAgeDays("not a date", on)).toBeNull();
  });
});
