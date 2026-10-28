import "server-only";

import { cache } from "react";
import { forbidden, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getDb } from "@/db/client";
import {
  ForbiddenError,
  UnauthenticatedError,
  type ActorContext,
} from "@/server/actor";
import { hashIp, hashUserAgent, newUlid } from "@/server/crypto";
import type { PermissionCode } from "@/server/permissions";
import { SESSION_COOKIE, SENTINEL_COOKIE, SENTINEL_VALUE } from "@/server/auth/session";
import { validateSessionToken, type ValidatedSession } from "@/server/auth/session";
import { tryWriteAudit } from "@/server/audit";

/**
 * The data access layer — the authorisation boundary.
 *
 * `src/proxy.ts` does an optimistic cookie-presence redirect so that an
 * unauthenticated visitor is not served a page shell before being bounced. It
 * is not a security boundary: it never reads the database, because the proxy
 * runs on every route including prefetches and a query there against a
 * three-connection pool is a self-inflicted outage.
 *
 * A layout is not the boundary either. Next's own documentation warns against
 * it: layouts do not re-render on navigation between sibling routes, so a
 * check in `app/admin/layout.tsx` runs once and then client-side navigations
 * render pages whose own code checked nothing. Layouts also do not protect
 * route handlers or server actions at all.
 *
 * This file is the boundary. Every page, action and handler begins with one of
 * these functions, and every exported function in `src/membership/` takes the
 * `ActorContext` they return.
 */

/**
 * The request id, stable for the whole request.
 *
 * `src/proxy.ts` sets `x-request-id`; this reads it, and mints one when there
 * is no proxy in the path (a cron invocation, a test). Wrapped in `cache` so
 * every call within one request gets the same id — which is the entire point,
 * since the id is what correlates the several audit events one action writes.
 */
export const getRequestId = cache(async (): Promise<string> => {
  try {
    const headerList = await headers();
    const fromProxy = headerList.get("x-request-id");
    if (fromProxy && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(fromProxy)) return fromProxy;
  } catch {
    // No request context — a script, or a cron job calling a domain function
    // directly. A fresh id is correct there.
  }
  return newUlid();
});

/**
 * Load the current session, at most once per request.
 *
 * `cache` is load-bearing rather than an optimisation. A single admin page
 * calls this from the layout, the page and three server components; without
 * memoisation that is five identical queries against a pool of three
 * connections, and the fifth waits on the first.
 */
export const getSession = cache(async (): Promise<ValidatedSession | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const result = await validateSessionToken(token);
  return result.ok ? result.value : null;
});

/**
 * True when this request carries the `SameSite=Strict` sentinel.
 *
 * Checked before irreversible actions. Next compares `Origin` against the host
 * for server actions, but a request carrying no `Origin` header at all is
 * allowed through with only a warning — so this is the second lock on that
 * door, and it costs a cookie read.
 */
export async function isSameSiteRequest(): Promise<boolean> {
  const jar = await cookies();
  return jar.get(SENTINEL_COOKIE)?.value === SENTINEL_VALUE;
}

/**
 * Build the actor for the current request.
 *
 * Roles and permissions come from the database rather than the session, so a
 * grant added while a session is live takes effect on the next request. A
 * grant *removed* is handled by `role_version`, which kills the session
 * outright — the asymmetry is deliberate: widening access should be immediate
 * and narrowing it should force a fresh sign-in.
 */
export const getActor = cache(async (): Promise<ActorContext | null> => {
  const session = await getSession();
  if (!session) return null;

  const [requestId, headerList] = await Promise.all([getRequestId(), safeHeaders()]);

  const grants = await getDb()
    .selectFrom("user_roles")
    .innerJoin("role_permissions", "role_permissions.role_code", "user_roles.role_code")
    .select(["user_roles.role_code", "role_permissions.permission_code"])
    .where("user_roles.user_id", "=", session.user.id)
    .execute();

  const roleCodes = [...new Set(grants.map((g) => g.role_code))];
  const permissions = new Set(
    grants.map((g) => g.permission_code as PermissionCode),
  );

  return {
    userId: session.user.id,
    userType: session.user.userType,
    // Where several roles are held, the first alphabetically is recorded on
    // audit events. The per-application separation-of-duties check inside the
    // approval transaction is what actually prevents one person performing two
    // conflicting acts, so this is a label rather than a control.
    roleCode: roleCodes.slice().sort()[0] ?? null,
    roleCodes,
    permissions,
    requestId,
    ipHash: hashIp(clientIp(headerList)),
    userAgentHash: hashUserAgent(headerList?.get("user-agent") ?? null),
    onBehalfOfUserId: null,
  };
});

async function safeHeaders(): Promise<Headers | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}

/**
 * The client address, as far as it can be trusted.
 *
 * Apache always fronts this app under Passenger, so exactly one proxy hop is
 * trusted and the leftmost `x-forwarded-for` entry is taken. An attacker
 * prepends entries freely, so this value is only ever used after hashing and
 * only for rate limiting and audit correlation — never for authorisation.
 *
 * This becomes `CF-Connecting-IP` the day Cloudflare lands in front, and at
 * that point Apache must also be restricted to Cloudflare's ranges, or anyone
 * who finds the origin address bypasses the WAF entirely. Recorded here
 * because that is a deployment change with a code change attached.
 */
export function clientIp(headerList: Headers | null): string | null {
  if (!headerList) return null;

  const forwarded = headerList.get("x-forwarded-for");
  if (!forwarded) return null;

  const first = forwarded.split(",")[0]?.trim();
  if (!first) return null;

  return looksLikeIp(first) ? first : null;
}

function looksLikeIp(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255);
  }
  // Loose but sufficient: the value is hashed, never resolved or connected to,
  // so the cost of accepting a malformed IPv6 literal is one useless bucket.
  return /^[0-9a-fA-F:]{2,45}$/.test(value) && value.includes(":");
}

/* -------------------------------------------------------------------------- */
/* The require* family                                                        */
/* -------------------------------------------------------------------------- */

/** Any authenticated actor. */
export async function requireActor(): Promise<ActorContext> {
  const actor = await getActor();
  if (!actor) throw new UnauthenticatedError();
  return actor;
}

/** An applicant or member. */
export async function requireMember(): Promise<ActorContext> {
  const actor = await requireActor();
  if (actor.userType !== "portal") {
    throw new ForbiddenError(null, "This area is for members and applicants.");
  }
  return actor;
}

/**
 * A staff account, optionally holding a permission.
 *
 * A denial is audit-logged. Denials are as interesting as successes: a spike
 * is either an attack or a grant somebody forgot to make, and both deserve
 * someone's attention.
 */
/**
 * Options for the two staff guards.
 *
 * `allowBeforeMfa` is held by exactly two routes — the sign-in page, which has
 * to render its own second step, and the enrolment page, which an account with
 * no authenticator must be able to reach. Everything else is refused until
 * `sessions.mfa_satisfied_at` is set, which is what makes enrolment a gate
 * rather than a suggestion. The flag is declared per route in `ROUTE_POLICY`
 * as well, so the two cannot drift without the inventory test noticing.
 */
export interface StaffGuardOptions {
  allowBeforeMfa?: boolean;
}

/** Thrown when a staff session exists but the second factor is outstanding. */
export class MfaRequiredError extends Error {
  /** True when there is no authenticator to present yet, only one to enrol. */
  readonly needsEnrolment: boolean;

  constructor(needsEnrolment: boolean) {
    super(
      needsEnrolment
        ? "Enrol an authenticator app to continue."
        : "Enter the code from your authenticator app to continue.",
    );
    this.name = "MfaRequiredError";
    this.needsEnrolment = needsEnrolment;
  }
}

export async function requireStaff(
  permission?: PermissionCode,
  options?: StaffGuardOptions,
): Promise<ActorContext> {
  const actor = await requireActor();

  if (actor.userType !== "staff") {
    throw new ForbiddenError(permission ?? null, "This area is for chamber staff.");
  }

  if (!options?.allowBeforeMfa) {
    // `getSession` is request-cached, so this is a property of a row already
    // loaded rather than another query against a three-connection pool.
    const session = await getSession();
    if (session && session.session.mfaSatisfiedAt === null) {
      throw new MfaRequiredError(session.user.mfaMode !== "totp");
    }
  }

  if (permission && !actor.permissions.has(permission)) {
    await tryWriteAudit(actor, {
      entityType: "permission",
      entityId: permission,
      action: "access.denied",
      summary: `Denied: ${permission}`,
    });
    throw new ForbiddenError(permission);
  }

  return actor;
}

/**
 * Require all of several permissions.
 *
 * Separate from `requireStaff` because the audit event should name every
 * permission that was missing, not just the first — otherwise fixing a grant
 * means discovering the next gap by trial and error.
 */
export async function requireStaffAll(
  permissions: readonly PermissionCode[],
  options?: StaffGuardOptions,
): Promise<ActorContext> {
  const actor = await requireActor();

  if (actor.userType !== "staff") {
    throw new ForbiddenError(null, "This area is for chamber staff.");
  }

  if (!options?.allowBeforeMfa) {
    const session = await getSession();
    if (session && session.session.mfaSatisfiedAt === null) {
      throw new MfaRequiredError(session.user.mfaMode !== "totp");
    }
  }

  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length > 0) {
    await tryWriteAudit(actor, {
      entityType: "permission",
      entityId: missing.join(","),
      action: "access.denied",
      summary: `Denied: ${missing.join(", ")}`,
    });
    throw new ForbiddenError(missing[0]);
  }

  return actor;
}

/* -------------------------------------------------------------------------- */
/* The page-level guard                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The guard an admin page calls, which turns each refusal into the right HTTP
 * answer instead of an exception.
 *
 * The three outcomes are genuinely different and must not be collapsed:
 *
 * - **No session**: redirect to the staff sign-in page. There is something
 *   useful to do, so a 401 screen would be a dead end.
 * - **Second factor outstanding**: redirect to whichever step is next — the
 *   code form, or enrolment for an account that has no authenticator yet.
 * - **Signed in and still not allowed**: `forbidden()`, which renders the 403
 *   boundary. Never a redirect: sending someone to sign in when they are
 *   already signed in is the single most confusing thing an admin area can
 *   do, and they will try different credentials to fix a problem that is not
 *   about credentials.
 *
 * `forbidden()` and `unauthorized()` work by throwing a framework error, so
 * this must be awaited in the render path — which it is, as the first line of
 * each page.
 */
export async function requireStaffPage(
  permission?: PermissionCode,
  options?: StaffGuardOptions,
): Promise<ActorContext> {
  try {
    return await requireStaff(permission, options);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      redirect("/admin/sign-in");
    }
    if (error instanceof MfaRequiredError) {
      redirect(error.needsEnrolment ? "/admin/setup-2fa" : "/admin/sign-in");
    }
    if (error instanceof ForbiddenError) {
      forbidden();
    }
    throw error;
  }
}
