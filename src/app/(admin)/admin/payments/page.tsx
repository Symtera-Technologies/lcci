import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import { cashierQueue } from "@/membership/payments";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Fees",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The cashier's queue.
 *
 * Ordered by the processing deadline rather than by arrival, because the three
 * tiers are a paid promise in working days — Rs 20,000 buys three of them — and
 * the cashier's desk is one of the two places that promise is actually spent.
 * An Executive application that arrived this morning is due before a Regular
 * one from six weeks ago, and a queue sorted by submission hides exactly that.
 *
 * Receipting runs *in parallel* with document verification, which is why this
 * is its own queue and not a column on the officers'. The pay order arrives
 * with the form, so making the cashier wait for verification — or the officer
 * wait for the cashier — would model a sequence the paper process does not
 * have.
 */
export default async function PaymentsQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("payment.read");
  const query = await searchParams;

  const showAll = query.show === "all";
  const rows = await cashierQueue(actor, { outstandingOnly: !showAll });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <main className="mx-auto max-w-[96rem] px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            Fees
          </h1>
          <p className="mt-1 text-[0.9375rem] text-ink-700">
            {showAll
              ? "Every fee on a submitted application."
              : "Fees not yet settled, soonest promise first."}
          </p>
        </div>

        <nav aria-label="Filter" className="flex gap-2">
          <Link
            href="/admin/payments"
            aria-current={!showAll ? "page" : undefined}
            className={
              !showAll
                ? "inline-flex min-h-11 items-center rounded-lg border border-ink-900 bg-ink-900 px-3.5 text-[0.875rem] font-medium text-white"
                : "inline-flex min-h-11 items-center rounded-lg border border-stone-300 bg-white px-3.5 text-[0.875rem] font-medium text-ink-800 hover:border-ink-400"
            }
          >
            Outstanding
          </Link>
          <Link
            href="/admin/payments?show=all"
            aria-current={showAll ? "page" : undefined}
            className={
              showAll
                ? "inline-flex min-h-11 items-center rounded-lg border border-ink-900 bg-ink-900 px-3.5 text-[0.875rem] font-medium text-white"
                : "inline-flex min-h-11 items-center rounded-lg border border-stone-300 bg-white px-3.5 text-[0.875rem] font-medium text-ink-800 hover:border-ink-400"
            }
          >
            All
          </Link>
        </nav>
      </header>

      {rows.length === 0 ? (
        <p className="mt-8 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-[0.9375rem] text-ink-700">
          {showAll
            ? "No submitted application has a fee against it yet."
            : "Every fee on a submitted application is settled."}
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full border-collapse text-left text-[0.9375rem]">
            <caption className="sr-only">
              {showAll ? "All fees" : "Unsettled fees"}, in order of the
              processing deadline
            </caption>
            <thead>
              <tr className="border-b border-stone-200 text-[0.8125rem] text-stone-600">
                <th scope="col" className="px-4 py-3 font-medium">
                  Application
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Fee
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  State
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Due
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const overdue = row.dueDate !== null && row.dueDate < today;
                return (
                  <tr
                    key={row.paymentId}
                    className="border-b border-stone-100 last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/admin/applications/${row.applicationId}/payment`}
                        className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
                      >
                        {row.publicRef ?? `#${row.applicationId}`}
                      </Link>
                      <span className="block text-[0.875rem] text-stone-600">
                        {row.firmName ?? "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-ink-900">
                      {row.feeKind === "itd_surcharge"
                        ? "ITD surcharge"
                        : "Membership"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-ink-900">
                      {row.amount} {row.currency}
                    </td>
                    <td className="px-4 py-3 text-ink-900">
                      {/*
                        The state first, and the receipt number only where the
                        state is `receipted`. A dishonoured fee keeps its
                        receipt number — finance has the counterfoil — so
                        printing the number here read as paid for money that
                        was returned.
                      */}
                      {row.state === "receipted" && row.receiptNo
                        ? row.receiptNo
                        : (STATE_WORDING[row.state] ?? row.state)}
                      {row.bankMatchVerdict === "mismatch" && (
                        <span className="block text-[0.8125rem] text-urgent-800">
                          bank mismatch
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {row.dueDate === null ? (
                        <span className="text-stone-500">no clock</span>
                      ) : (
                        <span
                          className={
                            overdue
                              ? "font-medium text-urgent-800"
                              : "text-ink-900"
                          }
                        >
                          {formatDate(row.dueDate)}
                          {/* Never colour alone: the word carries the meaning
                              and the colour reinforces it. */}
                          {overdue && (
                            <span className="block text-[0.8125rem]">
                              past due
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

const STATE_WORDING: Record<string, string> = {
  due: "Outstanding",
  instrument_received: "Taken in",
  receipted: "Receipted",
  dishonoured: "Dishonoured",
  refunded: "Refunded",
  waived: "Waived",
  cancelled: "Cancelled",
};
