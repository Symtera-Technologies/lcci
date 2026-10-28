import type { Metadata } from "next";
import { getSession, requireStaffPage } from "@/server/auth/dal";
import { newTotpSecret, otpauthUri } from "@/server/auth/totp";
import { TotpEnrolment } from "@/components/admin/totp-enrolment";

export const metadata: Metadata = {
  title: "Two-factor setup",
  robots: { index: false, follow: false },
};

/**
 * Never cached, and never prerendered.
 *
 * It generates a fresh secret on every render, so a cached copy would hand two
 * people the same one.
 */
export const dynamic = "force-dynamic";

/**
 * Two-factor enrolment — the gate, not an option.
 *
 * `allowBeforeMfa` is what makes it reachable by an account that has nothing
 * to present yet. It is one of exactly two routes that hold that flag, and the
 * route policy declares it so the two cannot drift apart unnoticed.
 *
 * A fresh secret per render is deliberate: a half-finished enrolment leaves no
 * state behind, so abandoning the page and coming back simply starts again.
 * The cost is that reloading mid-enrolment invalidates the key just
 * transcribed, which is the right trade — the alternative is a pending secret
 * on the user row, which means every query touching that row has to reason
 * about a half-enrolled account.
 */
export default async function SetupTwoFactorPage() {
  const actor = await requireStaffPage(undefined, { allowBeforeMfa: true });
  const session = await getSession();
  if (!actor.userId || !session) return null;

  const { base32 } = newTotpSecret();

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-14">
      <p className="text-[0.8125rem] font-medium uppercase tracking-[0.12em] text-stone-500">
        Chamber staff
      </p>
      <h1 className="mt-2 text-[1.75rem] font-semibold tracking-tight text-ink-950">
        Set up two-factor sign-in
      </h1>
      <p className="mt-3 max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
        Staff accounts approve memberships, receipt money and can read every
        identity document in the system, so a password alone is not enough. Pair
        an authenticator app with your account to continue — there is nothing
        else this account can reach until you do.
      </p>

      <div className="mt-10">
        <TotpEnrolment
          secret={base32}
          // Grouped in fours, because the realistic failure here is a
          // mis-transcribed 32-character string read off a screen.
          secretDisplay={base32.replace(/(.{4})/g, "$1 ").trim()}
          uri={otpauthUri({
            secret: base32,
            accountName: session.user.email,
            issuer: "LCCI",
          })}
          replacing={session.user.mfaMode === "totp"}
        />
      </div>
    </main>
  );
}
