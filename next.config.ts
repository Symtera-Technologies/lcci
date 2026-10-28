import type { NextConfig } from "next";
// A relative import, not the `@/` alias: next.config.ts is loaded by Next's
// own compilation step, which does not apply the tsconfig path mapping.
import {
  CSP_REPORT_DIRECTIVE,
  EXTRA_SECURITY_HEADERS,
  cspHeaderName,
  publicCsp,
} from "./src/server/csp";

const nextConfig: NextConfig = {
  // Passenger (cPanel Node.js app manager) boots a plain Node server, so the
  // build must be self-contained rather than relying on a serverless adapter.
  output: "standalone",

  // Tailwind is compiled through the Turbopack loader (see `turbopack.rules`).
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },

  images: {
    formats: ["image/avif", "image/webp"],
    // Shared cPanel has a tight memory ceiling; keep the generated set small.
    deviceSizes: [360, 640, 828, 1080, 1440, 1920],
    imageSizes: [96, 160, 256, 384],
  },

  poweredByHeader: false,

  experimental: {
    /**
     * Enables `forbidden()` and `unauthorized()`, with `forbidden.tsx` and
     * `unauthorized.tsx` as their boundaries.
     *
     * Needed because the admin area has three distinct refusals and collapsing
     * them is actively harmful: no session (redirect to sign-in, there is
     * something to do), second factor outstanding (redirect to the next step),
     * and signed in but not permitted — which must be a 403 page, never a
     * redirect to sign-in. Someone already signed in who is bounced to a login
     * form will try different credentials to fix a problem that has nothing to
     * do with credentials.
     *
     * Without this flag the third case would have to be a hand-rolled error
     * boundary matching on an error name, which is the same mechanism with
     * none of the framework's handling (`noindex`, the right status code).
     */
    authInterrupts: true,

    /**
     * Left at the 1 MB default, deliberately and permanently.
     *
     * The limit is global: raising it to accommodate document upload would
     * raise it for *every* server action in the app, including the public
     * newsletter action, turning each into a multi-megabyte memory sink
     * reachable from an unauthenticated form. Actions also buffer the whole
     * body before the handler runs, and on a plan whose memory ceiling already
     * defeats `next build`, a few concurrent bodies across Passenger workers
     * is the documented OOM — triggered by an applicant, taking the whole site
     * down rather than one upload.
     *
     * Files therefore never travel through a server action. They stream to
     * `/api/portal/uploads`, which returns an opaque document id, and the
     * action that submits the step carries only id strings — a few hundred
     * bytes. See `src/app/api/portal/uploads/route.ts`.
     */
    serverActions: {
      bodySizeLimit: "1mb",
      /**
       * Set once the canonical domain is settled (plan open question 15:
       * staff use @lcci.org.pk while the site is lcci.com.pk).
       *
       * Behind Apache and Passenger, confirm what cPanel actually forwards
       * before trusting the default — if Apache forwards its own host rather
       * than the public one in `x-forwarded-host`, every server action returns
       * 500 in production while working perfectly in development. That is a
       * well-known cPanel-plus-Next failure and it is worth ten minutes of
       * `curl -v` on the real host.
       */
      allowedOrigins: process.env.SITE_ORIGIN
        ? [new URL(process.env.SITE_ORIGIN).host]
        : undefined,
    },
  },

  async headers() {
    const csp = `${publicCsp()}; ${CSP_REPORT_DIRECTIVE}`;

    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Superseded by the CSP's `frame-ancestors`, kept for clients too old
          // to honour it.
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          ...Object.entries(EXTRA_SECURITY_HEADERS).map(([key, value]) => ({
            key,
            value,
          })),
          /**
           * The public policy. `src/proxy.ts` sets a tighter, nonce-based one
           * on the authenticated areas, and a response header set there wins
           * over this one.
           *
           * Ships as Report-Only until `CSP_ENFORCE=true`. See
           * `src/server/csp.ts` for why that is a separate switch from
           * NODE_ENV.
           */
          { key: cspHeaderName(), value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
