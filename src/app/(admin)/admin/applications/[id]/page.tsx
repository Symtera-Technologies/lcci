import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/server/auth/dal";
import {
  loadForReview,
  type ReviewDocument,
  type ReviewView,
} from "@/membership/review";
import { daysFromDue } from "@/membership/queue";
import { TIER_WORKING_DAYS } from "@/membership/workflow";
import { StatusPill, stateLabel } from "@/components/admin/status-pill";
import { AssignmentControls } from "@/components/admin/assignment-controls";
import { DocumentViewer } from "@/components/admin/document-viewer";
import { TRANSITION_LABELS } from "@/components/admin/transition-labels";
import { claimAction, releaseAction } from "./actions";

export const metadata: Metadata = {
  title: "Application",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The review screen.
 *
 * Two columns: the application on the left, the document being looked at on
 * the right. The selected document is in the URL (`?doc=…`), which keeps the
 * whole screen a server render with no client JavaScript except the assignment
 * buttons — so it works on a secretariat desktop with a locked-down browser,
 * the browser's back button steps back through the documents an officer
 * examined, and a link to "this application, showing the partnership deed" can
 * be pasted to a colleague.
 *
 * The viewer points at `/api/documents/<id>?inline=1`, which is staff-only and
 * serves under a tightened CSP. There is deliberately no pdf.js here: the
 * browser's own PDF viewer renders a scanned SECP filing perfectly well, and
 * ~400 KB of client JavaScript is not worth adding until something actually
 * needs page-level control. What pdf.js would buy — rendering page 1 as a
 * thumbnail, or a side-by-side of two pages of one file — is written down in
 * the plan rather than guessed at here.
 */
export default async function ApplicationReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("application.read");
  const [{ id }, query] = await Promise.all([params, searchParams]);

  const applicationId = Number(id);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) notFound();

  const review = await loadForReview(actor, applicationId);
  if (!review) notFound();

  const selectedId =
    typeof query.doc === "string" ? query.doc : review.documents[0]?.id;
  const selected =
    review.documents.find((doc) => doc.id === selectedId) ??
    review.supersededDocuments.find((doc) => doc.id === selectedId) ??
    null;

  const mine =
    review.assignedToId !== null && review.assignedToId === actor.userId;
  const days = daysFromDue(review.dueDate);

  return (
    <main className="mx-auto w-full max-w-[90rem] px-6 py-8">
      <nav aria-label="Breadcrumb" className="text-[0.8125rem]">
        <Link
          href="/admin/applications"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          ← Applications
        </Link>
      </nav>

      <header className="mt-4 flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-stone-200 pb-6">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[1.5rem] font-semibold tracking-tight text-ink-950">
              {review.particulars.firmName ?? `Application #${review.id}`}
            </h1>
            <StatusPill state={review.state} />
          </div>
          <p className="mt-2 text-[0.9375rem] text-ink-700">
            {review.publicRef ?? `Draft #${review.id}`}
            {review.membershipClass && (
              <>
                {" · "}
                <span className="capitalize">{review.membershipClass}</span>
              </>
            )}
            {review.processingTier && (
              <>
                {" · "}
                <span className="capitalize">
                  {review.processingTier}
                </span>, {TIER_WORKING_DAYS[review.processingTier]} working days
              </>
            )}
            {review.companyStatusLabel && <> · {review.companyStatusLabel}</>}
          </p>
          <p className="mt-1 text-[0.8125rem] text-stone-600">
            Filed by {review.applicantName} ({review.applicantEmail})
            {review.submittedAt && (
              <> · submitted {review.submittedAt.toISOString().slice(0, 10)}</>
            )}
          </p>
        </div>

        <div className="flex flex-col items-start gap-3">
          <dl className="text-[0.8125rem]">
            <div className="flex gap-2">
              <dt className="text-stone-600">Deadline</dt>
              <dd className="font-medium text-ink-900">
                {review.dueDate === null ? (
                  "—"
                ) : days !== null && days < 0 ? (
                  <span className="text-urgent-700">
                    {Math.abs(days)} day{Math.abs(days) === 1 ? "" : "s"} late (
                    {review.dueDate})
                  </span>
                ) : days === 0 ? (
                  <span className="text-urgent-700">Due today</span>
                ) : (
                  <>
                    {review.dueDate} · {days} day{days === 1 ? "" : "s"} left
                  </>
                )}
                {review.slaState === "paused" && (
                  <span className="text-stone-600"> · clock paused</span>
                )}
              </dd>
            </div>
            <div className="mt-1 flex gap-2">
              <dt className="text-stone-600">Officer</dt>
              <dd className="font-medium text-ink-900">
                {review.assignedToName ?? "Unassigned"}
              </dd>
            </div>
          </dl>

          {/* The working surface. Linked rather than embedded, because this
              screen is read by anyone with `application.read` — a cashier
              included — and the checklist is the verifier's own. */}
          <p className="mt-4 flex flex-wrap gap-3">
            {/* Ungated, like the route it leads to: an approver has to read
                the signed checklist before granting membership, and a verifier
                who can read but not decide is a legitimate state during
                handover. */}
            <Link
              href={`/admin/applications/${review.id}/checklist`}
              className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400"
            >
              Verification checklist
            </Link>
            {actor.permissions.has("payment.read") && (
              <Link
                href={`/admin/applications/${review.id}/payment`}
                className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400"
              >
                Fee and pay order
              </Link>
            )}
            {/* Ungated for the same reason the checklist is: the page states
                which controls were performed and by whom, which is what a
                verifier handing over, or a cashier wondering why a grant is
                stuck, needs to be able to read. Deciding is guarded by the
                actions. */}
            <Link
              href={`/admin/applications/${review.id}/approval`}
              className="inline-flex h-10 items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-ink-800 hover:border-ink-400"
            >
              Approval
            </Link>
          </p>

          {actor.permissions.has("application.assign") && (
            <AssignmentControls
              applicationId={review.id}
              claim={claimAction}
              release={releaseAction}
              mine={mine}
              assignedToName={review.assignedToName}
            />
          )}
        </div>
      </header>

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* Left: the application. */}
        <div className="min-w-0 space-y-8">
          <Documents review={review} selectedId={selected?.id ?? null} />
          <NextSteps review={review} />
          <Particulars review={review} />
          <Directors review={review} />
          <Endorsements review={review} />
          <History review={review} />
        </div>

        {/* Right: what the officer is looking at. Sticky at xl, where there is
            vertical room for it; stacked above the detail on anything narrower,
            because a 40vh frame beside a 60-field form helps nobody. */}
        <div className="min-w-0 xl:sticky xl:top-6 xl:self-start">
          <DocumentViewer document={selected} />
        </div>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function Panel({
  title,
  children,
  note,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5">
      <h2 className="text-[1.0625rem] font-semibold tracking-tight text-ink-950">
        {title}
      </h2>
      {note && <p className="mt-1 text-[0.8125rem] text-stone-600">{note}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Rupees, grouped the way they are read in Pakistan.
 *
 * `en-PK` groups by lakh and crore — 50,00,000 rather than 5,000,000 — which
 * is how the figure appears on the pay order and in the accounts the officer
 * is comparing it against. The column is DECIMAL(16,2) and arrives as a
 * string, so it is parsed here and not in the loader: a number that cannot be
 * parsed is shown as it was typed rather than silently becoming NaN.
 */
function formatRupees(value: string | null): string | null {
  if (!value) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return `Rs ${new Intl.NumberFormat("en-PK", {
    maximumFractionDigits: 0,
  }).format(amount)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------------------------- */

function Documents({
  review,
  selectedId,
}: {
  review: ReviewView;
  selectedId: string | null;
}) {
  // `optional` means "if it applies to you" — a passport for a foreign
  // national, a Form C for a registered partnership. Counting those as unmet
  // would put this screen at odds with the submit transition, which excludes
  // them by the same rule, and would show every complete application as
  // deficient.
  const required = review.requiredDocuments.filter(
    (item) => item.cardinality !== "optional",
  );
  const optional = review.requiredDocuments.filter(
    (item) => item.cardinality === "optional",
  );
  const missing = review.requiredDocuments.filter(
    (required) =>
      required.cardinality !== "optional" &&
      required.suppliedCount < required.requiredCount,
  );

  // Which director a per-director document belongs to. Two rows both labelled
  // "CNIC" are unreviewable; the officer has to know whose.
  const directorName = new Map(
    review.directors.map((director) => [
      director.id,
      director.fullName ?? `Director ${director.position}`,
    ]),
  );

  return (
    <Panel
      title="Documents"
      note="Against what this applicant was asked for at submission, not today's requirements."
    >
      {required.length > 0 && (
        <p
          className={
            missing.length === 0
              ? "mb-4 text-[0.875rem] font-medium text-success-800"
              : "mb-4 text-[0.875rem] font-medium text-urgent-700"
          }
        >
          {missing.length === 0
            ? `Every required document supplied (${required.length} of ${required.length}).`
            : `${missing.length} of ${required.length} required documents not supplied: ${missing
                .map((item) => item.typeLabel)
                .join(", ")}.`}
        </p>
      )}

      {optional.length > 0 && (
        <p className="mb-4 text-[0.8125rem] text-stone-600">
          Supplied only if they apply:{" "}
          {optional.map((item) => item.typeLabel).join(", ")}.
        </p>
      )}

      {review.documents.length === 0 ? (
        <p className="text-[0.9375rem] text-ink-700">Nothing uploaded yet.</p>
      ) : (
        <ul className="divide-y divide-stone-200">
          {review.documents.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              applicationId={review.id}
              selected={doc.id === selectedId}
              subjectName={
                doc.subjectId === null
                  ? null
                  : (directorName.get(doc.subjectId) ?? null)
              }
            />
          ))}
        </ul>
      )}

      {review.supersededDocuments.length > 0 && (
        <details className="mt-5">
          <summary className="cursor-pointer text-[0.875rem] font-medium text-ink-700">
            {review.supersededDocuments.length} replaced{" "}
            {review.supersededDocuments.length === 1 ? "document" : "documents"}
          </summary>
          {/* Kept reachable rather than hidden: after a deficiency round, what
              the applicant originally sent is often the thing in question. */}
          <ul className="mt-3 divide-y divide-stone-200">
            {review.supersededDocuments.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                applicationId={review.id}
                selected={doc.id === selectedId}
                subjectName={
                  doc.subjectId === null
                    ? null
                    : (directorName.get(doc.subjectId) ?? null)
                }
                superseded
              />
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

function DocumentRow({
  doc,
  applicationId,
  selected,
  subjectName,
  superseded,
}: {
  doc: ReviewDocument;
  applicationId: number;
  selected: boolean;
  subjectName: string | null;
  superseded?: boolean;
}) {
  return (
    <li className={selected ? "bg-brand-50/60" : undefined}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
        <div className="min-w-0">
          <Link
            href={`/admin/applications/${applicationId}?doc=${doc.id}`}
            aria-current={selected ? "true" : undefined}
            className="text-[0.9375rem] font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
          >
            {doc.typeLabel}
            {subjectName && (
              <span className="font-normal text-ink-800"> — {subjectName}</span>
            )}
          </Link>
          <p className="mt-0.5 truncate text-[0.8125rem] text-stone-600">
            {/* The original filename, which is frequently the CNIC number
                itself, so it is shown to the officer and never logged. */}
            {doc.originalFilename} · {formatBytes(doc.byteSize)}
            {doc.pageCount !== null && <> · {doc.pageCount} pp</>}
            {doc.issuedOn && <> · issued {doc.issuedOn}</>}
          </p>
          {doc.reviewNote && (
            <p className="mt-1 text-[0.8125rem] text-ink-700">
              {doc.reviewNote}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 text-[0.75rem]">
          {superseded && <span className="text-stone-600">replaced</span>}
          {doc.scanState === "skipped" && (
            // Said out loud, because this plan cannot run a virus scanner and
            // pretending otherwise would be the dishonest option.
            <span className="text-stone-600">not scanned</span>
          )}
          <span className="font-medium text-ink-800">{doc.reviewState}</span>
          <a
            href={`/api/documents/${doc.id}`}
            className="font-medium text-ink-700 underline decoration-ink-300 underline-offset-4 hover:decoration-ink-600"
          >
            Download
          </a>
        </div>
      </div>
    </li>
  );
}

function NextSteps({ review }: { review: ReviewView }) {
  if (review.nextSteps.length === 0) {
    return (
      <Panel title="Next steps">
        <p className="text-[0.9375rem] text-ink-700">
          {stateLabel(review.state)} is a final state. Nothing further to do.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Next steps"
      note="What the workflow allows from here, and what each blocked move is waiting on."
    >
      <ul className="space-y-4">
        {review.nextSteps.map((step) => (
          <li key={step.code}>
            <p className="text-[0.9375rem] font-medium text-ink-950">
              {TRANSITION_LABELS[step.code]}{" "}
              <span className="font-normal text-stone-600">
                → {stateLabel(step.toState)}
              </span>
            </p>

            {step.decision.allowed ? (
              <p className="mt-1 text-[0.8125rem] font-medium text-success-800">
                Available to you.
              </p>
            ) : step.decision.missingPermission ? (
              <p className="mt-1 text-[0.8125rem] text-stone-600">
                Another role does this.
              </p>
            ) : (
              /* The guards' own messages, from the same table the server
                 enforces — so the reason shown can never drift from the reason
                 the transition would actually be refused for. */
              <ul className="mt-1 space-y-1">
                {step.decision.reasons.map((reason) => (
                  <li key={reason} className="text-[0.8125rem] text-urgent-700">
                    {reason}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[0.8125rem] text-stone-600">
        Verification, deficiency rounds, receipting and approval are carried out
        on their own screens; this one is for reading the file.
      </p>
    </Panel>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)] gap-4 py-2">
      <dt className="text-[0.8125rem] text-stone-600">{label}</dt>
      <dd className="text-[0.9375rem] break-words text-ink-900">
        {value === null || value === "" ? (
          <span className="text-stone-500">—</span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function Particulars({ review }: { review: ReviewView }) {
  const p = review.particulars;

  return (
    <Panel
      title="Applicant particulars"
      note={
        review.identitiesVisible
          ? undefined
          : "Identity numbers are masked for your role; only the last four digits are shown."
      }
    >
      <dl className="divide-y divide-stone-100">
        <Row label="Firm or company" value={p.firmName} />
        <Row label="Representative" value={p.representativeName} />
        <Row label="CNIC" value={p.representativeCnic} />
        <Row label="Passport" value={p.representativePassport} />
        <Row
          label="Born"
          value={
            p.representativeDob || p.representativeBirthplace
              ? [p.representativeDob, p.representativeBirthplace]
                  .filter(Boolean)
                  .join(", ")
              : null
          }
        />
        <Row label="Nationality" value={p.representativeNationality} />
        <Row label="Postal address" value={p.postalAddress} />
        <Row
          label="Premises"
          value={
            p.premisesTenure ? (
              <span className="capitalize">{p.premisesTenure}</span>
            ) : null
          }
        />
        <Row label="Email" value={p.email} />
        <Row
          label="Office phone"
          value={
            [p.officePhone1, p.officePhone2].filter(Boolean).join(" / ") || null
          }
        />
        <Row label="Fax" value={p.fax} />
        <Row
          label="Mobile"
          value={[p.mobile1, p.mobile2].filter(Boolean).join(" / ") || null}
        />
        <Row label="Paid-up capital" value={formatRupees(p.paidUpCapital)} />
        <Row label="Annual turnover" value={formatRupees(p.annualTurnover)} />
        <Row
          label="Employees"
          value={p.employeeCount === null ? null : String(p.employeeCount)}
        />
        <Row label="NTN" value={p.ntn} />
        <Row
          label="Sales tax"
          value={
            p.strnRegistered === null
              ? null
              : p.strnRegistered
                ? `Registered${p.strn ? ` · ${p.strn}` : ""}`
                : "Not registered"
          }
        />
        <Row
          label="Business type"
          value={
            review.businessTypes.length > 0
              ? review.businessTypes.join(", ")
              : null
          }
        />
        <Row
          label="Sector"
          value={
            [p.businessSector, p.businessSubSector]
              .filter(Boolean)
              .join(" — ") || null
          }
        />
        <Row label="Main commodity" value={p.mainCommodity} />
        <Row
          label="Bank"
          value={[p.bankName, p.bankBranch].filter(Boolean).join(", ") || null}
        />
        {review.requiresItdSurcharge && (
          <Row
            label="Surcharge"
            value="USD 750 International Trade Development, by separate pay order"
          />
        )}
      </dl>
    </Panel>
  );
}

function Directors({ review }: { review: ReviewView }) {
  return (
    <Panel
      title={`Directors and partners (${review.directors.length})`}
      note="The attesting director must not be the representative."
    >
      {review.directors.length === 0 ? (
        <p className="text-[0.9375rem] text-ink-700">None recorded.</p>
      ) : (
        <ul className="divide-y divide-stone-200">
          {review.directors.map((director) => (
            <li key={director.id} className="py-3">
              <p className="text-[0.9375rem] font-medium text-ink-950">
                {director.fullName ?? "Unnamed"}
                {director.designation && (
                  <span className="font-normal text-stone-600">
                    {" "}
                    · {director.designation}
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-[0.8125rem] text-stone-600">
                {[
                  director.cnic && `CNIC ${director.cnic}`,
                  director.cell,
                  director.membershipNo && `Member ${director.membershipNo}`,
                  director.isForeignNational ? "Foreign national" : null,
                  director.attests ? "Attests the declaration" : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No further details"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Endorsements({ review }: { review: ReviewView }) {
  return (
    <Panel
      title="Proposer and seconder"
      note="Standing is recorded at endorsement and checked again at approval."
    >
      {review.endorsements.length === 0 ? (
        <p className="text-[0.9375rem] text-ink-700">None recorded.</p>
      ) : (
        <ul className="divide-y divide-stone-200">
          {review.endorsements.map((endorsement) => (
            <li key={endorsement.id} className="py-3">
              <p className="text-[0.9375rem] font-medium text-ink-950">
                <span className="capitalize">{endorsement.role}</span>
                {" · "}
                {endorsement.firmName ?? "Unnamed firm"}
              </p>
              <p className="mt-0.5 text-[0.8125rem] text-stone-600">
                {[
                  endorsement.membershipNo &&
                    `Member ${endorsement.membershipNo}`,
                  endorsement.representativeName,
                  endorsement.mobile,
                  `endorsement ${endorsement.state}`,
                  endorsement.standingAtEndorsement &&
                    `standing then: ${endorsement.standingAtEndorsement}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function History({ review }: { review: ReviewView }) {
  return (
    <Panel title="History">
      {review.history.length === 0 ? (
        <p className="text-[0.9375rem] text-ink-700">
          Nothing yet — this application has not moved.
        </p>
      ) : (
        <ol className="space-y-3">
          {review.history.map((entry, index) => (
            <li key={`${entry.occurredAt.toISOString()}-${index}`}>
              <p className="text-[0.9375rem] text-ink-900">
                {entry.fromState ? `${entry.fromState} → ` : ""}
                <span className="font-medium">{entry.toState}</span>
                <span className="text-stone-600"> · {entry.code}</span>
              </p>
              <p className="mt-0.5 text-[0.8125rem] text-stone-600">
                {entry.occurredAt.toISOString().replace("T", " ").slice(0, 16)}{" "}
                UTC
                {entry.actorName && ` · ${entry.actorName}`}
                {entry.actorRoleCode && ` (${entry.actorRoleCode})`}
              </p>
              {entry.reason && (
                <p className="mt-1 text-[0.8125rem] text-ink-700">
                  {entry.reason}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
