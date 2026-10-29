import type { PermissionCode } from "@/server/permissions";

/**
 * What every protected route requires.
 *
 * This table is not the security boundary — the data layer is, because a
 * Next.js server action is a publicly addressable endpoint and a check in the
 * component that renders the button only protects the button. This table is
 * the thing that makes a *missing* check impossible to merge.
 *
 * `tests/routes.test.ts` walks `src/app` for every `page.tsx` and `route.ts`,
 * derives the URL each one serves, and asserts that anything under a protected
 * prefix appears here. A new file under `/admin` with no entry fails the test
 * suite. Adding an unprotected admin route therefore stops being something a
 * reviewer has to spot and becomes something CI refuses.
 *
 * Deny by default: an unlisted path under a protected prefix is treated as
 * forbidden by `routePolicy`, so the failure mode of forgetting an entry is a
 * locked door rather than an open one.
 *
 * No `server-only`: `src/proxy.ts` imports this, and the proxy runs in its own
 * runtime.
 */

/**
 * Route prefixes that require a session, and that the proxy will redirect an
 * unauthenticated visitor away from. Everything else is public.
 */
export const PROTECTED_PREFIXES = [
  "/admin",
  "/membership/apply",
  // Its own entry, because "/membership/apply" does not cover it. The prefix
  // test is segment-aware on purpose — a plain `startsWith` would let
  // `/membership/applyXYZ` inherit a protection it was never given — so
  // `/membership/applications` is a different path, not a child of the
  // wizard's. Left off this list it still had its own guard in the page, but
  // it missed the two things only the proxy does: the nonce CSP, and
  // `Cache-Control: private, no-store` with `Vary: Cookie`. A membership
  // number and a fee receipt in a shared secretariat machine's back/forward
  // cache is the one outcome that rule exists to prevent.
  "/membership/applications",
  // Listed although it is public, so that it inherits the two things the
  // proxy only does for protected paths: `Cache-Control: private, no-store`
  // with `Vary: Cookie`, and the nonce CSP. A sign-in page is the last page
  // that should sit in a shared machine's back/forward cache, and the one
  // most worth hardening. `public: true` in the table below exempts it from
  // the redirect, and the inventory test now demands that declaration.
  "/membership/sign-in",
  "/portal",
] as const;

/**
 * Prefixes where an entry in this table is mandatory.
 *
 * Wider than `PROTECTED_PREFIXES`, and the difference matters. `/api/*` routes
 * are not in the protected list because the proxy must not redirect them: a
 * 302 to a sign-in page returned to an `<img src>` or a pdf.js range request
 * is a baffling failure rather than a prompt, so those routes answer 401
 * themselves. But an API route is exactly the kind of thing that can land
 * without anyone stating who may call it, so the inventory test still demands
 * a declaration — `public: true` with a written reason, or an audience and a
 * permission list.
 */
export const POLICY_REQUIRED_PREFIXES = [
  ...PROTECTED_PREFIXES,
  "/api",
] as const;

export type Audience = "staff" | "member" | "either";

export interface RoutePolicy {
  /** Who may reach it at all. */
  audience: Audience;
  /** Permissions the actor must hold. Empty means "any authenticated actor". */
  permissions: readonly PermissionCode[];
  /**
   * True when the route is reachable without a session.
   *
   * Used for the handful of paths that sit under a protected prefix but must
   * be public: the sign-in page itself, and the endorsement link a proposer
   * follows from an email before they have any account at all.
   */
  public?: boolean;
  /**
   * True when a staff member may reach it before enrolling a second factor.
   *
   * Exactly one route sets this. An admin account with no TOTP secret can
   * reach the enrolment page and nothing else, which makes enrolment a gate
   * rather than an option.
   */
  allowBeforeMfa?: boolean;
  /**
   * Set while the policy is written but the route does not exist yet.
   *
   * The inventory test enforces this in both directions: an entry with no
   * route file must carry it, and an entry whose route file now exists must
   * NOT. So building the route fails the suite until the flag is removed,
   * which is what stops the flag from quietly becoming permanent and masking
   * a mistyped path.
   */
  planned?: boolean;
  /** One line on why, for the reader of the table. */
  note?: string;
}

/**
 * The policy table.
 *
 * Ordered roughly as the routes are built. Keys are the URL path as served,
 * with `[param]` left in place — the inventory test compares against the
 * filesystem, so the two must be written the same way.
 */
export const ROUTE_POLICY: Record<string, RoutePolicy> = {
  /* --- Applicant and member area --------------------------------------- */

  "/membership/sign-in": {
    public: true,
    // `either`, not `member`: a staff account that lands here should be shown
    // the page rather than refused, and told to use the admin sign-in. The
    // audience only governs who may *act*, and nothing on this page acts as an
    // authenticated user — it is the page that creates the session.
    audience: "either",
    permissions: [],
    note: "Member OTP sign-in. Public by necessity, and the one path the proxy redirects an unauthenticated visitor to, so an entry that ever loses `public: true` would make it redirect to itself.",
  },

  "/membership/apply": {
    audience: "member",
    permissions: [],
    note: "The wizard. /membership/* rather than the spec's /portal/apply: six places in the public site already link here.",
  },

  "/membership/apply/submitted": {
    audience: "member",
    permissions: [],
    note: "The receipt page, reached by redirect after submission so a reload cannot re-post it. Scoped to the signed-in applicant, so the reference in the query string cannot reach someone else's application.",
  },

  "/membership/applications": {
    audience: "member",
    permissions: [],
    note: "The applicant's own list of applications, scoped to created_by in listApplications. The way into a terminal application: /membership/apply redirects only to one in flight, so without this an approved member had no page showing their own membership number.",
  },

  "/membership/applications/[id]": {
    audience: "member",
    permissions: [],
    note: "The applicant's own application: its stage, timeline, fee, membership and the deficiency round when one is open. Scoped to created_by in loadTracker's own query, so the id in the address bar reaches nobody else's application; a stranger's id is a 404, not a 403, so the route is not an existence oracle.",
  },

  /* --- Staff backend ---------------------------------------------------- */

  "/admin": {
    audience: "staff",
    permissions: [],
    note: "Dashboard. Any authenticated staff account; the panels inside it are individually permissioned.",
  },

  "/admin/sign-in": {
    public: true,
    // Also `allowBeforeMfa`, because this page renders the second step itself:
    // after the password a staff session exists with `mfa_satisfied_at` NULL,
    // and the page has to be reachable to collect the code that sets it.
    allowBeforeMfa: true,
    audience: "either",
    permissions: [],
    note: "Staff password + authenticator sign-in. Separate from the member page because the credentials are different: staff have a password and an app, members have an emailed code and no password at all.",
  },

  "/admin/setup-2fa": {
    // The other half of the enrolment gate. An account with no authenticator
    // reaches this and nothing else, which is what makes two-factor
    // mandatory rather than aspirational.
    allowBeforeMfa: true,
    audience: "staff",
    permissions: [],
    note: "Two-factor enrolment. Generates a fresh secret per render and leaves no half-enrolled state behind; the recovery codes are shown once in the action result, never through a redirect.",
  },

  "/admin/applications": {
    audience: "staff",
    permissions: ["application.read"],
    note: "The verification queue. Ordered by SLA pressure rather than arrival, because the tiers are a paid promise in working days.",
  },

  "/admin/applications/[id]": {
    audience: "staff",
    permissions: ["application.read"],
    note: "One application, with its documents alongside. Document bytes are authorised per document by /api/documents/[id], not by this route.",
  },

  "/admin/applications/[id]/checklist": {
    audience: "staff",
    // `application.read`, not `application.verify`. An approver has to be able
    // to read the signed checklist before granting membership, and a verifier
    // who can read but not decide is a legitimate state during handover. Every
    // action on the page carries its own permission, which is where the
    // separation of duties actually lives — the route only decides who may
    // look.
    permissions: ["application.read"],
    note: "The thirteen-item verification checklist, the deficiency composer and the round history. All thirteen items are shown in the printed order even where they do not apply, because the form is an ISO-controlled document.",
  },

  "/admin/calendar": {
    audience: "staff",
    permissions: ["calendar.manage"],
    note: "The working-day calendar, which is the input to every processing deadline in the system. Narrowly permissioned because a single edit here moves dates that have already been quoted to applicants — a holiday entered inside a running window makes the fortieth working day later than the date in somebody's inbox.",
  },

  "/admin/reports/sla": {
    audience: "staff",
    // `application.read`, the same grant the queue needs. The report is the
    // queue's own data counted up; anyone who may read the applications may
    // read how long they have taken, and a separate grant would mean the
    // people doing the work are the last to see whether it is on time.
    permissions: ["application.read"],
    note: "Whether the chamber is keeping the processing promises it sold. Open files first and decided ones second, because a tier with a clean record and a dozen applications already past their date is not a tier being met.",
  },

  "/admin/audit": {
    audience: "staff",
    // `audit.read`, which only the super administrator holds. Not a wider
    // grant: the log names every officer alongside every applicant, and the
    // payloads carry the values before and after each decision. The narrative
    // staff need while working their own files is on the application itself,
    // from `application_state_transitions`, and needs no sight of this.
    permissions: ["audit.read"],
    note: "The hash-chained audit log, grouped by request because one approval writes four events. The screen verifies the rows it displays and reports the weekly sweep for the rest; it does not claim to have walked seven years of chain on a page load.",
  },

  "/admin/payments": {
    audience: "staff",
    permissions: ["payment.read"],
    note: "The cashier's queue, ordered by the processing deadline rather than arrival. A separate queue from the officers' because receipting runs in parallel with verification: the pay order arrives with the form.",
  },

  "/admin/applications/[id]/approval": {
    audience: "staff",
    // `application.read`, like the review screen and the checklist, and
    // deliberately not `application.approve`. The page is a statement of which
    // controls were performed and by whom, and that is exactly what a verifier
    // or a cashier should be able to read without being able to act on it —
    // the decision itself is guarded by the actions, and by the workflow's own
    // separation-of-duties guards inside the approval transaction.
    permissions: ["application.read"],
    note: "The approval block from page 2: every guard on the grant, satisfied or not, and the three decisions. Granting needs application.approve, refusing application.reject, and waiving a separation-of-duties guard role.manage; each is checked by its action.",
  },

  "/admin/applications/[id]/payment": {
    audience: "staff",
    // `payment.read` and deliberately not `application.read`. This screen is
    // built around the two documents the money control compares, and a cashier
    // holds the narrow `documents.read_financial` grant rather than
    // `documents.read` — so putting receipting on the review screen would have
    // meant handing them a page organised around every director's CNIC.
    permissions: ["payment.read"],
    note: "Cashier receipting and the pay-order / bank-certificate control. Receipting itself needs payment.receipt, checked by the action; this route only decides who may look.",
  },

  /* --- API -------------------------------------------------------------- */

  "/api/cron/[job]": {
    audience: "either",
    permissions: [],
    public: true,
    note: "Authenticated by a bearer secret compared in constant time, not by a session. Returns 404 on failure rather than 401, so the endpoint does not advertise that it exists.",
  },

  "/api/portal/uploads": {
    audience: "either",
    permissions: [],
    note: "One file per request, streamed. Authenticates itself and answers 401 rather than redirecting, because the caller is fetch() from the wizard. Excluded from the proxy matcher: a proxy body buffer silently truncates past 10 MB.",
  },

  "/api/documents/[id]": {
    audience: "either",
    permissions: [],
    note: "Authorisation is per document, not per route — ownership or a scoped staff permission — so the permission list here is empty on purpose. See authorizeDocument in src/server/documents/serve.ts, which the route cannot bypass.",
  },

  "/api/csp-report": {
    audience: "either",
    permissions: [],
    public: true,
    note: "Browsers post violation reports with no credentials. Rate-limited, and the body is stored as-is without being trusted.",
  },
};

export interface PolicyDecision {
  /** The matched policy, or null when the path is not protected at all. */
  policy: RoutePolicy | null;
  /** True when the path sits under a protected prefix. */
  protectedPath: boolean;
}

/**
 * Resolve a request path to its policy.
 *
 * Concrete path segments are matched against `[param]` placeholders, so
 * `/api/cron/email-outbox` resolves to the `/api/cron/[job]` entry.
 */
export function routePolicy(pathname: string): PolicyDecision {
  const path = normalise(pathname);

  const exact = ROUTE_POLICY[path];
  if (exact) return { policy: exact, protectedPath: isProtected(path) };

  for (const [pattern, policy] of Object.entries(ROUTE_POLICY)) {
    if (pattern.includes("[") && matchesPattern(path, pattern)) {
      return { policy, protectedPath: isProtected(path) };
    }
  }

  return { policy: null, protectedPath: isProtected(path) };
}

/** True when this path must appear in `ROUTE_POLICY`. */
export function requiresPolicy(pathname: string): boolean {
  const path = normalise(pathname);
  return POLICY_REQUIRED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

export function isProtected(pathname: string): boolean {
  const path = normalise(pathname);
  return PROTECTED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/**
 * Strip a trailing slash and collapse repeats.
 *
 * `/admin//users` and `/admin/users/` must not slip past a prefix check that
 * `/admin/users` would fail.
 */
function normalise(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/"))
    return collapsed.slice(0, -1);
  return collapsed;
}

function matchesPattern(path: string, pattern: string): boolean {
  const pathParts = path.split("/");
  const patternParts = pattern.split("/");

  // A catch-all consumes the remaining segments; a single param consumes one.
  const catchAllIndex = patternParts.findIndex((part) =>
    part.startsWith("[..."),
  );
  if (catchAllIndex === -1 && pathParts.length !== patternParts.length)
    return false;
  if (catchAllIndex !== -1 && pathParts.length < catchAllIndex) return false;

  for (let i = 0; i < patternParts.length; i += 1) {
    const expected = patternParts[i];
    if (expected.startsWith("[...")) return true;
    if (expected.startsWith("[") && expected.endsWith("]")) {
      if (!pathParts[i]) return false;
      continue;
    }
    if (expected !== pathParts[i]) return false;
  }

  return true;
}
