import { describe, expect, it } from "vitest";
import { formatE164, toE164 } from "@/lib/phone";

/**
 * The one stored form of a telephone number.
 *
 * Worth a suite of its own because this function decides what goes in a column
 * named `mobile_e164`, and the cost of getting it wrong is not an error
 * message — it is twenty thousand rows in four different formats and a later
 * migration guessing which country `3001234567` is in.
 *
 * The cases are the ones a Pakistani applicant actually types. They were taken
 * from how numbers are written on the Chamber's own site and on the printed
 * membership form: `+92-42-111-222-499` in the footer, `042-37654321` in the
 * office telephone box, a mobile dictated as `0300 1234567`.
 */

describe("toE164", () => {
  it("keeps a number that already is E.164", () => {
    expect(toE164("+923001234567")).toBe("+923001234567");
  });

  it("accepts the separators people actually type", () => {
    // Spaces, dashes, brackets, dots and a slash: all punctuation in a dialled
    // number and noise in a column.
    for (const typed of [
      "+92 300 1234567",
      "+92-300-1234567",
      "+92 (300) 123 4567",
      "+92.300.1234567",
      "0300-1234567",
      "0300 123 4567",
    ]) {
      expect(toE164(typed), typed).toBe("+923001234567");
    }
  });

  it("drops the trunk zero and adds the country code", () => {
    expect(toE164("03001234567")).toBe("+923001234567");
  });

  it("does the same for a landline, which is what a one-man concern gives", () => {
    // The field asks for a mobile and this is not one. Accepted deliberately:
    // a check that insisted on `03` would refuse a real contact number, and an
    // applicant who cannot get past the field does not apply.
    expect(toE164("042-37654321")).toBe("+924237654321");
  });

  it("reads the international prefix as a plus", () => {
    expect(toE164("00923001234567")).toBe("+923001234567");
  });

  it("accepts a bare country code only at the length a Pakistani number is", () => {
    expect(toE164("923001234567")).toBe("+923001234567");
    // Ten digits with no zero and no plus. Probably a mobile with the zero
    // left off, and probably is not good enough to stamp +92 onto a number the
    // Chamber will ring.
    expect(toE164("3001234567")).toBeNull();
    // `92` followed by the wrong number of digits is not a country code — it
    // could be an area code in a country we have not been told about.
    expect(toE164("921234")).toBeNull();
    expect(toE164("92300123456789")).toBeNull();
  });

  it("keeps a foreign number, because foreign firms apply too", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("+1 (415) 555 0132")).toBe("+14155550132");
  });

  it("refuses anything that is not a dialled number", () => {
    for (const bad of [
      "",
      "   ",
      "not a number",
      "0300 1234567 ext 4",
      "+92 300 ABCDEFG",
      "++923001234567",
      "+92 300 1234567 / 0301 7654321",
      // Thirteen digits with no plus and no leading zero: a CNIC in the wrong
      // box, which is exactly the paste this must not turn into a number.
      "3520212345671",
    ]) {
      expect(toE164(bad), bad).toBeNull();
    }
  });

  it("refuses a number too short or too long to be one", () => {
    expect(toE164("+1234567")).toBeNull();
    expect(toE164("+1234567890123456")).toBeNull();
  });

  it("never returns something that is not E.164", () => {
    // The guarantee the column depends on: whatever comes back starts with a
    // plus, carries only digits after it, and fits VARCHAR(20).
    const inputs = [
      "+923001234567",
      "0300-1234567",
      "00923001234567",
      "042 37654321",
      "+44 20 7946 0958",
      "923001234567",
    ];

    for (const input of inputs) {
      const result = toE164(input);
      expect(result, input).not.toBeNull();
      expect(result).toMatch(/^\+[1-9]\d{7,14}$/);
      expect((result as string).length).toBeLessThanOrEqual(20);
    }
  });

  it("is idempotent, so a stored value re-validates unchanged", () => {
    // Matters on any screen that reads a number out of the database, shows it
    // in a form and saves it back: a function that mangled its own output
    // would corrupt the row on every edit.
    const once = toE164("0300-1234567") as string;
    expect(toE164(once)).toBe(once);
  });
});

describe("formatE164", () => {
  it("groups a Pakistani number the way it is read aloud", () => {
    expect(formatE164("+923001234567")).toBe("+92 300 1234567");
  });

  it("leaves anything else exactly as stored", () => {
    // A guess at another country's grouping would be a guess shown to the one
    // person who knows it is wrong.
    expect(formatE164("+442079460958")).toBe("+442079460958");
  });

  /**
   * The case that caught the first version of this function.
   *
   * `+924237654321` is a Lahore landline: area code `42`, then eight digits. A
   * three-and-seven split reads it as `+92 423 7654321`, which is not a
   * number anybody could dial. Pakistani area codes are two, three or four
   * digits, so there is no single rule to apply — and printing it unchanged is
   * right rather than merely safe.
   */
  it("does not regroup a landline, whose area code is not three digits", () => {
    expect(formatE164("+924237654321")).toBe("+924237654321");
    expect(formatE164("+92519876543")).toBe("+92519876543");
  });
});
