/**
 * Whether this site runs its own membership portal, and where to send people
 * when it does not.
 *
 * **It does not, as of 2 November 2026.** The Chamber asked for the rebuilt
 * site to be content only: joining, signing in, paying a fee and renewing all
 * stay on `membership.lcci.org.pk`, which is where lcci.com.pk sends people
 * today and which is already running. The code for all of it is finished and
 * tested and stays in the tree — this is a switch, not a deletion, because the
 * Chamber may ask for it back.
 *
 * **To turn it back on:** set `MEMBERSHIP_PORTAL_ENABLED` to `true`, revert
 * `migrations/0036_membership_portal_external.sql` (or edit the hero in the
 * admin), and run the test suite. Nothing else is switched off anywhere else;
 * everything that hides or redirects reads this file.
 *
 * No imports, deliberately. `src/proxy.ts` pulls this in and a proxy may be
 * deployed apart from the render path, so this module has to stand alone —
 * the same reason `server/auth/policy.ts` carries no `server-only`.
 */
export const MEMBERSHIP_PORTAL_ENABLED = false;

/**
 * The Chamber's live portal, exactly as lcci.com.pk links to it.
 *
 * Both were checked and return 200. The trailing slash on `signIn` is the
 * form the old site uses and the portal's own redirect expects; dropping it
 * costs a round trip.
 */
export const LEGACY_PORTAL = {
  /** "New Membership" and "Apply Now" on the old site. */
  register: "https://membership.lcci.org.pk/register",
  /** "Renew Now" on the old site, and the only member sign-in there is. */
  signIn: "https://membership.lcci.org.pk/member-login/",
} as const;

/**
 * Routes that have no meaning while the portal is off, and where each one
 * goes instead.
 *
 * Only the transactional routes are listed. The public `/membership` pages —
 * why join, categories, dues, the directory, FAQs, renew — are CMS content and
 * stay exactly where they are; that is the whole point of "content only".
 *
 * A member who has an application open on this site goes to the portal's
 * sign-in rather than its registration form, because they already have an
 * account somewhere and being handed a signup form is the more confusing of
 * the two wrong answers.
 */
const DISABLED_ROUTES: readonly (readonly [string, string])[] = [
  ["/membership/register", LEGACY_PORTAL.register],
  ["/membership/apply", LEGACY_PORTAL.register],
  ["/membership/sign-in", LEGACY_PORTAL.signIn],
  ["/membership/applications", LEGACY_PORTAL.signIn],
  // Staff-side. These queues can only ever be empty now, and an officer
  // working an empty queue is an officer who thinks the system is broken.
  // Back to the dashboard, which still has the content tools on it.
  ["/admin/applications", "/admin"],
  ["/admin/payments", "/admin"],
  ["/admin/reports/sla", "/admin"],
];

/**
 * Segment-aware, not a plain `startsWith`.
 *
 * `/membership/applyXYZ` is a different route from `/membership/apply` and
 * must not inherit its redirect — the same trap `PROTECTED_PREFIXES`
 * documents, where a loose prefix silently widens a rule to paths nobody
 * meant to include.
 */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Where `pathname` should be sent, or `null` to let it render.
 *
 * Always `null` while the portal is enabled, so the whole feature collapses
 * to nothing on one boolean.
 */
export function disabledRouteTarget(pathname: string): string | null {
  if (MEMBERSHIP_PORTAL_ENABLED) return null;

  for (const [prefix, target] of DISABLED_ROUTES) {
    if (under(pathname, prefix)) return target;
  }

  return null;
}
