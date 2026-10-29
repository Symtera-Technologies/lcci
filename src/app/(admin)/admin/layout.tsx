import type { ReactNode } from "react";
import Link from "next/link";
import { getActor, getSession } from "@/server/auth/dal";
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
  // Read for the nav only. A link an account cannot follow would land on the
  // forbidden boundary, which reads as a broken backend rather than as a
  // permission working — and a cashier should not be shown the verification
  // queue at all.
  const actor = staff ? await getActor() : null;
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
              {actor?.permissions.has("application.read") && (
                <Link
                  href="/admin/applications"
                  className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                >
                  Applications
                </Link>
              )}
              {actor?.permissions.has("payment.read") && (
                <Link
                  href="/admin/payments"
                  className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                >
                  Fees
                </Link>
              )}
              {actor?.permissions.has("application.read") && (
                <Link
                  href="/admin/reports/sla"
                  className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                >
                  Promises
                </Link>
              )}
              {/*
                The other half of the backend. Gated on `content.read_draft`
                rather than on any content grant, because that permission is
                what separates somebody who edits the site from somebody who
                only works the queues — a cashier holds no content grant at all
                and should not be shown the newsroom.
              */}
              {actor?.permissions.has("content.read_draft") && (
                <Link
                  href="/admin/content"
                  className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                >
                  Content
                </Link>
              )}
              {/*
                Last, and only for the accounts that hold it. The calendar is
                reference data a handful of people maintain, not a daily
                destination, and putting it beside the queues would invite the
                officer with no grant to click something that refuses them.
              */}
              {actor?.permissions.has("calendar.manage") && (
                <Link
                  href="/admin/calendar"
                  className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                >
                  Calendar
                </Link>
              )}
              {/*
                Narrower still: one account holds `audit.read`. Shown rather
                than reached by typing the URL, because a record nobody can
                find is not oversight — somebody has to be able to open it on
                the day a decision is questioned, without asking a developer.
              */}
              {/*
                Account administration, next to the audit log because the two
                are the same job: who may do what, and what they did. Gated on
                `user.manage`, which only a super administrator holds by seed.
              */}
              {actor?.permissions.has("user.manage") && (
                <Link
                  href="/admin/users"
                  className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                >
                  Staff
                </Link>
              )}
              {actor?.permissions.has("audit.read") && (
                <Link
                  href="/admin/audit"
                  className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                >
                  Audit log
                </Link>
              )}
            </nav>

            <div className="ml-auto flex items-center gap-4 text-sm">
              <span className="text-stone-600">{staff.user.fullName}</span>
              {/*
                Beside the name rather than in the section nav, because it is
                not a part of the backend — it is this account's own sign-in,
                and it is ungated for the same reason: every staff member must
                be able to reach their own two-factor setting without finding a
                super administrator first. A link rather than a buried URL
                because a security setting nobody can find is a security
                setting nobody uses.
              */}
              <Link
                href="/admin/security"
                className="font-medium text-ink-700 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
              >
                Your sign-in
              </Link>
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
