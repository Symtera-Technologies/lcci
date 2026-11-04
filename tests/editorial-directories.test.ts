import { describe, expect, it } from "vitest";
import { editorialWords, parseEditorial } from "@/content/editorial";

/**
 * The shapes the sixteen Resources pages are written in.
 *
 * `tests/editorial.test.ts` covers the shapes `/about/history` and
 * `/about/minutes` have — statements, named values, a list of files. This
 * file covers the ones the reference lists have, which are different in kind:
 * a directory of organisations with their addresses, a two-column table of
 * name and website typed inside three nested tables, a bolded paragraph used
 * as a sub-heading, and a list of short plain items.
 *
 * Every one of them gets the same closing assertion — **the rendered word
 * sequence equals the source's, exactly** — because that is the rule the whole
 * feature lives under. `scripts/verify-migrated-text.ts` enforces it on the
 * built site, minutes after a full build, with a message about migrated text
 * rather than about the layout that ate it. These run in milliseconds.
 *
 * `words` is the verifier's own normalisation, copied rather than imported for
 * the reason given where it is copied from: the verifier is a script outside
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

/** Every word the parse will render, flattened the way the verifier reads it. */
function rendered(html: string): string[] {
  return editorialWords(parseEditorial(html) ?? []).flatMap(words);
}

/* -------------------------------------------------------------------------- */
/* A directory of organisations                                               */
/* -------------------------------------------------------------------------- */

/**
 * `/resources/hospitals-lahore`, in miniature and in its own spelling.
 *
 * Two entries in the ordinary shape — the name alone in a bolded paragraph,
 * the address in the paragraph after it — and a third in the shape that broke
 * the first version of this parser, where the whole entry is one paragraph
 * with the name on its first line. Three of the twenty-four real entries are
 * written that way, and each one ended the run and sent the remainder of the
 * page back to prose: twenty-four hospitals became three cards and thirteen
 * paragraphs.
 */
const HOSPITALS =
  "<h2>Hospitals in Lahore</h2>" +
  "<p><strong>Ammar Medical Complex Lahore</strong></p>\n\n" +
  "<p><strong>Address: </strong><strong>8 Haroon Shah Scheme, Main Jail Road Lahore</strong><br />\n" +
  "<strong>Phone: +92-302-8428007, Fax: 042-35754810</strong><br />\n" +
  '<strong>Web: <a href="http://www.ammarcomplex.com/">www.ammarcomplex.com</a> </strong></p>\n\n' +
  "<hr />\n" +
  "<p><em><strong>Mian Muhammad Munshi Hospital</strong></em></p>\n\n" +
  "<p>Address: Fane Road, Lahore<br />\nTelephone: 042-37229704</p>\n\n" +
  "<hr />\n" +
  "<p><strong>Omar Hospital &amp; Cardiac Center<br />\n" +
  "Address: Jail road, Near Kinniard College, Lahore, Pakistan<br />\n" +
  "Phone: 042-111-222-333</strong></p>";

describe("parseEditorial on a directory of named entries", () => {
  const block = parseEditorial(HOSPITALS)?.[0]?.blocks[0];

  it("reads the whole run as one block of entries", () => {
    expect(block?.kind).toBe("contacts");
    expect(block?.kind === "contacts" && block.items).toHaveLength(3);
  });

  it("lifts the name out of the entry, however it was typed", () => {
    const items = block?.kind === "contacts" ? block.items : [];
    expect(items.map((item) => item.name)).toEqual([
      "Ammar Medical Complex Lahore",
      // `<em><strong>`: the same entry, by somebody who hit both buttons.
      "Mian Muhammad Munshi Hospital",
      // The whole entry in one paragraph, name read off the first line.
      "Omar Hospital & Cardiac Center",
    ]);
  });

  it("renders every word of the source, in order", () => {
    expect(rendered(HOSPITALS)).toEqual(words(HOSPITALS));
  });

  /** One rule between two paragraphs is a page break, not a directory. */
  it("declines a single entry", () => {
    const body = "<h2>One</h2><p><strong>A Hospital</strong></p>\n<p>Address: somewhere</p>";
    expect(parseEditorial(body)?.[0]?.blocks[0]?.kind).not.toBe("contacts");
  });

  /** `/resources/hospitals-pakistan` wraps the same entries one per item. */
  it("reads the same entries wrapped one per list item", () => {
    const body =
      "<h2>Hospitals</h2>" +
      "<ol>\n<li>\n<p><strong>Al-Shifa Trust Eye Hospital</strong></p>\n\n" +
      "<p>Address: Rawalpindi<br />\nPhone: 051-5487820</p>\n\n<p>&nbsp;</p>\n</li>\n" +
      "<li>\n<p><strong>Bait Ul Sukoon Cancer Hospital</strong></p>\n\n" +
      "<p>Address: Karachi</p>\n</li>\n</ol>";

    expect(parseEditorial(body)?.[0]?.blocks[0]?.kind).toBe("contacts");
    expect(rendered(body)).toEqual(words(body));
  });
});

/* -------------------------------------------------------------------------- */
/* A directory laid out as nested tables                                      */
/* -------------------------------------------------------------------------- */

/**
 * `/resources/airlines`: a table inside a table, most cells holding a bulleted
 * list of exactly one item.
 *
 * The words are a two-column directory. The markup is what a word processor
 * produced when somebody pasted one in 2014, and rendered as written it is
 * three nested boxes of single-item bullet lists.
 */
const AIRLINES =
  "<h2>Airlines</h2><table>\n\t<tbody>\n\t\t<tr>\n\t\t</tr>\n\t\t<tr>\n\t\t\t<td>\n" +
  "\t\t\t<table>\n\t\t\t\t<tbody>\n\t\t\t\t\t<tr>\n\t\t\t\t\t\t<td>\n\t\t\t\t\t\t<ul>\n" +
  '\t\t\t\t\t\t\t<li><strong><a href="http://www.etihadairways.com">Etihad Airways</a></strong></li>\n' +
  "\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t</td>\n" +
  '\t\t\t\t\t\t<td><a href="http://www.etihadairways.com">www.etihadairways.com</a></td>\n' +
  "\t\t\t\t\t</tr>\n\t\t\t\t\t<tr>\n\t\t\t\t\t\t<td>\n\t\t\t\t\t\t<ul>\n" +
  '\t\t\t\t\t\t\t<li><strong><a href="http://www.thy.com">Turkish Airlines </a></strong></li>\n' +
  "\t\t\t\t\t\t</ul>\n\t\t\t\t\t\t</td>\n" +
  '\t\t\t\t\t\t<td><a href="http://www.thy.com">www.thy.com</a></td>\n' +
  "\t\t\t\t\t</tr>\n\t\t\t\t</tbody>\n\t\t\t</table>\n\t\t\t</td>\n\t\t</tr>\n\t</tbody>\n</table>";

describe("parseEditorial on a directory laid out as nested tables", () => {
  const block = parseEditorial(AIRLINES)?.[0]?.blocks[0];

  it("flattens the rows to links, keeping the second column as the note", () => {
    expect(block?.kind).toBe("links");
    expect(block?.kind === "links" && block.items).toEqual([
      {
        href: "http://www.etihadairways.com",
        label: "Etihad Airways",
        note: "www.etihadairways.com",
      },
      { href: "http://www.thy.com", label: "Turkish Airlines", note: "www.thy.com" },
    ]);
  });

  it("renders every word of the source, in order", () => {
    expect(rendered(AIRLINES)).toEqual(words(AIRLINES));
  });

  /**
   * The guard that makes flattening safe at all.
   *
   * A third column nobody noticed would be dropped silently by a flatten that
   * only read the first two. Instead the result is compared word for word
   * against the table it came from and any difference sends the whole thing to
   * prose — the same property `parseRoster` has, for the same reason.
   */
  it("declines a table carrying a cell it did not read", () => {
    const body = AIRLINES.replace(
      '<td><a href="http://www.thy.com">www.thy.com</a></td>',
      '<td><a href="http://www.thy.com">www.thy.com</a></td><td>Daily</td>',
    );
    expect(parseEditorial(body)?.[0]?.blocks[0]?.kind).not.toBe("links");
  });

  /** `/resources/international-links` puts its heading in the first row. */
  it("keeps a heading row the table carried, above the rows", () => {
    const body = AIRLINES.replace(
      "<tbody>\n\t\t<tr>\n\t\t</tr>",
      "<tbody>\n\t\t<tr>\n\t\t\t<td><strong>International Airlines</strong></td>\n\t\t</tr>",
    );
    const first = parseEditorial(body)?.[0]?.blocks[0];

    expect(first?.kind === "links" && first.caption).toBe("International Airlines");
    expect(rendered(body)).toEqual(words(body));
  });
});

/* -------------------------------------------------------------------------- */
/* Bolded sub-headings and lists of short plain items                         */
/* -------------------------------------------------------------------------- */

describe("parseEditorial on bolded sub-headings and short plain lists", () => {
  const body =
    "<h2>Benefits</h2>" +
    "<p><strong>One window services</strong></p>\n\n" +
    "<ul>\n\t<li>Passport</li>\n\t<li>Lahore Traffic Police (Driving License)</li>\n" +
    "\t<li>Federal of Board of Revenue (FBR)</li>\n</ul>";
  const sections = parseEditorial(body);

  it("sets a bolded paragraph as the sub-heading it was being used as", () => {
    expect(sections?.[0]?.blocks[0]?.kind).toBe("label");
  });

  it("sets a run of short plain items in columns", () => {
    const block = sections?.[0]?.blocks[1];
    expect(block?.kind).toBe("facts");
    expect(block?.kind === "facts" && block.items).toHaveLength(3);
  });

  it("renders every word of the source, in order", () => {
    expect(rendered(body)).toEqual(words(body));
  });

  /** Past ninety characters a list item is a sentence, and needs a column. */
  it("declines a list whose items are sentences", () => {
    const long =
      "<h2>Benefits</h2><ul>" +
      "<li>Members may apply for a certificate of origin at the counter on any " +
      "working day between nine in the morning and four in the afternoon.</li>" +
      "<li>Short one</li><li>Short two</li></ul>";
    expect(parseEditorial(long)?.[0]?.blocks[0]?.kind).not.toBe("facts");
  });

  /** Two items are a pair. Columns need enough rows to be worth the eye's trip. */
  it("declines a list of two", () => {
    const pair = "<h2>Benefits</h2><ul><li>Passport</li><li>Driving licence</li></ul>";
    expect(parseEditorial(pair)?.[0]?.blocks[0]?.kind).not.toBe("facts");
  });

  /** A bolded phrase with a sentence after it is a sentence, not a heading. */
  it("declines a bolded paragraph that carries more than the phrase", () => {
    const body2 = "<h2>Benefits</h2><p><strong>Note:</strong> the counter shuts at four.</p>";
    expect(parseEditorial(body2)?.[0]?.blocks[0]?.kind).not.toBe("label");
  });
});

/* -------------------------------------------------------------------------- */
/* What counts as a claim                                                     */
/* -------------------------------------------------------------------------- */

describe("parseEditorial on short paragraphs that are not claims", () => {
  /**
   * The failure this is for, from `/trade/exhibitions`.
   *
   * Under "Participation Fee" are two paragraphs: "Rs. 500,000" and "Last
   * Date: 23rd October, 2026". Short, plain and side by side, which was the
   * whole of the old test — so they came out as a numbered grid reading
   * **01** Rs. 500,000, **02** Last Date. That asserts an enumeration the
   * chamber never wrote and makes a fee and a deadline look like two steps of
   * a procedure.
   */
  it("does not number a fee and a date", () => {
    const body =
      "<h3>Participation Fee</h3><p>Rs. 500,000</p><p>Last Date: 23rd October, 2026</p>";
    expect(parseEditorial(body)?.[0]?.blocks[0]?.kind).toBe("prose");
  });

  /** A fragment set at display size reads as a pull-quote for a list of sectors. */
  it("does not set a fragment as a statement", () => {
    const body =
      "<h3>Service Providers in Focus</h3>" +
      "<p>Tour Operators, Travel Agents, Airlines, Hospitality and associated Industry</p>";
    expect(parseEditorial(body)?.[0]?.blocks[0]?.kind).toBe("prose");
  });

  /** And the layout this was all built for is untouched. */
  it("still numbers a run of three or more sentences", () => {
    const body =
      "<h3>Our Mission</h3>" +
      "<p>To be the finest organization to serve the business community of Pakistan.</p>" +
      "<p>To be a bridge between the business community and the regulatory bodies.</p>" +
      "<p>To seek long term relations with members reflecting fairness and honesty.</p>";
    const block = parseEditorial(body)?.[0]?.blocks[0];

    expect(block?.kind).toBe("statements");
    expect(rendered(body)).toEqual(words(body));
  });
});

/* -------------------------------------------------------------------------- */
/* Debris                                                                     */
/* -------------------------------------------------------------------------- */

describe("parseEditorial on editor debris", () => {
  /**
   * `<h2>&nbsp;</h2>` sits between two real headings on `/trade/exhibitions`.
   *
   * Six characters of markup and no words, so the first version of the
   * emptiness test — run against the markup rather than against the decoded
   * text — let it through. It rendered as a heading with nothing in it, and it
   * closed the section above it, which is the part that actually broke the
   * page: the exhibition it belonged to lost its last paragraphs to a section
   * with no name.
   */
  /**
   * `/trade/humanitarian-appeals` is eighteen tables deep.
   *
   * Each appeal is an email somebody pasted in, and the mail client wrote the
   * letter inside a table, inside a table, inside a table. None of them is
   * tabular — every row has one cell — so the page rendered as a set of boxes
   * nested three deep with a paragraph at the bottom of them.
   */
  it("unwraps a table that is only a box drawn around something else", () => {
    const body =
      "<h2>Appeals</h2><table>\n\t<tbody>\n\t\t<tr>\n\t\t\t<td>\n\t\t\t<table>\n\t\t\t\t<tbody>\n" +
      "\t\t\t\t\t<tr>\n\t\t\t\t\t\t<td>\n\t\t\t\t\t\t<p>Dear Sir/Madam, we are reaching out on " +
      "behalf of a charity that treats patients who cannot pay for care.</p>\n" +
      "\t\t\t\t\t\t</td>\n\t\t\t\t\t</tr>\n\t\t\t\t</tbody>\n\t\t\t</table>\n\t\t\t</td>\n" +
      "\t\t</tr>\n\t</tbody>\n</table>";
    const block = parseEditorial(body)?.[0]?.blocks[0];

    expect(block?.kind).toBe("prose");
    expect(block?.kind === "prose" && block.html).not.toContain("<table");
    expect(rendered(body)).toEqual(words(body));
  });

  /**
   * Two cells with words in them is a table with columns, and a column is a
   * relationship between two values. The fee schedules on `/services/training`
   * and the advertisement tariff on `/about/secretariat` are kept by this.
   */
  it("keeps a table that has columns", () => {
    const body =
      "<h2>Tariff</h2><table><tbody>" +
      "<tr><td>Half Page 13 cm X 18 cm</td><td>Rs. 30,000/=</td></tr>" +
      "<tr><td>Full Page 26 cm x 18 cm</td><td>Rs. 50,000/=</td></tr>" +
      "</tbody></table>";
    const block = parseEditorial(body)?.[0]?.blocks[0];

    expect(block?.kind).toBe("prose");
    expect(block?.kind === "prose" && block.html).toContain("<table");
  });

  it("drops a heading that decodes to nothing", () => {
    const body =
      "<h2>ITB Berlin</h2><p>The largest travel trade show in Europe.</p>" +
      "<h2>&nbsp;</h2><p>The last date for applications is 23rd October.</p>";
    const sections = parseEditorial(body);

    expect(sections?.map((section) => section.heading?.text)).toEqual(["ITB Berlin"]);
    expect(rendered(body)).toEqual(words(body));
  });
});
