import { LEGACY_REDIRECTS } from "./legacy-redirects";

const PRESS_PREFIX = "/news/press-releases/";

/**
 * The slugs the legacy press archive was imported under.
 *
 * Derived from the 301 table's own destinations rather than listed, so it
 * cannot drift from where the redirects actually point.
 *
 * ## What it is for
 *
 * 686 of the 699 imported releases are drafts with no publication date,
 * because `press.php` prints no date and none was invented. Their slugs exist,
 * their redirects point at them, and `getPressRelease` correctly refuses to
 * serve a draft — so an inbound link to `press.php?id=1` would answer 308 and
 * then 404 at the destination.
 *
 * That chain is worse than the plain 404 it replaced. A crawler following a
 * permanent redirect to a Not Found page treats the destination as a soft 404
 * and drops the original URL *along with* the ranking the redirect existed to
 * transfer. So a known-but-unpublished slug is sent on to the archive index
 * instead: two hops, both resolving, and the visitor lands among press
 * releases, which is what they clicked a press link for.
 *
 * **It stops mattering the day the archive is published.** One `UPDATE` with
 * LCCI's dates turns the middle hop into a 200 and nothing here has to change.
 */
const ARCHIVE_SLUGS: ReadonlySet<string> = new Set(
  Object.values(LEGACY_REDIRECTS)
    .filter((to) => to.startsWith(PRESS_PREFIX))
    .map((to) => to.slice(PRESS_PREFIX.length)),
);

/**
 * Whether this slug is a press release the archive holds but has not published.
 *
 * Callers have already asked the repository and been given null, so "holds"
 * here means "was imported under this address", not "is live".
 */
export function isUnpublishedArchiveSlug(slug: string): boolean {
  return ARCHIVE_SLUGS.has(slug);
}

/** How many releases the imported archive addresses. For tests and reports. */
export function archiveSlugCount(): number {
  return ARCHIVE_SLUGS.size;
}
