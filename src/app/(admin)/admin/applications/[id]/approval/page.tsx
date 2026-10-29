import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireStaffPage } from "@/server/auth/dal";
import {
  approverCandidates,
  loadApproval,
  type ApprovalGuard,
  type ApprovalView,
} from "@/membership/approval";
import { GUARD_MESSAGES } from "@/membership/workflow";
import { formatDate } from "@/lib/format";
import { StatusPill, stateLabel } from "@/components/admin/status-pill";
import {
  GrantForm,
  RefuseForm,
  ReturnForm,
  WaiverForm,
} from "@/components/admin/approval-controls";
import {
  approveApplicationAction,
  rejectApplicationAction,
  returnForVerificationAction,
  waiveConflictAction,
} from "./actions";

export const metadata: Metadata = {
  title: "Approval",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The approval block from page 2 of the printed form.
 *
 * Its own screen, and not a button on the review page, for the same reason
 * receipting has its own: the approver is signing off on a file somebody else
 * assembled, and the thing they are signing is not "I have read the
 * particulars" but "every control was performed, by somebody who was not me."
 * That list is what this page is.
 *
 * So the satisfied guards are shown as well as the failing ones. "Nothing is
 * blocking you" is a far weaker statement than "the checklist is clear, the fee
 * is receipted, the pay order matched the certificate, you did not verify this
 * and you did not receipt it" — and the second is what an approval signature
 * means.
 */
/**
 * States in which the decision has been taken, rather than merely not reached.
 *
 * `WITHDRAWN` and the closure states belong here too: none of them is waiting
 * for an approver, and all of them are a conclusion.
 */
const DECIDED_STATES: ReadonlySet<string> = new Set([
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "CLOSED_NO_RESPONSE",
  "DRAFT_EXPIRED",
]);

export default async function ApprovalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireStaffPage("application.read");
  const { id } = await params;

  const applicationId = Number(id);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) notFound();

  const db = getDb();
  const view = await loadApproval(actor, applicationId, db);
  if (!view) notFound();

  const candidates = view.mayWaive ? await approverCandidates(actor, db) : [];

  const blocking = view.guards.filter(
    (guard) => !guard.satisfied && guard.waivedBy === null,
  );
  const waivableBlocking = blocking.filter((guard) => guard.waivable);

  return (
    <main className="mx-auto max-w-[72rem] px-5 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="text-[0.8125rem] text-stone-600">
        <Link
          href="/admin/applications"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Applications
        </Link>
        <span aria-hidden="true" className="mx-2 text-stone-400">
          /
        </span>
        <Link
          href={`/admin/applications/${applicationId}`}
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          {view.publicRef ?? `Application ${applicationId}`}
        </Link>
        <span aria-hidden="true" className="mx-2 text-stone-400">
          /
        </span>
        <span>Approval</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            Approval
          </h1>
          <p className="mt-1 text-[0.9375rem] text-ink-700">
            {view.firmName ?? "This application"} ·{" "}
            {view.publicRef ?? `Application ${applicationId}`}
            {view.membershipClass &&
              ` · ${view.membershipClass === "corporate" ? "Corporate" : "Associate"}`}
          </p>
        </div>
        <StatusPill state={view.state} />
      </header>

      {view.membership && (
        <Granted membership={view.membership} applicationId={applicationId} />
      )}

      <section
        aria-labelledby="controls"
        className="mt-8 rounded-xl border border-stone-200 bg-white p-6"
      >
        <h2
          id="controls"
          className="text-[1.0625rem] font-semibold text-ink-950"
        >
          The controls, and who performed them
        </h2>
        <p className="mt-1 text-[0.875rem] text-stone-600">
          Every guard on the grant, satisfied or not. These are the
          workflow&rsquo;s own checks, read from the same table the server
          enforces them with.
        </p>

        <ul className="mt-5 space-y-3">
          {view.guards.map((guard) => (
            <GuardRow key={guard.code} guard={guard} />
          ))}
        </ul>

        {view.dueDate && (
          <p className="mt-5 text-[0.875rem] text-stone-600">
            Processing deadline {formatDate(view.dueDate)}
            {view.slaOutcome
              ? ` — recorded as ${view.slaOutcome}.`
              : view.dueDate < new Date().toISOString().slice(0, 10)
                ? " — already past. Deciding now records the deadline as missed."
                : "."}
          </p>
        )}
      </section>

      {view.state !== "PENDING_APPROVAL" ? (
        <section className="mt-8 rounded-xl border border-stone-200 bg-white p-6">
          {/*
            Two different sentences, because "not yet" and "already" are not
            the same thing. Telling the reader of an approved file that it has
            to be verified and sent on reads as an instruction to repeat work
            that has been done, on a screen whose whole subject is a decision
            that cannot be taken twice.
          */}
          {DECIDED_STATES.has(view.state) ? (
            <>
              <h2 className="text-[1.0625rem] font-semibold text-ink-950">
                Already decided
              </h2>
              <p className="mt-2 text-[0.9375rem] text-ink-700">
                This application is{" "}
                {stateLabel(view.state).toLowerCase()}. The decision stands as
                recorded below; it is not taken again on this screen.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-[1.0625rem] font-semibold text-ink-950">
                Not for decision yet
              </h2>
              <p className="mt-2 text-[0.9375rem] text-ink-700">
                This application is{" "}
                {stateLabel(view.state).toLowerCase()}. A decision is taken
                from <em>For approval</em>, which an officer reaches by
                verifying the file and sending it on.
              </p>
            </>
          )}
        </section>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <section
            aria-labelledby="grant"
            className="rounded-xl border border-stone-200 bg-white p-6 lg:col-span-2"
          >
            <h2
              id="grant"
              className="text-[1.0625rem] font-semibold text-ink-950"
            >
              Grant membership
            </h2>

            {view.mayApprove ? (
              <div className="mt-4">
                <GrantForm
                  applicationId={applicationId}
                  version={view.version}
                  reference={view.publicRef ?? ""}
                  firmName={view.firmName ?? "this applicant"}
                  validUntil={formatDate(view.yearIfGrantedToday.validUntil)}
                  yearLabel={view.yearIfGrantedToday.label}
                  action={approveApplicationAction}
                />
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-urgent-300 bg-urgent-50 p-4">
                <p className="text-[0.9375rem] font-medium text-urgent-800">
                  {blocking.length === 0
                    ? "Another role grants membership."
                    : blocking.length === 1
                      ? "One control is still outstanding."
                      : `${blocking.length} controls are still outstanding.`}
                </p>
                <ul className="mt-2 space-y-1">
                  {blocking.map((guard) => (
                    <li
                      key={guard.code}
                      className="text-[0.875rem] text-ink-900"
                    >
                      {guard.message}
                    </li>
                  ))}
                </ul>
                {waivableBlocking.length > 0 && (
                  <p className="mt-3 text-[0.875rem] text-stone-600">
                    {waivableBlocking.length === 1
                      ? "That one is a separation-of-duties guard, which a super-admin can waive on the record."
                      : "Those are separation-of-duties guards, which a super-admin can waive on the record."}
                  </p>
                )}
              </div>
            )}
          </section>

          <section
            aria-labelledby="return"
            className="rounded-xl border border-stone-200 bg-white p-6"
          >
            <h2
              id="return"
              className="text-[1.0625rem] font-semibold text-ink-950"
            >
              Send it back
            </h2>
            <p className="mt-1 text-[0.875rem] text-stone-600">
              An approver short of one document should not have to choose
              between granting and refusing.
            </p>
            <div className="mt-4">
              {actor.permissions.has("application.approve") ? (
                <ReturnForm
                  applicationId={applicationId}
                  version={view.version}
                  action={returnForVerificationAction}
                />
              ) : (
                <p className="text-[0.9375rem] text-ink-700">
                  Another role does this.
                </p>
              )}
            </div>
          </section>

          <section
            aria-labelledby="refuse"
            className="rounded-xl border border-stone-200 bg-white p-6"
          >
            <h2
              id="refuse"
              className="text-[1.0625rem] font-semibold text-ink-950"
            >
              Refuse it
            </h2>
            <p className="mt-1 text-[0.875rem] text-stone-600">
              The fee has been receipted, so a refusal owes the applicant a
              refund decision. That disposition is not built yet &mdash; it is
              an open question with LCCI.
            </p>
            <div className="mt-4">
              {view.mayReject ? (
                <RefuseForm
                  applicationId={applicationId}
                  version={view.version}
                  action={rejectApplicationAction}
                />
              ) : (
                <p className="text-[0.9375rem] text-ink-700">
                  Another role does this.
                </p>
              )}
            </div>
          </section>

          {view.mayWaive && waivableBlocking.length > 0 && (
            <section
              aria-labelledby="waiver"
              className="rounded-xl border border-urgent-300 bg-white p-6 lg:col-span-2"
            >
              <h2
                id="waiver"
                className="text-[1.0625rem] font-semibold text-ink-950"
              >
                Waive separation of duties
              </h2>
              <p className="mt-1 text-[0.875rem] text-stone-600">
                For the secretariat where one officer is the only person in the
                building. The alternative people find on their own is a shared
                login, which destroys the audit log altogether &mdash; so this
                exists, narrow and recorded.
              </p>
              <div className="mt-4">
                <WaiverForm
                  applicationId={applicationId}
                  candidates={candidates}
                  waivableGuards={waivableBlocking.map((guard) => ({
                    code: guard.code,
                    label: GUARD_MESSAGES[guard.code],
                  }))}
                  action={waiveConflictAction}
                />
              </div>
            </section>
          )}
        </div>
      )}

      {view.decisions.length > 0 && (
        <section
          aria-labelledby="history"
          className="mt-8 rounded-xl border border-stone-200 bg-white p-6"
        >
          <h2
            id="history"
            className="text-[1.0625rem] font-semibold text-ink-950"
          >
            Decisions on this application
          </h2>
          <p className="mt-1 text-[0.875rem] text-stone-600">
            Every decision, not only the last. A file that was sent back twice
            and then granted reads as three judgements, which is what it was.
          </p>
          <ol className="mt-5 space-y-4">
            {view.decisions.map((decision, index) => (
              <li
                key={`${decision.decidedAt.toISOString()}-${index}`}
                className="border-l-2 border-stone-200 pl-4"
              >
                <p className="text-[0.9375rem] font-medium text-ink-950">
                  {DECISION_WORDING[decision.decision]}
                  {decision.membershipNo && ` — ${decision.membershipNo}`}
                </p>
                <p className="mt-0.5 text-[0.8125rem] text-stone-600">
                  {formatDate(decision.decidedAt.toISOString())}
                  {decision.decidedByName && ` by ${decision.decidedByName}`}
                  {decision.roleCode && ` (${decision.roleCode})`}
                </p>
                {decision.reason && (
                  <p className="mt-1 text-[0.9375rem] text-ink-900">
                    {decision.reason}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}

const DECISION_WORDING: Record<string, string> = {
  approved: "Membership granted",
  rejected: "Application refused",
  returned: "Sent back for verification",
};

function GuardRow({ guard }: { guard: ApprovalGuard }) {
  if (guard.satisfied) {
    return (
      <li className="flex gap-3 text-[0.9375rem]">
        <span aria-hidden="true" className="mt-0.5 text-success-700">
          &#10003;
        </span>
        {/* The word carries the meaning, the tick and the colour reinforce it.
            A list where state is a green tick alone is unreadable to anyone
            who cannot see the colour, and this is an audit control. */}
        <span className="text-ink-900">
          <span className="sr-only">Satisfied: </span>
          {SATISFIED_WORDING[guard.code] ?? guard.message}
        </span>
      </li>
    );
  }

  if (guard.waivedBy !== null) {
    return (
      <li className="flex gap-3 text-[0.9375rem]">
        <span aria-hidden="true" className="mt-0.5 text-urgent-700">
          &#9888;
        </span>
        <span className="text-ink-900">
          <span className="sr-only">Waived: </span>
          <span className="font-medium">Waived by {guard.waivedBy}.</span>{" "}
          {guard.message}
        </span>
      </li>
    );
  }

  return (
    <li className="flex gap-3 text-[0.9375rem]">
      <span aria-hidden="true" className="mt-0.5 text-urgent-700">
        &#10007;
      </span>
      <span className="text-ink-900">
        <span className="sr-only">Outstanding: </span>
        {guard.message}
      </span>
    </li>
  );
}

/**
 * What each guard says when it *passes*.
 *
 * `GUARD_MESSAGES` is written for failure — "the fee has not been receipted" —
 * and negating it in the UI ("not: the fee has not been receipted") is how an
 * approval checklist becomes unreadable. So the positive phrasing is its own
 * table, and it is phrased as the assertion the approver is signing.
 */
const SATISFIED_WORDING: Partial<Record<ApprovalGuard["code"], string>> = {
  checklist_complete: "The verification checklist is complete and signed.",
  checklist_clear: "The checklist records no unresolved defect.",
  payments_receipted: "Every applicable fee is receipted.",
  bank_match_resolved:
    "The cashier recorded whether the instrument matched the account-maintenance certificate.",
  bank_match_confirmed:
    "The instrument was drawn on the account the certificate is for.",
  endorsers_in_good_standing:
    "The proposer and seconder held valid membership when last checked.",
  not_the_verifier: "You did not complete the verification checklist.",
  not_the_cashier: "You did not receipt the fee.",
};

function Granted({
  membership,
  applicationId,
}: {
  membership: NonNullable<ApprovalView["membership"]>;
  applicationId: number;
}) {
  const live = membership.years[membership.years.length - 1];

  return (
    <section
      aria-labelledby="granted"
      className={
        membership.status === "active"
          ? "mt-8 rounded-xl border border-success-600 bg-success-50 p-6"
          : "mt-8 rounded-xl border border-urgent-300 bg-urgent-50 p-6"
      }
    >
      <h2 id="granted" className="text-[1.0625rem] font-semibold text-ink-950">
        Membership {membership.membershipNo}
      </h2>
      <dl className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Pair term="Status" detail={STATUS_WORDING[membership.status]} />
        <Pair
          term="Class"
          detail={
            membership.membershipClass === "corporate"
              ? "Corporate"
              : "Associate"
          }
        />
        <Pair
          term="Granted"
          detail={`${formatDate(membership.grantedOn)}${
            membership.grantedByName ? ` by ${membership.grantedByName}` : ""
          }`}
        />
        <Pair
          term="Membership year"
          detail={
            live
              ? `${live.label}, valid until ${formatDate(live.validUntil)}`
              : null
          }
        />
      </dl>

      {membership.suspendReason && (
        <p className="mt-4 text-[0.9375rem] text-ink-900">
          <span className="font-semibold">Suspended:</span>{" "}
          {membership.suspendReason}
        </p>
      )}

      <p className="mt-4 text-[0.875rem] text-stone-600">
        The number is permanent. If this approval is ever reversed the
        membership is cancelled and keeps its number, because the number has
        already been quoted.{" "}
        <Link
          href={`/admin/applications/${applicationId}/payment`}
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          The fee
        </Link>{" "}
        is on its own screen.
      </p>
    </section>
  );
}

const STATUS_WORDING: Record<string, string> = {
  active: "Active",
  lapsed: "Lapsed — the membership year has run out",
  suspended: "Suspended",
  cancelled: "Cancelled — the approval was reversed",
};

function Pair({ term, detail }: { term: string; detail: string | null }) {
  return (
    <div>
      <dt className="text-[0.8125rem] text-stone-600">{term}</dt>
      <dd className="text-[0.9375rem] text-ink-900">
        {detail === null || detail === "" ? (
          <span className="text-stone-500">&mdash;</span>
        ) : (
          detail
        )}
      </dd>
    </div>
  );
}
