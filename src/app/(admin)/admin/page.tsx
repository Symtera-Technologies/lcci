import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import { loadQueue, QUEUE_SCOPES, type QueueScope } from "@/membership/queue";

export const metadata: Metadata = {
  title: "Backend",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The staff dashboard.
 *
 * No permission required to reach it — any authenticated staff account lands
 * here — so each panel checks its own. A cashier and a membership officer sign
 * in to the same page and should not be shown each other's work, let alone a
 * count of it: a bare number is still a disclosure.
 */
export default async function AdminDashboard() {
  const actor = await requireStaffPage();
  const canReadApplications = actor.permissions.has("application.read");

  const queue = canReadApplications
    ? await loadQueue(actor, { scope: "open" })
    : null;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <h1 className="text-[1.75rem] font-semibold tracking-tight text-ink-950">
        Backend
      </h1>
      <p className="mt-2 text-[0.9375rem] text-ink-700">
        Signed in as {actor.roleCodes.length > 0 ? actor.roleCodes.join(", ") : "staff"}.
      </p>

      {queue ? (
        <section className="mt-8">
          <h2 className="text-[1.0625rem] font-semibold tracking-tight text-ink-950">
            Membership applications
          </h2>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(Object.keys(QUEUE_SCOPES) as QueueScope[]).map((scope) => (
              <Link
                key={scope}
                href={`/admin/applications?scope=${scope}`}
                className="rounded-xl border border-stone-200 bg-white p-4 outline-offset-2 transition-colors hover:border-brand-500"
              >
                <dt className="text-[0.8125rem] font-medium uppercase tracking-[0.08em] text-stone-500">
                  {QUEUE_SCOPES[scope].label}
                </dt>
                <dd className="mt-1 text-[1.75rem] font-semibold tabular-nums tracking-tight text-ink-950">
                  {queue.scopeCounts[scope]}
                </dd>
              </Link>
            ))}
          </dl>
        </section>
      ) : (
        <p className="mt-8 max-w-prose rounded-xl border border-stone-200 bg-white p-4 text-[0.9375rem] leading-relaxed text-ink-700">
          Your roles do not include access to membership applications. If that is
          wrong, a super administrator can adjust it — signing in again will not.
        </p>
      )}
    </main>
  );
}
