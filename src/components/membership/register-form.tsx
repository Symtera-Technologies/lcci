"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { IDLE, type ActionState } from "@/lib/action-state";
import {
  confirmRegistrationAction,
  startRegistrationAction,
} from "@/app/(portal)/membership/register/actions";
import { CheckboxField, TextField } from "@/components/membership/fields";
import { Button } from "@/components/ui/button";

/**
 * Opening an account, in two stages on one page.
 *
 * The same shape as the sign-in form, and for the same reason: the second
 * stage needs the address from the first, and a redirect would have to carry
 * it in the URL — where it lands in the Apache access log, in `Referer` on
 * every asset the page loads, and in the browser history of a shared office
 * machine. Holding it in component state costs nothing and keeps an email
 * address out of three logs.
 *
 * All three stage-one fields are controlled, which the sign-in form only needs
 * for one. The difference is that this form can go back: "use a different
 * address" remounts stage one, and an uncontrolled input would come back empty
 * so a typo in the email would cost the applicant their name and number too.
 */

type Stage = "details" | "code";

export interface RegisterFormProps {
  /** Where to land once the account exists. Already reduced to a safe path. */
  next: string;
}

export function RegisterForm({ next }: RegisterFormProps) {
  const [startState, startAction, starting] = useActionState<ActionState, FormData>(
    startRegistrationAction,
    IDLE,
  );
  const [confirmState, confirmAction, confirming] = useActionState<ActionState, FormData>(
    confirmRegistrationAction,
    IDLE,
  );

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const codePanel = useRef<HTMLDivElement>(null);

  /**
   * Which stage to show, from the action's result plus two corrections.
   *
   * `startState.status === "ok"` alone is nearly enough: a code has been sent,
   * so the code box is what the applicant needs next. It is wrong for exactly
   * one transition, and that transition is common. "Send another code" is the
   * *same* action, so a resend refused for spacing — "a code was just sent,
   * wait 40 seconds" — turns the status to `error` and collapses the form back
   * to the details stage, taking away the code box of somebody who is holding
   * a perfectly good code. Asking again is refused for the same 40 seconds, so
   * the only way out is to wait while looking at the wrong screen.
   *
   * `codeSent` latches that away. It means "a code has been sent to the
   * address currently in the box", which is why changing the address clears it
   * — otherwise editing the email and being refused for spacing would show a
   * code box whose hidden field names an address no challenge exists for.
   *
   * `editingDetails` is the one thing the applicant can say that the action
   * result does not already imply ("those were the wrong details"), and it is
   * cleared on the submit event rather than in an effect.
   */
  const [codeSent, setCodeSent] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const stage: Stage =
    (startState.status === "ok" || codeSent) && !editingDetails ? "code" : "details";

  /**
   * Set during render rather than in an effect, deliberately: an effect would
   * render the details stage once with a successful result already in hand,
   * which is a visible flash of the wrong form on the happy path.
   */
  if (startState.status === "ok" && !codeSent) setCodeSent(true);

  function changeEmail(value: string): void {
    setEmail(value);
    // The latch belongs to the address it was earned by.
    setCodeSent(false);
  }

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
   * something the applicant just did, and an assertive interruption is
   * reserved for what arrives unbidden. The region is always in the DOM with
   * its contents swapped, because a live region inserted at the moment it has
   * something to say is frequently not announced at all.
   */
  const announcement = confirmState.message ?? startState.message ?? "";

  return (
    <div className="flex flex-col gap-6">
      <p
        role="status"
        aria-live="polite"
        className={messageClass(confirmState, startState)}
      >
        {announcement}
      </p>

      {stage === "details" ? (
        <form
          action={startAction}
          onSubmit={() => setEditingDetails(false)}
          className="flex flex-col gap-5"
          noValidate
        >
          <input type="hidden" name="next" value={next} />

          <TextField
            name="fullName"
            label="Your full name"
            autoComplete="name"
            hint="The person applying, not the firm. You will name the firm on the form itself."
            error={startState.fieldErrors?.fullName}
            value={fullName}
            onValueChange={setFullName}
            maxLength={160}
            required
          />

          <TextField
            name="email"
            label="Email address"
            type="email"
            autoComplete="email"
            inputMode="email"
            hint="Every message about your application goes here, and it is how you sign in afterwards. There is no password."
            error={startState.fieldErrors?.email}
            value={email}
            onValueChange={changeEmail}
            maxLength={190}
            required
          />

          <TextField
            name="mobile"
            label="Mobile number"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="0300-1234567"
            hint="So the Secretariat can reach you if something on the form needs a word."
            error={startState.fieldErrors?.mobile}
            value={mobile}
            onValueChange={setMobile}
            maxLength={40}
            required
          />

          <div>
            <Button type="submit" disabled={starting}>
              {starting ? "Sending…" : "Send confirmation code"}
            </Button>
          </div>
        </form>
      ) : (
        <div ref={codePanel} className="flex flex-col gap-5">
          <form action={confirmAction} className="flex flex-col gap-5" noValidate>
            {/* Submitted rather than re-entered. Asking for the address a
                second time is how somebody types a different one on the
                second screen and is told their correct code is wrong. */}
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="next" value={next} />

            <TextField
              name="code"
              label="Six-digit code"
              inputMode="numeric"
              // The one token browsers and both mobile platforms honour for an
              // emailed or texted code. Without it the applicant retypes
              // digits they could have tapped.
              autoComplete="one-time-code"
              hint={`Sent to ${email}. It expires in 10 minutes and can be used once.`}
              error={confirmState.fieldErrors?.code}
              required
            />

            <CheckboxField
              name="remember"
              label="Keep me signed in on this device"
              hint="Leave this unticked on a shared or public computer."
            />

            <div>
              <Button type="submit" disabled={confirming}>
                {confirming ? "Checking…" : "Confirm and start my application"}
              </Button>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {/* The same action as stage one, so the address is normalised and
                the limits are keyed identically on a resend. */}
            <form action={startAction} onSubmit={() => setEditingDetails(false)}>
              <input type="hidden" name="fullName" value={fullName} />
              <input type="hidden" name="email" value={email} />
              <input type="hidden" name="mobile" value={mobile} />
              <input type="hidden" name="next" value={next} />
              <button
                type="submit"
                disabled={starting}
                className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700 disabled:opacity-50"
              >
                {starting ? "Sending…" : "Send another code"}
              </button>
            </form>

            <button
              type="button"
              onClick={() => setEditingDetails(true)}
              className="font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Change my details
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function messageClass(confirmState: ActionState, startState: ActionState): string {
  const base = "min-h-6 text-sm";
  const state = confirmState.status !== "idle" ? confirmState : startState;

  if (state.status === "error") return `${base} font-medium text-urgent-700`;
  if (state.status === "ok") return `${base} text-ink-700`;
  // Reserves the line's height so the form does not jump when a message
  // arrives, without putting an empty paragraph in the accessibility tree's
  // way.
  return `${base} text-transparent`;
}
