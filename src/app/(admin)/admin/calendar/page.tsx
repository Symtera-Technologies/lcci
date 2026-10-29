import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import {
  calendarReach,
  listDeviations,
  type CalendarDay,
} from "@/membership/calendar";
import { formatDate } from "@/lib/format";
import {
  CalendarDayForm,
  ExtendCalendarForm,
} from "@/components/admin/calendar-forms";
import { setCalendarDayAction, extendCalendarAction } from "./actions";

export const metadata: Metadata = {
  title: "Working-day calendar",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const TIER_LABEL: Record<string, string> = {
  regular: "Regular",
  urgent: "Urgent",
  executive: "Executive",
};

/**
 * The holiday calendar, which is the input to every deadline in the system.
 *
 * It is a screen and not a seed file because Pakistani public holidays cannot
 * be computed. Eid, Ashura and Eid Milad-un-Nabi are lunar and notified days
 * in advance, Eid shifts on the moon sighting, bank holidays stop a pay order
 * being issued or realised, and Lahore adds closures for security and smog.
 * `0010_seed_calendar.sql` seeds Monday to Friday and nothing else, every row
 * marked provisional, and points here.
 *
 * The page shows the deviations from that assumption rather than 365 rows a
 * year. Almost every row says only "this was a Tuesday"; what a secretariat
 * reads back is the set of days somebody decided about.
 */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("calendar.manage");
  const query = await searchParams;

  const reach = await calendarReach(actor);
  const thisYear = new Date().getUTCFullYear();

  const requested = Number(
    Array.isArray(query.year) ? query.year[0] : (query.year ?? ""),
  );
  const year =
    Number.isInteger(requested) && reach.years.includes(requested)
      ? requested
      : (reach.years.find((candidate) => candidate === thisYear) ??
        reach.years[0] ??
        thisYear);

  const deviations = await listDeviations(actor, year);

  const lastYearCovered =
    reach.lastDate === null ? thisYear : Number(reach.lastDate.slice(0, 4));

  return (
    <main className="mx-auto max-w-[72rem] px-5 py-8 sm:px-8">
      <header>
        <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
          Working-day calendar
        </h1>
        <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-700">
          Every processing promise is counted in working days against this
          calendar. Monday to Friday is assumed and seeded; the holidays are
          entered here as they are notified, because none of them can be
          calculated.
        </p>
      </header>

      <Reach reach={reach} />

      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="deviations-heading">
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <h2
              id="deviations-heading"
              className="text-[1.125rem] font-semibold text-ink-950"
            >
              Days somebody decided about
            </h2>

            <nav aria-label="Year" className="flex flex-wrap gap-2">
              {reach.years.map((candidate) => (
                <Link
                  key={candidate}
                  href={`/admin/calendar?year=${candidate}`}
                  aria-current={candidate === year ? "page" : undefined}
                  className={
                    candidate === year
                      ? "inline-flex min-h-10 items-center rounded-lg border border-ink-900 bg-ink-900 px-3 text-[0.875rem] font-medium text-white"
                      : "inline-flex min-h-10 items-center rounded-lg border border-stone-300 bg-white px-3 text-[0.875rem] font-medium text-ink-800 hover:border-ink-400"
                  }
                >
                  {candidate}
                </Link>
              ))}
            </nav>
          </div>

          <p className="mt-2 text-[0.875rem] text-stone-600">
            Closures on a weekday, and weekends the chamber worked. Everything
            not listed follows the Monday-to-Friday assumption.
          </p>

          {deviations.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-[0.9375rem] text-ink-700">
              Nothing recorded for {year}. Every weekday is treated as a working
              day and every weekend as a closure — including the public holidays
              nobody has entered yet.
            </p>
          ) : (
            <div className="mt-6 overflow-x-auto rounded-xl border border-stone-200 bg-white">
              <table className="w-full border-collapse text-left text-[0.9375rem]">
                <caption className="sr-only">
                  Recorded calendar days for {year}
                </caption>
                <thead>
                  <tr className="border-b border-stone-200 text-[0.8125rem] text-stone-600">
                    <th scope="col" className="px-4 py-3 font-medium">
                      Date
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      The chamber is
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      What it is
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Standing
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {deviations.map((day) => (
                    <Row key={day.date} day={day} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="space-y-10">
          <section aria-labelledby="record-heading">
            <h2
              id="record-heading"
              className="text-[1.125rem] font-semibold text-ink-950"
            >
              Record a day
            </h2>
            <p className="mt-1 mb-4 text-[0.875rem] text-stone-600">
              Entering a closure inside a running application&rsquo;s window
              moves its promised date. That is correct — the promise is in
              working days — and every move is written to the audit log.
            </p>

            <CalendarDayForm
              action={setCalendarDayAction}
              defaultDate={`${year}-01-01`}
            />
          </section>

          <section aria-labelledby="extend-heading">
            <h2
              id="extend-heading"
              className="text-[1.125rem] font-semibold text-ink-950"
            >
              Extend it
            </h2>
            <p className="mt-1 mb-4 text-[0.875rem] text-stone-600">
              When the calendar runs out, an application cannot be submitted at
              all: the arithmetic refuses rather than quietly counting calendar
              days. Extend a year before the horizon above reaches today.
            </p>

            <ExtendCalendarForm
              action={extendCalendarAction}
              nextYear={lastYearCovered + 1}
            />
          </section>
        </aside>
      </div>
    </main>
  );
}

/**
 * How far the calendar reaches, per tier rather than as one date.
 *
 * The calendar running out hits the cheapest promise first: an Executive
 * application needs three working days of headroom and a Regular one forty, so
 * the Rs 20,000 tier survives longest and the Rs 10,650 tier fails first. That
 * is the opposite of how anybody would guess, which is why it is three rows
 * and not one sentence.
 */
function Reach({
  reach,
}: {
  reach: Awaited<ReturnType<typeof calendarReach>>;
}) {
  return (
    <section
      aria-labelledby="reach-heading"
      className="mt-8 rounded-xl border border-stone-200 bg-white p-5"
    >
      <h2
        id="reach-heading"
        className="text-[0.8125rem] font-semibold tracking-[0.08em] text-stone-600 uppercase"
      >
        How far it reaches
      </h2>

      <p className="mt-2 text-[0.9375rem] text-ink-900">
        {reach.firstDate === null || reach.lastDate === null ? (
          "The calendar is empty. No application can be submitted until it is extended."
        ) : (
          <>
            {formatDate(reach.firstDate)} to{" "}
            <span className="font-semibold">{formatDate(reach.lastDate)}</span>,
            with {reach.workingDaysAhead} working days left after today.
          </>
        )}
      </p>

      <ul className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-3">
        {Object.entries(reach.tierHorizon).map(([tier, horizon]) => (
          <li key={tier} className="text-[0.875rem]">
            <span className="font-medium text-ink-900">
              {TIER_LABEL[tier] ?? tier}
            </span>
            <span className="block text-stone-600">
              {horizon === null ? (
                <span className="font-medium text-urgent-700">
                  cannot be promised — extend the calendar
                </span>
              ) : (
                <>can be promised until {formatDate(horizon)}</>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const WEEKDAY = [
  "",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function Row({ day }: { day: CalendarDay }) {
  return (
    <tr className="border-b border-stone-100 last:border-b-0">
      <td className="px-4 py-3">
        <span className="font-medium text-ink-900">{formatDate(day.date)}</span>
        <span className="block text-[0.8125rem] text-stone-600">
          {WEEKDAY[day.weekday] ?? ""}
        </span>
      </td>

      {/* The word carries the meaning. A closure shown only as a red cell is
          lost in a printout of the year, which is how this list gets checked. */}
      <td className="px-4 py-3 text-ink-900">
        {day.isWorkingDay ? "Open" : "Closed"}
      </td>

      <td className="px-4 py-3 text-ink-900">
        {day.label ?? <span className="text-stone-500">—</span>}
        {day.source && (
          <span className="block text-[0.8125rem] text-stone-600">
            {day.source}
          </span>
        )}
      </td>

      <td className="px-4 py-3">
        <span
          className={
            day.confidence === "confirmed"
              ? "text-ink-900"
              : "font-medium text-urgent-800"
          }
        >
          {day.confidence === "confirmed" ? "Confirmed" : "Provisional"}
        </span>
        <span className="block text-[0.8125rem] text-stone-600">
          {day.notifiedOn
            ? `notified ${formatDate(day.notifiedOn)}`
            : "not yet notified"}
        </span>
      </td>
    </tr>
  );
}
