import type { Metadata } from "next";
import Link from "next/link";
import { requireStaffPage } from "@/server/auth/dal";
import {
  auditEntityTypes,
  auditIntegrity,
  auditPage,
  type AuditEntry,
  type AuditIntegrity,
  type AuditRequestGroup,
  type Linkage,
} from "@/server/audit-read";
import { formatDateShort, formatTime } from "@/lib/format";

export const metadata: Metadata = {
  title: "Audit log",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The audit log, read back.
 *
 * `audit.read` is held by the super administrator alone, and that is the right
 * place for it. The per-file narrative staff need while working — submitted,
 * returned, verified, granted — comes from `application_state_transitions` and
 * is already on the application and the applicant's tracker. This screen is the
 * other thing: who did it, under which role, in which request, with the values
 * before and after. It answers a dispute, not a working question.
 *
 * **Grouped by request, because one approval is four events.** A grant writes
 * a decision, a membership, a number allocation and an SLA stop. Listed flat
 * they are four lines a reader has to reassemble; listed by `request_id` they
 * are one action with its consequences under it, which is what happened.
 *
 * **The payloads are behind a disclosure, not in the list.** `summary` is
 * written once at the time and is safe to read at a glance; `before`, `after`
 * and `context` can carry a document's original filename, and on this system a
 * CNIC scan's filename *is* the CNIC. So a page of history does not spray
 * identity numbers across the screen of whoever left it open, and opening one
 * is a deliberate act.
 *
 * Worth stating because it is a gap rather than a decision: reading this screen
 * is **not** itself recorded. Document reads are, in `document_access_log`, and
 * the same argument applies to a log that names every applicant and every
 * officer. A row per page load would fill the log with reads of itself, so the
 * useful version is coarser — and what it should be is LCCI's to say, not
 * something to invent here.
 */

const ENTITY_LABEL: Record<string, string> = {
  application: "Applications",
  membership: "Memberships",
  payment: "Fees",
  document: "Documents",
  calendar: "Calendar",
  user: "Accounts",
  session: "Sign-ins",
};

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function civilDate(value: string | string[] | undefined): string | undefined {
  const raw = one(value);
  return raw !== undefined && ISO_DATE.test(raw) ? raw : undefined;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("audit.read");
  const query = await searchParams;

  const filters = {
    entityType: one(query.entity),
    entityId: one(query.id),
    actorUserId: positiveInt(query.actor),
    action: one(query.action),
    requestId: one(query.request),
    from: civilDate(query.from),
    to: civilDate(query.to),
    before: positiveInt(query.before),
  };

  const [page, integrity, entityTypes] = await Promise.all([
    auditPage(actor, filters),
    auditIntegrity(actor),
    auditEntityTypes(actor),
  ]);

  // The cursor is deliberately dropped: changing a filter starts at the newest
  // matching event, because carrying an id from the previous filter would open
  // the new view part-way down for no reason the reader could see.
  const base = new URLSearchParams();
  if (filters.entityType) base.set("entity", filters.entityType);
  if (filters.entityId) base.set("id", filters.entityId);
  if (filters.actorUserId) base.set("actor", String(filters.actorUserId));
  if (filters.action) base.set("action", filters.action);
  if (filters.requestId) base.set("request", filters.requestId);
  if (filters.from) base.set("from", filters.from);
  if (filters.to) base.set("to", filters.to);

  const older = new URLSearchParams(base);
  if (page.nextCursor !== null) older.set("before", String(page.nextCursor));

  return (
    <main className="mx-auto max-w-[80rem] px-5 py-8 sm:px-8">
      <header>
        <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
          Audit log
        </h1>
        <p className="mt-1 max-w-3xl text-[0.9375rem] text-ink-700">
          Every recorded action, newest first, grouped by the request that
          performed it. The log is append-only and hash-chained: it does not
          prevent the record being altered, it makes an alteration show up here.
        </p>
      </header>

      <IntegrityPanel integrity={integrity} altered={page.altered} linkage={page.linkage} />

      <section aria-labelledby="filters-heading" className="mt-8">
        <h2 id="filters-heading" className="sr-only">
          Narrow the log
        </h2>

        <nav aria-label="Filter by kind of thing" className="flex flex-wrap gap-2">
          <Chip href="/admin/audit" current={filters.entityType === undefined}>
            Everything
          </Chip>
          {entityTypes.map((type) => (
            <Chip
              key={type}
              href={`/admin/audit?entity=${encodeURIComponent(type)}`}
              current={filters.entityType === type}
            >
              {ENTITY_LABEL[type] ?? type}
            </Chip>
          ))}
        </nav>

        {/*
          A GET form, so narrowing the log is navigation rather than a mutation:
          no action, no sentinel, and every view is a URL somebody can paste
          into a complaint file. The hidden fields carry the filters arrived at
          by clicking, which would otherwise be dropped by submitting this one.
        */}
        <form method="get" action="/admin/audit" className="mt-4 flex flex-wrap items-end gap-3">
          {filters.entityType && <input type="hidden" name="entity" value={filters.entityType} />}
          {filters.entityId && <input type="hidden" name="id" value={filters.entityId} />}
          {filters.actorUserId && (
            <input type="hidden" name="actor" value={String(filters.actorUserId)} />
          )}
          {filters.action && <input type="hidden" name="action" value={filters.action} />}
          {filters.requestId && <input type="hidden" name="request" value={filters.requestId} />}

          <DateBox name="from" label="From" value={filters.from} />
          <DateBox name="to" label="To" value={filters.to} />

          <button
            type="submit"
            className="rounded-lg border border-ink-300 bg-white px-4 py-2 text-[0.875rem] font-medium text-ink-800 hover:border-ink-500"
          >
            Apply dates
          </button>

          {(filters.from || filters.to) && (
            <Link
              href={`/admin/audit?${stripDates(base)}`}
              className="text-[0.875rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
            >
              Clear dates
            </Link>
          )}
        </form>

        {/*
          The name rather than the id where the page can supply one. A filter
          reading "account #11" asks the reader to hold a number in their head
          while every row beneath it says who that is.
        */}
        <ActiveFilters
          filters={filters}
          base={base}
          actorName={
            page.groups
              .flatMap((group) => group.entries)
              .find((entry) => entry.actor.userId === filters.actorUserId)?.actor.name ??
            null
          }
        />
      </section>

      <section aria-labelledby="log-heading" className="mt-8">
        <h2 id="log-heading" className="sr-only">
          Recorded actions
        </h2>

        {page.groups.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 bg-white p-8 text-center text-[0.9375rem] text-ink-700">
            Nothing recorded matches this.
          </p>
        ) : (
          <ol className="space-y-4">
            {page.groups.map((group) => (
              <li key={`${group.requestId}-${group.entries[0].id}`}>
                <RequestGroup group={group} />
              </li>
            ))}
          </ol>
        )}

        {page.nextCursor !== null && (
          <div className="mt-6 flex justify-center">
            <Link
              href={`/admin/audit?${older.toString()}`}
              className="rounded-lg border border-ink-300 bg-white px-5 py-2.5 text-[0.9375rem] font-medium text-ink-800 hover:border-ink-500"
            >
              Older events
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}

function stripDates(base: URLSearchParams): string {
  const next = new URLSearchParams(base);
  next.delete("from");
  next.delete("to");
  return next.toString();
}

/**
 * What the chain says about itself.
 *
 * The three findings are kept apart because they mean different things, and a
 * single green tick covering all of them would be a claim this page cannot
 * support: it verified the forty rows it is showing, not seven years.
 */
function IntegrityPanel({
  integrity,
  altered,
  linkage,
}: {
  integrity: AuditIntegrity;
  altered: readonly number[];
  linkage: Linkage;
}) {
  const broken =
    altered.length > 0 ||
    integrity.tail === "rows_missing" ||
    (linkage.kind === "checked" && linkage.brokenAfterId !== null) ||
    integrity.lastSweep?.broken === true;

  return (
    <section
      aria-labelledby="integrity-heading"
      className={`mt-6 rounded-xl border p-5 ${
        broken
          ? "border-urgent-600/50 bg-urgent-50"
          : "border-stone-200 bg-white"
      }`}
    >
      <h2
        id="integrity-heading"
        className="text-[0.75rem] font-semibold tracking-[0.08em] text-stone-600 uppercase"
      >
        Whether this record holds together
      </h2>

      <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <Finding
          label="The rows on this page"
          ok={altered.length === 0}
          detail={
            altered.length === 0
              ? "Each one hashes to the value stored on it, so none has been edited."
              : `${altered.length} ${
                  altered.length === 1 ? "row does" : "rows do"
                } not hash to the value stored on ${
                  altered.length === 1 ? "it" : "them"
                }. ${altered.length === 1 ? "It is" : "They are"} marked below.`
          }
        />

        <Finding
          label="Nothing missing between them"
          ok={linkage.kind === "checked" && linkage.brokenAfterId === null}
          unknown={linkage.kind === "not_checked"}
          detail={
            linkage.kind === "not_checked"
              ? "Not checked while a filter is on: selected rows are not meant to be next to each other, so a gap would prove nothing."
              : linkage.brokenAfterId === null
                ? "Each row names the one below it as its predecessor, so nothing has been removed from between them."
                : `The row after #${linkage.brokenAfterId} does not name it as its predecessor. Something that sat between them is gone.`
          }
        />

        <Finding
          label="Nothing missing from the end"
          ok={integrity.tail === "intact"}
          unknown={integrity.tail === "empty"}
          detail={
            integrity.tail === "empty"
              ? "The log is empty. There is nothing to check."
              : integrity.tail === "intact"
                ? `The newest event is #${integrity.newestId}, which is the one the chain head names.`
                : `The chain head names #${integrity.headId}, but the newest event in the table is #${integrity.newestId}. Rows have been removed from the end.`
          }
        />
      </dl>

      <p className="mt-4 border-t border-stone-200 pt-3 text-[0.8125rem] text-stone-600">
        {integrity.lastSweep === null ? (
          <>
            The weekly check has never run, so only the rows on this page have
            been verified. Everything older is unexamined.
          </>
        ) : integrity.lastSweep.broken ? (
          <>
            The weekly check last reported a break at event #
            {integrity.lastSweep.brokenAtId}. A break does not prove tampering —
            a partly applied restore looks the same — but it does mean this
            table is no longer a record to rely on.
          </>
        ) : (
          <>
            The weekly check found no break
            {integrity.lastSweep.at
              ? `, last finishing ${formatDateShort(
                  integrity.lastSweep.at.toISOString(),
                )} at ${formatTime(integrity.lastSweep.at.toISOString())}`
              : ""}
            . It walks the whole chain in pages; this page verified only what it
            is showing.
          </>
        )}
      </p>
    </section>
  );
}

function Finding({
  label,
  ok,
  unknown = false,
  detail,
}: {
  label: string;
  ok: boolean;
  unknown?: boolean;
  detail: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-[0.9375rem] font-medium text-ink-900">
        {/*
          A word, not only a colour. The palette has success and urgent steps
          and neither is allowed to carry the meaning on its own.
        */}
        <span
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold tracking-wide uppercase ${
            unknown
              ? "bg-stone-100 text-stone-700"
              : ok
                ? "bg-success-50 text-success-800"
                : "bg-urgent-200 text-urgent-800"
          }`}
        >
          {unknown ? "Not checked" : ok ? "Holds" : "Broken"}
        </span>
        {label}
      </dt>
      <dd className="mt-1 text-[0.8125rem] text-stone-600">{detail}</dd>
    </div>
  );
}

function ActiveFilters({
  filters,
  base,
  actorName,
}: {
  filters: {
    entityId?: string;
    actorUserId?: number;
    action?: string;
    requestId?: string;
  };
  base: URLSearchParams;
  actorName: string | null;
}) {
  const active: { label: string; value: string; param: string }[] = [];
  if (filters.entityId) {
    active.push({ label: "this record", value: filters.entityId, param: "id" });
  }
  if (filters.actorUserId) {
    active.push({
      label: "one person",
      value: actorName ?? `account #${filters.actorUserId}`,
      param: "actor",
    });
  }
  if (filters.action) {
    active.push({ label: "one action", value: filters.action, param: "action" });
  }
  if (filters.requestId) {
    active.push({
      label: "one request",
      value: filters.requestId,
      param: "request",
    });
  }

  if (active.length === 0) return null;

  return (
    <p className="mt-4 flex flex-wrap items-center gap-2 text-[0.875rem] text-ink-700">
      <span>Narrowed to</span>
      {active.map((item) => {
        const without = new URLSearchParams(base);
        without.delete(item.param);
        return (
          <span
            key={item.param}
            className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-white px-3 py-1"
          >
            <span className="text-stone-600">{item.label}:</span>
            <span className="font-medium text-ink-900">{item.value}</span>
            <Link
              href={`/admin/audit?${without.toString()}`}
              className="text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-ink-800"
              aria-label={`Stop narrowing to ${item.label}`}
            >
              remove
            </Link>
          </span>
        );
      })}
    </p>
  );
}

function RequestGroup({ group }: { group: AuditRequestGroup }) {
  const iso = group.occurredAt.toISOString();

  return (
    <article className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-stone-200 bg-stone-50 px-4 py-3">
        <h3 className="text-[0.9375rem] font-semibold text-ink-950">
          <Actor actor={group.actor} />
        </h3>
        <p className="text-[0.8125rem] text-stone-600">
          {formatDateShort(iso)} at {formatTime(iso)}
          {group.entries.length > 1 && (
            <> · {group.entries.length} events in one request</>
          )}
        </p>
        <Link
          href={`/admin/audit?request=${encodeURIComponent(group.requestId)}`}
          className="ml-auto font-mono text-[0.75rem] text-stone-500 underline decoration-stone-300 underline-offset-2 hover:text-ink-800"
          title="Everything this request did"
        >
          {group.requestId}
        </Link>
      </header>

      <ol className="divide-y divide-stone-100">
        {group.entries.map((entry) => (
          <li key={entry.id}>
            <Entry entry={entry} />
          </li>
        ))}
      </ol>
    </article>
  );
}

function Actor({ actor }: { actor: AuditRequestGroup["actor"] }) {
  if (actor.kind === "system") {
    return (
      <>
        <span>The system</span>
        <span className="ml-2 text-[0.8125rem] font-normal text-stone-600">
          a scheduled job, holding no permissions
        </span>
      </>
    );
  }

  /*
    An account since deleted still shows the role it held, because that is the
    fact the log kept. It is not linked and not called "somebody", both of which
    would read as the record having lost the actor — it has not; it has lost
    only the name, and saying which role approved something is most of the
    answer when the question is whether the right person did.
  */
  if (actor.kind === "deleted") {
    return (
      <>
        <span>An account since deleted</span>
        <span className="ml-2 text-[0.8125rem] font-normal text-stone-600">
          acting as {actor.roleCode?.replace(/_/g, " ")}
        </span>
      </>
    );
  }

  return (
    <>
      <Link
        href={`/admin/audit?actor=${actor.userId}`}
        className="underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
      >
        {actor.name ?? `Account #${actor.userId}`}
      </Link>
      {actor.roleCode && (
        <span className="ml-2 text-[0.8125rem] font-normal text-stone-600">
          as {actor.roleCode.replace(/_/g, " ")}
        </span>
      )}
    </>
  );
}

function Entry({ entry }: { entry: AuditEntry }) {
  const hasPayload =
    entry.before !== null || entry.after !== null || entry.context !== null;

  return (
    <div
      className={`px-4 py-3 ${entry.integrity === "altered" ? "bg-urgent-50" : ""}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/*
          The action code verbatim, in monospace. It is not prettified into a
          sentence because it is the string an auditor is given to look for, and
          a map of friendly names for sixty-odd codes would go quietly stale the
          first time one was added. The sentence is `summary`, which was written
          at the time and means what it said then.
        */}
        <Link
          href={`/admin/audit?action=${encodeURIComponent(entry.action)}`}
          className="font-mono text-[0.8125rem] text-ink-800 underline decoration-ink-200 underline-offset-2 hover:decoration-ink-600"
        >
          {entry.action}
        </Link>

        <EntityLink entry={entry} />

        <span className="ml-auto font-mono text-[0.75rem] text-stone-400">
          #{entry.id}
        </span>
      </div>

      <p className="mt-1 text-[0.9375rem] text-ink-900">{entry.summary}</p>

      {entry.onBehalfOf && (
        <p className="mt-1 text-[0.8125rem] text-stone-600">
          Acting for {entry.onBehalfOf.name ?? `account #${entry.onBehalfOf.userId}`}.
        </p>
      )}

      {entry.integrity === "altered" && (
        <p className="mt-2 rounded-lg border border-urgent-600/40 bg-white p-3 text-[0.875rem] text-urgent-800">
          This row does not hash to the value stored on it. Either its contents
          were changed after it was written, or the stored hash was. Nothing on
          this line can be relied on.
        </p>
      )}

      {hasPayload && (
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer items-center text-[0.8125rem] text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600">
            What changed
          </summary>
          <div className="mt-2 space-y-3 border-l-2 border-stone-200 pl-4">
            {entry.before !== null && <Payload label="Before" value={entry.before} />}
            {entry.after !== null && <Payload label="After" value={entry.after} />}
            {entry.context !== null && <Payload label="Context" value={entry.context} />}
            {entry.formRevisionId !== null && (
              <p className="text-[0.8125rem] text-stone-600">
                Form revision {entry.formRevisionId} was in force.
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * A link to the thing the event is about, where there is a screen for it.
 *
 * `entity_id` is a VARCHAR holding a numeric application id, a document uuid or
 * a press-release slug, so the link is built per type rather than assumed. An
 * unrecognised type still shows what it refers to — an audit log that hides the
 * subject of an event because the developer had not thought of a screen for it
 * would be worse than one with a plain label.
 */
function EntityLink({ entry }: { entry: AuditEntry }) {
  const label = `${entry.entityType} ${entry.entityId}`;

  const href =
    entry.entityType === "application" && /^\d+$/.test(entry.entityId)
      ? `/admin/applications/${entry.entityId}`
      : null;

  return (
    <span className="text-[0.8125rem] text-stone-600">
      {href ? (
        <Link
          href={href}
          className="underline decoration-stone-300 underline-offset-2 hover:text-ink-800"
        >
          {label}
        </Link>
      ) : (
        label
      )}
      {/*
        Named for a reader who meets the link on its own. "Its history" is
        clear beside the label and useless in a list of links read out in
        sequence, which is how one of these pages is navigated by anyone not
        looking at it — and there are twenty of them on a page, all with the
        same text and different destinations.
      */}
      <Link
        href={`/admin/audit?entity=${encodeURIComponent(
          entry.entityType,
        )}&id=${encodeURIComponent(entry.entityId)}`}
        aria-label={`Everything recorded about ${label}`}
        className="ml-2 underline decoration-stone-300 underline-offset-2 hover:text-ink-800"
      >
        its history
      </Link>
    </span>
  );
}

/**
 * One payload, as rows rather than a blob of JSON.
 *
 * A flat object is the common case and reads as a list of fields. Anything
 * nested falls back to formatted JSON, because guessing at a shape and
 * flattening it wrongly would misreport the record this screen exists to show
 * exactly.
 */
function Payload({ label, value }: { label: string; value: unknown }) {
  const flat =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (v) => v === null || typeof v !== "object",
    );

  return (
    <div>
      <p className="text-[0.75rem] font-semibold tracking-[0.06em] text-stone-500 uppercase">
        {label}
      </p>
      {flat ? (
        <dl className="mt-1 grid gap-x-4 gap-y-1 text-[0.875rem] sm:grid-cols-[auto_1fr]">
          {Object.entries(value as Record<string, unknown>).map(([key, v]) => (
            <div key={key} className="contents">
              <dt className="font-mono text-[0.8125rem] text-stone-600">{key}</dt>
              <dd className="text-ink-900">
                {v === null ? (
                  <span className="text-stone-500">not set</span>
                ) : (
                  String(v)
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <pre className="mt-1 overflow-x-auto rounded-lg bg-stone-50 p-3 text-[0.75rem] text-ink-900">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
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
      className={`rounded-full border px-3.5 py-1.5 text-[0.875rem] font-medium ${
        current
          ? "border-brand-800 bg-brand-800 text-white"
          : "border-ink-200 bg-white text-ink-800 hover:border-ink-400"
      }`}
    >
      {children}
    </Link>
  );
}

function DateBox({
  name,
  label,
  value,
}: {
  name: string;
  label: string;
  value: string | undefined;
}) {
  return (
    <div>
      <label
        htmlFor={`audit-${name}`}
        className="block text-[0.8125rem] font-medium text-ink-800"
      >
        {label}
      </label>
      <input
        id={`audit-${name}`}
        type="date"
        name={name}
        defaultValue={value ?? ""}
        className="mt-1 rounded-lg border border-ink-300 bg-white px-3 py-2 text-[0.875rem] text-ink-900"
      />
    </div>
  );
}
