import { describe, expect, it } from "vitest";
import { splitHeadline } from "@/content/headline";

/**
 * The hero headline's highlight phrase.
 *
 * Worth its own file because this is the one place where two editable fields
 * have to agree with each other, and the generic editor validates fields one
 * at a time — so nothing stops an editor changing the headline and leaving the
 * phrase behind. Every way that can go wrong has to produce correct copy
 * without the green rather than a missing word, a doubled word or a crash.
 *
 * The reassembly assertions are the load-bearing ones: `before + highlight +
 * after` must equal the headline character for character in every case. A
 * split that loses or duplicates a space is invisible in a unit test that only
 * checks the three parts separately, and glaring at 60px on the homepage.
 */
describe("splitHeadline", () => {
  const headline = "The chamber that speaks for 20,000 businesses in Lahore.";

  it("splits around the phrase", () => {
    const parts = splitHeadline(headline, "20,000 businesses");

    expect(parts).toEqual({
      before: "The chamber that speaks for ",
      highlight: "20,000 businesses",
      after: " in Lahore.",
    });
  });

  it("keeps every character, including the spaces either side", () => {
    const parts = splitHeadline(headline, "20,000 businesses");

    expect(parts.before + parts.highlight + parts.after).toBe(headline);
  });

  it("renders plain when the phrase is not in the headline", () => {
    // The failure this function exists for: an editor rewrites the headline
    // and forgets the phrase. The copy must survive.
    const parts = splitHeadline(headline, "30,000 businesses");

    expect(parts.highlight).toBe("");
    expect(parts.before).toBe(headline);
    expect(parts.after).toBe("");
  });

  it("renders plain when no phrase is set", () => {
    for (const absent of [undefined, null, "", "   "]) {
      const parts = splitHeadline(headline, absent);

      expect(parts.highlight, JSON.stringify(absent)).toBe("");
      expect(parts.before, JSON.stringify(absent)).toBe(headline);
    }
  });

  it("is case-sensitive, so a casing typo shows rather than hides", () => {
    // Greening "20,000 Businesses" when the headline says "businesses" would
    // make the mismatch invisible to the person who introduced it.
    const parts = splitHeadline(headline, "20,000 Businesses");

    expect(parts.highlight).toBe("");
  });

  it("handles a phrase at the very start", () => {
    const parts = splitHeadline("20,000 businesses, one chamber.", "20,000 businesses");

    expect(parts.before).toBe("");
    expect(parts.highlight).toBe("20,000 businesses");
    expect(parts.after).toBe(", one chamber.");
  });

  it("handles a phrase at the very end", () => {
    const parts = splitHeadline("The voice of 20,000 businesses", "20,000 businesses");

    expect(parts.before).toBe("The voice of ");
    expect(parts.after).toBe("");
  });

  it("highlights the whole headline when the phrase is the headline", () => {
    const parts = splitHeadline(headline, headline);

    expect(parts).toEqual({ before: "", highlight: headline, after: "" });
  });

  it("takes the first of two occurrences and leaves the second alone", () => {
    // Highlighting both would mean deciding which repetition the editor meant,
    // which this function cannot know.
    const parts = splitHeadline("Trade, and more trade.", "trade");

    expect(parts.before).toBe("Trade, and more ");
    expect(parts.highlight).toBe("trade");
    expect(parts.after).toBe(".");
  });

  it("trims the phrase, since a form field collects stray spaces", () => {
    const parts = splitHeadline(headline, "  20,000 businesses  ");

    expect(parts.highlight).toBe("20,000 businesses");
    expect(parts.before + parts.highlight + parts.after).toBe(headline);
  });
});
