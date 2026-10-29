import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/auth/dal";
import { getStaff } from "@/server/auth/staff-admin";
import { ResetPasswordForm, UpdateStaffForm } from "@/components/admin/staff-forms";
import { formatDateShort } from "@/lib/format";
import { departmentOptions, roleOptions } from "../role-options";

export const metadata: Metadata = {
  title: "Staff account",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * One colleague's account.
 *
 * The two-factor requirement lives on the same form as the roles and the
 * status, because it is part of the same decision — what this account is for
 * and what it must prove. Splitting it onto its own screen would make it a
 * thing somebody configures once and never revisits.
 *
 * An administrator's own row renders read-only, with the reason stated. That
 * refusal is enforced in `updateStaff`, not here: this page only decides what
 * to draw, and a server action is reachable without it.
 */
export default async function StaffAccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = Number(id);
  if (!Number.isSafeInteger(userId) || userId <= 0) notFound();

  const actor = await requireStaffPage("user.manage");
  const [person, departments] = await Promise.all([
    getStaff(actor, userId),
    departmentOptions(),
  ]);

  if (!person) notFound();

  const isSelf = actor.userId === person.id;

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="text-[0.875rem]">
        <Link
          href="/admin/users"
          className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Staff accounts
        </Link>
      </nav>

      <h1 className="mt-2 text-[1.75rem] leading-tight font-semibold tracking-tight text-ink-950">
        {person.fullName}
      </h1>
      <p className="mt-1 text-[0.9375rem] text-ink-700">{person.email}</p>
      <p className="mt-1 text-[0.8125rem] text-stone-600">
        Account created {formatDateShort(person.createdAt.toISOString())}
        {person.lastLoginAt
          ? `, last signed in ${formatDateShort(person.lastLoginAt.toISOString())}.`
          : ", never signed in."}
      </p>

      {/*
        Stated before the form, because it is the one fact on this page that
        the form cannot show: a requirement already imposed has an author, and
        an administrator about to lift it should see whose decision they are
        reversing.
      */}
      {person.twoFactorRequired && (
        <p className="mt-6 rounded-lg border border-stone-300 bg-stone-50 px-4 py-3 text-[0.9375rem] leading-relaxed text-ink-800">
          Two-factor sign-in is required on this account
          {person.requiredByName ? `, set by ${person.requiredByName}` : ""}
          {person.requiredAt
            ? ` on ${formatDateShort(person.requiredAt.toISOString())}`
            : ""}
          .{" "}
          {person.twoFactorEnabled
            ? "They have paired an app and cannot turn it off."
            : "They have not paired an app yet, so they cannot reach anything in the backend until they do."}
        </p>
      )}

      <section aria-labelledby="account-heading" className="mt-8">
        <h2 id="account-heading" className="sr-only">
          Account settings
        </h2>
        <UpdateStaffForm
          user={{
            id: person.id,
            email: person.email,
            fullName: person.fullName,
            status: person.status,
            roles: person.roles,
            departmentScope: person.departmentScopes[0] ?? null,
            twoFactorEnabled: person.twoFactorEnabled,
            twoFactorRequired: person.twoFactorRequired,
          }}
          roles={roleOptions()}
          departments={departments}
          isSelf={isSelf}
        />
      </section>

      {!isSelf && (
        <section
          aria-labelledby="password-heading"
          className="mt-10 rounded-xl border border-stone-200 bg-white p-6"
        >
          <h2
            id="password-heading"
            className="text-[1.0625rem] font-semibold text-ink-950"
          >
            Their password
          </h2>
          <div className="mt-3">
            <ResetPasswordForm userId={person.id} name={person.fullName} />
          </div>
        </section>
      )}
    </main>
  );
}
