import "server-only";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { env } from "@/server/env";
import { logError, log } from "@/server/log";
import {
  ConcurrencyError,
  ForbiddenError,
  UnauthenticatedError,
  type ActorContext,
} from "@/server/actor";
import {
  getRequestId,
  isSameSiteRequest,
  requireMember,
  requireStaff,
  clientIp,
  MfaRequiredError,
} from "@/server/auth/dal";
import { consume, type LimitName } from "@/server/rate-limit";
import { fail as failState, type ActionState } from "@/lib/action-state";
import type { PermissionCode } from "@/server/permissions";

/**
 * The server-action contract and its wrapper.
 *
 * The state shape extends the one `src/components/home/subscribe-action.ts`
 * already established — `status`/`message`, errors returned as values rather
 * than thrown, the `(prev, formData)` signature — with one addition it did not
 * need and the application wizard cannot do without: a per-field error map.
 * One email field is served by a single message; sixty fields across four
 * steps are not.
 *
 * That file also validates by hand, with a comment explaining why
 * ("intentionally permissive: the provider is the real validator"). That was
 * right for one email address and does not scale to the membership form, its
 * thirteen checklist items and a legacy import. So zod is now a declared
 * dependency and actions validate with it, keeping the file shape and
 * replacing the body.
 */

// Defined in `src/lib/action-state.ts`, which has no `server-only` guard, so
// that a client component can name the type it renders without pulling the
// server boundary into the browser bundle. Re-exported here because this is
// where callers expect to find it.
export { IDLE, ok, fail, type ActionState } from "@/lib/action-state";

/* -------------------------------------------------------------------------- */
/* Origin checking                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Require a present, matching `Origin`.
 *
 * Next compares `Origin` against `host`/`x-forwarded-host` for server actions
 * and rejects a mismatch — but a request carrying **no** `Origin` header at
 * all is allowed through with only a warning. That is the gap this closes, in
 * the one place every action passes through, in six lines.
 *
 * Compared against the configured `SITE_ORIGIN` rather than against the
 * request's own host, because behind Apache the forwarded host is exactly the
 * value under dispute.
 */
async function assertSameOrigin(): Promise<void> {
  const headerList = await headers();
  const origin = headerList.get("origin");

  if (!origin) {
    throw new ForbiddenError(
      null,
      "This request could not be verified. Reload the page and try again.",
    );
  }

  let requestOrigin: string;
  try {
    requestOrigin = new URL(origin).origin;
  } catch {
    throw new ForbiddenError(null, "This request could not be verified.");
  }

  if (requestOrigin !== env.siteOrigin) {
    log.warn("server action origin mismatch", { outcome: "denied" });
    throw new ForbiddenError(null, "This request could not be verified.");
  }
}

/* -------------------------------------------------------------------------- */
/* The wrapper                                                                */
/* -------------------------------------------------------------------------- */

export interface ActionOptions<TSchema extends z.ZodType> {
  /** For the log line and the rate-limit subject. Not shown to the user. */
  name: string;
  /** Who may call it. `"public"` is for the newsletter and contact forms. */
  audience: "public" | "member" | "staff";
  /** Required for a staff action; ignored otherwise. */
  permission?: PermissionCode;
  /** The shape of the submitted form. */
  schema: TSchema;
  /** Which limit to consume, and what to key it on. */
  rateLimit?: { name: LimitName; subject: "ip" | "actor" };
  /**
   * Set for an action that cannot be undone — approve, reject, delete, issue
   * a certificate. Adds the `SameSite=Strict` sentinel check on top of the
   * `Origin` check, so a request that arrived cross-site is refused even if it
   * managed to present a session cookie.
   */
  irreversible?: boolean;
  /**
   * Set only by the two actions that run while a staff session is still
   * half-authenticated: submitting the authenticator code, and enrolling one.
   * Everything else must be refused until the second factor is satisfied.
   */
  allowBeforeMfa?: boolean;
}

export type ActionHandler<TSchema extends z.ZodType> = (args: {
  input: z.output<TSchema>;
  actor: ActorContext | null;
  formData: FormData;
}) => Promise<ActionState>;

/**
 * Wrap a server action with everything every action needs.
 *
 * Order matters and is not arbitrary. Origin before anything else, because a
 * cross-site request should not reach the rate limiter and spend a victim's
 * allowance. Rate limit before authentication, because an unauthenticated
 * flood is the case the limiter exists for. Authentication before validation,
 * because validation errors leak the shape of a form the caller has no right
 * to submit.
 *
 * Nothing is thrown out of here. Every failure becomes a value, because the
 * `useActionState` pattern already in use across the home components renders a
 * returned message into a live region and has nowhere to put an exception.
 */
export function withAction<TSchema extends z.ZodType>(
  options: ActionOptions<TSchema>,
  handler: ActionHandler<TSchema>,
): (prev: ActionState, formData: FormData) => Promise<ActionState> {
  return async function action(_prev: ActionState, formData: FormData) {
    const requestId = await getRequestId();

    try {
      await assertSameOrigin();

      if (options.irreversible && !(await isSameSiteRequest())) {
        return failState("This request could not be verified. Reload the page and try again.");
      }

      let actor: ActorContext | null = null;
      if (options.audience === "member") actor = await requireMember();
      else if (options.audience === "staff") {
        actor = await requireStaff(options.permission, {
          allowBeforeMfa: options.allowBeforeMfa,
        });
      }

      if (options.rateLimit) {
        const subject = await rateLimitSubject(options.rateLimit.subject, actor);
        const result = await consume(options.rateLimit.name, subject);
        if (!result.allowed) {
          return failState(
            result.tooSoon
              ? `Please wait ${result.retryAfterSeconds} seconds before trying again.`
              : "Too many attempts. Please try again later.",
          );
        }
      }

      const parsed = options.schema.safeParse(formDataToObject(formData));
      if (!parsed.success) {
        return failState("Please check the highlighted fields.", fieldErrorsFrom(parsed.error));
      }

      return await handler({ input: parsed.data, actor, formData });
    } catch (error) {
      // First, always. `redirect()` and `notFound()` work by throwing an
      // internal error that Next itself must receive, and this catch is broad
      // enough to swallow it — which would turn a successful submission that
      // redirects to its receipt page into "something went wrong on our side",
      // after the transition had already committed. `unstable_rethrow` is the
      // documented way to let those through; it is unstable in name only, and
      // the alternative is matching on an error digest by hand.
      unstable_rethrow(error);

      if (error instanceof UnauthenticatedError) {
        return failState("Your session has ended. Sign in again to continue.");
      }
      if (error instanceof MfaRequiredError) {
        // Its own message, because "session ended" would be wrong and
        // misleading: the session is fine and the second factor is the step
        // that is missing.
        return failState(error.message);
      }
      if (error instanceof ForbiddenError) {
        return failState(error.message);
      }
      if (error instanceof ConcurrencyError) {
        return failState(error.message);
      }

      // Anything else is ours, not the caller's. The user gets a generic
      // message with the request id so support can find the matching log line;
      // the detail goes to `logError`, which strips the driver's SQL and bound
      // parameters before anything is written.
      logError("server action failed", error, { action: options.name, requestId });
      return failState(
        `Something went wrong on our side. Please try again — if it keeps ` +
          `happening, quote reference ${requestId}.`,
      );
    }
  };
}

async function rateLimitSubject(
  kind: "ip" | "actor",
  actor: ActorContext | null,
): Promise<string> {
  if (kind === "actor" && actor?.userId) return `user:${actor.userId}`;

  const headerList = await headers();
  const ip = clientIp(headerList);
  // A missing address falls back to a single shared bucket rather than to an
  // unlimited one. It means addressless requests throttle each other, which is
  // the safe direction: the alternative is one header away from no limit.
  return ip ? `ip:${ip}` : "ip:unknown";
}

/**
 * Flatten a FormData into a plain object for zod.
 *
 * Repeated keys become arrays, which is what a multi-select of business types
 * and a repeatable directors list both produce. `File` entries are dropped:
 * files never travel through a server action in this app — they stream to the
 * upload route and the action carries document ids — so a File arriving here
 * is a mistake, and silently dropping it would hide it. Hence the explicit
 * marker.
 */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of formData.entries()) {
    const normalised = value instanceof File ? "__file__" : value;

    if (key in out) {
      const existing = out[key];
      if (Array.isArray(existing)) existing.push(normalised);
      else out[key] = [existing, normalised];
    } else {
      out[key] = normalised;
    }
  }

  return out;
}

/**
 * One message per field, at the field.
 *
 * Only the first error per path: showing a field three simultaneous complaints
 * is how a form becomes unreadable, and the user can only fix one at a time
 * anyway. The array index is kept in the key (`directors.0.cnic`) so a
 * repeatable section can place the error on the right row.
 */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "_form";
    if (!(key in out)) out[key] = issue.message;
  }

  return out;
}
