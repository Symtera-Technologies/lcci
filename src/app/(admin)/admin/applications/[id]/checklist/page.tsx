import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { requireStaffPage } from "@/server/auth/dal";
import {
  loadVerification,
  type ChecklistRoundView,
  type VerificationView,
} from "@/membership/verification";
import { DEFICIENCY_RESPONSE_WORKING_DAYS, loadOpenDeficiency } from "@/membership/deficiency";
import { affirmativeLabel, markFor, negativeLabel } from "@/membership/checklist";
import { formatDate } from "@/lib/format";
import type { ChecklistItemOutcome, ChecklistPolarity } from "@/db/schema";
import { StatusPill } from "@/components/admin/status-pill";
import { ChecklistForm } from "@/components/admin/checklist-form";
import {
  DeficiencyComposer,
  type ComposerDocumentType,
  type ComposerRow,
  type ComposerSubject,
} from "@/components/admin/deficiency-composer";
import { DocumentViewer, type ViewableDocument } from "@/components/admin/document-viewer";
import { StateActionButton } from "@/components/admin/state-action-button";
import {
  markVerifiedAction,
  raiseDeficiencyAction,
  startVerificationAction,
  submitChecklistAction,
} from "./actions";

export const metadata: Metadata = {
  title: "Verification checklist",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * The verification checklist, as page 5 of the printed form.
 *
 * All thirteen items, in the printed order, every time — including the ones
 * that plainly do not apply to this applicant. Hiding the partnership deed
 * from a proprietorship would be a kindness that diverged from a controlled
 * ISO document, and an officer cross-checking the screen against the paper has
 * to find the same thirteen lines in the same order. What the screen does
 * instead is pre-select "Not applicable" where the application's own frozen
 * document matrix says the item is about documents this applicant never owed.
 *
 * The document being examined is in the URL, as on the review screen, so the
 * back button walks back through what the officer looked at and a link to
 * "this checklist, showing the bank certificate" can be pasted to a colleague.
 *
 * `application.read` guards the route rather than `application.verify`,
 * because an approver genuinely needs to read the signed checklist before
 * granting membership. Acting on it is guarded per action, which is where the
 * separation of duties lives.
 */
export default async function ChecklistPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireStaffPage("application.read");
  const { id } = await params;
  const query = await searchParams;

  const applicationId = Number(id);
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0) notFound();

  const view = await loadVerification(actor, applicationId);
  if (!view) notFound();

  const db = getDb();
  const deficiency = await loadOpenDeficiency(db, applicationId);

  const mayVerify = actor.permissions.has("application.verify");
  const mayReturn = actor.permissions.has("application.raise_deficiency");

  // Every document the thirteen items could refer to, gathered off the items
  // themselves so the viewer and the pickers agree about what exists.
  const byId = new Map<string, ViewableDocument>();
  for (const round of [view.current, ...view.history]) {
    for (const item of round?.items ?? []) {
      for (const candidate of item.candidateDocuments) {
        if (byId.has(candidate.id)) continue;
        byId.set(candidate.id, {
          id: candidate.id,
          typeLabel: candidate.subjectLabel
            ? `${candidate.typeLabel} — ${candidate.subjectLabel}`
            : candidate.typeLabel,
          originalFilename: candidate.label,
          mimeType: candidate.mimeType,
          viewable: candidate.viewable,
        });
      }
    }
  }

  const selectedId = typeof query.doc === "string" ? query.doc : null;
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  const lastSigned = view.history.find((round) => round.outcome !== null) ?? null;

  return (
    <main className="mx-auto max-w-[96rem] px-5 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="text-[0.8125rem] text-stone-600">
        <Link
          href="/admin/applications"
          className="font-medium text-brand-700 underline decoration-brand-700/40 underline-offset-4 hover:decoration-brand-700"
        >
          Queue
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
        <span>Verification</span>
      </nav>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[1.75rem] leading-tight font-semibold text-ink-950">
            Verification checklist
          </h1>
          <p className="mt-1 text-[0.9375rem] text-ink-700">
            {view.firmName ?? "This application"} ·{" "}
            <span className="text-stone-600">
              {view.publicRef ?? `#${applicationId}`}
            </span>
          </p>
        </div>
        <StatusPill state={view.state} />
      </header>

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-8">
          {view.current ? (
            <section aria-labelledby="round-heading">
              <h2
                id="round-heading"
                className="text-[1.0625rem] font-semibold text-ink-950"
              >
                Round {view.current.round}
                <span className="ml-2 text-[0.875rem] font-normal text-stone-600">
                  {view.undecidedCodes.length === 0
                    ? "every item decided"
                    : `${view.undecidedCodes.length} of ${view.current.items.length} still to decide`}
                </span>
              </h2>

              {!mayVerify && (
                <p className="mt-2 rounded-lg border border-stone-200 bg-stone-50 p-4 text-[0.9375rem] text-ink-700">
                  You can read this round but not decide it. Deciding the
                  checklist needs the verification permission.
                </p>
              )}

              <div className="mt-4">
                <ChecklistForm
                  applicationId={applicationId}
                  round={view.current.round}
                  items={view.current.items}
                  selectedDocumentId={selectedId}
                  action={submitChecklistAction}
                  readOnly={!mayVerify}
                />
              </div>
            </section>
          ) : (
            <NoOpenRound
              applicationId={applicationId}
              view={view}
              mayVerify={mayVerify}
              lastSigned={lastSigned}
            />
          )}

          {deficiency && (
            <section
              aria-labelledby="awaiting-heading"
              className="rounded-xl border border-stone-200 bg-white p-6"
            >
              <h2
                id="awaiting-heading"
                className="text-[1.0625rem] font-semibold text-ink-950"
              >
                Waiting on the applicant since{" "}
                {deficiency.raisedAt.toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </h2>
              <p className="mt-1 text-[0.9375rem] text-ink-700">
                Round {deficiency.round}, to be answered by{" "}
                {deficiency.respondBy ? formatDate(deficiency.respondBy) : "no date set"}. The processing clock is
                paused.
              </p>
              {deficiency.summary && (
                <p className="mt-3 text-[0.9375rem] text-ink-800">
                  {deficiency.summary}
                </p>
              )}
              <ol className="mt-4 space-y-2">
                {[
                  ...deficiency.documents.map((item) => ({
                    id: `d-${item.itemId}`,
                    instruction: item.instruction,
                    answered: item.resolvedDocumentId !== null,
                  })),
                  ...deficiency.fields.map((item) => ({
                    id: `f-${item.itemId}`,
                    instruction: item.instruction,
                    answered: false,
                  })),
                  ...deficiency.other.map((item) => ({
                    id: `o-${item.itemId}`,
                    instruction: item.instruction,
                    answered: false,
                  })),
                ].map((item) => (
                  <li
                    key={item.id}
                    className="flex gap-3 text-[0.9375rem] text-ink-800"
                  >
                    <span className="text-stone-500">
                      {item.answered ? "answered" : "outstanding"}
                    </span>
                    <span>{item.instruction}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {lastSigned &&
            lastSigned.outcome === "deficient" &&
            !deficiency &&
            view.state === "UNDER_VERIFICATION" &&
            mayReturn && (
              <section
                aria-labelledby="return-heading"
                className="rounded-xl border border-stone-200 bg-white p-6"
              >
                <h2
                  id="return-heading"
                  className="text-[1.0625rem] font-semibold text-ink-950"
                >
                  Return for more information
                </h2>
                <p className="mt-1 text-[0.9375rem] text-ink-700">
                  Round {lastSigned.round} recorded{" "}
                  {lastSigned.items.filter((item) => item.outcome === "fail").length}{" "}
                  finding(s). Each line below becomes one item the applicant can
                  answer — and the only thing it unlocks on their form.
                </p>

                <div className="mt-5">
                  <DeficiencyComposer
                    applicationId={applicationId}
                    rows={await composerRows(lastSigned, applicationId)}
                    documentTypes={await documentTypeOptions()}
                    subjects={await subjectOptions(applicationId)}
                    defaultWorkingDays={DEFICIENCY_RESPONSE_WORKING_DAYS}
                    action={raiseDeficiencyAction}
                  />
                </div>
              </section>
            )}

          {view.history.length > 0 && (
            <History rounds={view.history} />
          )}
        </div>

        {/* The document being examined. Sticky at xl, stacked above the items
            on anything narrower, because a short frame next to thirteen
            fieldsets helps nobody. */}
        <div className="min-w-0 xl:sticky xl:top-6 xl:self-start">
          <DocumentViewer
            document={selected}
            height="68vh"
            emptyMessage="Choose a document from an item to examine it here."
          />
        </div>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function NoOpenRound({
  applicationId,
  view,
  mayVerify,
  lastSigned,
}: {
  applicationId: number;
  view: VerificationView;
  mayVerify: boolean;
  lastSigned: ChecklistRoundView | null;
}) {
  const clear = lastSigned?.outcome === "clear";

  return (
    <section
      aria-labelledby="no-round-heading"
      className="rounded-xl border border-stone-200 bg-white p-6"
    >
      <h2
        id="no-round-heading"
        className="text-[1.0625rem] font-semibold text-ink-950"
      >
        {lastSigned
          ? `Round ${lastSigned.round} is signed off: ${lastSigned.outcome}`
          : "Verification has not started"}
      </h2>

      {view.state === "SUBMITTED" && (
        <>
          <p className="mt-1 text-[0.9375rem] text-ink-700">
            Opening a round assigns the application to you and starts the
            thirteen items.
          </p>
          {view.canStart ? (
            <StateActionButton
              applicationId={applicationId}
              action={startVerificationAction}
              label="Start verification"
              pendingLabel="Opening…"
            />
          ) : (
            <ul className="mt-3 space-y-1 text-[0.9375rem] text-urgent-700">
              {view.startBlockedBecause.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      )}

      {clear && view.state === "UNDER_VERIFICATION" && mayVerify && (
        <StateActionButton
          applicationId={applicationId}
          action={markVerifiedAction}
          label="Mark verified"
          pendingLabel="Marking…"
          note="It then needs the fee receipted and the pay order matched before anyone can approve it."
        />
      )}

      {view.state === "VERIFIED" && (
        <p className="mt-1 text-[0.9375rem] text-ink-700">
          Verified. The fee and the pay-order match are the next step, and then
          approval.
        </p>
      )}
    </section>
  );
}

function History({ rounds }: { rounds: readonly ChecklistRoundView[] }) {
  return (
    <section aria-labelledby="history-heading">
      <h2
        id="history-heading"
        className="text-[1.0625rem] font-semibold text-ink-950"
      >
        Earlier rounds
      </h2>
      <p className="mt-1 text-[0.9375rem] text-stone-600">
        A signed round is never edited. A change of mind opens the next one, so
        each successive judgement is kept.
      </p>

      <div className="mt-4 space-y-4">
        {rounds.map((round) => (
          <article
            key={round.id}
            className="rounded-xl border border-stone-200 bg-white p-5"
          >
            <h3 className="text-[0.9375rem] font-semibold text-ink-950">
              Round {round.round} — {round.outcome ?? round.state}
            </h3>
            <p className="mt-1 text-[0.8125rem] text-stone-600">
              {round.completedAt
                ? `Signed ${round.completedAt.toLocaleString("en-GB")}`
                : "Not signed"}
              {round.completedByName ? ` by ${round.completedByName}` : ""}
              {round.completedByRole ? ` (${round.completedByRole})` : ""}
            </p>

            <ul className="mt-3 space-y-1.5">
              {round.items
                .filter((item) => item.outcome !== null)
                .map((item) => (
                  <li
                    key={item.code}
                    className="flex gap-3 text-[0.875rem] text-ink-800"
                  >
                    <span className="w-6 shrink-0 text-right text-stone-500 tabular-nums">
                      {item.ordinal}.
                    </span>
                    <span
                      className={
                        item.outcome === "fail"
                          ? "w-28 shrink-0 font-semibold text-urgent-700"
                          : "w-28 shrink-0 text-stone-600"
                      }
                    >
                      {/* In the item's own polarity, as the officer answered
                          it. A defect row recorded as "satisfactory" would be
                          a signed record of the opposite judgement: item 13
                          asks whether the signatures fail to match, and
                          passing it means "no defect", not "satisfactory". */}
                      {outcomeWording(item.polarity, item.outcome)}
                    </span>
                    <span className="min-w-0">
                      {item.labelEn}
                      {item.note && (
                        <span className="block text-stone-600">{item.note}</span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Seeding the composer                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One row per finding, plus three blanks.
 *
 * The instruction is seeded from the note the officer wrote against the item,
 * because that sentence was written minutes ago about this exact problem and
 * retyping it invites a different one. The document type is seeded from the
 * item's own linked types where exactly one of them is a document this
 * applicant actually owes — guessing between `cnic` and `passport` would be
 * worse than leaving it unset.
 */
async function composerRows(
  round: ChecklistRoundView,
  applicationId: number,
): Promise<readonly ComposerRow[]> {
  const required = new Set(
    (
      await getDb()
        .selectFrom("application_required_documents")
        .select(["document_type_code"])
        .where("application_id", "=", applicationId)
        .execute()
    ).map((row) => row.document_type_code),
  );

  const seeded: ComposerRow[] = round.items
    .filter((item) => item.outcome === "fail")
    .map((item) => {
      const candidates = [
        ...new Set(item.candidateDocuments.map((document) => document.documentTypeCode)),
      ].filter((code) => required.has(code));

      return {
        checklistItemCode: item.code,
        fromItemLabel: `${item.ordinal} — ${item.labelEn}`,
        instruction: item.note ?? "",
        documentTypeCode: candidates.length === 1 ? (candidates[0] as string) : "",
        // Left as "anyone's" rather than guessed. An item that failed because
        // one partner's scan is illegible and one that failed because the
        // whole board is missing look identical from here, and narrowing the
        // unlock to the wrong person costs the applicant a second round.
        subject: "",
      };
    });

  return [
    ...seeded,
    ...Array.from({ length: 3 }, () => ({
      checklistItemCode: null,
      fromItemLabel: null,
      instruction: "",
      documentTypeCode: "",
      subject: "",
    })),
  ];
}

async function documentTypeOptions(): Promise<readonly ComposerDocumentType[]> {
  const rows = await getDb()
    .selectFrom("document_types")
    .select(["code", "label_en"])
    .where("active", "=", 1)
    .orderBy("sort_order", "asc")
    .execute();

  return rows.map((row) => ({ code: row.code, label: row.label_en }));
}

/**
 * Who a re-upload belongs to.
 *
 * "Anyone's" is the default and is the right one for "CNIC of all partners is
 * illegible" — one item, not five. Naming a director narrows the unlock to
 * that person's document, so one partner's bad scan does not reopen the whole
 * board's identity files.
 */
async function subjectOptions(
  applicationId: number,
): Promise<readonly ComposerSubject[]> {
  const directors = await getDb()
    .selectFrom("application_directors")
    .select(["id", "full_name", "position"])
    .where("application_id", "=", applicationId)
    .orderBy("position", "asc")
    .orderBy("id", "asc")
    .execute();

  return [
    { value: "company", label: "The firm" },
    { value: "payment", label: "The payment" },
    ...directors.map((director) => ({
      value: `director:${director.id}`,
      label:
        director.full_name ?? `Director ${Number(director.position) + 1}`,
    })),
  ];
}

/**
 * What a signed item says, in its own polarity.
 *
 * Keyed on the tick rather than on the outcome, because the two labels are the
 * officer's two answers and not two verdicts. Item 13 asks whether the
 * signatures *fail* to match, so a pass there reads "no defect" and a fail
 * reads "defect found" — the reverse of items 2 to 12. A defect row written
 * into the history as "satisfactory" would be a signed record of the opposite
 * judgement, which is the same inversion `outcomeFor` exists to prevent on the
 * way in.
 */
function outcomeWording(
  polarity: ChecklistPolarity,
  outcome: ChecklistItemOutcome | null,
): string {
  if (outcome === null) return "not decided";
  if (outcome === "not_applicable") return "not applicable";

  return markFor(polarity, outcome)
    ? affirmativeLabel(polarity).toLowerCase()
    : negativeLabel(polarity).toLowerCase();
}
