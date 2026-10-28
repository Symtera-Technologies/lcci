"use client";

import { useActionState } from "react";
import Link from "next/link";
import { IDLE, type ActionState } from "@/lib/action-state";
import { enrolAction } from "@/app/(admin)/admin/setup-2fa/actions";
import { TextField } from "@/components/membership/fields";
import { Button } from "@/components/ui/button";

export interface TotpEnrolmentProps {
  /** Base32, pre-grouped in fours for transcription. */
  secretDisplay: string;
  /** The raw base32, submitted back with the confirming code. */
  secret: string;
  /** `otpauth://` — what a QR code would encode, offered as a link. */
  uri: string;
  /** True when replacing a working authenticator rather than adding a first one. */
  replacing: boolean;
}

export function TotpEnrolment({
  secretDisplay,
  secret,
  uri,
  replacing,
}: TotpEnrolmentProps) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    enrolAction,
    IDLE,
  );

  const codes = state.data?.recoveryCodes?.split("\n").filter(Boolean) ?? [];

  if (codes.length > 0) return <RecoveryCodes codes={codes} />;

  return (
    <form action={action} className="flex flex-col gap-6" noValidate>
      {/* The secret returns with the code generated from it. It is already on
          this screen to be transcribed, the page is served `no-store`, and it
          is inert until a code derived from it is confirmed — so a hidden
          field is the honest place for it, rather than a pending-secret column
          that every other query on the user row would have to know about. */}
      <input type="hidden" name="secret" value={secret} />

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

      {replacing && (
        <div className="rounded-lg border border-urgent-600/30 bg-urgent-50 p-4 text-[0.875rem] leading-relaxed text-ink-900">
          <strong className="font-semibold">This replaces your current authenticator.</strong>{" "}
          Your old codes stop working, every session you have open is signed out,
          and a new set of recovery codes is issued. If you did not mean to do
          this, leave the page.
        </div>
      )}

      <ol className="flex flex-col gap-5 text-[0.9375rem] leading-relaxed text-ink-800">
        <li>
          <span className="font-medium text-ink-950">1. Add the key to your app.</span>{" "}
          In Google Authenticator, Microsoft Authenticator, 1Password or Authy,
          choose to add an account by entering a setup key, then type this in:
          <code className="mt-2 block break-all rounded-lg border border-stone-300 bg-stone-50 px-3 py-2.5 font-mono text-[0.9375rem] tracking-[0.08em] text-ink-950">
            {secretDisplay}
          </code>
          <span className="mt-2 block text-[0.8125rem] text-stone-600">
            The account name is your chamber address and the issuer is LCCI. On a
            phone you can instead open{" "}
            <a
              href={uri}
              className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4"
            >
              this setup link
            </a>
            , which fills both in for you.
          </span>
        </li>

        <li>
          <span className="font-medium text-ink-950">2. Enter the code it shows.</span>
          <div className="mt-2 max-w-[14rem]">
            <TextField
              name="code"
              label="Six-digit code"
              inputMode="numeric"
              autoComplete="one-time-code"
              error={state.fieldErrors?.code}
              required
            />
          </div>
        </li>
      </ol>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Confirming…" : replacing ? "Replace authenticator" : "Confirm and continue"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The ten codes, shown exactly once.
 *
 * They are scrypt digests in the database, so this is genuinely the only time
 * they can be displayed — which is why the page says so plainly and offers a
 * fresh set rather than pretending the moment can be recovered. Rendered as a
 * list that prints and copies cleanly, because what actually happens is that
 * somebody prints it and puts it in a drawer.
 */
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="flex flex-col gap-6">
      <div
        role="status"
        className="rounded-lg border border-success-600/30 bg-success-50 p-4 text-[0.9375rem] leading-relaxed text-ink-900"
      >
        <strong className="font-semibold">Authenticator enrolled.</strong> Save these
        ten recovery codes now — they are stored as one-way hashes, so this is the
        only time they can be shown. Each works once, and using one is recorded
        against your account.
      </div>

      <ol className="grid grid-cols-2 gap-2 rounded-lg border border-stone-300 bg-stone-50 p-4 font-mono text-[0.9375rem] tracking-[0.06em] text-ink-950">
        {codes.map((code, index) => (
          <li key={code} className="flex gap-2">
            <span aria-hidden className="w-5 text-right text-stone-500">
              {index + 1}
            </span>
            <span>{code}</span>
          </li>
        ))}
      </ol>

      <p className="text-[0.8125rem] leading-relaxed text-stone-600">
        If you leave this page without saving them, open two-factor setup again
        and enrol afresh — that issues a new set and invalidates these.
      </p>

      <p>
        <Link
          href="/admin"
          className="inline-flex h-11 items-center justify-center rounded-lg bg-brand-400 px-5 text-[0.9375rem] font-medium tracking-tight text-ink-950 shadow-sm transition-colors hover:bg-brand-300"
        >
          I have saved them — continue
        </Link>
      </p>
    </div>
  );
}
