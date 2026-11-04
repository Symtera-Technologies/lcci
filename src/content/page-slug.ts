/**
 * The address a page's prose is published at, derived from the route it serves.
 *
 * `/about/history` is published at the slug `about-history`. One mechanical
 * rule, in one function, because the alternative is 48 hand-typed slugs and a
 * silent failure mode: a route whose slug does not match the row an editor
 * created renders a correct-looking page that is permanently empty, and
 * nothing in a build, a test or a log says so. There is no error to notice —
 * `getPage` returns null, which is also what "nobody has written this yet"
 * looks like.
 *
 * So the route does not get to choose. It passes its own path and the slug
 * follows, and the admin's help text on the slug field states the same rule in
 * words, so an editor creating a page from scratch arrives at the same answer.
 *
 * **The one collision to know about.** Flattening `/` to `-` means
 * `/about/past-leadership` and a hypothetical `/about/past/leadership` would
 * both be `about-past-leadership`. The IA has no such pair and
 * `tests/page-slug.test.ts` asserts that for every route in `PRIMARY_NAV`, so
 * adding one fails the suite rather than quietly pointing two pages at one
 * row. The fix, if it ever happens, is to pick a different label — not to
 * change the rule, which would orphan every row already published under it.
 */
export function pageSlug(path: `/${string}`): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");

  if (trimmed === "") {
    throw new Error(
      "pageSlug(\"/\") has no slug: the homepage is not a `page`. Its editable " +
        "content is the `hero` content type and its twelve section types.",
    );
  }

  return trimmed.replace(/\//g, "-");
}
