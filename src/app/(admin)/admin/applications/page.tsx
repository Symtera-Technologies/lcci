import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import type { ProcessingTier } from "@/db/schema";
import {
  PAGE_SIZE,
  QUEUE_SCOPES,
  daysFromDue,
  isQueueScope,
  loadQueue,
  type QueueFilters,
  type QueueRow,
  type QueueScope,
} from "@/membership/queue";
import { TIER_WORKING_DAYS } from "@/membership/workflow";
import { StatusPill } from "@/components/admin/status-pill";

export const metadata: Metadata = {
  title: "Applications",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const TIERS: readonly ProcessingTier[] = ["regular", "urgent", "executive"];

function isTier(value: unknown): value is ProcessingTier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/**
 * The verification queue.
 *
 * Every filter is in the URL rather than in component state, which is the
 * whole reason this page has no client JavaScript. An officer can bookmark
 * "my breached Executive applications", send that link to a colleague, and use
 * the back button — none of which works when the filters live in React. It
 * also means the page is a plain server render on a connection where that
 * matters.
 */
export default async function ApplicationsQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("application.read");
  const params = await searchParams;

  const scope: QueueScope = isQueueScope(params.scope) ? params.scope : "open";
  const filters: QueueFilters = {
    scope,
    tier: isTier(params.tier) ? params.tier : undefined,
    breachedOnly: params.breached === "1",
    mine: params.mine === "1",
    unassigned: params.unassigned === "1",
    search: typeof params.q === "string" && params.q.trim() ? params.q.trim() : undefined,
    page: Number(params.page) || 1,
  };

  const queue = await loadQueue(actor, filters);

  const linkWith = (changes: Record<string, string | undefined>): string => {
    const next = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      scope,
      tier: filters.tier,
      breached: filters.breachedOnly ? "1" : undefined,
      mine: filters.mine ? "1" : undefined,
      unassigned: filters.unassigned ? "1" : undefined,
      q: filters.search,
      page: filters.page && filters.page > 1 ? String(filters.page) : undefined,
      ...changes,
    };
    for (const [key, value] of Object.entries(current)) {
      if (value) next.set(key, value);
    }
    const query = next.toString();
    return query ? `/admin/applications?${query}` : "/admin/applications";
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <h1 className="text-[1.75rem] font-semibold tracking-tight text-ink-950">
        Applications
      </h1>
      <p className="mt-2 max-w-prose text-[0.9375rem] leading-relaxed text-ink-700">
        Ordered by how close each one is to the deadline the chamber was paid
        for, not by when it arrived.
      </p>

      {/* Tabs are links, not buttons: they change the URL, so they are
          navigation, and a screen reader should announce them as such. */}
      <nav aria-label="Queue" className="mt-6 flex flex-wrap gap-2">
        {(Object.keys(QUEUE_SCOPES) as QueueScope[]).map((candidate) => (
          <Link
            key={candidate}
            href={linkWith({ scope: candidate, page: undefined })}
            aria-current={candidate === scope ? "page" : undefined}
            className={
              candidate === scope
                ? "inline-flex h-9 items-center gap-2 rounded-lg bg-ink-900 px-3.5 text-sm font-medium text-white"
                : "inline-flex h-9 items-center gap-2 rounded-lg border border-stone-300 bg-white px-3.5 text-sm font-medium text-ink-800 hover:border-ink-400"
            }
          >
            {QUEUE_SCOPES[candidate].label}
            <span className="tabular-nums text-stone-400">
              {queue.scopeCounts[candidate]}
            </span>
          </Link>
        ))}
      </nav>

      <form
        action="/admin/applications"
        method="get"
        className="mt-4 flex flex-wrap items-end gap-3"
      >
        <input type="hidden" name="scope" value={scope} />

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="queue-search"
            className="text-[0.8125rem] font-medium text-ink-800"
          >
            Firm or reference
          </label>
          <input
            id="queue-search"
            name="q"
            type="search"
            defaultValue={filters.search ?? ""}
            placeholder="Symtera, or LCCI/2026/…"
            className="h-11 w-60 rounded-lg border border-stone-300 bg-white px-3 text-[0.9375rem] text-ink-950 focus:border-brand-500"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="queue-tier" className="text-[0.8125rem] font-medium text-ink-800">
            Processing
          </label>
          <select
            id="queue-tier"
            name="tier"
            defaultValue={filters.tier ?? ""}
            className="h-11 rounded-lg border border-stone-300 bg-white px-3 text-[0.9375rem] text-ink-950 focus:border-brand-500"
          >
            <option value="">Any tier</option>
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {tier[0].toUpperCase() + tier.slice(1)} — {TIER_WORKING_DAYS[tier]} working
                days
              </option>
            ))}
          </select>
        </div>

        <fieldset className="flex flex-wrap items-center gap-4">
          <legend className="sr-only">Narrow the list</legend>
          <Checkbox name="breached" label="Late only" checked={filters.breachedOnly} />
          <Checkbox name="mine" label="Assigned to me" checked={filters.mine} />
          <Checkbox name="unassigned" label="Unassigned" checked={filters.unassigned} />
        </fieldset>

        <button
          type="submit"
          className="h-11 rounded-lg bg-ink-900 px-5 text-[0.9375rem] font-medium text-white hover:bg-ink-800"
        >
          Apply
        </button>

        {(filters.tier ||
          filters.breachedOnly ||
          filters.mine ||
          filters.unassigned ||
          filters.search) && (
          <Link
            href={`/admin/applications?scope=${scope}`}
            className="h-11 self-end pb-3 text-sm font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
          >
            Clear
          </Link>
        )}
      </form>

      <p className="mt-6 text-[0.8125rem] text-stone-600" role="status">
        {queue.total === 0
          ? "Nothing matches."
          : `${queue.total} application${queue.total === 1 ? "" : "s"}` +
            (queue.pageCount > 1
              ? `, showing ${(queue.page - 1) * PAGE_SIZE + 1}–${Math.min(
                  queue.page * PAGE_SIZE,
                  queue.total,
                )}`
              : "")}
      </p>

      {queue.rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[56rem] border-collapse text-left text-[0.9375rem]">
            <caption className="sr-only">
              Membership applications in the {QUEUE_SCOPES[scope].label} queue,
              most urgent first
            </caption>
            <thead>
              <tr className="border-b border-stone-300 text-[0.8125rem] uppercase tracking-[0.06em] text-stone-600">
                <th scope="col" className="py-2 pr-4 font-medium">
                  Reference
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Firm
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Class and tier
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Deadline
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Officer
                </th>
                <th scope="col" className="py-2 font-medium">
                  Docs
                </th>
              </tr>
            </thead>
            <tbody>
              {queue.rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-3 rounded-xl border border-stone-200 bg-white p-5 text-[0.9375rem] text-ink-700">
          {scope === "open"
            ? "Nothing is waiting on the chamber in this queue."
            : "No applications here."}
        </p>
      )}

      {queue.pageCount > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center gap-4 text-sm">
          {queue.page > 1 && (
            <Link
              href={linkWith({ page: String(queue.page - 1) })}
              className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4"
            >
              Previous
            </Link>
          )}
          <span className="text-stone-600">
            Page {queue.page} of {queue.pageCount}
          </span>
          {queue.page < queue.pageCount && (
            <Link
              href={linkWith({ page: String(queue.page + 1) })}
              className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4"
            >
              Next
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}

function Row({ row }: { row: QueueRow }) {
  const days = daysFromDue(row.dueDate);

  return (
    <tr className="border-b border-stone-200 align-top">
      <td className="py-3 pr-4 whitespace-nowrap">
        <Link
          href={`/admin/applications/${row.id}`}
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          {row.publicRef ?? `Draft #${row.id}`}
        </Link>
      </td>

      <td className="py-3 pr-4">
        {row.firmName ?? <span className="text-stone-500">Not yet named</span>}
      </td>

      <td className="py-3 pr-4">
        <StatusPill state={row.state} />
      </td>

      <td className="py-3 pr-4 whitespace-nowrap text-ink-800">
        {row.membershipClass ? (
          <>
            <span className="capitalize">{row.membershipClass}</span>
            {row.processingTier && (
              <span className="text-stone-600"> · {row.processingTier}</span>
            )}
          </>
        ) : (
          <span className="text-stone-500">—</span>
        )}
      </td>

      {/* The number in words, not a coloured row. A queue gets printed, and a
          red background does not survive a photocopier or a colleague who
          cannot separate these particular reds from the page. */}
      <td className="py-3 pr-4 whitespace-nowrap">
        {row.dueDate === null ? (
          <span className="text-stone-500">—</span>
        ) : days !== null && days < 0 ? (
          <span className="font-medium text-urgent-700">
            {Math.abs(days)} day{Math.abs(days) === 1 ? "" : "s"} late
          </span>
        ) : days === 0 ? (
          <span className="font-medium text-urgent-700">Due today</span>
        ) : (
          <span className="text-ink-800">
            {days} day{days === 1 ? "" : "s"} left
          </span>
        )}
        {row.slaState === "paused" && (
          <span className="block text-[0.75rem] text-stone-600">clock paused</span>
        )}
      </td>

      <td className="py-3 pr-4 whitespace-nowrap">
        {row.assignedToName ?? <span className="text-stone-500">Unassigned</span>}
      </td>

      <td className="py-3 tabular-nums text-ink-800">{row.documentCount}</td>
    </tr>
  );
}

function Checkbox({
  name,
  label,
  checked,
}: {
  name: string;
  label: string;
  checked?: boolean;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-2 text-[0.9375rem] text-ink-900">
      <input
        type="checkbox"
        name={name}
        value="1"
        defaultChecked={checked}
        className="h-4 w-4 accent-brand-700"
      />
      {label}
    </label>
  );
}
