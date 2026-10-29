import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import { listStaff } from "@/server/auth/staff-admin";
import { ROLE_SEED, type RoleCode } from "@/server/permissions";
import { formatDateShort } from "@/lib/format";

export const metadata: Metadata = {
  title: "Staff accounts",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Who has an account, and what each one can do.
 *
 * **The two-factor column is the reason this screen earns its place.** Making
 * two-factor each staff member's own setting only works if somebody can see
 * who has taken it up, and a requirement an administrator can impose is
 * useless if they cannot see where it is already imposed. Both are columns
 * here rather than facts buried on fifteen separate pages.
 *
 * A table, not cards. Fifteen rows of the same four facts is exactly what a
 * table is for, and this is a screen people scan down one column of.
 */
export default async function StaffListPage() {
  const actor = await requireStaffPage("user.manage");
  const staff = await listStaff(actor);

  const unprotected = staff.filter(
    (person) =>
      person.status === "active" && !person.twoFactorEnabled && !person.twoFactorRequired,
  ).length;

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            Staff accounts
          </h1>
          <p className="mt-1 text-[0.9375rem] text-ink-700">
            {staff.length} {staff.length === 1 ? "account" : "accounts"}. Members
            are not listed here — they have no password and no roles.
          </p>
        </div>

        <Link
          href="/admin/users/new"
          className="rounded-lg bg-brand-800 px-4 py-2 text-[0.875rem] font-medium text-white hover:bg-brand-900"
        >
          New colleague
        </Link>
      </header>

      {/*
        Said once, with a number, where it can be acted on. Not a banner on
        every screen: a warning that follows people around is a warning they
        stop reading, and the only person who can do anything about this one is
        already standing on the page where the fix is.
      */}
      {unprotected > 0 && (
        <p className="mt-6 rounded-lg border border-stone-300 bg-stone-50 px-4 py-3 text-[0.9375rem] leading-relaxed text-ink-800">
          <strong className="font-semibold">
            {unprotected} active {unprotected === 1 ? "account signs" : "accounts sign"}{" "}
            in with a password alone.
          </strong>{" "}
          Open an account to require an authenticator app on it. Worth doing
          first for anyone who receipts fees, approves memberships or reads
          uploaded identity documents.
        </p>
      )}

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse text-left">
          <caption className="sr-only">Staff accounts, by name</caption>
          <thead>
            <tr className="border-b border-stone-300 text-[0.8125rem] text-ink-600">
              <th scope="col" className="py-2 pr-4 font-medium">
                Name
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Roles
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Status
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Two-factor
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Last signed in
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {staff.map((person) => (
              <tr key={person.id} className="border-b border-stone-200 align-top">
                <td className="py-3 pr-4">
                  <Link
                    href={`/admin/users/${person.id}`}
                    className="text-[0.9375rem] font-medium text-ink-950 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
                  >
                    {person.fullName}
                  </Link>
                  <p className="mt-0.5 text-[0.75rem] text-ink-500">{person.email}</p>
                  {person.id === actor.userId && (
                    <p className="mt-0.5 text-[0.75rem] text-ink-600">That is you.</p>
                  )}
                </td>
                <td className="py-3 pr-4 text-[0.875rem] text-ink-700">
                  {person.roles.length === 0
                    ? "None"
                    : person.roles.map((role) => roleLabel(role)).join(", ")}
                </td>
                <td className="py-3 pr-4 text-[0.875rem] text-ink-700">
                  {person.status === "active" ? "Active" : capitalise(person.status)}
                </td>
                <td className="py-3 pr-4 text-[0.875rem]">
                  <TwoFactorCell
                    enabled={person.twoFactorEnabled}
                    required={person.twoFactorRequired}
                  />
                </td>
                <td className="py-3 pr-4 text-[0.875rem] whitespace-nowrap text-ink-700">
                  {person.lastLoginAt
                    ? formatDateShort(person.lastLoginAt.toISOString())
                    : "Never"}
                </td>
                <td className="py-3 text-[0.875rem]">
                  <Link
                    href={`/admin/users/${person.id}`}
                    className="text-brand-800 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
                  >
                    Manage
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

/**
 * Four states, not two, and the words matter.
 *
 * "On" and "Required" are different facts: one is a colleague's own choice,
 * which they may reverse, and the other is a decision somebody else made,
 * which they may not. "Required, not set up" is the state an administrator
 * needs to chase, because that account cannot do any work until it is
 * resolved.
 */
function TwoFactorCell({
  enabled,
  required,
}: {
  enabled: boolean;
  required: boolean;
}) {
  if (enabled) {
    return (
      <span className="text-ink-700">
        On{required && <span className="block text-[0.75rem] text-ink-600">Required</span>}
      </span>
    );
  }
  if (required) {
    return (
      <span className="font-medium text-urgent-700">
        Required, not set up
        <span className="block text-[0.75rem] font-normal text-ink-600">
          They cannot work until they pair an app
        </span>
      </span>
    );
  }
  return <span className="text-ink-600">Off</span>;
}

function roleLabel(role: RoleCode): string {
  return ROLE_SEED[role]?.label ?? role;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
