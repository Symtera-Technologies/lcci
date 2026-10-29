import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import { formatDateShort } from "@/lib/format";
import { twoFactorStatus } from "@/server/auth/staff";
import { DisableTwoFactor } from "@/components/admin/two-factor-controls";

export const metadata: Metadata = {
  title: "Your sign-in",
  robots: { index: false, follow: false },
};

/** Per-actor, and a setting that changes under the reader. Never cached. */
export const dynamic = "force-dynamic";

/**
 * Each staff member's own sign-in settings.
 *
 * **No permission, by design.** Every staff account must be able to manage its
 * own sign-in; gating this on a grant would mean an officer who turned
 * two-factor on could not turn it off without finding a super administrator,
 * and the workaround people invent for that is sharing a login.
 *
 * It reads the setting for the signed-in actor and nothing else. There is
 * deliberately no list of colleagues and no way to change anyone else's
 * second factor from here: an administrator who could turn a colleague's
 * two-factor off could also turn it off, sign in as them and turn it back on,
 * which would make the audit trail describe the wrong person's decision. If
 * LCCI later wants two-factor required for a role, that belongs in the role
 * grants and the sign-in path, not as a button on somebody else's row.
 *
 * The honest framing of the recommendation lives on the screen rather than in
 * this comment, because the person who needs to read it is the officer, not
 * the next developer.
 */
export default async function SecurityPage() {
  const actor = await requireStaffPage();
  if (!actor.userId) return null;

  const { enabled, required, requiredBy, requiredAt, recoveryRemaining } =
    await twoFactorStatus(actor.userId);

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight text-ink-950">
        Your sign-in
      </h1>
      <p className="mt-2 max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
        How this account proves it is you. These settings are yours alone —
        nobody else, including a super administrator, changes them from here.
      </p>

      <section
        aria-labelledby="two-factor-heading"
        className="mt-8 rounded-xl border border-stone-200 bg-white p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <h2
            id="two-factor-heading"
            className="text-[1.0625rem] font-semibold text-ink-950"
          >
            Two-factor sign-in
          </h2>
          <p
            className={
              enabled
                ? "inline-flex items-center rounded-md border border-success-700/50 bg-success-100 px-2 py-0.5 text-[0.75rem] font-medium whitespace-nowrap text-success-900"
                : required
                  ? "inline-flex items-center rounded-md border border-urgent-600/40 bg-urgent-50 px-2 py-0.5 text-[0.75rem] font-medium whitespace-nowrap text-urgent-700"
                  : "inline-flex items-center rounded-md border border-stone-300 bg-stone-100 px-2 py-0.5 text-[0.75rem] font-medium whitespace-nowrap text-ink-700"
            }
          >
            {enabled ? "On" : required ? "Required, not set up" : "Off"}
          </p>
        </div>

        <p className="mt-3 max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
          {enabled
            ? "After your password, you enter a six-digit code from your authenticator app. Someone who learns your password still cannot sign in."
            : "Your password alone signs you in. Anyone who learns it — from a reused password on another site, or over your shoulder — has everything this account can reach."}
        </p>

        {/*
          Named, not anonymous. "An administrator requires this" leaves the
          holder with a demand and nobody to ask about it; the audit log has
          the answer and is a page they cannot open.
        */}
        {required && (
          <p className="mt-3 max-w-prose text-[0.9375rem] leading-relaxed text-ink-800">
            <strong className="font-semibold">
              Two-factor sign-in is required on this account
              {requiredBy ? `, set by ${requiredBy}` : ""}
              {requiredAt ? ` on ${formatDateShort(requiredAt.toISOString())}` : ""}.
            </strong>{" "}
            {enabled
              ? "You can pair a different app, but you cannot turn it off. Ask whoever set it if that needs to change."
              : "Pair an authenticator app to use the backend — nothing else here is reachable until you do."}
          </p>
        )}

        {/*
          Said once, plainly, where the decision is made — and only where it is
          still the holder's to make. Staff accounts here approve memberships,
          receipt money and open identity documents, so a recommendation is
          honest; nagging on every screen is not, and an account holder who is
          pressed at every sign-in learns to click past warnings generally.
        */}
        {!enabled && !required && (
          <p className="mt-3 max-w-prose text-[0.9375rem] leading-relaxed text-ink-800">
            This account can approve memberships, receipt fees and read the
            CNICs and bank certificates applicants upload. Turning two-factor
            on takes about a minute and is strongly recommended.
          </p>
        )}

        {enabled && (
          <p className="mt-3 text-[0.875rem] text-ink-700">
            {recoveryRemaining === 0
              ? "You have no unused recovery codes left. Replace your authenticator to be issued a fresh set — without them, a lost phone means asking a super administrator for help."
              : `${recoveryRemaining} of your ten recovery codes ${
                  recoveryRemaining === 1 ? "is" : "are"
                } still unused.`}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-5 border-t border-stone-200 pt-5">
          <Link
            href="/admin/setup-2fa"
            className={
              enabled
                ? "self-start text-[0.9375rem] font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
                : "self-start rounded-lg bg-brand-800 px-4 py-2 text-[0.875rem] font-medium text-white hover:bg-brand-900"
            }
          >
            {enabled ? "Pair a different authenticator" : "Turn two-factor on"}
          </Link>

          {/*
            The off switch is absent, not disabled, when it is required. A
            disabled control invites the holder to work out how to enable it;
            the sentence above has already told them it is not theirs to
            change, and who to ask. `disableTotp` refuses it server-side too —
            the hidden button is not the control.
          */}
          {enabled && !required && <DisableTwoFactor />}
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-stone-200 bg-white p-6">
        <h2 className="text-[1.0625rem] font-semibold text-ink-950">Your password</h2>
        <p className="mt-3 max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
          Changing your own password is not built yet — ask a super
          administrator, who will set a new one and sign out every session this
          account has open. Until then: do not reuse it on any other site, and
          tell the secretariat at once if you think somebody else has it.
        </p>
      </section>
    </main>
  );
}
