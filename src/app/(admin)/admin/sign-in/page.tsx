import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/dal";
import {
  PasswordForm,
  SecondFactorForm,
} from "@/components/admin/staff-sign-in-forms";

export const metadata: Metadata = {
  title: "Staff sign-in",
  description: "Sign in to the Lahore Chamber of Commerce & Industry staff backend.",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Staff sign-in.
 *
 * Which of the two steps renders is read off the session, not held in the
 * client: after the password a staff session exists with `mfa_satisfied_at`
 * NULL where a code is still owed, and `requireStaff` refuses every route but
 * this one until it is set. So a refresh, a second tab and the back button all
 * land on the correct step, and there is no half-authenticated state anywhere
 * except the row that represents it.
 *
 * Most accounts never see the second step: two-factor is off by default and
 * each staff member turns it on for themselves at `/admin/security`.
 */
export default async function StaffSignInPage({
  searchParams,
}: {
  searchParams: Promise<{ signedOut?: string }>;
}) {
  const params = await searchParams;
  const signedOut = params.signedOut === "1";

  const session = signedOut ? null : await getSession();
  const staff = session?.user.userType === "staff" ? session : null;

  // A staff session that is already trusted has nothing to do here. That
  // includes an account with two-factor off, whose session is created
  // satisfied.
  if (staff && staff.session.mfaSatisfiedAt !== null) redirect("/admin");

  // Owing a second factor is not the same as owing a *code*. An account an
  // administrator has required two-factor on, with nothing paired, has no code
  // to produce — rendering the code form for it is a box it cannot fill and no
  // way out but signing out again. Send it to enrolment instead.
  if (staff && !staff.user.twoFactorEnabled) redirect("/admin/setup-2fa");

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16 sm:py-24">
      <p className="text-[0.8125rem] font-medium uppercase tracking-[0.12em] text-stone-500">
        Chamber staff
      </p>
      <h1 className="mt-2 text-[1.75rem] font-semibold tracking-tight text-ink-950">
        {staff ? "Two-factor code" : "Sign in"}
      </h1>

      {signedOut && (
        <p className="mt-3 text-[0.9375rem] text-ink-700">You have been signed out.</p>
      )}

      <div className="mt-8">
        {staff ? <SecondFactorForm email={staff.user.email} /> : <PasswordForm />}
      </div>

      <div className="mt-10 border-t border-stone-200 pt-6 text-[0.8125rem] leading-relaxed text-stone-600">
        {staff ? (
          <p>
            Lost your authenticator? Enter one of the ten recovery codes you were
            given at enrolment. Each works once, and using one is recorded.
          </p>
        ) : (
          <p>
            Staff accounts are created by a super administrator. Members sign in
            separately, with a code sent to their registered email address.
          </p>
        )}
      </div>
    </main>
  );
}
