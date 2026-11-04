import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { EditorialBody } from "@/components/site/editorial-body";

/**
 * The same assertion the build makes, against the actual rendered HTML.
 *
 * `tests/editorial.test.ts` proves the *parser* keeps every word. This proves
 * the *renderer* does — that no component between the parse and the page adds
 * a label, an ordinal or a visually-hidden hint that lands between two words
 * of somebody's sentence and breaks the six-word run spanning them.
 *
 * That is not a theoretical risk. The numbered grid wants `01` beside each
 * mission statement and the obvious way to write it is a `<span>`; the whole
 * reason it is a CSS counter is this check. A test that only exercised the
 * parser would have passed on the `<span>` version and the failure would have
 * surfaced as `npm run verify:migration` reporting migrated text as lost,
 * after a full build, pointing at the migration rather than at the markup.
 */
function words(markup: string): string[] {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ � ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** `/about/history` as migration 0026 stores it. */
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
  "<p> </p>\n\n" +
  "<p><strong>Respect</strong> – Treating all well and work with courtesy and respect, the way you want to be treated.</p>\n\n" +
  "<p><strong>Empathy</strong> – Listening and understanding the feelings and ideas of others.</p>\n\n" +
  "<p><strong>Shared Responsibility</strong> – taking ownership and working as a team through collaboration among all stakeholders.</p>\n\n" +
  "<p><strong>Consistency </strong>– being consistent in mastering and maintaining standards in services and overall the image of the institution.</p>\n\n" +
  "<p><strong>Innovation</strong> – constant creativity in Research, Development and services for value addition and exceeding expectations of members, stakeholders and employees</p>";

const rendered = renderToStaticMarkup(createElement(EditorialBody, { html: HISTORY_BODY }));

describe("the rendered /about/history body", () => {
  it("contains every six-word run from the stored body", () => {
    const page = words(rendered).join(" ");
    const source = words(HISTORY_BODY);

    const missing: string[] = [];
    for (let i = 0; i + 6 <= source.length; i += 1) {
      const run = source.slice(i, i + 6).join(" ");
      if (!page.includes(run)) missing.push(run);
    }

    expect(missing).toEqual([]);
    // Guards against the test passing because `source` came out empty.
    expect(source.length).toBeGreaterThan(150);
  });

  it("writes no ordinals into the markup", () => {
    // The numbers are a CSS counter. If one ever appears here, it is sitting
    // between two words of a sentence.
    expect(rendered).not.toMatch(/>0[1-9]</);
  });

  it("keeps the document outline: h2, then h3s, then h4s inside them", () => {
    const levels = [...rendered.matchAll(/<h([234])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(2);
    expect(levels.filter((l) => l === 3)).toHaveLength(3);
    // Five values, each a card heading under "Our Values".
    expect(levels.filter((l) => l === 4)).toHaveLength(5);
    // No level is skipped on the way down.
    for (let i = 1; i < levels.length; i += 1) {
      expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    }
  });

  it("renders the five mission statements as one ordered list", () => {
    expect([...rendered.matchAll(/<ol\b/g)]).toHaveLength(1);
    const ol = /<ol[\s\S]*?<\/ol>/.exec(rendered)?.[0] ?? "";
    expect([...ol.matchAll(/<li\b/g)]).toHaveLength(5);
    expect(ol).toContain("step-ordinal");
  });

  it("keeps each value's dash between its term and its meaning", () => {
    const page = words(rendered).join(" ");
    for (const term of ["Respect", "Empathy", "Consistency", "Innovation"]) {
      expect(page).toContain(`${term} –`);
    }
  });

  it("falls back to prose for a body it does not recognise", () => {
    const prose = "<p>One short paragraph, and nothing with a shape.</p>";
    const out = renderToStaticMarkup(createElement(EditorialBody, { html: prose }));
    expect(out).toContain("prose-site");
    expect(out).not.toContain("step-ordinal");
  });
});
