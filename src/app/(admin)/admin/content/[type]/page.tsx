import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/auth/dal";
import { countForList, previewList, type PreviewItem } from "@/content/preview";
import { CONTENT_FORMS, isContentKind } from "@/content/fields";
import { ContentStatusPill, visibilityNote } from "@/components/admin/content-status-pill";
import { formatDateShort } from "@/lib/format";
import type { ContentStatus } from "@/db/schema";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

const STATUSES: readonly ContentStatus[] = ["draft", "in_review", "published", "archived"];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ type: string }>;
}): Promise<Metadata> {
  const { type } = await params;
  return {
    title: isContentKind(type) ? CONTENT_FORMS[type].plural : "Content",
    robots: { index: false, follow: false },
  };
}

/**
 * One content type's list.
 *
 * Ordered by when it was last touched, not by publication date. A queue of
 * drafts has no publication dates to sort by, and the thing an editor opens
 * this screen looking for is what they or a colleague were working on.
 *
 * **The filters are links and the search is a GET form.** Narrowing a list is
 * navigation, not a mutation: no action, no sentinel, and every view is a URL
 * that can be pasted into a message. It also means the back button does what
 * it looks like it does, which a client-side filter would not.
 *
 * **Published is not the same as visible.** The status column says what an
 * editor decided; the note under it says what a visitor can see, because an
 * embargoed release and a retired notice are both `published` and neither is
 * on the site. Without that line the first question of every support
 * conversation is "it says published, why can I not see it".
 */
export default async function ContentListPage({
  params,
  searchParams,
}: {
  params: Promise<{ type: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { type } = await params;
  if (!isContentKind(type)) notFound();

  const actor = await requireStaffPage("content.read_draft");
  const query = await searchParams;

  const form = CONTENT_FORMS[type];
  const status = statusFilter(query.status);
  const search = one(query.q);
  const page = Math.max(1, positiveInt(query.page) ?? 1);

  const [items, total] = await Promise.all([
    previewList(actor, type, {
      status,
      search,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    countForList(actor, type, { status, search }),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const base = new URLSearchParams();
  if (status) base.set("status", status);
  if (search) base.set("q", search);

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="text-[0.875rem]">
        <Link
          href="/admin/content"
          className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
        >
          Content
        </Link>
      </nav>

      <header className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            {form.plural}
          </h1>
          <p className="mt-1 text-[0.9375rem] text-ink-700">
            {total === 0
              ? "Nothing here yet."
              : `${total} ${total === 1 ? "item" : "items"}${status ? ` ${describe(status)}` : ""}${
                  search ? ` matching “${search}”` : ""
                }.`}
          </p>
        </div>

        {actor.permissions.has("content.create") && (
          <Link
            href={`/admin/content/${type}/new`}
            className="rounded-lg bg-brand-800 px-4 py-2 text-[0.875rem] font-medium text-white hover:bg-brand-900"
          >
            New {form.singular.toLowerCase()}
          </Link>
        )}
      </header>

      {query.deleted !== undefined && (
        <p className="mt-6 rounded-lg border border-stone-300 bg-stone-50 px-4 py-3 text-[0.9375rem] text-ink-800">
          Draft deleted. What it said is kept in the audit log.
        </p>
      )}

      <section aria-labelledby="narrow-heading" className="mt-6">
        <h2 id="narrow-heading" className="sr-only">
          Narrow this list
        </h2>

        <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
          <Chip href={listHref(type, { q: search })} current={status === undefined}>
            All
          </Chip>
          {STATUSES.map((candidate) => (
            <Chip
              key={candidate}
              href={listHref(type, { status: candidate, q: search })}
              current={status === candidate}
            >
              {describeShort(candidate)}
            </Chip>
          ))}
        </nav>

        <form
          method="get"
          action={`/admin/content/${type}`}
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          {status && <input type="hidden" name="status" value={status} />}
          <label className="flex flex-col gap-1">
            <span className="text-[0.8125rem] font-medium text-ink-700">
              Search {form.titleLabel.toLowerCase()}
            </span>
            <input
              type="search"
              name="q"
              defaultValue={search ?? ""}
              className="w-72 rounded-lg border border-ink-300 bg-white px-3 py-2 text-[0.9375rem] text-ink-950 focus-visible:border-brand-700"
            />
          </label>
          <button
            type="submit"
            className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-[0.875rem] font-medium text-ink-800 hover:border-ink-500"
          >
            Search
          </button>
          {search && (
            <Link
              href={listHref(type, { status })}
              className="text-[0.875rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Clear
            </Link>
          )}
        </form>
      </section>

      {items.length === 0 ? (
        <p className="mt-8 rounded-lg border border-stone-200 bg-white px-4 py-6 text-center text-[0.9375rem] text-ink-600">
          {total === 0 && !status && !search
            ? `No ${form.plural.toLowerCase()} have been created yet.`
            : "Nothing matches that."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-left">
            <caption className="sr-only">
              {form.plural}, most recently changed first
            </caption>
            <thead>
              <tr className="border-b border-stone-300 text-[0.8125rem] text-ink-600">
                <th scope="col" className="py-2 pr-4 font-medium">
                  {form.titleLabel}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Department
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Last changed
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <Row key={item.id} item={item} type={type} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav aria-label="Pages" className="mt-6 flex items-center gap-4 text-[0.875rem]">
          {page > 1 ? (
            <Link
              href={withPage(type, base, page - 1)}
              className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Newer
            </Link>
          ) : (
            <span className="text-ink-400">Newer</span>
          )}
          <span className="text-ink-600">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Link
              href={withPage(type, base, page + 1)}
              className="text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Older
            </Link>
          ) : (
            <span className="text-ink-400">Older</span>
          )}
        </nav>
      )}
    </main>
  );
}

function Row({ item, type }: { item: PreviewItem; type: string }) {
  const note = visibilityNote(item);

  return (
    <tr className="border-b border-stone-200 align-top">
      <td className="py-3 pr-4">
        <Link
          href={`/admin/content/${type}/${item.id}`}
          className="text-[0.9375rem] font-medium text-ink-950 underline decoration-transparent underline-offset-4 hover:decoration-ink-400"
        >
          {item.titleEn}
        </Link>
        <p className="mt-0.5 font-mono text-[0.75rem] text-ink-500">{item.slug}</p>
      </td>
      <td className="py-3 pr-4">
        <ContentStatusPill status={item.status} />
        {note && <p className="mt-1 text-[0.75rem] text-ink-600">{note}</p>}
      </td>
      <td className="py-3 pr-4 text-[0.875rem] text-ink-700">{item.departmentName}</td>
      <td className="py-3 pr-4 text-[0.875rem] whitespace-nowrap text-ink-700">
        {formatDateShort(item.updatedAt.toISOString())}
      </td>
      <td className="py-3 text-[0.875rem]">
        <Link
          href={`/admin/content/${type}/${item.id}`}
          className="text-brand-800 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Edit
        </Link>
      </td>
    </tr>
  );
}

function Chip({
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
      aria-current={current ? "true" : undefined}
      className={
        current
          ? "rounded-full border border-brand-700 bg-brand-800 px-3 py-1 text-[0.8125rem] font-medium text-white"
          : "rounded-full border border-ink-300 bg-white px-3 py-1 text-[0.8125rem] text-ink-700 hover:border-ink-500"
      }
    >
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */

function one(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | string[] | undefined): number | undefined {
  const raw = one(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function statusFilter(value: string | string[] | undefined): ContentStatus | undefined {
  const raw = one(value);
  return raw !== undefined && (STATUSES as readonly string[]).includes(raw)
    ? (raw as ContentStatus)
    : undefined;
}

function listHref(
  type: string,
  parts: { status?: ContentStatus; q?: string },
): string {
  const search = new URLSearchParams();
  if (parts.status) search.set("status", parts.status);
  if (parts.q) search.set("q", parts.q);
  const query = search.toString();
  return query ? `/admin/content/${type}?${query}` : `/admin/content/${type}`;
}

function withPage(type: string, base: URLSearchParams, page: number): string {
  const search = new URLSearchParams(base);
  if (page > 1) search.set("page", String(page));
  const query = search.toString();
  return query ? `/admin/content/${type}?${query}` : `/admin/content/${type}`;
}

function describe(status: ContentStatus): string {
  return status === "in_review" ? "in review" : status;
}

function describeShort(status: ContentStatus): string {
  switch (status) {
    case "draft":
      return "Drafts";
    case "in_review":
      return "In review";
    case "published":
      return "Published";
    case "archived":
      return "Archived";
  }
}
