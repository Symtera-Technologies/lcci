import { describe, expect, it } from "vitest";
import { PROXY_EXCLUDED_PREFIXES, config } from "@/proxy";
import {
  CSP_REPORT_DIRECTIVE,
  authenticatedCsp,
  cspHeaderName,
  documentCsp,
  publicCsp,
} from "@/server/csp";

/**
 * The proxy matcher and the two CSP policies.
 *
 * The matcher test is here because of a Next 16 behaviour whose failure is
 * invisible: when a proxy file exists, Next buffers the request body in memory
 * so it can be read twice, and a body over the 10 MB cap is **truncated with a
 * logged warning while the request continues normally**. It does not fail.
 *
 * On the upload route that is silent corruption — a bank certificate arrives
 * short, passes validation on its first bytes, and sits in storage until an
 * officer opens it. Nothing in review would catch a matcher edit that removed
 * the exclusion, so the matcher is asserted instead.
 */

/** Apply the matcher the way Next does, so the test checks the real pattern. */
function matcherMatches(pathname: string): boolean {
  const patterns = Array.isArray(config.matcher) ? config.matcher : [config.matcher];
  return patterns.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));
}

describe("proxy matcher", () => {
  it("excludes every path that streams a request or response body", () => {
    for (const prefix of PROXY_EXCLUDED_PREFIXES) {
      expect(
        matcherMatches(prefix),
        `${prefix} must be excluded: a proxy on this path buffers and silently ` +
          "truncates bodies over 10 MB",
      ).toBe(false);
      expect(matcherMatches(`${prefix}/anything`), `${prefix}/anything`).toBe(false);
    }
  });

  it("excludes a document fetch with a UUID, which is the real shape", () => {
    expect(
      matcherMatches("/api/documents/3f8a1c2e-7b4d-4f1a-9c0e-8d2b6a5f4e31"),
    ).toBe(false);
  });

  it("excludes a cron job invocation", () => {
    expect(matcherMatches("/api/cron/email-outbox")).toBe(false);
  });

  it("still runs on the pages that need a nonce and a session check", () => {
    for (const pathname of ["/admin", "/admin/applications", "/membership/apply"]) {
      expect(matcherMatches(pathname), pathname).toBe(true);
    }
  });

  it("still runs on the public site, which needs the request id", () => {
    for (const pathname of ["/", "/v2", "/news/press-releases"]) {
      expect(matcherMatches(pathname), pathname).toBe(true);
    }
  });

  it("skips Next's static output and common asset types", () => {
    for (const pathname of [
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/favicon.ico",
      "/photos/agm-1.jpg",
      "/video/XtwEvI2MKbs.jpg",
      "/fonts/something.woff2",
    ]) {
      expect(matcherMatches(pathname), pathname).toBe(false);
    }
  });

  it("does run on the CSP report route, which has no body size concern", () => {
    expect(matcherMatches("/api/csp-report")).toBe(true);
  });
});

describe("the public policy", () => {
  const csp = publicCsp();

  it("allows the YouTube frame but no YouTube script or image origin", () => {
    // The click-to-load facade means the page never loads YouTube's player
    // script and never fetches a thumbnail from Google — posters are local
    // files produced by scripts/prepare-video-posters.mjs. If somebody
    // replaces the facade with a plain embed, this test fails and says why.
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com");
    expect(csp).not.toMatch(/script-src[^;]*youtube/);
    expect(csp).not.toMatch(/img-src[^;]*ytimg/);
  });

  it("needs no Google Fonts origin", () => {
    // next/font/google self-hosts at build time; the browser sends no request
    // to Google. Adding these origins would widen the policy for no benefit.
    expect(csp).not.toContain("fonts.googleapis.com");
    expect(csp).not.toContain("fonts.gstatic.com");
    expect(csp).toContain("font-src 'self'");
  });

  it("carries no nonce, so public pages stay prerenderable", () => {
    expect(csp).not.toContain("nonce-");
  });

  it("locks down the directives that cost nothing to lock down", () => {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it("holds `upgrade-insecure-requests` back until the policy is enforced", () => {
    // A browser ignores the directive in a Report-Only policy and logs an
    // error saying so, on every page — noise sitting on top of the violations
    // the Report-Only period exists to collect. It returns with `CSP_ENFORCE`,
    // which is when it starts doing anything.
    expect(csp).not.toContain("upgrade-insecure-requests");

    const previous = process.env.CSP_ENFORCE;
    process.env.CSP_ENFORCE = "true";
    try {
      expect(cspHeaderName()).toBe("Content-Security-Policy");
      expect(publicCsp()).toContain("upgrade-insecure-requests");
      expect(authenticatedCsp("dGVzdC1ub25jZS0xMjM0NTY3OA==", false)).toContain(
        "upgrade-insecure-requests",
      );
    } finally {
      if (previous === undefined) delete process.env.CSP_ENFORCE;
      else process.env.CSP_ENFORCE = previous;
    }
  });
});

describe("the authenticated policy", () => {
  const nonce = "dGVzdC1ub25jZS0xMjM0NTY3OA==";

  it("uses the nonce with strict-dynamic", () => {
    const csp = authenticatedCsp(nonce, false);
    expect(csp).toContain(`'nonce-${nonce}'`);
    expect(csp).toContain("'strict-dynamic'");
  });

  it("never allows unsafe-eval in production", () => {
    // React needs eval in development to rebuild server component stacks.
    // Shipping that to production would undo most of what the nonce buys.
    expect(authenticatedCsp(nonce, false)).not.toContain("'unsafe-eval'");
    expect(authenticatedCsp(nonce, true)).toContain("'unsafe-eval'");
  });

  it("refuses to be framed at all", () => {
    // 'none', not 'self': the admin approves memberships and reads identity
    // documents, and nothing has a legitimate reason to frame it.
    expect(authenticatedCsp(nonce, false)).toContain("frame-ancestors 'none'");
  });

  it("permits only what pdfjs-dist needs, and no third-party origin", () => {
    const csp = authenticatedCsp(nonce, false);
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("youtube");
    expect(csp).not.toContain("challenges.cloudflare.com");
  });
});

describe("the per-document policy", () => {
  it("sandboxes and allows nothing but a same-origin image", () => {
    // The directive that actually contains a malicious upload: `sandbox` with
    // no allow-list denies scripts, plugins, forms and same-origin for this
    // one response.
    const csp = documentCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("script-src");
  });
});

describe("the CSP header name", () => {
  it("reports rather than enforces until CSP_ENFORCE is set", () => {
    // Driven by its own variable, not by NODE_ENV, so enforcement is a
    // deliberate decision made once the report table has gone quiet — rather
    // than something that silently happens at the first production build.
    const before = process.env.CSP_ENFORCE;
    try {
      delete process.env.CSP_ENFORCE;
      expect(cspHeaderName()).toBe("Content-Security-Policy-Report-Only");
      process.env.CSP_ENFORCE = "true";
      expect(cspHeaderName()).toBe("Content-Security-Policy");
      process.env.CSP_ENFORCE = "yes";
      expect(cspHeaderName()).toBe("Content-Security-Policy-Report-Only");
    } finally {
      if (before === undefined) delete process.env.CSP_ENFORCE;
      else process.env.CSP_ENFORCE = before;
    }
  });

  it("points reports at a route we own", () => {
    expect(CSP_REPORT_DIRECTIVE).toBe("report-uri /api/csp-report");
  });
});
