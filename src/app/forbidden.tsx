import Link from "next/link";

/**
 * 403, for someone who is signed in and still not allowed.
 *
 * Deliberately not a sign-in prompt. The visitor's credentials are fine and
 * the problem is a grant they do not hold, so the useful thing to tell them is
 * which it was and who can change it — not to try again. `requireStaffPage`
 * has already written an `access.denied` audit event by the time this renders,
 * so the secretariat's own log is the answer to "why can't I see this".
 */
export default function Forbidden() {
  return (
    <main className="mx-auto w-full max-w-lg px-6 py-20">
      <p className="text-[0.8125rem] font-medium uppercase tracking-[0.12em] text-stone-500">
        403
      </p>
      <h1 className="mt-2 text-[1.75rem] font-semibold tracking-tight text-ink-950">
        You do not have access to this
      </h1>
      <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-700">
        Your account is signed in, but it does not hold the permission this page
        needs. Signing in again will not change that — ask a super administrator
        to review your roles.
      </p>
      <p className="mt-6 text-[0.9375rem]">
        <Link
          href="/admin"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Back to the dashboard
        </Link>
      </p>
    </main>
  );
}
