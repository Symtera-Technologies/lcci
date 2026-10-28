/**
 * Content Security Policy.
 *
 * Two policies, because the public site and the authenticated app have
 * genuinely different needs — and because of one constraint that decides the
 * shape of both: a nonce-based CSP forces dynamic rendering on every page it
 * covers. Next's own guidance says so outright. For `/admin` and
 * `/membership/apply` that is free, since they are dynamic anyway. For the
 * public site, which has to reach Lighthouse 90 on shared hosting with no CDN,
 * making every page dynamic in order to serve a nonce is a bad trade.
 *
 * So the public policy is nonce-free and static, set in `next.config.ts`
 * alongside the four headers already there; the authenticated policy is
 * nonce-based and set per-request in `src/proxy.ts`.
 *
 * No `server-only`: `next.config.ts` imports this, and it runs outside the
 * server bundle.
 */

/**
 * Where the `youtube-nocookie.com` embed is allowed to be framed from.
 *
 * Note what is *not* here: no YouTube origin in `script-src`, and no
 * `i.ytimg.com` in `img-src`. That is the click-to-load facade in
 * `src/components/v2/video-player.tsx` paying off a second time — it renders a
 * local poster from `public/video/` and a real button, and mounts the iframe
 * only after a visitor presses play, so the page never loads YouTube's
 * `iframe_api` and never fetches a thumbnail from Google.
 *
 * Worth stating out loud, because the day somebody "simplifies" the facade
 * into a plain embed, this policy has to be widened to match and the privacy
 * property is lost silently.
 */
const YOUTUBE_FRAME = "https://www.youtube-nocookie.com";

/**
 * Cloudflare Turnstile, on the public forms only.
 *
 * Chosen over reCAPTCHA because it sets no cookies and does no cross-site
 * tracking, which matters on a site that also has to carry a privacy policy
 * and whose video player already refuses to leak visitors to Google by
 * default. It is rendered lazily on first interaction with a form, so it never
 * loads on the homepage at all.
 */
const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * `upgrade-insecure-requests`, but only once the policy is enforced.
 *
 * A browser ignores this directive in a Report-Only policy and says so in the
 * console, on every page, as an error. While the policy is being read rather
 * than enforced that message is pure noise sitting on top of the violations
 * that matter — and on an admin screen it is the first thing in the console of
 * anyone debugging something else. It comes back the moment `CSP_ENFORCE` is
 * set, which is the moment it starts doing anything.
 */
function upgradeInsecureRequests(): string[] | null {
  return cspHeaderName() === "Content-Security-Policy" ? [] : null;
}

function directives(entries: Record<string, string[] | null>): string {
  return Object.entries(entries)
    .filter((entry): entry is [string, string[]] => entry[1] !== null)
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}

/**
 * The public policy: static, no nonce, so every page stays prerenderable.
 *
 * `'unsafe-inline'` in `script-src` is the honest cost of that choice. The App
 * Router emits inline bootstrap scripts whose content varies per page, so a
 * fixed hash list is unmaintainable and a nonce needs dynamic rendering.
 *
 * What makes it tolerable is that there is no injection sink on the public
 * site: content arrives through `src/content/repository.ts`, and rich-text
 * bodies are sanitised server-side on write rather than at render. With
 * nothing able to inject a script tag, `'unsafe-inline'` has nothing to
 * amplify. That reasoning is written down here deliberately, so a future
 * reviewer reads the policy as a decision rather than as carelessness — and so
 * that whoever removes the write-time sanitiser knows what else they are
 * removing.
 *
 * If an OWASP scan flags it — and scanners do — the upgrade path is the nonce
 * policy site-wide, accepting dynamic rendering, with a CDN absorbing the
 * cost.
 */
export function publicCsp(): string {
  return directives({
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'self'"],
    "form-action": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", TURNSTILE],
    // Unavoidable in practice: Tailwind 4 compiles to a stylesheet, but React
    // inline `style` attributes and next/font's CSS variables both put inline
    // styles in the document. The risk from inline styles is far below that of
    // inline scripts.
    "style-src": ["'self'", "'unsafe-inline'"],
    // `blob:` for the client-side canvas that generates upload thumbnails;
    // `data:` for the small inline SVGs in the icon set.
    "img-src": ["'self'", "data:", "blob:"],
    // Complete as-is. `next/font/google` downloads and self-hosts the font
    // files at build time and the browser sends no request to Google, so
    // adding fonts.googleapis.com or fonts.gstatic.com would widen the policy
    // for exactly no benefit. (The build machine needs network access to
    // Google — that is a CI concern, not a CSP one.)
    "font-src": ["'self'"],
    "connect-src": ["'self'", TURNSTILE],
    "frame-src": [YOUTUBE_FRAME, TURNSTILE],
    "media-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "upgrade-insecure-requests": upgradeInsecureRequests(),
  });
}

/**
 * The authenticated policy: nonce plus `'strict-dynamic'`.
 *
 * `'strict-dynamic'` makes the allowlist irrelevant — a script loaded by a
 * nonced script is trusted — while still letting Next's chunk loader insert
 * the scripts it needs.
 *
 * `style-src` carries `'unsafe-inline'` and deliberately **no nonce**. A nonce
 * there would be worse than useless: a browser ignores `'unsafe-inline'` as
 * soon as a nonce is present, and a nonce cannot be attached to an inline
 * `style` attribute at all — which is how React sets every computed style and
 * how a dozen components in this admin position things. With the nonce in
 * place, each of those attributes was a violation, so loading one page filed
 * several reports and an enforcing flip would have stripped the admin's
 * layout. The honest trade is stated rather than hidden: inline *styles* are
 * allowed, inline *scripts* are not, and it is the script policy that stops
 * an injection from running.
 *
 * `'wasm-unsafe-eval'`, `worker-src blob:` and `frame-src blob:` exist for
 * `pdfjs-dist` on the document review screen, where an officer compares a CNIC
 * scan against a signature. They are scoped to the authenticated policy and
 * never appear on the public site.
 */
export function authenticatedCsp(nonce: string, isDev: boolean): string {
  return directives({
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    // Not `'self'`: the admin must never be framable, including by itself.
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "'wasm-unsafe-eval'",
      // React uses eval in development to reconstruct server component stack
      // traces. Gated on the environment so production never carries it.
      ...(isDev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": ["'self'"],
    "frame-src": ["'self'", "blob:"],
    // No video or audio in the backend. Narrowing this costs nothing and
    // removes a class of exfiltration channel.
    "media-src": ["'none'"],
    "worker-src": ["'self'", "blob:"],
    "upgrade-insecure-requests": upgradeInsecureRequests(),
  });
}

/**
 * The per-response policy for a served document.
 *
 * Far tighter than either page policy, and it is what actually contains a
 * malicious uploaded file. `sandbox` with no allow-list is the valuable
 * directive here: it denies scripts, plugins, forms and same-origin for this
 * response, so even something that slipped past magic-byte and structural
 * validation has nothing to execute against.
 *
 * Used on the staff inline viewer. Everything else is served as
 * `Content-Disposition: attachment`, which neutralises the same class of
 * problem by never rendering the file at all.
 */
export function documentCsp(): string {
  return directives({
    "default-src": ["'none'"],
    "img-src": ["'self'"],
    "object-src": ["'none'"],
    sandbox: [],
  });
}

/**
 * Headers added beside the four already in `next.config.ts`.
 *
 * `Cross-Origin-Embedder-Policy: require-corp` is deliberately absent: it
 * would break the YouTube iframe, and the isolation it buys is not worth
 * losing the chamber's own video.
 */
export const EXTRA_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none",
  // A future "scan a document with your phone" flow would want `camera=(self)`
  // — scoped to that route, not opened globally.
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

/**
 * Whether the policy is enforced or only reported.
 *
 * Report-Only first, with violations collected at `/api/csp-report` and read
 * for a couple of weeks before the header name is flipped. An enforcing CSP
 * shipped blind to a site with third-party embeds and a CMS breaks something
 * on day one, and the breakage is invisible to the person who shipped it.
 *
 * Driven by an environment variable rather than by NODE_ENV, so the switch is
 * a deployment decision made once the report table has gone quiet — not
 * something that silently happens at the first production build.
 */
export function cspHeaderName(): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return process.env.CSP_ENFORCE === "true"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
}

/** Appended so violations reach us while the policy is in Report-Only. */
export const CSP_REPORT_DIRECTIVE = "report-uri /api/csp-report";
