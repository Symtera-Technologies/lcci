import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/server/auth/dal";
import { ButtonLink } from "@/components/ui/button";
import { RegisterForm } from "@/components/membership/register-form";
import { safeDestination } from "@/server/auth/destination";

export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Open an LCCI account to apply for membership. No password: we send a six-digit code to your email address.",
  // A page that creates accounts in an index is a page in a phishing kit's
  // search results, and the public membership pages are what a prospective
  // member should find instead.
  robots: { index: false, follow: false },
};

/**
 * Rendered per request, always.
 *
 * It reads the session to decide what to show, and a cached copy is a page
 * that tells the next visitor who the last one was.
 */
export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const params = await searchParams;
  const next = safeDestination(params.next);

  // Already signed in. Offering the form would invite a second account for
  // somebody who already has one — and the address they would type is
  // probably the one they are signed in with, which this page answers by
  // sending a code rather than by saying so. Better to say it plainly here,
  // where saying it discloses nothing: they are holding the session.
  const session = await getSession();

  return (
    <main className="mx-auto w-full max-w-lg px-6 py-16 sm:py-24">
      <h1 className="text-[1.75rem] font-semibold tracking-tight text-ink-950 sm:text-[2rem]">
        Create your account
      </h1>

      {session ? (
        <div className="mt-6 flex flex-col gap-6">
          <p className="text-[0.9375rem] leading-relaxed text-ink-700">
            You are already signed in as{" "}
            <span className="font-medium text-ink-950">{session.user.fullName}</span>, so
            there is nothing to create — carry on to the application form.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <ButtonLink href={next}>Continue</ButtonLink>
            <Link
              href="/membership/sign-in"
              className="text-[0.9375rem] font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Use a different account
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-700">
            Anyone can open an account. It takes three details and a code sent to your
            email address — there is no password to choose or remember.
          </p>

          <div className="mt-8">
            <RegisterForm next={next} />
          </div>

          <div className="mt-10 border-t border-stone-200 pt-6 text-[0.8125rem] leading-relaxed text-stone-600">
            <p>
              Already have an account, or a membership number?{" "}
              <Link
                href="/membership/sign-in"
                className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
              >
                Sign in instead
              </Link>
              .
            </p>
            {/* What the account is and is not. An applicant who thinks this
                form was the application will wait for a decision that nobody
                is making, and the Secretariat takes that telephone call. */}
            <p className="mt-3">
              An account is not an application. Once it exists you will land on the
              membership form, where you can fill in your firm&apos;s particulars over
              several sittings — your part-finished answers are saved to you and nobody
              else, and nothing reaches the Chamber until you submit it.
            </p>
            <p className="mt-3">
              If the code does not arrive, check the junk folder before asking for
              another: each new code cancels the one before it.
            </p>
          </div>
        </>
      )}
    </main>
  );
}
