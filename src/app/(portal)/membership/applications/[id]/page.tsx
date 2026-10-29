import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { getDb } from "@/db/client";
import { requireMemberPage } from "@/server/auth/dal";
import { outstandingFor, type OutstandingItem } from "@/membership/deficiency";
import { PUBLIC_STAGE_LABELS, type PublicStage } from "@/membership/workflow";
import {
  loadTracker,
  type TimelineEntry,
  type TrackerFee,
  type TrackerMembership,
} from "@/membership/tracker";
import { TIER_LABELS } from "@/membership/fees";
import { formatDate, formatMoney } from "@/lib/format";
import type { DocumentSubjectKind } from "@/db/schema";
import { UploadSlot, type UploadedDocument } from "@/components/membership/document-upload";
import { RespondButton } from "@/components/membership/respond-button";
import { respondToDeficiencyAction } from "./actions";

export const metadata: Metadata = {
  title: "Your application",
  robots: { index: false, follow: false },
};

/**
 * The applicant's own application, and what it needs from them.
 *
 * This is the minimum of the tracker that A8 builds out: the stage, the
 * reference, and — the part that cannot wait — the deficiency round. When the
 * Chamber returns an application for more information it emails an itemised
 * list and the applicant has fifteen working days to answer it. Without this
 * page that list has nowhere to be answered: the wizard is locked, uploads are
 * refused for every type the deficiency did not name, and the redirect the
 * apply page already performs would land on nothing.
 *
 * Per request, never cached. One applicant's own half-answered deficiency is
 * the last thing that should be served to anyone else.
 */
export const dynamic = "force-dynamic";

export default async function ApplicationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The id first, so an expired session is sent back to the application the
  // member was actually reading rather than to the list.
  const { id } = await params;
  const actor = await requireMemberPage(`/membership/applications/${id}`);

  const applicationId = Number(id);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) notFound();

  const db = getDb();

  // Ownership lives in `loadTracker`'s own `WHERE`, not in a check afterwards.
  // A row read and then rejected has already been read, and it leaks through a
  // log line or a count. Null for both "not yours" and "does not exist", so
  // this `notFound` cannot be used to discover which application ids exist.
  const tracker = await loadTracker(actor, applicationId, db);
  if (!tracker) notFound();

  const stage = tracker.stage;
  // The deficiency and the three lookups its upload slots need, together.
  // Awaiting them inside the JSX would read more cleanly and would run them
  // one after another on a connection pool of three.
  const [outstanding, documents, labels, subjects] = await Promise.all([
    outstandingFor(db, applicationId),
    candidateDocuments(db, applicationId),
    documentTypeLabels(db),
    subjectLabels(db, applicationId),
  ]);

  return (
    <main className="container-page py-16 lg:py-24">
      <div className="max-w-3xl">
        <Link
          href="/membership/applications"
          className="text-[0.875rem] font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          ← Your applications
        </Link>

        <div className="mt-6">
          <StageHeading stage={stage} />
        </div>

        <h1 className="mt-3 font-display text-display-md font-semibold text-ink-950">
          {stage === "need_info"
            ? "The Chamber needs a little more from you"
            : "Your membership application"}
        </h1>

        <dl className="mt-8 grid gap-px overflow-hidden rounded-xl bg-stone-200 sm:grid-cols-3">
          <Cell term="Your reference" detail={tracker.reference ?? "—"} emphasis />
          <Cell
            term="Processing"
            detail={
              tracker.processingTier ? TIER_LABELS[tracker.processingTier] : "—"
            }
          />
          <Cell
            term={decided(stage) ? "Decided" : "Due by"}
            detail={
              decided(stage)
                ? (tracker.slaOutcome === "breached"
                    ? "Later than promised"
                    : "Within the promised time")
                : tracker.dueDate
                  ? formatDate(tracker.dueDate)
                  : "—"
            }
          />
        </dl>

        {/* The membership first, where there is one. It is the only thing on
            this page a granted member came to see, and making them read past a
            fee table to find their own number would be perverse. */}
        {tracker.membership && <Membership membership={tracker.membership} />}

        {outstanding ? (
          <Deficiency
            applicationId={applicationId}
            round={outstanding.deficiency.round}
            summary={outstanding.deficiency.summary}
            respondBy={outstanding.deficiency.respondBy}
            items={outstanding.items}
            documents={documents}
            labels={labels}
            subjects={subjects}
          />
        ) : (
          <WithTheChamber stage={stage} />
        )}

        {tracker.fees.length > 0 && <Fees fees={tracker.fees} />}

        {tracker.timeline.length > 0 && <Timeline entries={tracker.timeline} />}
      </div>
    </main>
  );
}

/** Whether the Chamber has finished with this application, either way. */
function decided(stage: PublicStage): boolean {
  return (
    stage === "approved" ||
    stage === "not_approved" ||
    stage === "withdrawn" ||
    stage === "closed"
  );
}

/* -------------------------------------------------------------------------- */
/* The membership, once granted                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the grant email told them this page would show.
 *
 * "Sign in at the Chamber's website with this email address to see your
 * membership" was, until A8, a promise the site did not keep: an approved
 * application is not in flight, so nothing linked here and the wizard opened a
 * fresh draft instead.
 *
 * The 31 March rule is restated rather than left to be inferred from the date.
 * A member granted in February holds a membership that expires in weeks, and
 * the one place they are certain to look at the date is here.
 */
function Membership({ membership }: { membership: TrackerMembership }) {
  const suspended = membership.status === "suspended";
  const cancelled = membership.status === "cancelled";
  const lapsed = membership.status === "lapsed";

  return (
    <section
      className={
        suspended || cancelled
          ? "mt-8 rounded-xl border border-urgent-300 bg-urgent-50/40 p-6"
          : "mt-8 rounded-xl border border-success-300 bg-success-50/40 p-6"
      }
      aria-labelledby="membership-heading"
    >
      <h2
        id="membership-heading"
        className="font-display text-xl font-semibold text-ink-950"
      >
        Your membership
      </h2>

      <dl className="mt-5 space-y-3">
        <div>
          <dt className="text-[0.75rem] font-semibold tracking-wide text-stone-600 uppercase">
            Membership number
          </dt>
          <dd className="mt-0.5 font-mono text-[1.25rem] font-semibold text-ink-950">
            {membership.membershipNo}
          </dd>
        </div>

        <div>
          <dt className="text-[0.75rem] font-semibold tracking-wide text-stone-600 uppercase">
            Class
          </dt>
          <dd className="mt-0.5 text-[0.9375rem] text-ink-900">
            {membership.membershipClass === "corporate"
              ? "Corporate"
              : "Associate"}
          </dd>
        </div>

        {membership.validUntil && (
          <div>
            <dt className="text-[0.75rem] font-semibold tracking-wide text-stone-600 uppercase">
              Valid until
            </dt>
            <dd className="mt-0.5 text-[0.9375rem] text-ink-900">
              {formatDate(membership.validUntil)}
              {membership.yearLabel && ` · membership year ${membership.yearLabel}`}
            </dd>
          </div>
        )}
      </dl>

      {/* Status as words, and only when it is not the ordinary case. "Active"
          needs no banner; the other three are the ones a member must not have
          to work out from a colour. */}
      {suspended && (
        <p className="mt-5 text-[0.9375rem] font-medium text-urgent-800">
          This membership is suspended. The Chamber has written to you; please
          quote the membership number when you reply.
        </p>
      )}
      {cancelled && (
        <p className="mt-5 text-[0.9375rem] font-medium text-urgent-800">
          This membership has been cancelled. The number is not reissued and
          remains on the Chamber&rsquo;s record.
        </p>
      )}
      {lapsed && (
        <p className="mt-5 text-[0.9375rem] font-medium text-ink-900">
          This membership year has ended. Renewal reopens it.
        </p>
      )}

      <p className="mt-5 text-[0.875rem] text-stone-600">
        Membership expires on 31 March each year whatever the date of grant, so
        the date above is the end of the current membership year and not twelve
        months from the day you were granted it.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The fee                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What is owed, and whether the Chamber has taken it in.
 *
 * Here because the alternative is a telephone call. A firm that posted a pay
 * order three weeks ago has exactly one question, and the receipt number
 * answers it without anybody at the Chamber stopping work to do so.
 */
function Fees({ fees }: { fees: readonly TrackerFee[] }) {
  return (
    <section className="mt-10" aria-labelledby="fees-heading">
      <h2
        id="fees-heading"
        className="font-display text-xl font-semibold text-ink-950"
      >
        Your fee
      </h2>

      <ul className="mt-4 space-y-3">
        {fees.map((fee) => (
          <li
            key={fee.feeKind}
            className="rounded-xl border border-stone-200 bg-white p-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-[0.9375rem] font-medium text-ink-950">
                {fee.label}
              </p>
              <p className="text-[1.0625rem] font-semibold text-ink-950">
                {formatMoney(fee.amount, fee.currency)}
              </p>
            </div>

            <p
              className={
                fee.dishonoured
                  ? "mt-2 text-[0.875rem] font-medium text-urgent-800"
                  : "mt-2 text-[0.875rem] text-ink-800"
              }
            >
              {fee.dishonoured
                ? "The bank returned this instrument unpaid. Please contact the Chamber, quoting your reference."
                : fee.receiptNo
                  ? `Receipted — ${fee.receiptNo}`
                  : fee.settled
                    ? "Settled."
                    : "Not yet receipted. A cashier compares the pay order against your bank's account-maintenance certificate before issuing a receipt number."}
            </p>

            {fee.receivedAt && !fee.dishonoured && (
              <p className="mt-1 text-[0.8125rem] text-stone-600">
                Received {formatDate(fee.receivedAt.toISOString())}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The history                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where the application has been, in the applicant's own vocabulary.
 *
 * Built from the state-transition log and mapped through `publicStage`, so the
 * Chamber's internal moves between desks collapse into one "Under review"
 * line. The applicant is not shown `PENDING_APPROVAL`: it is a word that only
 * helps them guess at a process they cannot influence, and it would commit the
 * Chamber to explaining the difference between four internal states.
 */
function Timeline({ entries }: { entries: readonly TimelineEntry[] }) {
  return (
    <section className="mt-10" aria-labelledby="timeline-heading">
      <h2
        id="timeline-heading"
        className="font-display text-xl font-semibold text-ink-950"
      >
        What has happened
      </h2>

      <ol className="mt-4 space-y-4 border-l border-stone-200 pl-5">
        {entries.map((entry, index) => (
          <li key={`${entry.stage}-${index}`} className="relative">
            <span
              className="absolute top-1.5 -left-[1.4375rem] h-2.5 w-2.5 rounded-full bg-brand-700 ring-4 ring-white"
              aria-hidden
            />
            <p className="text-[0.9375rem] font-medium text-ink-950">
              {entry.label}
            </p>
            <p className="mt-0.5 text-[0.8125rem] text-stone-600">
              {formatDate(entry.at.toISOString())}
            </p>
            {entry.note && (
              <p className="mt-2 rounded-lg border border-stone-200 bg-stone-50 p-3 text-[0.875rem] whitespace-pre-line text-ink-900">
                {entry.note}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The deficiency round                                                       */
/* -------------------------------------------------------------------------- */

function Deficiency({
  applicationId,
  round,
  summary,
  respondBy,
  items,
  documents,
  labels,
  subjects,
}: {
  applicationId: number;
  round: number;
  summary: string | null;
  respondBy: string | null;
  items: readonly OutstandingItem[];
  documents: readonly DocumentRow[];
  labels: ReadonlyMap<
    string,
    { label: string; guidance: string | null; subjectKind: DocumentSubjectKind }
  >;
  subjects: ReadonlyMap<number, string>;
}) {
  const unanswered = items.filter((item) => !item.answered).length;

  return (
    <section className="mt-10" aria-labelledby="deficiency-heading">
      <h2
        id="deficiency-heading"
        className="font-display text-xl font-semibold text-ink-950"
      >
        What we have asked for
      </h2>

      {respondBy && (
        <p className="mt-2 text-[0.9375rem] text-ink-800">
          Please answer by <strong className="font-semibold">{formatDate(respondBy)}</strong>.
          Your processing clock is paused until you do, so the days you take are
          not counted against the Chamber&rsquo;s deadline.
        </p>
      )}

      {summary && (
        <div className="mt-5 rounded-xl border border-stone-200 bg-stone-50 p-5">
          {/* The officer's covering note, as written. Rendered as text, never
              as markup: it is typed into an admin form and nothing in this app
              renders staff input as HTML. */}
          <p className="whitespace-pre-line text-[0.9375rem] text-ink-900">{summary}</p>
        </div>
      )}

      <ol className="mt-6 space-y-4">
        {items.map((item) => (
          <li
            key={item.itemId}
            className={
              item.answered
                ? "rounded-xl border border-success-300 bg-success-50/40 p-5"
                : "rounded-xl border border-stone-200 bg-white p-5"
            }
          >
            <div className="flex items-start gap-3">
              {item.answered ? (
                <CheckCircle2
                  className="mt-0.5 h-5 w-5 shrink-0 text-success-700"
                  aria-hidden
                />
              ) : (
                <AlertCircle
                  className="mt-0.5 h-5 w-5 shrink-0 text-urgent-600"
                  aria-hidden
                />
              )}
              <div className="min-w-0">
                {/* Not colour alone: the state is a word as well as an icon
                    and a border. */}
                <p className="text-[0.75rem] font-semibold tracking-wide text-stone-600 uppercase">
                  {item.answered ? "Received" : "Still needed"}
                </p>
                <p className="mt-1 text-[0.9375rem] text-ink-900">{item.instruction}</p>
              </div>
            </div>

            {item.kind === "document" && item.documentTypeCode && (
              <div className="mt-4 sm:pl-8">
                <UploadSlot
                  applicationId={applicationId}
                  documentTypeCode={item.documentTypeCode}
                  label={labels.get(item.documentTypeCode)?.label ?? item.documentTypeCode}
                  note={labels.get(item.documentTypeCode)?.guidance ?? null}
                  subjectKind={subjectKindFor(item, labels)}
                  subjectId={item.subjectId}
                  subjectLabel={
                    item.subjectId === null
                      ? undefined
                      : (subjects.get(item.subjectId) ?? undefined)
                  }
                  existing={documentsFor(documents, item)}
                />
              </div>
            )}

            {item.kind === "field" && (
              <p className="mt-3 text-[0.875rem] text-stone-600 sm:pl-8">
                This is a figure or detail on your form. Open{" "}
                <Link
                  href="/membership/apply"
                  className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
                >
                  your application
                </Link>{" "}
                to correct it — only the fields named here can be changed.
              </p>
            )}
          </li>
        ))}
      </ol>

      <RespondButton
        applicationId={applicationId}
        action={respondToDeficiencyAction}
        outstanding={unanswered}
      />

      <p className="mt-4 text-[0.8125rem] text-stone-600">
        Round {round}. Replacing a document does not delete the one we already
        hold — the officer can see both, and which one came later.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Everything else                                                            */
/* -------------------------------------------------------------------------- */

function WithTheChamber({ stage }: { stage: keyof typeof PUBLIC_STAGE_LABELS }) {
  return (
    <section className="mt-10 rounded-xl border border-stone-200 bg-white p-6">
      <p className="text-[0.9375rem] text-ink-900">
        {stage === "approved"
          ? "Your application has been approved. Your membership number and the date it runs to are above."
          : stage === "not_approved"
            ? "Your application was not approved. The reason the Chamber recorded is in the history below, and it was emailed to you. You may submit a fresh application."
            : stage === "withdrawn" || stage === "closed"
              ? "This application is closed. You are welcome to apply again."
              : "Your application is with the Chamber. There is nothing for you to do; we will write to you if we need anything."}
      </p>
      <p className="mt-3 text-[0.875rem] text-stone-600">
        Questions about an application in progress: write to{" "}
        <a
          href="mailto:membership@lcci.com.pk"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          membership@lcci.com.pk
        </a>{" "}
        quoting your reference.
      </p>
    </section>
  );
}

function StageHeading({ stage }: { stage: keyof typeof PUBLIC_STAGE_LABELS }) {
  const tone =
    stage === "need_info"
      ? "text-urgent-700"
      : stage === "approved"
        ? "text-success-700"
        : "text-brand-800";

  const Icon = stage === "need_info" ? AlertCircle : stage === "approved" ? CheckCircle2 : Clock;

  return (
    <p className={`flex items-center gap-2 text-sm font-semibold ${tone}`}>
      <Icon className="h-5 w-5" aria-hidden />
      {PUBLIC_STAGE_LABELS[stage]}
    </p>
  );
}

function Cell({
  term,
  detail,
  emphasis = false,
}: {
  term: string;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div className="bg-white p-5">
      <dt className="text-[0.75rem] font-semibold tracking-wide text-stone-600 uppercase">
        {term}
      </dt>
      <dd
        className={
          emphasis
            ? "mt-1 font-mono text-[1.0625rem] font-semibold text-ink-950"
            : "mt-1 text-[0.9375rem] text-ink-900"
        }
      >
        {detail}
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading the bits the slots need                                            */
/* -------------------------------------------------------------------------- */

interface DocumentRow {
  readonly id: string;
  readonly documentTypeCode: string;
  readonly subjectId: number | null;
  readonly filename: string;
  readonly byteSize: number;
  readonly reviewState: string;
}

async function candidateDocuments(
  db: ReturnType<typeof getDb>,
  applicationId: number,
): Promise<DocumentRow[]> {
  const rows = await db
    .selectFrom("documents")
    .select([
      "id",
      "document_type_code",
      "subject_id",
      "original_filename",
      "byte_size",
      "review_state",
    ])
    .where("application_id", "=", applicationId)
    .where("deleted_at", "is", null)
    .where("review_state", "!=", "superseded")
    .orderBy("uploaded_at", "desc")
    .execute();

  return rows.map((row) => ({
    id: String(row.id),
    documentTypeCode: row.document_type_code,
    subjectId: row.subject_id === null ? null : Number(row.subject_id),
    filename: String(row.original_filename),
    byteSize: Number(row.byte_size),
    reviewState: String(row.review_state),
  }));
}

function documentsFor(
  documents: readonly DocumentRow[],
  item: OutstandingItem,
): UploadedDocument[] {
  return documents
    .filter((document) => {
      if (document.documentTypeCode !== item.documentTypeCode) return false;
      return item.subjectId === null || document.subjectId === item.subjectId;
    })
    .map((document) => ({
      id: document.id,
      filename: document.filename,
      byteSize: document.byteSize,
      reviewState: document.reviewState,
    }));
}

async function documentTypeLabels(db: ReturnType<typeof getDb>) {
  const rows = await db
    .selectFrom("document_types")
    .select(["code", "label_en", "guidance_en", "subject_kind"])
    .execute();

  return new Map(
    rows.map((row) => [
      row.code,
      {
        label: row.label_en,
        guidance: row.guidance_en,
        subjectKind: row.subject_kind,
      },
    ]),
  );
}

/**
 * Director and partner names, for the slot that says whose CNIC is wanted.
 *
 * Only the name — the CNIC itself is sealed and the applicant does not need it
 * read back to them to know which partner the Chamber means.
 */
async function subjectLabels(db: ReturnType<typeof getDb>, applicationId: number) {
  const rows = await db
    .selectFrom("application_directors")
    .select(["id", "full_name"])
    .where("application_id", "=", applicationId)
    .execute();

  return new Map(
    rows.map((row) => [Number(row.id), String(row.full_name ?? `#${row.id}`)]),
  );
}

/**
 * The subject kind the upload slot must post.
 *
 * A deficiency item may legitimately name no subject — "the CNICs of all
 * partners are illegible" is one item, not five — and `mayUpload` matches such
 * an item against any subject of that type, so the upload is authorised
 * whatever the slot posts. But what it posts is *stored*, and a CNIC filed
 * under `company` is a CNIC the officer's next round cannot tie to a person.
 * So the fallback is the document type's own subject kind rather than a
 * constant: a CNIC belongs to a representative, a utility bill to the firm.
 */
function subjectKindFor(
  item: OutstandingItem,
  labels: ReadonlyMap<string, { subjectKind: DocumentSubjectKind }>,
): UploadedSubjectKind {
  if (item.subjectKind !== null) return item.subjectKind as UploadedSubjectKind;

  const fallback =
    item.documentTypeCode === null
      ? "company"
      : (labels.get(item.documentTypeCode)?.subjectKind ?? "company");

  return fallback as UploadedSubjectKind;
}

type UploadedSubjectKind = "company" | "representative" | "director" | "endorser" | "payment";
