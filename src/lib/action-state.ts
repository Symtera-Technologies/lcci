/**
 * The shape a server action returns, shared with the client.
 *
 * Separate from `src/server/action.ts` because that module opens with
 * `server-only` — rightly, since it reads headers, touches the session and
 * consumes rate limits — and a client component that renders the result of an
 * action still has to name its type. Importing the wrapper to get at
 * `ActionState` would drag the whole server boundary into the browser bundle,
 * and `server-only` would stop the build before it got there.
 *
 * So the contract lives here, with no imports of its own, and
 * `src/server/action.ts` re-exports it. One definition, two consumers, no
 * leak.
 */

export interface ActionState {
  status: "idle" | "ok" | "error";
  message?: string;
  /** Keyed by the form field name, so the UI can place each error at its input. */
  fieldErrors?: Record<string, string>;
  /**
   * Values the action hands back for the form to render **once**.
   *
   * It exists for one shape of problem: something generated server-side that
   * the user must see exactly now and that the server deliberately cannot show
   * again — two-factor recovery codes, which are stored as scrypt digests, so
   * there is no second chance to display them.
   *
   * The alternative was carrying them through a redirect in the query string,
   * where they would land in the Apache access log, in `Referer` on every
   * asset the page loads, and in the browser history of a shared secretariat
   * machine. Returning them in the action result keeps them in one response
   * body on a `no-store` page.
   *
   * Not state, not storage, and never persisted: a refresh loses it, which is
   * correct, and any flow using it must offer a way to generate a fresh set.
   */
  data?: Record<string, string>;
}

export const IDLE: ActionState = { status: "idle" };

export function ok(message?: string, data?: Record<string, string>): ActionState {
  return {
    status: "ok",
    ...(message ? { message } : {}),
    ...(data ? { data } : {}),
  };
}

export function fail(message: string, fieldErrors?: Record<string, string>): ActionState {
  return { status: "error", message, ...(fieldErrors ? { fieldErrors } : {}) };
}
