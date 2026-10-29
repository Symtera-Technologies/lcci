import "server-only";

import type { PermissionCode } from "@/server/permissions";
import type { UserType } from "@/db/schema";
import { newUlid } from "@/server/crypto";

/**
 * Who is doing this, and under what request.
 *
 * Every mutating function in `src/membership/` and `src/server/` takes an
 * `ActorContext` as its first argument. That is a deliberate shape rather than
 * a convention: a Next.js server action is a publicly addressable endpoint, so
 * authorising in the component that renders the button authorises the button.
 * Making the actor a required parameter of the data layer means there is no
 * path — route handler, server action, cron job, future CLI — that reaches a
 * write without having had to say who is performing it.
 *
 * It also means every audit event has an actor without the writer having to
 * remember to look one up.
 */
export interface ActorContext {
  /** NULL for the system actor: a cron job has no user. */
  readonly userId: number | null;
  readonly userType: UserType | "system";
  /**
   * The role recorded on audit events. Where a user holds several, this is the
   * one the action was authorised under, so the log says which hat they wore.
   */
  readonly roleCode: string | null;
  readonly roleCodes: readonly string[];
  readonly permissions: ReadonlySet<PermissionCode>;
  /**
   * Department codes this actor's roles are scoped to, from `user_roles`
   * where `scope_kind = 'department'`.
   *
   * Empty means unscoped, which for a `super_admin` or a `reviewer` is the
   * whole chamber and for anyone else means they hold no departmental grant
   * at all. The two are distinguished by the permission, not by this list:
   * `content.read_draft` plus an empty scope is site-wide, and no
   * `content.read_draft` is no access whatever the scopes say. Row scoping is
   * a SQL predicate at the point of the read and never a post-fetch filter,
   * because a filter has already read the data and will leak it through a
   * count, an export or a log line.
   */
  readonly departmentScopes: readonly string[];
  /** One ULID per HTTP request, correlating every event the request writes. */
  readonly requestId: string;
  readonly ipHash: string | null;
  readonly userAgentHash: string | null;
  /** Set when staff act for an applicant, e.g. keying in a postal application. */
  readonly onBehalfOfUserId: number | null;
}

/**
 * The system actor, for cron jobs and migrations.
 *
 * It holds no permissions. A cron job that needs to change something calls the
 * domain function that performs that change, which checks its own invariants;
 * it does not get a blanket grant. Jobs that legitimately act outside the
 * permission model — closing an application for no response, expiring a draft
 * — are modelled as system transitions in the workflow table, so they are
 * enumerable rather than implicit.
 */
export function systemActor(requestId: string = newUlid()): ActorContext {
  return {
    userId: null,
    userType: "system",
    roleCode: null,
    roleCodes: [],
    permissions: new Set<PermissionCode>(),
    departmentScopes: [],
    requestId,
    ipHash: null,
    userAgentHash: null,
    onBehalfOfUserId: null,
  };
}

export function hasPermission(actor: ActorContext, permission: PermissionCode): boolean {
  return actor.permissions.has(permission);
}

/** Thrown when an actor lacks a permission. Rendered as 403, and audit-logged. */
export class ForbiddenError extends Error {
  readonly permission: PermissionCode | null;

  constructor(permission: PermissionCode | null, detail?: string) {
    super(
      detail ??
        (permission
          ? `This account does not hold ${permission}.`
          : "This account is not permitted to do that."),
    );
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

/** Thrown when there is no usable session at all. Rendered as 401. */
export class UnauthenticatedError extends Error {
  constructor(detail = "Sign in to continue.") {
    super(detail);
    this.name = "UnauthenticatedError";
  }
}

/**
 * Thrown when a guarded state change found the row already moved.
 *
 * Not an internal error and not a validation failure: it means another officer
 * acted first. The UI must say so and reload, because silently retrying would
 * overwrite a decision this request never saw.
 */
export class ConcurrencyError extends Error {
  constructor(what: string) {
    super(`${what} has changed since this page was loaded. Reload and try again.`);
    this.name = "ConcurrencyError";
  }
}

/**
 * Assert a permission, or throw.
 *
 * Denials are as interesting as successes — a spike is either an attack or a
 * missing grant — so callers at the repository boundary record the throw. The
 * check itself stays cheap and synchronous.
 */
export function requirePermission(
  actor: ActorContext,
  permission: PermissionCode,
): void {
  if (!actor.permissions.has(permission)) {
    throw new ForbiddenError(permission);
  }
}
