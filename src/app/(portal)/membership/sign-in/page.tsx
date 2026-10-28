import type { Metadata } from "next";
import Link from "next/link";
import { getSession } from "@/server/auth/dal";
import { Button, ButtonLink } from "@/components/ui/button";
import { SignInForm } from "@/components/membership/sign-in-form";
import { DEFAULT_DESTINATION, safeDestination } from "@/server/auth/destination";
import { signOut } from "./actions";

export const metadata: Metadata = {
  title: "Member sign-in",
  description:
    "Sign in to the LCCI member area with a code sent to your registered email address.",
  // A sign-in page in an index is a sign-in page in a phishing kit's search
  // results, and it has nothing a search engine should rank.
  robots: { index: false, follow: false },
};

/**
 * Rendered per request, always.
 *
 * It reads the session to decide what to show, and a cached sign-in page is a
 * page that tells the next visitor who the last one was.
 */
export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; signedOut?: string }>;
}) {
  const params = await searchParams;
  const next = safeDestination(params.next);
  const signedOut = params.signedOut === "1";

  // Already signed in. Offering the form again would be the one case where
  // "enter your code" is genuinely confusing, and it is also how a member ends
  // up with two sessions on one machine.
  const session = signedOut ? null : await getSession();

  return (
    <main className="mx-auto w-full max-w-lg px-6 py-16 sm:py-24">
      <h1 className="text-[1.75rem] font-semibold tracking-tight text-ink-950 sm:text-[2rem]">
        Member sign-in
      </h1>

      {session ? (
        <div className="mt-6 flex flex-col gap-6">
          <p className="text-[0.9375rem] text-ink-700">
            You are signed in as{" "}
            <span className="font-medium text-ink-950">{session.user.fullName}</span>.
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <ButtonLink href={next}>Continue</ButtonLink>

            <form action={signOut}>
              <Button type="submit" variant="ghost">
                Sign out
              </Button>
            </form>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-700">
            Enter the email address registered with the Chamber and we will send you a
            six-digit code. There is no password.
          </p>

          <div className="mt-8">
            <SignInForm next={next} signedOut={signedOut} />
          </div>

          <div className="mt-10 border-t border-stone-200 pt-6 text-[0.8125rem] leading-relaxed text-stone-600">
            <p>
              Not a member yet?{" "}
              <Link
                href={DEFAULT_DESTINATION}
                className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
              >
                Apply for membership
              </Link>{" "}
              — you will be asked to sign in before the form opens, so that your
              part-finished application is saved to you and nobody else.
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
