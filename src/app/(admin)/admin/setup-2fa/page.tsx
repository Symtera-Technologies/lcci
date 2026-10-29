import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
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
 * Two-factor enrolment, reached two ways: by choice from `/admin/security`
 * inside a fully signed-in session, and under compulsion by an account an
 * administrator has required two-factor on, which cannot reach anything else
 * until it pairs an app.
 *
 * That second route is why `allowBeforeMfa` is back. It was removed when
 * two-factor became each staff member's own setting, on the reasoning that
 * enrolment always happens inside an already-trusted session — true then, and
 * untrue the moment an administrator could impose the requirement. Without the
 * exemption this page is the destination of its own guard and loops.
 *
 * The exemption is deliberately wider than the rule, so the rule is restated
 * below: it admits an account that owes an *enrolment*, and the check in the
 * body turns away one that owes a *code*.
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

  // An account that owes a code can produce one, and must. Letting a session
  // that has not yet produced it pair a *new* authenticator would make a stolen
  // password sufficient on its own: the thief pairs their own app over the real
  // holder's and the second factor is theirs. The enrolment action states the
  // same rule again, because this check is not the control — it only keeps the
  // holder off a page that would refuse them.
  if (session.session.mfaSatisfiedAt === null && session.user.twoFactorEnabled) {
    redirect("/admin/sign-in");
  }

  const { base32 } = newTotpSecret();

  const replacing = session.user.mfaMode === "totp";

  // An account an administrator has required two-factor on arrives here owing
  // an enrolment rather than choosing one, and this is the only page its
  // session can reach. The second clause is already guaranteed by the redirect
  // above and is written out anyway, so that what this flag means survives
  // somebody moving or relaxing that redirect.
  const compelled =
    session.session.mfaSatisfiedAt === null && !session.user.twoFactorEnabled;

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-14">
      {/*
        No breadcrumb for an account that was sent here. `/admin/security` sits
        behind the very gate this page exists to pass, so the link would bounce
        straight back — a way out that is not one reads as a broken page.
      */}
      {!compelled && (
        <nav aria-label="Breadcrumb" className="text-[0.875rem]">
          <Link
            href="/admin/security"
            className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
          >
            Your sign-in
          </Link>
        </nav>
      )}
      {/*
        Deliberately the same words whether this is a first enrolment or a
        replacement, and that is not laziness. Confirming enrolment re-renders
        this page with `replacing` now true, so a heading that read "Turn
        two-factor on" would change to "Pair a different authenticator" at the
        moment of success, above a panel announcing the enrolment that just
        happened. The difference between the two cases is a warning about
        losing a working authenticator, which belongs beside the button that
        does it — `TotpEnrolment` carries it, and stops carrying it once there
        is nothing left to warn about.
      */}
      <h1 className="mt-2 text-[1.75rem] font-semibold tracking-tight text-ink-950">
        Two-factor sign-in
      </h1>
      <p className="mt-3 max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
        Pair an authenticator app with your account. After your password,
        signing in will ask for the six-digit code the app is showing — so
        somebody who learns your password still cannot get in.
      </p>
      {compelled && (
        <p className="mt-4 max-w-prose rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-[0.9375rem] leading-relaxed text-ink-800">
          An administrator has made two-factor sign-in a requirement on this
          account, so this is the only page you can reach until an app is
          paired.
        </p>
      )}

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
          replacing={replacing}
        />
      </div>
    </main>
  );
}
