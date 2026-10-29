import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import { CreateStaffForm } from "@/components/admin/staff-forms";
import { departmentOptions, roleOptions } from "../role-options";

export const metadata: Metadata = {
  title: "New colleague",
  robots: { index: false, follow: false },
};

/** Generates a password per submission; a cached render would be a shared one. */
export const dynamic = "force-dynamic";

export default async function NewStaffPage() {
  await requireStaffPage("user.manage");
  const departments = await departmentOptions();

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
        New colleague
      </h1>
      <p className="mt-2 max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
        A staff account signs in with a password, and with an authenticator app
        as well if they turn one on or you require it here.
      </p>

      <div className="mt-8">
        <CreateStaffForm roles={roleOptions()} departments={departments} />
      </div>
    </main>
  );
}
