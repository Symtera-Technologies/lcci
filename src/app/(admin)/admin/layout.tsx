import type { ReactNode } from "react";
import Link from "next/link";
import { getSession } from "@/server/auth/dal";
import { signOutStaff } from "./sign-in/actions";

/**
 * The admin shell.
 *
 * **Not the authorisation boundary**, and that is the whole reason this file
 * is as thin as it is. Next's own documentation warns against it: a layout
 * does not re-render when navigating between sibling routes, so a check here
 * would run once and then every client-side navigation would render pages
 * whose own code checked nothing. Layouts also do not protect route handlers
 * or server actions at all. Each page calls `requireStaffPage` itself; this
 * only decides what chrome to draw.
 *
 * It reads the session for the nav, which makes the whole admin area dynamic —
 * correct, since every page here is per-actor data that must never be cached.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  const staff = session?.user.userType === "staff" ? session : null;
  // The nav is hidden until the second factor is satisfied. Showing links an
  // account cannot yet follow would make the enrolment gate look like a bug.
  const signedIn = staff !== null && staff.session.mfaSatisfiedAt !== null;

  return (
    <div className="min-h-dvh bg-stone-50">
      {signedIn && staff && (
        <header className="border-b border-stone-200 bg-white">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
            <Link
              href="/admin"
              className="text-[0.9375rem] font-semibold tracking-tight text-ink-950"
            >
              LCCI <span className="font-normal text-stone-500">backend</span>
            </Link>

            <nav aria-label="Admin sections" className="flex flex-wrap gap-x-5 text-sm">
              <Link
                href="/admin/applications"
                className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
              >
                Applications
              </Link>
            </nav>

            <div className="ml-auto flex items-center gap-4 text-sm">
              <span className="text-stone-600">{staff.user.fullName}</span>
              <form action={signOutStaff}>
                <button
                  type="submit"
                  className="font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </header>
      )}

      {children}
    </div>
  );
}
