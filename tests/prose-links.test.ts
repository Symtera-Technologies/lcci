import { describe, expect, it } from "vitest";
import { withSafeOutboundLinks } from "@/components/site/prose";

/**
 * The one transform the public prose renderer applies.
 *
 * `src/content/sanitise.ts` allows `href` on an anchor and strips `target` and
 * `rel` deliberately, so that an editor pasting an outbound link does not have
 * to know to ask for `rel="noopener"`. That means the renderer *must* add it,
 * and that it must add it to links the editor never thought about — which is
 * exactly the kind of invisible obligation that rots quietly. Hence a test
 * file of its own.
 *
 * It is a regex over markup, which is only defensible because the input has
 * already been through `sanitize-html`: a 20-tag allowlist, anchors carrying
 * nothing but `href`, no comments, no CDATA, no unquoted attributes. Several
 * of the cases below assert the regex's *limits* rather than its successes, so
 * that the day somebody renders unsanitised HTML through this component, the
 * assumption it rests on is written down where they will find it.
 */

describe("withSafeOutboundLinks", () => {
  it("leaves prose with no links alone", () => {
    const html = "<p>The chamber has represented Lahore since 1923.</p>";
    expect(withSafeOutboundLinks(html)).toBe(html);
  });

  it("adds target and rel to an https link", () => {
    expect(withSafeOutboundLinks('<a href="https://example.pk">FBR</a>')).toBe(
      '<a href="https://example.pk" target="_blank" rel="noopener noreferrer">FBR</a>',
    );
  });

  it("adds them to an http link too", () => {
    // Still reachable: the legacy government sites this body links to are not
    // all on HTTPS, and an insecure outbound link needs `noopener` more, not
    // less.
    expect(withSafeOutboundLinks('<a href="http://example.pk">x</a>')).toContain(
      'rel="noopener noreferrer"',
    );
  });

  it("adds them to a protocol-relative link", () => {
    expect(withSafeOutboundLinks('<a href="//example.pk">x</a>')).toContain(
      'target="_blank"',
    );
  });

  it("matches the scheme case-insensitively", () => {
    expect(withSafeOutboundLinks('<a href="HTTPS://example.pk">x</a>')).toContain(
      'rel="noopener noreferrer"',
    );
  });

  /* ---------------------------------------------------------------------- */

  it("leaves a link to this site as it is", () => {
    const html = '<a href="/membership/apply">Apply</a>';
    expect(withSafeOutboundLinks(html)).toBe(html);
  });

  it("leaves a fragment and a query alone", () => {
    expect(withSafeOutboundLinks('<a href="#fees">Fees</a>')).toBe(
      '<a href="#fees">Fees</a>',
    );
    expect(withSafeOutboundLinks('<a href="?page=2">Next</a>')).toBe(
      '<a href="?page=2">Next</a>',
    );
  });

  it("leaves mailto and tel alone", () => {
    // Neither is a navigation, so neither has an opener to sever — and
    // `target="_blank"` on a `mailto:` leaves an empty tab behind in several
    // browsers.
    expect(withSafeOutboundLinks('<a href="mailto:info@lcci.org.pk">write</a>')).toBe(
      '<a href="mailto:info@lcci.org.pk">write</a>',
    );
    expect(withSafeOutboundLinks('<a href="tel:+92111222499">call</a>')).toBe(
      '<a href="tel:+92111222499">call</a>',
    );
  });

  /* ---------------------------------------------------------------------- */

  it("treats every link in a body independently", () => {
    const out = withSafeOutboundLinks(
      '<p>See <a href="https://example.pk">the notification</a> and ' +
        '<a href="/services/forms">our forms</a>.</p>',
    );

    expect(out).toContain('<a href="https://example.pk" target="_blank"');
    expect(out).toContain('<a href="/services/forms">our forms</a>');
    // Exactly one rel, so the internal link did not acquire one.
    expect(out.match(/rel=/g)).toHaveLength(1);
  });

  it("does not touch the closing tag or the link text", () => {
    const out = withSafeOutboundLinks(
      '<a href="https://example.pk">https://example.pk</a>',
    );
    expect(out.endsWith(">https://example.pk</a>")).toBe(true);
  });

  it("is idempotent on markup that already carries the attributes", () => {
    // It should not matter, because the sanitiser strips `target` and `rel` on
    // write — but a body migrated in from the legacy site, or hand-inserted by
    // a seed migration, could arrive with them. Running twice must not produce
    // two copies.
    const once = withSafeOutboundLinks('<a href="https://example.pk">x</a>');
    expect(withSafeOutboundLinks(once)).toBe(once);
  });

  /* ---------------------------------------------------------------------- */

  describe("the assumptions it rests on", () => {
    it("requires a double-quoted href", () => {
      // `sanitize-html` always emits double quotes. Unquoted or
      // single-quoted markup is therefore markup that did not come through the
      // write path, and this function silently does nothing to it — which is
      // the failure mode to know about, and the reason `Prose` documents that
      // it must only ever be handed a sanitised column.
      const html = "<a href='https://example.pk'>x</a>";
      expect(withSafeOutboundLinks(html)).toBe(html);
    });

    it("does not add anything twice to one anchor with two hrefs", () => {
      // Malformed, and unreachable through the sanitiser. Asserted so the
      // behaviour is known rather than discovered.
      const out = withSafeOutboundLinks(
        '<a href="https://a.example" href="https://b.example">x</a>',
      );
      expect(out.match(/target="_blank"/g)).toHaveLength(1);
    });
  });
});
