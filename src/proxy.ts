import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/server/auth/session";
import { authenticatedCsp, cspHeaderName, CSP_REPORT_DIRECTIVE } from "@/server/csp";
import { routePolicy } from "@/server/auth/policy";

/**
 * Proxy — a pre-filter, not a security boundary.
 *
 * Named `proxy.ts` rather than `middleware.ts` because the middleware file
 * convention is deprecated in Next 16 and renamed. Two consequences follow
 * from that rename and both matter here: proxy now defaults to the Node.js
 * runtime, and setting the `runtime` segment config inside a proxy file
 * *throws* — so there is deliberately no runtime export below.
 *
 * Three jobs, and nothing else:
 *
 *   1. Mint the request id that correlates every audit event, log line and
 *      document access within one request.
 *   2. Emit the nonce-based CSP for the authenticated areas.
 *   3. Redirect a visitor with no session cookie away from a protected route
 *      before any rendering starts.
 *
 * What it must never do is query the database. Next's own authentication
 * guidance is explicit about why: proxy runs on every route including
 * prefetches, so a query here multiplies load — and against the
 * three-connection pool this host allows, that is a self-inflicted outage.
 *
 * And (3) is not an authorisation decision. A cookie's presence is not a
 * session: the cookie may be expired, revoked, or minted before a role change.
 * The real check is `src/server/auth/dal.ts`, which every page, action and
 * route handler calls. This only saves an unauthenticated visitor from being
 * served a shell they will be bounced out of.
 */

/**
 * Paths the proxy must not touch.
 *
 * This is the most important line in the file, and it is not about
 * performance. When a proxy file exists, Next clones and buffers the request
 * body in memory so it can be read twice — in the proxy and again in the route
 * handler. The cap is 10 MB by default, and a body over the cap is
 * **truncated with a logged warning while the request continues normally**.
 * It does not fail.
 *
 * On the upload route that is silent data corruption: an applicant's bank
 * certificate would arrive short, pass validation on its first bytes, and be
 * stored as a truncated file nobody notices until an officer opens it. On the
 * document-serving route the buffering is pure waste on the hottest streaming
 * path in the staff UI. On the cron route there is no session and no CSP to
 * apply, so there is nothing to gain.
 *
 * Expressed as a negative-lookahead matcher below, and asserted by
 * `tests/proxy.test.ts`, because a change to the matcher is otherwise
 * impossible to review for this consequence.
 */
export const PROXY_EXCLUDED_PREFIXES = [
  "/api/portal/uploads",
  "/api/documents",
  "/api/cron",
] as const;

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // 26 Crockford-base32 characters, generated with the Web Crypto API that is
  // available in every Next runtime. `src/server/crypto.ts` has the richer
  // version; this one is deliberately standalone, because the proxy docs warn
  // against relying on shared modules and globals — a proxy may be deployed
  // separately from the render path.
  const requestId = newRequestId();

  const headers = new Headers(request.headers);
  headers.set("x-request-id", requestId);

  // The nonce policy is emitted for the authenticated areas only, because a
  // nonce forces dynamic rendering and the public site has to stay
  // prerenderable. See src/server/csp.ts.
  const { policy, protectedPath } = routePolicy(pathname);
  const nonce = protectedPath ? newNonce() : null;
  if (nonce) headers.set("x-nonce", nonce);

  // An optimistic redirect: no cookie at all means there is certainly no
  // session, so there is no point rendering a shell the visitor will be
  // bounced out of. A cookie that is present but expired, revoked or minted
  // before a role change is caught by the data layer, which is where the
  // database is.
  //
  // `policy.public` exempts the paths that sit under a protected prefix but
  // must be reachable with no account at all — the sign-in page, and the
  // endorsement link a proposer follows from an email.
  const exempt = policy?.public === true;
  if (protectedPath && !exempt && !request.cookies.has(SESSION_COOKIE)) {
    // Staff and members have separate sign-in pages, because they have
    // different credentials: staff a password and an authenticator, members an
    // emailed code and no password at all. Sending an officer to the member
    // form would offer them the one method their account does not have.
    const signIn = new URL(
      pathname.startsWith("/admin") ? "/admin/sign-in" : "/membership/sign-in",
      request.url,
    );
    signIn.searchParams.set("next", pathname + request.nextUrl.search);
    const redirect = NextResponse.redirect(signIn);
    redirect.headers.set("x-request-id", requestId);
    return redirect;
  }

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("x-request-id", requestId);

  if (nonce) {
    response.headers.set(
      cspHeaderName(),
      `${authenticatedCsp(nonce, process.env.NODE_ENV !== "production")}; ${CSP_REPORT_DIRECTIVE}`,
    );
    // An authenticated page must never be cached by anything between the
    // worker and the browser. The public site's caching is unaffected because
    // this branch only runs for protected paths.
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie");
  }

  return response;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newRequestId(now: number = Date.now()): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = "";
  for (const byte of bytes) random += CROCKFORD[byte % 32];

  return time + random;
}

function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Where the proxy runs.
 *
 * Everything except Next's own static output, the public folder's common file
 * types, and the three excluded API prefixes. The exclusions are the point —
 * see `PROXY_EXCLUDED_PREFIXES` above for why a proxy on the upload path
 * corrupts files rather than merely slowing them down.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|api/portal/uploads|api/documents|api/cron|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|otf|mp4|webm|pdf|txt|xml|json|webmanifest)$).*)",
  ],
};
