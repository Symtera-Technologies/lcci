import { describe, expect, it } from "vitest";
import { parseRoster, rosterWords } from "@/content/roster";

/**
 * The roster layout may only *regroup* text, never change it.
 *
 * `parseRoster` already checks this for itself — it reads the words back out
 * of its own result and refuses the whole layout if they differ from the
 * input's by one — so these tests are not the only guard. They are the guard
 * that says *which* shapes it is supposed to accept, because a parser that
 * silently returns `null` for everything would pass its own check perfectly
 * and lay out nothing.
 *
 * `words` is the verifier's own normalisation, copied rather than imported for
 * the reason `tests/editorial.test.ts` gives: the verifier is a script outside
 * the app's module graph, and the point is to assert against the rule as that
 * script applies it.
 */
function words(markup: string): string[] {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[� ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * `/about/past-leadership` as migration 0026 stores it, in miniature.
 *
 * Every awkward feature of the real 17,000-character body is here: the name in
 * an `<h3>`, the year as a **bare text node between tags**, the firm as the
 * paragraph's leading `<strong>`, the run-together contact line after it, the
 * empty paragraphs the legacy template emits, a death marked by a second
 * heading rather than by words, and an entry with nothing but a name.
 */
const PRESIDENTS =
  "<h2>Former Presidents</h2><p></p>\n\n" +
  "<h3>\nMr. Faheem ur Rehman Saigol</h3>\n\n     Year 2025-26\n" +
  "<p><strong>M/s Nasir &amp; Sons</strong>\nNo.1 S-49 R-24 , Pak Center , " +
  "Chamberlane Road LahoreTel: ---------------Fax: Mob: 03218463640</p>\n\n" +
  "<h3>\nMian Abuzar Shad </h3>\n\n     Year 2024-25\n" +
  "<p><strong>M/s Victoria Fabrics</strong>\nAbuzar Tower , Peco Road Lahore</p>\n\n" +
  "<p></p>\n\n" +
  "<h3>\nSheikh Muhammad Arshad</h3>\n\n<h3>Late</h3>\n\n" +
  "<h3>\nDr. A. Waheed</h3>\n\n<h3>Late</h3>";

/**
 * The second and third sections of the same page.
 *
 * A year and a name in one paragraph, separated by non-breaking spaces, under
 * column headings the old site set in bold inside the first paragraph. The
 * 1969 row has a double space *inside* the name, which is the row that decided
 * how the split works.
 */
const VICE_PRESIDENTS =
  "<h2>Former Senior Vice President</h2><p><strong>Year    Name</strong></p>\n\n" +
  "<p>2025-26    Mr. Tanveer Ahmed Sheikh</p>\n\n" +
  "<p>2024-25    Engr. Khalid Usman</p>\n\n" +
  "<p>1969    Mr.A.Majid Mufti  (Late)</p>";

describe("parseRoster on the presidents section", () => {
  const sections = parseRoster(PRESIDENTS);

  it("reads it as a list of people under its heading", () => {
    expect(sections).toHaveLength(1);
    expect(sections?.[0]?.heading).toBe("Former Presidents");
    expect(sections?.[0]?.kind).toBe("people");
  });

  it("pulls the name, the loose year, the firm and the contact line apart", () => {
    const section = sections?.[0];
    const people = section?.kind === "people" ? section.people : [];

    expect(people[0]).toEqual({
      name: "Mr. Faheem ur Rehman Saigol",
      notes: [],
      term: "Year 2025-26",
      firm: "M/s Nasir & Sons",
      detail:
        "No.1 S-49 R-24 , Pak Center , Chamberlane Road LahoreTel: ---------------Fax: Mob: 03218463640",
    });
  });

  /**
   * The bug this caught is the one worth keeping a test for.
   *
   * A death is marked by a second `<h3>Late</h3>` with no text between it and
   * the name. Treating *every* heading after a name as a note made the next
   * person's name a note too, and the real page lost a third of its roster —
   * forty-eight people where there are sixty, with nothing visibly wrong.
   */
  it("attaches Late to the person above it without swallowing the next", () => {
    const section = sections?.[0];
    const people = section?.kind === "people" ? section.people : [];

    expect(people).toHaveLength(4);
    expect(people[2]).toMatchObject({ name: "Sheikh Muhammad Arshad", notes: ["Late"] });
    expect(people[3]).toMatchObject({ name: "Dr. A. Waheed", notes: ["Late"] });
  });

  it("renders every word of the source, in order", () => {
    expect(rosterWords(sections ?? []).flatMap(words)).toEqual(words(PRESIDENTS));
  });
});

describe("parseRoster on the vice presidents sections", () => {
  const sections = parseRoster(VICE_PRESIDENTS);

  it("reads the bold first paragraph as column headings", () => {
    const section = sections?.[0];
    expect(section?.kind).toBe("pairs");
    expect(section?.kind === "pairs" && section.columns).toEqual(["Year", "Name"]);
  });

  it("splits on the first column gap only", () => {
    const section = sections?.[0];
    const pairs = section?.kind === "pairs" ? section.pairs : [];

    expect(pairs).toHaveLength(3);
    expect(pairs[0]).toEqual({ term: "2025-26", name: "Mr. Tanveer Ahmed Sheikh" });
    // Splitting on every gap gives three cells here and sends fifty-seven
    // good rows to prose for the sake of one.
    expect(pairs[2]).toEqual({ term: "1969", name: "Mr.A.Majid Mufti (Late)" });
  });

  it("renders every word of the source, in order", () => {
    expect(rosterWords(sections ?? []).flatMap(words)).toEqual(words(VICE_PRESIDENTS));
  });
});

describe("parseRoster on a whole page", () => {
  const sections = parseRoster(`${PRESIDENTS}\n<p></p>\n${VICE_PRESIDENTS}`);

  it("divides it at the highest heading level, not at every heading", () => {
    // Dividing at `<h3>` would give one section per person.
    expect(sections?.map((section) => section.kind)).toEqual(["people", "pairs"]);
  });

  it("renders every word of both sections, in order", () => {
    expect(rosterWords(sections ?? []).flatMap(words)).toEqual(
      words(`${PRESIDENTS}\n<p></p>\n${VICE_PRESIDENTS}`),
    );
  });
});

describe("parseRoster declining", () => {
  it("returns null for a body with no headings", () => {
    expect(parseRoster("<p>A paragraph.</p><p>Another.</p>")).toBeNull();
  });

  it("returns null when nothing in it is a list of people or of pairs", () => {
    // Ordinary prose under a heading. There is nothing for this layout to add,
    // and `<Prose>` is already correct.
    expect(
      parseRoster("<h2>About</h2><p>The chamber was founded in 1923 by local traders.</p>"),
    ).toBeNull();
  });

  it("sends a section with a link in it to prose rather than guessing", () => {
    const body =
      "<h2>Former Presidents</h2>\n" +
      "<h3>Mr. A</h3>\n<p><a href=\"/a\">M/s A</a> of Lahore</p>\n" +
      "<h3>Mr. B</h3>\n<p><strong>M/s B</strong> of Lahore</p>\n" +
      `${VICE_PRESIDENTS}`;

    const sections = parseRoster(body);
    expect(sections?.[0]?.kind).toBe("prose");
    // And the words still come through, which is what lets the page render.
    expect(rosterWords(sections ?? []).flatMap(words)).toEqual(words(body));
  });

  it("treats one person under a heading as a paragraph, not a list", () => {
    const body = `<h2>President</h2>\n<h3>Mr. A</h3>\n<p><strong>M/s A</strong></p>\n${VICE_PRESIDENTS}`;
    const sections = parseRoster(body);
    expect(sections?.[0]?.kind).toBe("prose");
  });
});
