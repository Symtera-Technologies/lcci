import { describe, expect, it } from "vitest";
import { bodyToText, sanitiseBody } from "@/content/sanitise";

/**
 * The one injection sink on the public site, and what closes it.
 *
 * The public CSP carries `script-src 'unsafe-inline'` because the App Router
 * emits per-page inline bootstraps and the site has to stay statically
 * generated. That directive is only defensible while nothing on a public page
 * renders markup a person supplied — and a rich-text body is exactly that. So
 * these are not tidying tests. Each one is a way the chamber's own newsroom
 * could be used to run script on a member's browser, under LCCI's domain, with
 * LCCI's session cookie in scope.
 *
 * Sanitising happens on **write**, so these assertions are about what reaches
 * the database, not about what a renderer chooses to do with it.
 */

describe("sanitiseBody", () => {
  it("keeps the markup a press release is actually written in", () => {
    const html =
      "<p>The chamber <strong>welcomed</strong> the decision.</p>" +
      "<h2>Background</h2><ul><li>One</li><li>Two</li></ul>";
    expect(sanitiseBody(html)).toBe(html);
  });

  it("drops a script tag and its contents, not just the tag", () => {
    const cleaned = sanitiseBody("<p>Before</p><script>alert(1)</script><p>After</p>");
    expect(cleaned).toBe("<p>Before</p><p>After</p>");
    // The text inside a script tag is code. Keeping it would put `alert(1)`
    // into a paragraph, which is worse than dropping it.
    expect(cleaned).not.toContain("alert");
  });

  it("strips an event handler attribute while keeping the element", () => {
    expect(sanitiseBody('<p onclick="steal()">Read this</p>')).toBe("<p>Read this</p>");
  });

  it("refuses a javascript: link", () => {
    const cleaned = sanitiseBody('<p><a href="javascript:alert(1)">Click</a></p>');
    expect(cleaned).not.toContain("javascript:");
    expect(bodyToText(cleaned)).toBe("Click");
  });

  it("refuses a data: URI link", () => {
    const cleaned = sanitiseBody('<p><a href="data:text/html,<script>alert(1)</script>">x</a></p>');
    expect(cleaned).not.toContain("data:");
  });

  it("keeps an ordinary external link but not the editor's target or rel", () => {
    // `target` and `rel` are the renderer's to set, so every external link
    // gets `rel="noopener"` whether or not whoever pasted it knew to ask.
    const cleaned = sanitiseBody(
      '<p><a href="https://www.sbp.org.pk" target="_blank" rel="opener">SBP</a></p>',
    );
    expect(cleaned).toBe('<p><a href="https://www.sbp.org.pk">SBP</a></p>');
  });

  it("keeps a relative link to the chamber's own pages", () => {
    expect(sanitiseBody('<p><a href="/news/circulars">Circulars</a></p>')).toBe(
      '<p><a href="/news/circulars">Circulars</a></p>',
    );
  });

  it("drops an iframe with its contents", () => {
    const cleaned = sanitiseBody('<p>A</p><iframe src="https://evil.test"></iframe>');
    expect(cleaned).toBe("<p>A</p>");
  });

  /**
   * A form on a page a member trusts is a phishing page with LCCI's
   * letterhead on it.
   */
  it("drops a form and its fields", () => {
    const cleaned = sanitiseBody(
      '<p>Sign in</p><form action="https://evil.test"><input name="password"></form>',
    );
    expect(cleaned).toBe("<p>Sign in</p>");
  });

  it("drops an image rather than letting one in without alt text", () => {
    // Editorial images go through `media_assets`, where `alt_en` is NOT NULL.
    // An `<img>` pasted into a body is how an undescribed photograph gets onto
    // the site.
    expect(sanitiseBody('<p>A</p><img src="/photos/hero-1.jpg">')).toBe("<p>A</p>");
  });

  it("removes inline styles and classes pasted from a word processor", () => {
    const cleaned = sanitiseBody(
      '<p class="MsoNormal" style="color:#ff0000;font-size:48px">Pasted</p>',
    );
    expect(cleaned).toBe("<p>Pasted</p>");
  });

  it("unwraps an unknown tag and keeps its text", () => {
    expect(sanitiseBody("<p>A <o:p>pasted</o:p> word</p>")).toBe("<p>A pasted word</p>");
  });

  it("refuses an h1, because the page supplies it", () => {
    // A body that can introduce a second `h1` breaks the document outline for
    // anyone navigating by heading.
    const cleaned = sanitiseBody("<h1>Headline</h1><p>Body</p>");
    expect(cleaned).not.toContain("<h1");
    expect(bodyToText(cleaned)).toBe("Headline Body");
  });

  it("keeps table semantics and drops table decoration", () => {
    const cleaned = sanitiseBody(
      '<table bgcolor="red"><tr><th scope="col" width="200">Year</th>' +
        '<td colspan="2">2026</td></tr></table>',
    );
    expect(cleaned).toContain('scope="col"');
    expect(cleaned).toContain('colspan="2"');
    expect(cleaned).not.toContain("bgcolor");
    expect(cleaned).not.toContain("width");
  });

  it("drops an HTML comment", () => {
    const cleaned = sanitiseBody("<p>A</p><!-- not for publication: check with legal -->");
    expect(cleaned).toBe("<p>A</p>");
  });

  it("returns null for an empty body rather than an empty paragraph", () => {
    // `<p></p>` renders as a blank paragraph with margins, which is what an
    // editor who selected-all and deleted leaves behind.
    expect(sanitiseBody("")).toBeNull();
    expect(sanitiseBody("   ")).toBeNull();
    expect(sanitiseBody("<p></p>")).toBeNull();
    expect(sanitiseBody("<p>&nbsp;</p>")).toBeNull();
    expect(sanitiseBody(null)).toBeNull();
    expect(sanitiseBody(undefined)).toBeNull();
  });

  it("returns null for a body that was nothing but a script", () => {
    expect(sanitiseBody("<script>alert(1)</script>")).toBeNull();
  });

  it("is idempotent, so a re-save cannot degrade a stored body", () => {
    const once = sanitiseBody('<p>A <a href="https://x.test" onclick="y()">link</a></p>');
    expect(sanitiseBody(once)).toBe(once);
  });

  /**
   * The browsers' own tags, which are not optional to support.
   *
   * A `contenteditable` surface emits `<b>` or `<strong>` and `<i>` or `<em>`
   * depending on the browser, and a paste from Word brings `<b>`, `<i>` and a
   * `<div>` per line. Dropping them keeps the words and loses the emphasis and
   * the paragraph breaks, which looks like the editor's formatting being
   * thrown away — because it is.
   */
  it("maps the tags an editor and a paste actually produce", () => {
    expect(sanitiseBody("<p>The chamber <b>welcomed</b> the <i>interim</i> decision.</p>")).toBe(
      "<p>The chamber <strong>welcomed</strong> the <em>interim</em> decision.</p>",
    );
    expect(sanitiseBody("<div>One line</div><div>Another line</div>")).toBe(
      "<p>One line</p><p>Another line</p>",
    );
  });

  it("stays idempotent across the tag mapping", () => {
    // The mapped output must itself be a fixed point, or the second save of a
    // body would differ from the first and every re-save would look like an
    // edit in the audit log.
    const once = sanitiseBody("<div>A <b>bold</b> claim</div>");
    expect(sanitiseBody(once)).toBe(once);
  });

  it("leaves Urdu text intact", () => {
    const urdu = "<p>لاہور چیمبر آف کامرس اینڈ انڈسٹری</p>";
    expect(sanitiseBody(urdu)).toBe(urdu);
  });
});

describe("bodyToText", () => {
  it("counts the reading length, not the markup length", () => {
    // A "too long" message has to be counting what the editor wrote, or it
    // reports a 400-word release as over the limit because of its tags.
    expect(bodyToText("<p><strong>Four</strong> words right here</p>")).toBe(
      "Four words right here",
    );
  });

  it("collapses whitespace across block boundaries", () => {
    expect(bodyToText("<p>One</p>\n\n<p>Two</p>")).toBe("One Two");
  });

  it("decodes entities so a quotation is one character, not six", () => {
    expect(bodyToText("<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry");
    expect(bodyToText("<p>a &lt; b &gt; c</p>")).toBe("a < b > c");
  });

  /**
   * Decodes one level, never two.
   *
   * An editor writing *about* the ampersand entity types `&amp;amp;`, which
   * reads as the literal text `&amp;`. A decoder that re-scanned its own
   * output would quietly turn that into `&` and change what the release says.
   */
  it("does not decode an entity it just produced", () => {
    expect(bodyToText("<p>the &amp;amp; entity</p>")).toBe("the &amp; entity");
  });

  it("keeps a heading and the paragraph after it as separate words", () => {
    expect(bodyToText("<h2>Energy</h2><p>The chamber asked.</p>")).toBe(
      "Energy The chamber asked.",
    );
    expect(bodyToText("<ul><li>One</li><li>Two</li></ul>")).toBe("One Two");
  });

  it("does not split a word that contains an inline tag", () => {
    expect(bodyToText("<p>un<em>believable</em></p>")).toBe("unbelievable");
  });

  it("is empty for nothing", () => {
    expect(bodyToText(null)).toBe("");
    expect(bodyToText("")).toBe("");
  });
});
