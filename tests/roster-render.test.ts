import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { RosterSections } from "@/components/site/roster-body";
import { parseRoster } from "@/content/roster";
import type { Portrait } from "@/content/types";

/**
 * The same assertion the build makes, against the actual rendered HTML.
 *
 * `tests/roster.test.ts` proves the *parser* keeps every word in order. This
 * proves the *card* does — and it exists because the first version did not.
 *
 * That card set the year above the name, as an eyebrow. It reads well, the
 * parser was perfectly happy, every parser test passed, and
 * `npm run verify:migration` then reported **352 missing runs of six words**
 * on `/about/past-leadership`: every one of them spanning a name and the year
 * printed beside it, because the markup had swapped the two. The failure
 * surfaced after a full build, as a message about migrated text rather than
 * about the component that reordered it.
 *
 * So the rule the roster has to live by is not "do not add words" — it is
 * **do not reorder them either**, and a layout choice as ordinary as where to
 * put a date can break it. This test is milliseconds; the build is minutes.
 */
function words(markup: string): string[] {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[� ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** `/about/past-leadership` as migration 0026 stores it, in miniature. */
const BODY =
  "<h2>Former Presidents</h2><p></p>\n\n" +
  "<h3>\nMr. Faheem ur Rehman Saigol</h3>\n\n     Year 2025-26\n" +
  "<p><strong>M/s Nasir &amp; Sons</strong>\nNo.1 S-49 R-24 , Pak Center , " +
  "Chamberlane Road LahoreTel: ---------------Fax: Mob: 03218463640</p>\n\n" +
  "<h3>\nMian Abuzar Shad </h3>\n\n     Year 2024-25\n" +
  "<p><strong>M/s Victoria Fabrics</strong>\nAbuzar Tower , Peco Road Lahore</p>\n\n" +
  "<h3>\nDr. A. Waheed</h3>\n\n<h3>Late</h3>\n\n" +
  "<h2>Former Senior Vice President</h2><p><strong>Year    Name</strong></p>\n\n" +
  "<p>2025-26    Mr. Tanveer Ahmed Sheikh</p>\n\n" +
  "<p>1969    Mr.A.Majid Mufti  (Late)</p>";

/**
 * One portrait, for the name it belongs to, and nothing for the others.
 *
 * Both paths matter: a card with a photograph and a card with the initial
 * placeholder have to render the same words, and the placeholder is the one
 * that could plausibly put a letter into the text.
 */
const PORTRAITS = new Map<string, Portrait>([
  [
    "faheem-ur-rehman-saigol",
    {
      slug: "mr-faheem-ur-rehman-saigol",
      nameEn: "Mr. Faheem ur Rehman Saigol",
      photo: {
        src: "/people/mr-faheem-ur-rehman-saigol.jpg",
        altEn: "Portrait of Mr. Faheem ur Rehman Saigol.",
        width: 480,
        height: 600,
      },
    },
  ],
]);

const sections = parseRoster(BODY);
const rendered = renderToStaticMarkup(
  createElement(RosterSections, { sections: sections ?? [], portraits: PORTRAITS }),
);

describe("the rendered roster", () => {
  it("parsed the body at all", () => {
    // Without this the test below passes trivially on an empty render.
    expect(sections).not.toBeNull();
  });

  it("contains every six-word run from the stored body", () => {
    const page = words(rendered).join(" ");
    const source = words(BODY);

    const missing: string[] = [];
    for (let i = 0; i + 6 <= source.length; i += 1) {
      const run = source.slice(i, i + 6).join(" ");
      if (!page.includes(run)) missing.push(run);
    }

    expect(missing).toEqual([]);
    expect(source.length).toBeGreaterThan(50);
  });

  it("renders the words in exactly the source's order", () => {
    // Stricter than the six-word rule and the thing that actually broke:
    // nothing added, nothing dropped, nothing moved.
    expect(words(rendered)).toEqual(words(BODY));
  });

  it("puts a photograph beside the name that has one", () => {
    // The file, not a whole path: `next/image` rewrites the `src` through
    // `/_next/image` here because the test environment does not read
    // `next.config.ts`, where `images.unoptimized` turns that off. The
    // filename survives either way, URL-encoded or not.
    expect(rendered).toContain("mr-faheem-ur-rehman-saigol.jpg");
    expect(rendered).toContain('alt="Portrait of Mr. Faheem ur Rehman Saigol."');
  });

  it("keeps the placeholder initial out of the text", () => {
    // Three names, one photograph. The other two get an initial in the same
    // frame, drawn by CSS from `data-initial` — because a "D" in the markup
    // is a word, and it would sit between two of the chamber's.
    expect(rendered).toContain('data-initial="D"');
    expect(words(rendered)).not.toContain("D");
  });

  it("sets the former vice presidents as a table with the source's headings", () => {
    expect(rendered).toContain("<table");
    expect(rendered).toContain("<th");
    expect(rendered).toContain("Year");
    expect(rendered).toContain("Mr.A.Majid Mufti (Late)");
  });
});
