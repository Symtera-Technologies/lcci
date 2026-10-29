import { describe, expect, it } from "vitest";
import {
  LITERAL_POLICY,
  daysOfMembership,
  hasLapsed,
  membershipYearFor,
  yearLabel,
  type MembershipYearPolicy,
} from "@/membership/year";

/**
 * The 31 March rule, pinned.
 *
 * This is the piece of policy in the system most likely to be quietly broken
 * by a later refactor — it is six lines of arithmetic that decide a date on a
 * certificate — so the cases below are written as the chamber would state them
 * rather than as the code is shaped.
 */
describe("the literal rule from the printed form", () => {
  it("expires on 31 March whatever the date of grant", () => {
    expect(membershipYearFor("2026-04-01").validUntil).toBe("2027-03-31");
    expect(membershipYearFor("2026-10-28").validUntil).toBe("2027-03-31");
    expect(membershipYearFor("2026-12-31").validUntil).toBe("2027-03-31");
    expect(membershipYearFor("2027-01-05").validUntil).toBe("2027-03-31");
    expect(membershipYearFor("2027-02-20").validUntil).toBe("2027-03-31");
  });

  it("charges a full fee for 39 days when granted on 20 February", () => {
    // Open question 11 in plain arithmetic. This test is not asserting that
    // the rule is fair — it is asserting that the system implements the rule
    // LCCI's own form states, so that the number in the conversation with
    // them is the real one.
    const year = membershipYearFor("2027-02-20");
    expect(daysOfMembership(year.startsOn, year.validUntil)).toBe(39);
  });

  it("rolls to the next year for a grant on 1 April", () => {
    // The day after an expiry starts a fresh year, not a one-day stub.
    expect(membershipYearFor("2027-04-01").validUntil).toBe("2028-03-31");
    expect(membershipYearFor("2027-03-30").validUntil).toBe("2027-03-31");
  });

  it("gives a grant on the expiry day exactly that day", () => {
    // Vanishingly rare and deliberately literal: granting a whole extra year
    // here would be generosity invented in a function rather than decided by
    // the chamber.
    const year = membershipYearFor("2027-03-31");
    expect(year.validUntil).toBe("2027-03-31");
    expect(daysOfMembership(year.startsOn, year.validUntil)).toBe(0);
  });

  it("labels the year by the one it ends in", () => {
    expect(membershipYearFor("2026-10-28").label).toBe("2026–27");
    expect(membershipYearFor("2027-04-01").label).toBe("2027–28");
    expect(yearLabel(2030)).toBe("2029–30");
  });

  it("keeps the grant date as the start, not 1 April", () => {
    // The year the applicant paid for begins when they were granted it. A
    // start of 1 April would claim they were a member in a month they were
    // not, which matters for anything that asks "were they in good standing
    // on this date?" — endorsement standing, for one.
    expect(membershipYearFor("2026-10-28").startsOn).toBe("2026-10-28");
  });
});

describe("a carry-forward cut-off, if LCCI sets one", () => {
  // One row in `membership_year_policy`, no deploy. These tests exist so that
  // the row is known to work before anybody is told they can set it.
  const newYear: MembershipYearPolicy = {
    ...LITERAL_POLICY,
    carryForwardMonth: 1,
    carryForwardDay: 1,
  };

  it("credits a January grant to the following year", () => {
    expect(membershipYearFor("2027-01-05", newYear).validUntil).toBe(
      "2028-03-31",
    );
    expect(membershipYearFor("2027-03-30", newYear).validUntil).toBe(
      "2028-03-31",
    );
  });

  it("leaves a grant before the cut-off alone", () => {
    expect(membershipYearFor("2026-10-28", newYear).validUntil).toBe(
      "2027-03-31",
    );
    expect(membershipYearFor("2026-12-31", newYear).validUntil).toBe(
      "2027-03-31",
    );
  });

  it("handles a cut-off that falls before the new year", () => {
    // 1 December against a 31 March expiry: the window wraps, so December as
    // well as January to March carry forward. Written out because the wrap is
    // the case an implementation gets wrong.
    const december: MembershipYearPolicy = {
      ...LITERAL_POLICY,
      carryForwardMonth: 12,
      carryForwardDay: 1,
    };
    expect(membershipYearFor("2026-11-30", december).validUntil).toBe(
      "2027-03-31",
    );
    expect(membershipYearFor("2026-12-01", december).validUntil).toBe(
      "2028-03-31",
    );
    expect(membershipYearFor("2027-02-20", december).validUntil).toBe(
      "2028-03-31",
    );
  });
});

describe("expiry as a read, never a stored flag", () => {
  it("compares civil dates without constructing an instant", () => {
    expect(hasLapsed("2027-03-31", "2027-03-31")).toBe(false);
    expect(hasLapsed("2027-03-31", "2027-04-01")).toBe(true);
    expect(hasLapsed("2027-03-31", "2026-12-31")).toBe(false);
  });

  it("refuses a value that is not a civil date", () => {
    // The guard that keeps a timestamp out. `2027-03-31T00:00:00Z` through a
    // timezone is 30 March somewhere, and this value is printed on paper.
    expect(() => membershipYearFor("2027-03-31T00:00:00.000Z")).toThrow(
      /civil date/,
    );
    expect(() => hasLapsed("2027-03-31", "yesterday")).toThrow(/civil date/);
  });
});
