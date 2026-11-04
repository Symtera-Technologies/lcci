import { describe, expect, it } from "vitest";
import { editorialWords, parseEditorial } from "@/content/editorial";

/**
 * The section layout may only *regroup* text, never change it.
 *
 * `scripts/verify-migrated-text.ts` asserts that every run of six consecutive
 * words from a legacy page appears in the built HTML of the route it was
 * mapped to, so a layout that dropped a dash, reordered two paragraphs or
 * wrote an ordinal into the markup would fail the build — but only after a
 * full `npm run build`, with a message about migrated text rather than about
 * the layout that ate it. These tests catch the same mistake in milliseconds.
 *
 * `words` is deliberately the verifier's own normalisation, copied rather than
 * imported: the verifier is a script outside the app's module graph, and the
 * point is to assert against the rule as that script applies it.
 */
function words(markup: string): string[] {
  return markup
    .replace(/<[^>]*>/g, " ")
    // Zero-width characters are not words, and the verifier removes them for
    // the reason stated there. Removed and not spaced, on both sides.
    .replace(/[​‌‍﻿]/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \ufffd\u00a0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * `/about/history` as migration 0026 stores it, byte for byte.
 *
 * Pasted rather than read from the migration, because the test's job is to
 * pin the behaviour against the shape the page actually has: if the row is
 * later re-seeded differently this test should keep passing against the shape
 * it was written for, and the live body is covered by `verify:migration`.
 */
const HISTORY_BODY =
  "<h2>Vision &amp; Mission</h2><h3><strong>Our Vision</strong></h3>\n\n" +
  "<p>To be the best Chamber in SAARC Countries through growth in business volumes, turnovers, exports and contribution in tax revenues.</p>\n\n" +
  "<h3><strong>Our Mission</strong></h3>\n\n" +
  "<p>To be the finest organization to serve the business community and to conduct its practices in best possible professional manner.</p>\n\n" +
  "<p>To be a bridge between the Business Community and Regulatory Bodiesfor in policy advocacy.</p>\n\n" +
  "<p>To seek long term relations with members reflecting fairness, honesty and transparency.</p>\n\n" +
  "<p>To build good repute of the Organization and maintaining high professional and ethical standards.</p>\n\n" +
  "<p>To conduct Business with integrity and strive to be a top Chamber in the Region.</p>\n\n" +
  "<h3><strong>Our Values</strong></h3>\n\n" +
  "<p>\u00a0</p>\n\n" +
  "<p><strong>Respect</strong> – Treating all well and work with courtesy and respect, the way you want to be treated.</p>\n\n" +
  "<p><strong>Empathy</strong> – Listening and understanding the feelings and ideas of others.</p>\n\n" +
  "<p><strong>Shared Responsibility</strong> – taking ownership and working as a team through collaboration among all stakeholders.</p>\n\n" +
  "<p><strong>Consistency </strong>– being consistent in mastering and maintaining standards in services and overall the image of the institution.</p>\n\n" +
  "<p><strong>Innovation</strong> – constant creativity in Research, Development and services for value addition and exceeding expectations of members, stakeholders and employees</p>";

describe("parseEditorial on the /about/history body", () => {
  const sections = parseEditorial(HISTORY_BODY);

  it("reads it as four sections", () => {
    expect(sections).not.toBeNull();
    expect(sections).toHaveLength(4);
  });

  it("treats the opening h2 as a label with nothing under it", () => {
    const first = sections?.[0];
    expect(first?.heading).toEqual({ level: 2, text: "Vision & Mission" });
    expect(first?.blocks).toHaveLength(0);
  });

  it("sets the lone vision paragraph as a statement", () => {
    const vision = sections?.[1];
    expect(vision?.heading?.text).toBe("Our Vision");
    expect(vision?.blocks[0]).toEqual({
      kind: "statement",
      text:
        "To be the best Chamber in SAARC Countries through growth in business " +
        "volumes, turnovers, exports and contribution in tax revenues.",
    });
  });

  it("groups the five mission paragraphs into one numbered run", () => {
    const mission = sections?.[2];
    expect(mission?.heading?.text).toBe("Our Mission");
    expect(mission?.blocks).toHaveLength(1);
    const block = mission?.blocks[0];
    expect(block?.kind).toBe("statements");
    expect(block?.kind === "statements" && block.items).toHaveLength(5);
  });

  it("reads the five values as term, dash and meaning", () => {
    const values = sections?.[3];
    expect(values?.heading?.text).toBe("Our Values");
    const block = values?.blocks[0];
    expect(block?.kind).toBe("definitions");
    if (block?.kind !== "definitions") throw new Error("expected definitions");

    expect(block.items).toHaveLength(5);
    expect(block.items[0]).toEqual({
      term: "Respect",
      dash: "–",
      meaning:
        "Treating all well and work with courtesy and respect, the way you " +
        "want to be treated.",
    });
    // The source writes `<strong>Consistency </strong>` with the space inside
    // the emphasis, which would otherwise become a heading with a hanging gap.
    expect(block.items[3]?.term).toBe("Consistency");
    // Every dash is kept, on every item. Dropping one would break the run that
    // spans it.
    expect(block.items.map((item) => item.dash)).toEqual(Array(5).fill("–"));
  });

  it("drops the spacer paragraph and nothing else", () => {
    // `&nbsp;` contributes no word, so this is invisible to the verifier — but
    // keeping it would split the five values into two grids.
    const values = sections?.[3];
    expect(values?.blocks).toHaveLength(1);
  });
});

describe("the layout changes no words", () => {
  it("renders the history body's words in the source's order", () => {
    const sections = parseEditorial(HISTORY_BODY);
    expect(sections).not.toBeNull();
    expect(editorialWords(sections ?? [])).toEqual(words(HISTORY_BODY));
  });

  it("holds for every six-word run, which is what the build checks", () => {
    const sections = parseEditorial(HISTORY_BODY);
    const rendered = editorialWords(sections ?? []).join(" ");
    const source = words(HISTORY_BODY);

    const missing: string[] = [];
    for (let i = 0; i + 6 <= source.length; i += 1) {
      const run = source.slice(i, i + 6).join(" ");
      if (!rendered.includes(run)) missing.push(run);
    }

    expect(missing).toEqual([]);
  });
});

describe("it declines rather than guesses", () => {
  it("falls back for a body of ordinary prose", () => {
    const prose =
      "<p>The chamber was established in 1923 and has represented the " +
      "businesses of Lahore ever since, through a secretariat that has grown " +
      "with the city it serves and a membership that now runs past twenty " +
      "thousand firms across every sector of the economy.</p>";
    expect(parseEditorial(prose)).toBeNull();
  });

  it("falls back when a body does not tokenise into top-level blocks", () => {
    // A stray unclosed tag. The sanitiser cannot emit this, but a seed
    // migration or a legacy import can, and a half-understood body must not
    // be restructured.
    expect(parseEditorial("<p>One</p><p>Two")).toBeNull();
  });

  it("keeps a paragraph run as prose when one paragraph carries a link", () => {
    const body =
      "<h3>Contact</h3>\n<p>Write to the Research Department.</p>\n" +
      '<p>Or see <a href="https://example.org/x">the published note</a>.</p>';
    const sections = parseEditorial(body);
    expect(sections?.[0]?.blocks[0]?.kind).toBe("prose");
  });

  it("keeps long paragraphs as prose rather than carding them", () => {
    const long = "word ".repeat(80).trim();
    const body = `<h3>Background</h3>\n<p>${long}</p>\n<p>${long}</p>`;
    expect(parseEditorial(body)?.[0]?.blocks[0]?.kind).toBe("prose");
  });

  it("hands a body back whole when a heading carries a link", () => {
    const body = '<h3><a href="https://example.org">Our Vision</a></h3>\n<p>Short.</p>';
    // Recognising the heading would mean rendering its text and dropping the
    // link, so it is not recognised — it stays markup, which leaves nothing
    // here but prose, which is `null` and the caller's plain `<Prose>`. The
    // link survives because nothing tried to be clever about it.
    expect(parseEditorial(body)).toBeNull();
  });

  it("does not card a single pair, which is a sentence and not a grid", () => {
    const body =
      "<h3>Values</h3>\n<p><strong>Respect</strong> – treating all well.</p>";
    expect(parseEditorial(body)?.[0]?.blocks[0]?.kind).toBe("prose");
  });

  it("keeps lists and tables as their own markup", () => {
    const body =
      "<h3>Banks</h3>\n<p>The following banks operate in Lahore.</p>\n" +
      "<ul><li>One</li><li>Two</li></ul>";
    const blocks = parseEditorial(body)?.[0]?.blocks ?? [];
    expect(blocks.map((b) => b.kind)).toEqual(["prose", "prose"]);
    expect(blocks[1]?.kind === "prose" && blocks[1].html).toContain("<ul>");
  });

  /**
   * The case that caught the parser guessing.
   *
   * "The following banks operate in Lahore." is a short plain paragraph under a
   * heading, exactly like the vision statement, and setting it at display size
   * would be wrong. The difference is not in the paragraph, it is in the body
   * around it — so that is what decides.
   */
  it("sets a lone paragraph large only beside a grid", () => {
    const line = "<h3>Our Vision</h3>\n<p>To be the best Chamber in SAARC.</p>";
    const grid =
      "<h3>Our Values</h3>\n" +
      "<p><strong>Respect</strong> – treating all well.</p>\n" +
      "<p><strong>Empathy</strong> – listening to others.</p>";

    expect(parseEditorial(line)?.[0]?.blocks[0]?.kind).toBe("prose");
    expect(parseEditorial(line + "\n" + grid)?.[0]?.blocks[0]?.kind).toBe("statement");
  });

  it("re-encodes a demoted statement rather than injecting its text raw", () => {
    const body = "<h3>Scope</h3>\n<p>Trade &amp; industry, 5 &lt; 6.</p>";
    const block = parseEditorial(body)?.[0]?.blocks[0];
    expect(block?.kind).toBe("prose");
    // Had the decoded text gone straight back into `dangerouslySetInnerHTML`,
    // the ampersand would have started an entity and `&lt;` would have become
    // a tag.
    expect(block?.kind === "prose" && block.html).toBe(
      "<p>Trade &amp; industry, 5 &lt; 6.</p>",
    );
  });
});

/**
 * The minutes page, which is why `documents` exists.
 *
 * Its body is thirty-nine `<ul>`s of a single `<li>` each, separated by
 * paragraphs holding nothing but a zero-width space. The shape below is three
 * of them, byte for byte as migration 0029 stores it.
 */
const MINUTES_BODY =
  "<h2>Minutes of Meeting</h2>\n" +
  '<ul>\n\t<li><a href="http://lcci.com.pk/minutes_2025/EC_15_07_2020.pdf">' +
  "<strong>Executive Committee Minutes Held on 15-07-20</strong></a></li>\n</ul>\n\n" +
  "<p><strong>​​</strong></p>\n\n" +
  '<ul>\n\t<li><a href="http://lcci.com.pk/minutes_2025/EC_12_09_2020.pdf">' +
  "<strong>Executive Committee Minutes Held on 12-09-20</strong></a></li>\n</ul>\n\n" +
  "<p><strong>​</strong></p>\n\n" +
  '<ul>\n\t<li><a href="http://lcci.com.pk/minutes_2025/EC_3-2-22.pdf">' +
  "<strong>Executive Committee Minutes Held on 03-02-22​<strong>​</strong></strong></a></li>\n</ul>";

describe("parseEditorial on a page of file links", () => {
  const sections = parseEditorial(MINUTES_BODY);

  it("merges consecutive one-item lists into a single block", () => {
    // The failure this is for: three lists of one bullet, with gaps.
    expect(sections).toHaveLength(1);
    expect(sections?.[0]?.blocks).toHaveLength(1);

    const block = sections?.[0]?.blocks[0];
    expect(block?.kind).toBe("documents");
    expect(block?.kind === "documents" && block.items).toHaveLength(3);
  });

  it("keeps each link's href and strips the emphasis off its label", () => {
    const block = sections?.[0]?.blocks[0];
    const items = block?.kind === "documents" ? block.items : [];

    expect(items[0]).toEqual({
      href: "http://lcci.com.pk/minutes_2025/EC_15_07_2020.pdf",
      label: "Executive Committee Minutes Held on 15-07-20",
    });
    // The last item nests a second `<strong>` around a zero-width space.
    // Both go, and the label is clean.
    expect(items[2]?.label).toBe("Executive Committee Minutes Held on 03-02-22");
  });

  it("renders every word of the source, in order", () => {
    expect(editorialWords(sections ?? []).flatMap(words)).toEqual(words(MINUTES_BODY));
  });

  /**
   * Text after the link is kept as the row's note, never dropped.
   *
   * This used to send the whole list to prose, which was the safe reading of
   * "a list item carrying a link *and* a sentence is a list, not a file" — and
   * it cost `/resources/banks` its layout over `(HBL)`. Keeping the text is
   * both safer and more useful: the words are rendered either way, and now
   * they are rendered in a row that says what they belong to.
   */
  it("keeps text after the link as the row's note", () => {
    const body =
      "<h2>Papers</h2>\n" +
      '<ul><li><a href="/a.pdf">The paper</a> — tabled in March</li></ul>';
    const block = parseEditorial(body)?.[0]?.blocks[0];
    expect(block?.kind).toBe("documents");
    expect(block?.kind === "documents" && block.items[0]).toEqual({
      href: "/a.pdf",
      label: "The paper",
      note: "— tabled in March",
    });
  });

  /** A second tag after the link is a row this has not understood. */
  it("declines a list item carrying a second link", () => {
    const body =
      "<h2>Papers</h2>\n" +
      '<ul><li><a href="/a.pdf">The paper</a> <a href="/b.pdf">and another</a></li></ul>';
    const block = parseEditorial(body)?.[0]?.blocks[0];
    expect(block?.kind).toBe("prose");
  });

  /**
   * An unfinished link is a row, not a reason to decline the list.
   *
   * `<a>Khaleej Time</a>` is the seventh of seven on
   * `/resources/newspapers-international`. Declining over it cost the other
   * six their layout and gained nothing: prose renders that anchor as plain
   * text too, because it has nowhere to go.
   */
  it("keeps a list item whose link has no href, as plain text", () => {
    const body =
      "<h2>Papers</h2>\n" +
      '<ul><li><a href="/a.pdf">The paper</a></li><li><a>Another</a></li></ul>';
    const block = parseEditorial(body)?.[0]?.blocks[0];
    expect(block?.kind).toBe("links");
    expect(block?.kind === "links" && block.items[1]).toEqual({ label: "Another" });
  });

  /** Where the links point decides the layout, not how they were typed. */
  it("reads a list of websites as a directory and a list of files as an archive", () => {
    const sites =
      "<h2>Banks</h2>\n" +
      '<ul><li><a href="http://a.example">A Bank</a></li>' +
      '<li><a href="http://b.example">B Bank</a></li></ul>';
    expect(parseEditorial(sites)?.[0]?.blocks[0]?.kind).toBe("links");

    const files =
      "<h2>Papers</h2>\n" +
      '<ul><li><a href="/a.pdf">A</a></li><li><a href="/b.pdf">B</a></li></ul>';
    expect(parseEditorial(files)?.[0]?.blocks[0]?.kind).toBe("documents");
  });
});

/**
 * A list inside a list.
 *
 * `/about/secretariat` has one, and the first version of `topLevelBlocks` used
 * a non-greedy regex that closed the outer `<ul>` at the inner list's
 * `</ul>`. Its own leftover check caught that and sent the whole page to
 * prose, so nothing was ever rendered wrong — but the page could not be laid
 * out at all until the scanner replaced the regex.
 */
describe("parseEditorial with nested blocks", () => {
  const body =
    "<h2>Research &amp; Development Department</h2>\n" +
    "<ul><li>Range of activities<ul><li>Policy Advocacy</li><li>Research Reports</li></ul></li></ul>\n" +
    "<p>Proposals are taken up with the relevant departments.</p>";

  it("does not mis-close the outer list", () => {
    const sections = parseEditorial(body);
    expect(sections).not.toBeNull();
    expect(sections?.[0]?.heading?.text).toBe("Research & Development Department");
  });

  it("renders every word of the source, in order", () => {
    expect(editorialWords(parseEditorial(body) ?? []).flatMap(words)).toEqual(words(body));
  });
});
