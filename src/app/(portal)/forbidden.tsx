import Link from "next/link";

/**
 * 403, for a staff account that followed a member's link.
 *
 * The root boundary tells the visitor to ask a super administrator to review
 * their roles, which is the right advice inside `/admin` and the wrong advice
 * here: no role grants access to this area. `requireMemberPage` refuses on
 * `user_type`, and an officer's account is staff whatever it has been granted,
 * so an officer who goes looking for the role that would let them in is
 * looking for something that does not exist.
 *
 * The member in question is the one thing this page cannot offer to fix. A
 * "sign in as someone else" button on a 403 invites an officer to try the
 * applicant's own credentials, which is the opposite of what the separate
 * sign-in pages are for.
 */
export default function PortalForbidden() {
  return (
    <main className="mx-auto w-full max-w-lg px-6 py-20">
      <p className="text-[0.8125rem] font-medium tracking-[0.12em] text-stone-500 uppercase">
        403
      </p>
      <h1 className="mt-2 text-[1.75rem] font-semibold tracking-tight text-ink-950">
        This area is for members and applicants
      </h1>
      <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-700">
        You are signed in with a Chamber staff account. These pages belong to
        the applicant whose form they are about, and no staff role opens them —
        an application is read from the admin queue instead.
      </p>
      <p className="mt-6 text-[0.9375rem]">
        <Link
          href="/admin/applications"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Back to the application queue
        </Link>
      </p>
    </main>
  );
}
