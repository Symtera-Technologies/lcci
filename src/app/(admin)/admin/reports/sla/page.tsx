import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import {
  slaReport,
  type DecidedPromise,
  type OpenPromise,
  type TierOutcome,
} from "@/membership/sla-report";
import type { ProcessingTier } from "@/db/schema";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Processing promises",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<ProcessingTier, string> = {
  regular: "Regular",
  urgent: "Urgent",
  executive: "Executive",
};

const TIERS: readonly ProcessingTier[] = ["regular", "urgent", "executive"];

function isTier(value: unknown): value is ProcessingTier {
  return typeof value === "string" && TIERS.includes(value as ProcessingTier);
}

/**
 * Whether the chamber is keeping the promises it sold.
 *
 * The processing tiers are not service levels in the abstract: Rs 20,000 buys
 * an Executive answer in three working days, and an application that misses it
 * is money taken for something undelivered. Open question 2 asks whether a
 * committee meeting weekly can meet a three-day promise at all. This page is
 * what turns that question from an opinion into a count.
 *
 * Open files come first and decided ones second, which is the opposite of how
 * a report usually reads. A tier with a clean record and eleven applications
 * already past their date is not a tier being met — it is one whose bad news
 * has not been written down yet, and putting last quarter's successes at the
 * top is how that goes unnoticed for a quarter more.
 */
export default async function SlaReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("application.read");
  const query = await searchParams;

  const raw = Array.isArray(query.tier) ? query.tier[0] : query.tier;
  const tier = isTier(raw) ? raw : undefined;

  const report = await slaReport(actor, { tier });

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            Processing promises
          </h1>
          <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-700">
            Each tier is a paid promise in working days. Decided outcomes are
            counted from {formatDate(report.since)}; the figures are frozen on
            the day each application was decided.
          </p>
        </div>

        <nav aria-label="Filter by tier" className="flex flex-wrap gap-2">
          <Filter href="/admin/reports/sla" current={tier === undefined}>
            All tiers
          </Filter>
          {TIERS.map((code) => (
            <Filter
              key={code}
              href={`/admin/reports/sla?tier=${code}`}
              current={tier === code}
            >
              {TIER_LABEL[code]}
            </Filter>
          ))}
        </nav>
      </header>

      {report.awaitingRecompute > 0 && (
        /*
          Surfaced rather than hidden, because during the gap this page and the
          applicants' inboxes disagree. The calendar has been edited and the
          recompute job has not caught up, so some date below is the old one.
        */
        <p className="mt-6 rounded-xl border border-urgent-600/40 bg-urgent-50 p-4 text-[0.9375rem] text-urgent-800">
          {report.awaitingRecompute} promised{" "}
          {report.awaitingRecompute === 1 ? "date is" : "dates are"} waiting to
          be recomputed after a change to the{" "}
          <Link
            href="/admin/calendar"
            className="font-medium underline decoration-urgent-700/40 underline-offset-4 hover:decoration-urgent-700"
          >
            working-day calendar
          </Link>
          . Until that runs, the dates shown here are the ones before the
          change.
        </p>
      )}

      <section aria-labelledby="tiers-heading" className="mt-8">
        <h2 id="tiers-heading" className="sr-only">
          Each tier
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {report.byTier.map((row) => (
            <TierCard key={row.tier} row={row} />
          ))}
        </div>
      </section>

      <section aria-labelledby="open-heading" className="mt-12">
        <h2
          id="open-heading"
          className="text-[1.125rem] font-semibold text-ink-950"
        >
          Promises outstanding
        </h2>
        <p className="mt-1 text-[0.875rem] text-stone-600">
          Past the promised date first. Working days the file spent with the
          applicant are counted separately, because they are not the
          chamber&rsquo;s.
        </p>

        {report.open.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-[0.9375rem] text-ink-700">
            No application is in flight.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full border-collapse text-left text-[0.9375rem]">
              <caption className="sr-only">
                Applications in flight, past the promised date first
              </caption>
              <thead>
                <tr className="border-b border-stone-200 text-[0.8125rem] text-stone-600">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Application
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Promised
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Due
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Where it stands
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Time spent
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.open.map((row) => (
                  <OpenRow key={row.applicationId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="breaches-heading" className="mt-12">
        <h2
          id="breaches-heading"
          className="text-[1.125rem] font-semibold text-ink-950"
        >
          Promises missed
        </h2>
        <p className="mt-1 max-w-3xl text-[0.875rem] text-stone-600">
          Decided after the promised date. What the chamber owes an applicant
          for a tier it took the fee for and did not meet is open question 2 and
          has no answer yet — so this list is a record, not a remedy.
        </p>

        {report.breaches.length === 0 ? (
          <p className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-[0.9375rem] text-ink-700">
            Nothing decided late since {formatDate(report.since)}.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full border-collapse text-left text-[0.9375rem]">
              <caption className="sr-only">
                Applications decided after the promised date
              </caption>
              <thead>
                <tr className="border-b border-stone-200 text-[0.8125rem] text-stone-600">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Application
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Promised
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Due
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Decided
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Time spent
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.breaches.map((row) => (
                  <BreachRow key={row.applicationId} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Filter({
  href,
  current,
  children,
}: {
  href: string;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={
        current
          ? "inline-flex min-h-11 items-center rounded-lg border border-ink-900 bg-ink-900 px-3.5 text-[0.875rem] font-medium text-white"
          : "inline-flex min-h-11 items-center rounded-lg border border-stone-300 bg-white px-3.5 text-[0.875rem] font-medium text-ink-800 hover:border-ink-400"
      }
    >
      {children}
    </Link>
  );
}

function TierCard({ row }: { row: TierOutcome }) {
  const decided = row.met + row.breached;

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <h3 className="text-[1.0625rem] font-semibold text-ink-950">
        {TIER_LABEL[row.tier]}
      </h3>
      <p className="mt-0.5 text-[0.875rem] text-stone-600">
        {row.promisedWorkingDays} working days
      </p>

      <dl className="mt-4 space-y-1.5 text-[0.875rem]">
        <div className="flex justify-between gap-4">
          <dt className="text-stone-600">Decided on time</dt>
          <dd className="tabular-nums text-ink-900">
            {decided === 0 ? "—" : `${row.met} of ${decided}`}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-stone-600">Decided late</dt>
          <dd
            className={
              row.breached > 0
                ? "font-semibold tabular-nums text-urgent-800"
                : "tabular-nums text-ink-900"
            }
          >
            {row.breached}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-stone-100 pt-1.5">
          <dt className="text-stone-600">In flight</dt>
          <dd className="tabular-nums text-ink-900">{row.open}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-stone-600">Already past due</dt>
          <dd
            className={
              row.openBreached > 0
                ? "font-semibold tabular-nums text-urgent-800"
                : "tabular-nums text-ink-900"
            }
          >
            {row.openBreached}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * The two numbers side by side.
 *
 * "32 working days elapsed, 11 of them waiting on the applicant" is the
 * sentence this report exists to produce, and neither half of it means
 * anything alone. Elapsed without the pause makes the office look slow for
 * time it never held the file; the pause without the elapsed hides a file that
 * genuinely sat on a desk.
 */
function Spent({
  elapsed,
  paused,
}: {
  elapsed: number;
  paused: number;
}) {
  return (
    <>
      <span className="tabular-nums text-ink-900">
        {elapsed} working {elapsed === 1 ? "day" : "days"}
      </span>
      <span className="block text-[0.8125rem] text-stone-600">
        {paused === 0
          ? "none of it with the applicant"
          : `${paused} of them with the applicant`}
      </span>
    </>
  );
}

function OpenRow({ row }: { row: OpenPromise }) {
  const late = row.workingDaysToDue < 0;
  const magnitude = Math.abs(row.workingDaysToDue);

  return (
    <tr className="border-b border-stone-100 last:border-b-0">
      <td className="px-4 py-3">
        <Link
          href={`/admin/applications/${row.applicationId}`}
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          {row.publicRef ?? `#${row.applicationId}`}
        </Link>
        <span className="block text-[0.875rem] text-stone-600">
          {row.firmName ?? "—"}
        </span>
      </td>

      <td className="px-4 py-3 text-ink-900">
        {TIER_LABEL[row.tier]}
        <span className="block text-[0.8125rem] text-stone-600">
          {row.promisedWorkingDays} working days
        </span>
      </td>

      <td className="px-4 py-3">
        <span className={late ? "font-medium text-urgent-800" : "text-ink-900"}>
          {formatDate(row.dueDate)}
        </span>
        {/* Never colour alone: the count is in words beneath the date. */}
        <span
          className={
            late
              ? "block text-[0.8125rem] font-medium text-urgent-800"
              : "block text-[0.8125rem] text-stone-600"
          }
        >
          {late
            ? `${magnitude} working ${magnitude === 1 ? "day" : "days"} late`
            : magnitude === 0
              ? "due today"
              : `${magnitude} working ${magnitude === 1 ? "day" : "days"} left`}
        </span>
      </td>

      <td className="px-4 py-3 text-ink-900">
        {row.clockState === "paused" ? "With the applicant" : "With the chamber"}
        {row.needsRecompute && (
          <span className="block text-[0.8125rem] text-urgent-800">
            awaiting recompute
          </span>
        )}
      </td>

      <td className="px-4 py-3">
        <Spent
          elapsed={row.elapsedWorkingDays}
          paused={row.pausedWorkingDays}
        />
      </td>
    </tr>
  );
}

function BreachRow({ row }: { row: DecidedPromise }) {
  return (
    <tr className="border-b border-stone-100 last:border-b-0">
      <td className="px-4 py-3">
        <Link
          href={`/admin/applications/${row.applicationId}`}
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          {row.publicRef ?? `#${row.applicationId}`}
        </Link>
        <span className="block text-[0.875rem] text-stone-600">
          {row.firmName ?? "—"}
        </span>
      </td>

      <td className="px-4 py-3 text-ink-900">{TIER_LABEL[row.tier]}</td>

      <td className="px-4 py-3 text-ink-900">{formatDate(row.dueDate)}</td>

      <td className="px-4 py-3 font-medium text-urgent-800">
        {row.stoppedAt === null
          ? "—"
          : formatDate(row.stoppedAt.toISOString().slice(0, 10))}
      </td>

      <td className="px-4 py-3">
        <Spent
          elapsed={row.elapsedWorkingDays}
          paused={row.pausedWorkingDays}
        />
      </td>
    </tr>
  );
}
