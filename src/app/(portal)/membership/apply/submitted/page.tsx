import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getDb } from "@/db/client";
import { requireMember } from "@/server/auth/dal";
import { TIER_LABELS } from "@/membership/fees";
import type { ProcessingTier } from "@/db/schema";

export const metadata: Metadata = {
  title: "Application submitted",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The receipt page.
 *
 * Reached by redirect after the submit transition, so a reload cannot re-post
 * the submission. The reference in the query string is only a hint about which
 * application to show — the row is loaded scoped to the signed-in applicant,
 * so changing the reference in the address bar shows nothing rather than
 * someone else's application.
 */
export default async function SubmittedPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const actor = await requireMember();
  const { ref } = await searchParams;

  const db = getDb();

  let query = db
    .selectFrom("applications")
    .leftJoin("sla_clocks", "sla_clocks.application_id", "applications.id")
    .select([
      "applications.public_ref",
      "applications.processing_tier",
      "applications.submitted_at",
      "sla_clocks.due_date",
    ])
    .where("applications.created_by", "=", actor.userId)
    .where("applications.state", "!=", "DRAFT")
    .orderBy("applications.submitted_at", "desc")
    .limit(1);

  if (ref) query = query.where("applications.public_ref", "=", ref);

  const application = await query.executeTakeFirst();

  const payments = application?.public_ref
    ? await db
        .selectFrom("payments")
        .innerJoin("applications", "applications.id", "payments.application_id")
        .select(["payments.fee_kind", "payments.amount", "payments.currency"])
        .where("applications.public_ref", "=", application.public_ref)
        .where("applications.created_by", "=", actor.userId)
        .execute()
    : [];

  return (
    <main className="container-page py-16 lg:py-24">
      <div className="max-w-2xl">
        <p className="flex items-center gap-2 text-sm font-semibold text-success-700">
          <CheckCircle2 className="h-5 w-5" aria-hidden />
          Submitted
        </p>

        <h1 className="mt-3 font-display text-display-md font-semibold text-ink-950">
          Your application is with the Chamber
        </h1>

        {application?.public_ref ? (
          <>
            <dl className="mt-8 grid gap-px overflow-hidden rounded-xl bg-stone-200 sm:grid-cols-2">
              <Cell term="Your reference" detail={application.public_ref} emphasis />
              <Cell
                term="Processing"
                detail={
                  application.processing_tier
                    ? TIER_LABELS[application.processing_tier as ProcessingTier]
                    : "—"
                }
              />
              <Cell
                term="Due by"
                detail={
                  application.due_date
                    ? new Date(`${application.due_date}T00:00:00Z`).toLocaleDateString(
                        "en-GB",
                        { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" },
                      )
                    : "—"
                }
              />
              <Cell
                term="Fee due"
                detail={payments
                  .map((payment) => `${payment.currency} ${payment.amount}`)
                  .join(" + ")}
              />
            </dl>

            <div className="mt-8 space-y-4 text-[1.0625rem] leading-relaxed text-ink-900">
              <p>
                Quote <strong>{application.public_ref}</strong> in any correspondence. The
                date above is the Chamber&rsquo;s own working-day promise for the processing
                you chose; it pauses if we come back to you for something.
              </p>
              <p>
                The fee is paid by pay order drawn on the same bank account as the
                account-maintenance certificate you uploaded. The receipt is issued by the
                cashier once the instrument has been presented — it is not automatic, and
                this page is not a receipt.
              </p>
            </div>
          </>
        ) : (
          <p className="mt-6 text-[1.0625rem] leading-relaxed text-ink-900">
            We could not find a submitted application on your account. If you have just
            submitted one, reload this page.
          </p>
        )}

        <div className="mt-10 flex flex-wrap gap-4">
          <Link
            href="/membership"
            className="inline-flex h-11 items-center rounded-lg bg-brand-800 px-5 text-[0.9375rem] font-semibold text-white hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Back to membership
          </Link>
        </div>
      </div>
    </main>
  );
}

function Cell({
  term,
  detail,
  emphasis,
}: {
  term: string;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div className="bg-white p-5">
      <dt className="text-[0.8125rem] font-medium uppercase tracking-wide text-stone-600">
        {term}
      </dt>
      <dd
        className={
          emphasis
            ? "mt-1 font-display text-xl font-semibold text-ink-950"
            : "mt-1 text-[1.0625rem] text-ink-900"
        }
      >
        {detail || "—"}
      </dd>
    </div>
  );
}
