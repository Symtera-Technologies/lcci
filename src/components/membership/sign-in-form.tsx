"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import { requestCodeAction, verifyCodeAction } from "@/app/(portal)/membership/sign-in/actions";
import { CheckboxField, TextField } from "@/components/membership/fields";
import { Button } from "@/components/ui/button";

/**
 * The sign-in form, in two stages on one page.
 *
 * One page rather than two routes, because the second stage needs the
 * identifier from the first and a redirect would have to carry it in the URL —
 * where it lands in the Apache access log, in `Referer` on every asset the
 * page loads, and in the browser history of a shared office machine. Holding
 * it in component state costs nothing and keeps an email address out of three
 * logs. The stage is state rather than a query parameter for the same reason.
 */

type Stage = "identifier" | "code";

export interface SignInFormProps {
  /** Where to land after signing in. Already reduced to a safe path. */
  next: string;
  /** True when the member has just signed out, so the page can say so. */
  signedOut?: boolean;
}

export function SignInForm({ next, signedOut = false }: SignInFormProps) {
  const [requestState, requestAction, requesting] = useActionState<ActionState, FormData>(
    requestCodeAction,
    IDLE,
  );
  const [verifyState, verifyAction, verifying] = useActionState<ActionState, FormData>(
    verifyCodeAction,
    IDLE,
  );

  const [identifier, setIdentifier] = useState("");
  const codePanel = useRef<HTMLDivElement>(null);

  /**
   * The stage is derived, not stored.
   *
   * A code has been sent, so the code box is what the member needs next —
   * which is a fact about `requestState`, not a second piece of state to keep
   * in step with it. `editingIdentifier` is the one thing the member can say
   * that the action result does not already imply ("that was the wrong
   * address"), and it is cleared when they ask for another code, on the submit
   * event rather than in an effect.
   */
  const [editingIdentifier, setEditingIdentifier] = useState(false);
  const stage: Stage =
    requestState.status === "ok" && !editingIdentifier ? "code" : "identifier";

  // Move focus to the code box when it appears. Without this, a keyboard or
  // screen-reader user is left on a submit button that has just been replaced,
  // with no indication that a new field arrived further down the page.
  useEffect(() => {
    if (stage !== "code") return;
    codePanel.current?.querySelector<HTMLInputElement>('input[name="code"]')?.focus();
  }, [stage]);

  /**
   * One live region for the whole form.
   *
   * `role="status"`, not `role="alert"`: these messages are the outcome of
   * something the member just did, and an assertive interruption is reserved
   * for things that arrive unbidden. The region is always in the DOM with its
   * contents swapped, because a live region inserted at the moment it has
   * something to say is frequently not announced at all.
   */
  const announcement =
    verifyState.message ??
    requestState.message ??
    (signedOut ? "You have been signed out." : "");

  return (
    <div className="flex flex-col gap-6">
      <p
        role="status"
        aria-live="polite"
        className={messageClass(verifyState, requestState, signedOut)}
      >
        {announcement}
      </p>

      {stage === "identifier" ? (
        <form
          action={requestAction}
          onSubmit={() => setEditingIdentifier(false)}
          className="flex flex-col gap-5"
          noValidate
        >
          <input type="hidden" name="next" value={next} />

          <TextField
            name="identifier"
            label="Email address or membership number"
            autoComplete="username"
            hint="We send a six-digit code to the address registered with the Chamber. There is no password to remember."
            error={requestState.fieldErrors?.identifier}
            value={identifier}
            onValueChange={setIdentifier}
            required
          />

          <div>
            <Button type="submit" disabled={requesting}>
              {requesting ? "Sending…" : "Send sign-in code"}
            </Button>
          </div>
        </form>
      ) : (
        <div ref={codePanel} className="flex flex-col gap-5">
          <form action={verifyAction} className="flex flex-col gap-5" noValidate>
            {/* Submitted rather than re-entered. Asking for the identifier a
                second time is how a member types a different address on the
                second screen and is told their correct code is wrong. */}
            <input type="hidden" name="identifier" value={identifier} />
            <input type="hidden" name="next" value={next} />

            <TextField
              name="code"
              label="Six-digit code"
              inputMode="numeric"
              // The one token browsers and both mobile platforms honour for an
              // emailed or texted code. Without it the member retypes digits
              // they could have tapped.
              autoComplete="one-time-code"
              hint="It expires in 10 minutes and can be used once."
              error={verifyState.fieldErrors?.code}
              required
            />

            <CheckboxField
              name="remember"
              label="Keep me signed in on this device"
              hint="Leave this unticked on a shared or public computer."
            />

            <div>
              <Button type="submit" disabled={verifying}>
                {verifying ? "Checking…" : "Sign in"}
              </Button>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {/* The same action as stage one, so the identifier is normalised
                and the limits are keyed identically on a resend. */}
            <form action={requestAction} onSubmit={() => setEditingIdentifier(false)}>
              <input type="hidden" name="identifier" value={identifier} />
              <input type="hidden" name="next" value={next} />
              <button
                type="submit"
                disabled={requesting}
                className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700 disabled:opacity-50"
              >
                {requesting ? "Sending…" : "Send another code"}
              </button>
            </form>

            <button
              type="button"
              onClick={() => setEditingIdentifier(true)}
              className="font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Use a different address
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function messageClass(
  verifyState: ActionState,
  requestState: ActionState,
  signedOut: boolean,
): string {
  const base = "min-h-6 text-sm";
  const state = verifyState.status !== "idle" ? verifyState : requestState;

  if (state.status === "error") return `${base} font-medium text-urgent-700`;
  if (state.status === "ok" || signedOut) return `${base} text-ink-700`;
  // Reserves the line's height so the form does not jump when a message
  // arrives, without putting an empty paragraph in the accessibility tree's
  // way.
  return `${base} text-transparent`;
}
