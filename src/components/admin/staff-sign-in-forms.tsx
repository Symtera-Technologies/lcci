"use client";

import { useActionState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  passwordAction,
  secondFactorAction,
} from "@/app/(admin)/admin/sign-in/actions";
import { TextField } from "@/components/membership/fields";
import { Button } from "@/components/ui/button";

/**
 * The two staff sign-in forms.
 *
 * Two components rather than one with a stage, because the stage is a fact
 * about the session and the server already knows it. The page decides which to
 * render; neither of these holds any state but its own action result. That is
 * also what makes a refresh, a second tab and the back button behave — there
 * is nothing client-side to get out of step.
 *
 * Reusing the wizard's `TextField` on purpose: the error placement, the
 * `aria-describedby` wiring and the 44px control height were worked out there
 * and a sign-in form has no reason to have its own.
 */

export function PasswordForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    passwordAction,
    IDLE,
  );

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <Announcement state={state} />

      <TextField
        name="email"
        label="Chamber email address"
        type="email"
        autoComplete="username"
        error={state.fieldErrors?.email}
        required
      />

      <TextField
        name="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        error={state.fieldErrors?.password}
        required
      />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}

export function SecondFactorForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    secondFactorAction,
    IDLE,
  );

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <Announcement state={state} />

      <p className="text-[0.9375rem] text-ink-700">
        Signing in as <span className="font-medium text-ink-950">{email}</span>.
      </p>

      <TextField
        name="code"
        label="Authenticator code"
        inputMode="numeric"
        autoComplete="one-time-code"
        hint="The six digits from your authenticator app. If you have lost your phone, enter one of your recovery codes instead."
        error={state.fieldErrors?.code}
        required
      />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Checking…" : "Sign in"}
        </Button>
      </div>
    </form>
  );
}

/**
 * One polite live region per form.
 *
 * `role="status"` rather than `role="alert"`: the message is the result of a
 * submission the user just made, not something arriving unbidden. The node is
 * always present with its contents swapped, because a live region added to the
 * DOM at the moment it has something to say is often never announced.
 */
function Announcement({ state }: { state: ActionState }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={
        state.status === "error"
          ? "min-h-6 text-sm font-medium text-urgent-700"
          : "min-h-6 text-sm text-transparent"
      }
    >
      {state.message ?? ""}
    </p>
  );
}
