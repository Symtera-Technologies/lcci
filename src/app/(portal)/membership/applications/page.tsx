import type { Metadata } from "next";
import Link from "next/link";
import { AlertCircle, ArrowRight, FileText } from "lucide-react";
import { requireMemberPage } from "@/server/auth/dal";
import { listApplications, type TrackerListItem } from "@/membership/tracker";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Your applications",
  robots: { index: false, follow: false },
};

/**
 * Every application this applicant has filed.
 *
 * The page that was missing, and the gap was not cosmetic. The only route into
 * an applicant's own file was `/membership/apply`, which redirects to the
 * application it finds *in flight* — and an approved or refused application is
 * not in flight, so it redirected nowhere and started a fresh draft instead.
 * A granted member who followed the instruction in their own grant email,
 * "sign in at the Chamber's website to see your membership", was handed a
 * blank sixty-field form. Their membership number was in the register and no
 * page on the site would show it to them.
 *
 * Per request and never cached: one applicant's own list of applications.
 */
export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  const actor = await requireMemberPage("/membership/applications");
  const applications = await listApplications(actor);

  return (
    <main className="container-page py-16 lg:py-24">
      <div className="max-w-3xl">
        <h1 className="font-display text-display-md font-semibold text-ink-950">
          Your applications
        </h1>

        {applications.length === 0 ? (
          <Empty />
        ) : (
          <>
            <p className="mt-3 text-[0.9375rem] text-ink-700">
              Everything you have filed with the Chamber, newest first. A
              refused or closed application stays here so you can read it back.
            </p>

            <ul className="mt-8 space-y-4">
              {applications.map((application) => (
                <li key={application.id}>
                  <Row application={application} />
                </li>
              ))}
            </ul>
          </>
        )}

        {/*
          Offered below the list rather than above it. An applicant whose form
          is already with the Chamber does not want a "start a new
          application" button as the first thing on the page — and the wizard
          refuses them anyway, redirecting to the one they already have.
        */}
        <p className="mt-10 text-[0.9375rem] text-ink-700">
          Need to apply for a different firm?{" "}
          <Link
            href="/membership/apply"
            className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
          >
            Start an application
          </Link>
          .
        </p>
      </div>
    </main>
  );
}

function Row({ application }: { application: TrackerListItem }) {
  return (
    <Link
      href={`/membership/applications/${application.id}`}
      className="group block rounded-xl border border-stone-200 bg-white p-5 transition-colors hover:border-brand-700/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* The stage as a word, never as colour alone — and the one stage
              that needs the applicant carries an icon and a second sentence
              as well, because this is the row they must not scroll past. */}
          <p
            className={
              application.needsYou
                ? "flex items-center gap-1.5 text-[0.75rem] font-semibold tracking-wide text-urgent-700 uppercase"
                : "text-[0.75rem] font-semibold tracking-wide text-stone-600 uppercase"
            }
          >
            {application.needsYou && (
              <AlertCircle className="h-4 w-4" aria-hidden />
            )}
            {application.stageLabel}
          </p>

          <p className="mt-1.5 truncate text-[1.0625rem] font-semibold text-ink-950">
            {application.firmName ?? "Unnamed application"}
          </p>

          <p className="mt-1 font-mono text-[0.875rem] text-stone-600">
            {application.reference ?? "Not yet submitted"}
          </p>

          {application.membershipNo && (
            <p className="mt-2 text-[0.875rem] text-ink-800">
              Membership{" "}
              <span className="font-mono font-semibold">
                {application.membershipNo}
              </span>
            </p>
          )}

          {application.needsYou && (
            <p className="mt-2 text-[0.875rem] text-urgent-700">
              {application.stage === "draft"
                ? "Not sent to the Chamber yet."
                : "The Chamber is waiting for something from you."}
            </p>
          )}
        </div>

        <ArrowRight
          className="mt-1 h-5 w-5 shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-700"
          aria-hidden
        />
      </div>

      <p className="mt-4 border-t border-stone-100 pt-3 text-[0.8125rem] text-stone-600">
        {application.submittedAt
          ? `Submitted ${formatDate(application.submittedAt.toISOString())}`
          : `Started ${formatDate(application.updatedAt.toISOString())}`}
      </p>
    </Link>
  );
}

function Empty() {
  return (
    <div className="mt-8 rounded-xl border border-stone-200 bg-white p-8 text-center">
      <FileText className="mx-auto h-8 w-8 text-stone-400" aria-hidden />
      <p className="mt-4 text-[0.9375rem] text-ink-900">
        You have not filed an application yet.
      </p>
      <p className="mt-2 text-[0.875rem] text-stone-600">
        If you are already a member and signed in to see your membership, it was
        granted before this website was built. Write to membership@lcci.com.pk
        with your membership number and we will link it to this account.
      </p>
    </div>
  );
}
