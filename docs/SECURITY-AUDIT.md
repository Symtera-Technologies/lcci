# Security audit — 17 November 2026

Source-only audit of the site as it is deployed today, plus the three changes it
led to. Read this with `docs/PROJECT-STATUS.md`, which says what the site
contains; this says what protects it.

**Result: no confirmed vulnerabilities.** One control was weak enough to fix and
has been fixed; two defence-in-depth gaps were closed. The rest of this document
is as much about what was deliberately *not* changed, because on a codebase that
already holds up, the expensive mistake is a developer told to "tighten security"
rewriting things that were right.

---

## What was audited

The site as deployed: public content pages, an admin CMS behind staff password
plus TOTP, and one public contact form. **The membership portal is off** —
`/membership/*` redirects to `membership.lcci.org.pk` — so the application
wizard, payments, the verification checklist, membership numbering and document
upload were not reachable and were **not** audited.

That is a scope statement, not a clean bill. Those surfaces need their own pass
before the portal is ever switched on. Recording them as out of scope rather
than as covered is the point.

| In scope | Excluded, and why |
|---|---|
| Legacy redirect handling (`src/proxy.ts`) | Application wizard, payments, checklist, numbering — portal off, unreachable |
| Contact form and newsletter stub | Document **upload** route — portal off |
| The server-action CSRF wrapper and every action using it | Membership SLA and calendar — reachable only through the portal |
| Authentication, sessions, TOTP, login throttle | |
| Authorization coverage across all admin and portal routes | |
| SQL construction and mass assignment | |
| HTML sanitisation and the public render sink | |
| Cron and CSP-report endpoints | |
| Document **serving** (excluded from the proxy matcher, so it self-authorizes) | |
| Secret handling in version control | |

---

## What held

Verified against source, with the file that carries the control. Nothing here
needed changing.

| Surface | Result | Where |
|---|---|---|
| Open redirect, member sign-in | Allowlist rejects `//`, `\`, and non-`/membership` prefixes | `server/auth/destination.ts` |
| Open redirect, admin sign-in | `?next=` ignored entirely; always `/admin` | `(admin)/admin/sign-in/actions.ts` |
| Open redirect, 755 legacy entries | All targets single-slash internal; no protocol-relative, scheme or backslash values | `content/legacy-redirects.ts` |
| CSRF on server actions | `Origin` required **and** equal — closes the gap Next leaves for a request carrying none | `server/action.ts:153` |
| Enforcement order | origin → sentinel → authn/authz → rate limit → schema → handler | `server/action.ts:153-182` |
| Actions bypassing the wrapper | Three, all justified: two sign-outs carry `isSameSiteRequest`; `subscribe` has no side effect | — |
| Email header injection | Newline rejection on subject and Reply-To, narrow address grammar | `server/mail/templates.ts:673-706` |
| HTML email sink | Does not exist — all mail is plain text | `server/mail/templates.ts:20-32` |
| Stored XSS into the admin | Zero `dangerouslySetInnerHTML` anywhere in `(admin)` | — |
| SQL injection | Identifiers via `sql.id`/`sql.table`, values parameterised | `content/admin.ts:316-341` |
| Mass assignment | The writer loops the **field spec**, not submitted keys | `content/admin.ts:283-288` |
| `sql.raw` (two uses) | One behind `Number.isInteger`, one from a constant map | `membership/sla.ts:66`, `membership/calendar.ts:190` |
| Public XSS via CMS bodies | Sanitised on write; the legacy importer calls the same function; schemes limited to http/https | `content/sanitise.ts:93-150` |
| The stored corpus | Zero hits for `<script`, `javascript:`, `on*=`, `<iframe>`, `<form>`, `srcdoc`, `data:text/html` across all migrations | — |
| Authorization coverage | 30 of 30 protected routes carry an in-file DAL guard; 5 others are public by design | `src/app/**` |
| Cron endpoint | `timingSafeEqual`, 404 rather than 401, POST-only, no query-string token | `api/cron/[job]/route.ts` |
| CSP report endpoint | IP rate limit, 16 KB cap, field truncation, always 204 | `api/csp-report/route.ts` |
| Document serving | Self-authorizes, 401 without session, 404 for forbidden (no existence oracle), `attachment`, `no-store`, no `ETag` | `api/documents/[id]/route.ts` |
| Sessions | `__Host-` prefix, `httpOnly`, `secure` always, no `Domain`, only `sha256(token)` stored | `server/auth/session.ts:61-156` |
| Login throttle | Two independent axes, both HMAC-bucketed | `server/auth/throttle.ts:57,108-112` |
| Secrets in git | Four real env files ignored, only `.env.example` tracked, none ever committed | — |

---

## What was changed

### 1. The client address was read from the end the caller controls

`src/server/auth/dal.ts` took the **leftmost** `x-forwarded-for` entry. That is
the wrong end. `X-Forwarded-For` is a chain in which each proxy appends the peer
it received the request from, so entries run furthest-away first and the
leftmost one is the only entry in the header that no proxy vouched for — it is
whatever the caller sent. The function's own comment conceded the mechanism
("an attacker prepends entries freely") and then read that entry anyway.

Three controls keyed on it:

| Control | Call site |
|---|---|
| `publicFormIp`, 5/hour | `(site)/about/contact/actions.ts:92` |
| `cspReportIp` | `api/csp-report/route.ts:37` |
| **Login throttle, IP axis** | `server/auth/throttle.ts:112` |

A fresh header per request is a fresh bucket per request, which is the same as
no limit. Hashing the value does not help: an attacker does not need to know the
bucket key, only to change it.

**Bounded impact, stated honestly.** The throttle's identifier axis is
independent and was unaffected, so hammering one account was always locked out.
What was defeated is credential *spraying* across many accounts from one source,
and contact-form spam limiting.

**The fix counts in from the right**, which is correct without knowing the
host's Apache configuration — the fact the audit was blocked on, since
`RemoteIPHeader` lives in host config that is not in this repository:

- if Apache **appends** the peer, the rightmost entry is the one Apache wrote,
  and forged entries sit harmlessly to its left;
- if Apache **overwrites** the header, there is one entry and both readings
  agree.

Parsing moved to `src/server/auth/forwarded.ts`, which has no imports so it can
be tested without `next/headers`, `next/navigation` and the database client.
A chain shorter than the configured hop count returns `null` rather than falling
back toward the caller-controlled end. An `:port` suffix is now stripped — left
in place it failed validation and silently collapsed those requests into the
shared bucket, which is a rate limit that has quietly stopped telling anyone
apart while still looking like it works.

Hop count is `TRUSTED_PROXY_HOPS` (`src/server/env.ts`), documented in
`.env.example`, defaulting to `1`. It defaults rather than being `required()`
because there is a correct default and a host that refuses to boot over an unset
optional value is the worse outcome.

Tests: `tests/client-ip.test.ts`.

### 2. `.gitignore` did not cover `.env.production`

It matched `.env` and `.env*.local`. `.env.production` is a conventional Next.js
filename and matched neither. No such file existed — this closes the gap before
someone creates it on a deadline. Now `.env.*` with `!.env.example`, so the
template stays tracked.

### 3. Prototype-chain lookup in the legacy redirect map

`src/proxy.ts` indexed a plain object literal with a key built from the request,
so `constructor` or `toString` would return a truthy function where a `string`
is declared. **Not reachable** — `legacyRedirect` returns early unless the path
ends `.php` or `.html`, and nothing inherited does. Fixed anyway with
`Object.hasOwn`, because the guard making it unreachable is a routing decision
three lines away that a later change could loosen without anyone connecting the
two. The fix is at the lookup, not in `legacy-redirects.ts`, which is generated
and would lose it on the next run of `scripts/generate-redirect-map.ts`.

Tests: added to `tests/legacy-redirects.test.ts`.

### Verification

`npx tsc --noEmit` clean, `npm run lint` clean, `npx vitest run` — 45 files, 819
tests, all passing. The whole suite, not just the new files: `clientIp` feeds
twelve call sites.

---

## Still owed, on the host

Neither is a source change.

1. **Check Apache's `X-Forwarded-For` handling once.** The default of `1` matches
   the deployment as it exists, so nothing breaks if nothing is set. But if
   Apache passes the caller's header through *without appending*, no hop count
   helps — that configuration means the header is untrusted entirely and
   `TRUSTED_PROXY_HOPS=0` is the right answer.
2. **CSP is `Report-Only`, deliberately.** Flipping it is a launch gate, and it
   should be flipped only after reading a fortnight of real violation reports
   from `/api/csp-report`. An enforcing CSP shipped blind to a site with
   third-party embeds and a CMS breaks something on day one, and a blocked
   script fails silently.

---

## Considered and rejected

| Proposed | Why not |
|---|---|
| Flip CSP to enforcing now | Needs real violation data first. See above. |
| WAF, virus scanning, Redis-backed rate limiting | The shared cPanel host has none of them. Cloudflare's free tier is already recorded as a DNS-level launch decision, not a source change. |
| Harden the membership wizard, payments, uploads, numbering | Portal off, unreachable. Out of scope — these need their own pass before it is switched on. |
| Replace `'unsafe-inline'` in the public CSP with nonces | A nonce forces dynamic rendering and the public site must stay statically generated for the Lighthouse target. The mitigation is real: there is no injection sink, because rich text is sanitised on write. |
| CAPTCHA on the contact form | Defensible, but it is a feature with a third-party origin, a key and a UX cost — an owner's decision, not a security fix smuggled into a remediation pass. The `publicFormIp` limit became genuinely effective once change 1 landed, which was the actual defect. |
| Sanitise rich text on the read path too | The wrong instinct. Sanitising on write is one pass in one place, and the stored corpus is clean. Adding read-path sanitisation invites someone to later weaken the write-path guarantee. |
| Rotate `ENCRYPTION_KEY` / `IP_HASH_PEPPER` | Nothing indicates exposure and no secret was ever committed. Rotation without cause breaks decryption of existing data for no gain. |

---

## Limits of this audit

- **No independent verifier.** The run was sequential and single-threaded, so it
  lacks the second reviewer that catches an auditor's own blind spots. Three of
  the load-bearing claims — the unconditional `Origin` check, write-path-only
  sanitisation, and the five intentionally public routes — were re-checked
  against source in a separate pass and all held. Every other conclusion rests
  on the file references above, which are there to be checked rather than taken
  on trust.
- **Source inspection only.** No code was executed, and nothing was probed
  against a live or deployed system.
- **Scoped.** The membership surfaces listed above were not examined at all.
- One pass is not completeness. This is what was looked at on one day, by one
  reviewer, at one commit.
