import type { Metadata } from "next";
import Link from "next/link";
import { Mail, Phone } from "lucide-react";
import { requireStaffPage } from "@/server/auth/dal";
import { countEnquiries, listEnquiries, enquiryInbox } from "@/server/enquiries";
import { CONTACT_TOPICS, contactTopicLabel } from "@/content/contact-topics";
import { formatDate, formatTime } from "@/lib/format";

export const metadata: Metadata = {
  title: "Enquiries",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

/**
 * What the public sent through the contact form.
 *
 * **Not the place enquiries are answered.** Staff read them in the chamber's
 * own inbox and press reply there, because that is where a reply thread
 * belongs and because a second place to answer from would mean two halves of
 * every conversation. This screen exists for the half of the job the inbox
 * cannot do: proving that the form is working, and holding what the mail
 * server failed to deliver.
 *
 * Which is why the delivery column is the one worth looking at. A list of
 * enquiries tells you what came in. A list of enquiries whose notifications
 * say `dead` tells you the form has been working and the inbox has not —
 * which is the failure that otherwise shows up weeks later as a member saying
 * nobody answered them.
 *
 * There is no status, no assignee and no "mark as handled". A status column
 * that nobody updates makes this screen lie about which enquiries were
 * answered, and the honest version of that is to not have one until LCCI
 * decides someone owns the triage.
 */
export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("enquiry.read");
  const query = await searchParams;

  const search = one(query.q);
  const topic = one(query.topic);
  const page = Math.max(1, positiveInt(query.page) ?? 1);

  const filters = { search, topic, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };

  const [rows, total] = await Promise.all([
    listEnquiries(actor, filters),
    countEnquiries(actor, filters),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-[72rem] px-5 py-8 sm:px-8">
      <header>
        <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">Enquiries</h1>
        <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-700">
          Everything sent through the contact form on the website. Each one was
          also emailed to{" "}
          <span className="font-medium text-ink-900">{enquiryInbox()}</span>, and
          answering happens there — reply to the mail and it reaches the sender.
          This list is the record, and the place to look when the mail did not
          arrive.
        </p>
      </header>

      <form method="get" action="/admin/enquiries" className="mt-7 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[0.8125rem] font-medium text-ink-700">
            Search name, address, reference or message
          </span>
          <input
            type="search"
            name="q"
            defaultValue={search ?? ""}
            className="w-80 rounded-lg border border-ink-300 bg-white px-3 py-2 text-[0.9375rem] text-ink-950 focus-visible:border-brand-700"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[0.8125rem] font-medium text-ink-700">Topic</span>
          <select
            name="topic"
            defaultValue={topic ?? ""}
            className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-[0.9375rem] text-ink-950 focus-visible:border-brand-700"
          >
            <option value="">All topics</option>
            {CONTACT_TOPICS.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="rounded-lg bg-ink-900 px-4 py-2 text-[0.875rem] font-medium text-white hover:bg-ink-800"
        >
          Filter
        </button>

        {(search || topic) && (
          <Link
            href="/admin/enquiries"
            className="py-2 text-[0.875rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
          >
            Clear
          </Link>
        )}
      </form>

      <p className="mt-6 text-[0.875rem] text-ink-600">
        {total === 0
          ? "Nothing to show."
          : `${total.toLocaleString("en-GB")} ${total === 1 ? "enquiry" : "enquiries"}${
              search || topic ? " matching" : ""
            }.`}
      </p>

      <ol className="mt-4 space-y-4">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-xl border border-ink-200 bg-white px-5 py-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="text-[1.0625rem] font-semibold text-ink-950">
                {row.senderName}
                {row.organisation && (
                  <span className="ml-2 font-normal text-ink-600">
                    · {row.organisation}
                  </span>
                )}
              </h2>
              <p className="font-mono text-[0.8125rem] text-ink-600">{row.reference}</p>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.8125rem] text-ink-600">
              <span className="rounded-full bg-brand-50 px-2.5 py-0.5 font-medium text-brand-800 ring-1 ring-inset ring-brand-300">
                {contactTopicLabel(row.topic)}
              </span>
              <span>
                {formatDate(row.receivedAt)} at {formatTime(row.receivedAt)}
              </span>
              <Delivery state={row.delivery} />
            </div>

            <p className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.875rem]">
              <a
                href={`mailto:${row.senderEmail}?subject=${encodeURIComponent(
                  `Re: your enquiry to the Lahore Chamber (${row.reference})`,
                )}`}
                className="inline-flex items-center gap-1.5 font-medium text-brand-800 underline decoration-brand-400 decoration-2 underline-offset-4 hover:decoration-brand-700"
              >
                <Mail className="h-3.5 w-3.5" aria-hidden />
                {row.senderEmail}
              </a>
              {row.senderPhone && (
                <span className="inline-flex items-center gap-1.5 text-ink-700">
                  <Phone className="h-3.5 w-3.5" aria-hidden />
                  {row.senderPhone}
                </span>
              )}
            </p>

            {/* `whitespace-pre-wrap` and nothing else. The message is plain
                text that a stranger typed, it is rendered as a text node, and
                there is no step anywhere on this page that would treat it as
                markup. */}
            <p className="mt-3 border-t border-ink-100 pt-3 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-ink-800">
              {row.body}
            </p>
          </li>
        ))}
      </ol>

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-8 flex items-center gap-4 text-[0.875rem]">
          {page > 1 && (
            <Link
              href={pageHref(page - 1, search, topic)}
              className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Previous
            </Link>
          )}
          <span className="text-ink-600">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link
              href={pageHref(page + 1, search, topic)}
              className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Next
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}

/**
 * What became of the email to the chamber.
 *
 * Only the states worth acting on are coloured. `sent` is the overwhelming
 * majority and gets the quietest treatment, because a list where every row is
 * green is a list nobody scans.
 */
function Delivery({ state }: { state: string | null }) {
  if (state === "sent") return <span className="text-ink-500">Emailed</span>;

  if (state === null) {
    return (
      <span className="font-medium text-urgent-700">
        Never queued — this was not emailed
      </span>
    );
  }

  if (state === "dead") {
    return (
      <span className="font-medium text-urgent-700">
        Email failed — reply from here instead
      </span>
    );
  }

  return <span className="font-medium text-ink-800">Email {state}</span>;
}

function pageHref(page: number, search?: string, topic?: string): string {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (topic) params.set("topic", topic);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/enquiries?${query}` : "/admin/enquiries";
}

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.trim() !== "" ? first.trim() : undefined;
}

function positiveInt(value: string | string[] | undefined): number | undefined {
  const raw = one(value);
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
