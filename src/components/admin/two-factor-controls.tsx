"use client";

import { useActionState, useState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import { disableTwoFactorAction } from "@/app/(admin)/admin/security/actions";
import { TextField } from "@/components/membership/fields";
import { Button } from "@/components/ui/button";

/**
 * Turning two-factor off, as its own two-step control.
 *
 * **The password box is not shown until the holder asks for it.** A settings
 * page that renders a password field next to a "turn it off" button invites
 * the muscle memory of filling in every box on a form, and the thing this
 * particular box does is weaken the account. So the default state is a plain
 * link-weight button, and the confirmation — the warning, the password, the
 * destructive button — only appears once somebody has said that is what they
 * came for.
 *
 * It is also its own form rather than a button inside the page's, so that
 * pressing Enter in a field elsewhere on the screen cannot submit it. The same
 * reasoning as `content-delete-form.tsx`.
 */
export function DisableTwoFactor() {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    disableTwoFactorAction,
    IDLE,
  );
  const [confirming, setConfirming] = useState(false);

  // The page re-reads the setting on its next render, so once this has
  // succeeded there is nothing here to press again.
  if (state.status === "ok") {
    return (
      <p role="status" className="text-[0.9375rem] font-medium text-ink-900">
        {state.message}
      </p>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="self-start text-[0.9375rem] font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
      >
        Turn two-factor sign-in off
      </button>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <div className="rounded-lg border border-urgent-600/30 bg-urgent-50 p-4 text-[0.875rem] leading-relaxed text-ink-900">
        <strong className="font-semibold">
          Your password alone will sign you in.
        </strong>{" "}
        Your authenticator and your unused recovery codes are deleted, so
        turning it on again means pairing your app afresh. This account can
        read every identity document in the system, so if the reason is a lost
        or replaced phone, use a recovery code and re-pair instead.
      </div>

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

      <TextField
        name="password"
        type="password"
        // Not "Your password", which is also the heading of the section
        // below. Two controls or landmarks with the same accessible name on
        // one screen is a navigation problem before it is a cosmetic one.
        label="Confirm your password"
        hint="Confirming with your password is what stops someone using a session left open on a shared machine."
        error={state.fieldErrors?.password}
        autoComplete="current-password"
        required
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" disabled={pending}>
          {pending ? "Turning it off…" : "Turn two-factor off"}
        </Button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[0.875rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Keep it on
        </button>
      </div>
    </form>
  );
}
