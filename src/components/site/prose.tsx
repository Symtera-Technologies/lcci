import { cn } from "@/lib/cn";

/**
 * Editorial body copy, rendered from the sanitised HTML the CMS stores.
 *
 * `dangerouslySetInnerHTML` is used here on purpose, and what makes it safe is
 * that the markup was sanitised on **write** — see `src/content/sanitise.ts`
 * and the note in `migrations/0018_content_body.sql`. Sanitising on write
 * rather than on render means a render path that forgot cannot produce an
 * unsanitised page, and means the stored bytes are the audited bytes. This
 * component therefore never sanitises; it must only ever be handed a column
 * that went through the write path.
 *
 * **It does one transform, and it is a security one.** The sanitiser allows
 * `href` on an anchor and strips `target` and `rel`, deliberately, because
 * those are the renderer's to set — an editor pasting an outbound link should
 * not have to know to ask for `rel="noopener"`. So that is added here, to
 * every link that leaves the site, whether or not whoever pasted it knew.
 *
 * The typography is `prose-site`, which is `prose-editor` plus the sizes a
 * full-width page wants. Those two have to stay in step: the editor's surface
 * is a promise about what the page will look like, and an editor who styles a
 * heading in a box that renders differently has been misled.
 */

/**
 * Add `rel="noopener noreferrer"` and `target="_blank"` to outbound anchors.
 *
 * A regex over markup, which is normally the wrong tool — and is the right one
 * here for a narrow reason: this input is not arbitrary HTML. It has already
 * been through `sanitize-html`, so every tag is from a 20-tag allowlist, an
 * anchor carries nothing but `href`, and there are no comments, no CDATA and
 * no unquoted attributes left for a regex to misread. Parsing it a second time
 * to add two attributes would mean a DOM implementation on the render path of
 * every page.
 *
 * Matched on the opening `<a` tag only, and only where the href starts with a
 * scheme or `//`. A relative href is this site; `mailto:` and `tel:` are not
 * navigations and get nothing.
 *
 * The whole opening tag is captured rather than just its `href`, for one
 * reason: an anchor that already carries a `rel` is left exactly as it is. The
 * sanitiser strips `rel` on write, so that cannot happen through the editor —
 * but a body pasted in by a seed migration or imported from the legacy site
 * can arrive with one, and appending a second `rel` would produce markup whose
 * meaning depends on which copy the browser reads first.
 */
function withSafeOutboundLinks(html: string): string {
  return html.replace(
    /<a\s+href="([^"]*)"([^>]*)>/gi,
    (whole, href: string, rest: string) => {
      const isOutbound = /^(https?:)?\/\//i.test(href);
      if (!isOutbound) return whole;
      if (/\brel=/i.test(rest)) return whole;

      return `<a href="${href}"${rest} target="_blank" rel="noopener noreferrer">`;
    },
  );
}

export function Prose({
  html,
  className,
}: {
  /** Sanitised HTML from the CMS. Never user input from a request. */
  html: string;
  className?: string;
}) {
  return (
    <div
      className={cn("prose-site", className)}
      dangerouslySetInnerHTML={{ __html: withSafeOutboundLinks(html) }}
    />
  );
}

export { withSafeOutboundLinks };
