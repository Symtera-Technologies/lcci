/**
 * The checklist, as arithmetic.
 *
 * No `server-only` and no database import, for the same reason `workflow.ts`
 * has neither: the admin screen renders a control per item, the server decides
 * whether the round may be completed, and the report counts failures — and all
 * three have to agree about what a tick means. One implementation, shared.
 *
 * Everything here exists because of one property of the printed form: **two of
 * its thirteen items are inverted.** Item 1 "Incomplete form" and item 13
 * "Signatures do not match with CNIC" are defects, where a tick blocks. The
 * other eleven are compliances, where a tick clears. Code that treats
 * "checked" as "good" passes an application whose signatures do not match its
 * CNIC, and nothing anywhere would say so.
 *
 * So the tick and its meaning are kept apart throughout. `marked` is what the
 * officer did to the box; `outcome` is what that means under the item's own
 * polarity; and the conversion happens in exactly one function, which has a
 * test asserting that a checklist with only items 1 and 13 ticked comes out
 * deficient.
 */

import type {
  ChecklistItemOutcome,
  ChecklistOutcome,
  ChecklistPolarity,
  ChecklistSystemVerdict,
} from "@/db/schema";

/* -------------------------------------------------------------------------- */
/* Tick to meaning, and back                                                  */
/* -------------------------------------------------------------------------- */

/** What the officer did to one item's control. */
export interface ItemDecision {
  /** Whether the box was ticked. */
  readonly marked: boolean;
  /**
   * Whether the item does not apply to this application at all — the
   * partnership deed on a proprietorship. Takes precedence over `marked`,
   * because "not applicable, and also ticked" is not a state the form has.
   */
  readonly notApplicable: boolean;
}

/**
 * What a tick means for this item.
 *
 * The single conversion in the system. Read the file header before changing
 * either branch.
 */
export function outcomeFor(
  polarity: ChecklistPolarity,
  decision: ItemDecision,
): ChecklistItemOutcome {
  if (decision.notApplicable) return "not_applicable";
  if (polarity === "defect") return decision.marked ? "fail" : "pass";
  return decision.marked ? "pass" : "fail";
}

/**
 * The tick that produced a stored outcome, for rendering one back.
 *
 * The inverse of `outcomeFor`, and derived rather than read from the stored
 * `marked` column on purpose: this is what the *outcome* implies, so a screen
 * built on it cannot show a tick that disagrees with the conclusion. The
 * stored `marked` is evidence of the form's state and is shown in the audit
 * view, not in the control.
 */
export function markFor(
  polarity: ChecklistPolarity,
  outcome: ChecklistItemOutcome,
): boolean {
  if (outcome === "not_applicable") return false;
  return polarity === "defect" ? outcome === "fail" : outcome === "pass";
}

/**
 * How the control should be worded, given the polarity.
 *
 * A defect item asks the opposite question, so a screen that labels every
 * control "Satisfactory" reads as a lie next to "Incomplete form". The two
 * phrasings live here so the screen cannot pick the wrong one for an item
 * added in a later revision.
 */
export function affirmativeLabel(polarity: ChecklistPolarity): string {
  return polarity === "defect" ? "Defect found" : "Satisfactory";
}

export function negativeLabel(polarity: ChecklistPolarity): string {
  return polarity === "defect" ? "No defect" : "Deficient";
}

/* -------------------------------------------------------------------------- */
/* The round's conclusion                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether the round clears the application.
 *
 * `not_applicable` clears: an item that does not apply cannot be a reason to
 * refuse. Anything that failed makes the round deficient, however many
 * passed — this is a checklist, not a score.
 */
export function checklistOutcome(
  items: readonly { readonly outcome: ChecklistItemOutcome }[],
): ChecklistOutcome {
  return items.some((item) => item.outcome === "fail") ? "deficient" : "clear";
}

/** The failed items, in the order they appear on the form. */
export function failedItems<T extends { readonly outcome: ChecklistItemOutcome; readonly ordinal: number }>(
  items: readonly T[],
): readonly T[] {
  return items
    .filter((item) => item.outcome === "fail")
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * Items where the officer concluded something the machine did not.
 *
 * The most audit-relevant fact on the page, and the reason `system_verdict` is
 * stored per item rather than recomputed: the question asked later is "did
 * somebody override the system", and the system's opinion moves as the
 * application does. An `unknown` verdict is not a disagreement — most of the
 * thirteen items are judgements no machine can make.
 */
export function disagreements<
  T extends {
    readonly outcome: ChecklistItemOutcome;
    readonly systemVerdict: ChecklistSystemVerdict;
  },
>(items: readonly T[]): readonly T[] {
  return items.filter((item) => {
    if (item.systemVerdict === "unknown") return false;
    if (item.outcome === "not_applicable") return false;
    return item.outcome !== item.systemVerdict;
  });
}

/* -------------------------------------------------------------------------- */
/* What the machine can tell                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The machine's opinion on one item, with its reasoning.
 *
 * `because` matters as much as the verdict. "Fail" against item 10 is not
 * actionable; "The proposer's membership lapsed on 31 March" is, and it is the
 * difference between a hint an officer reads and one they learn to ignore.
 */
export interface SystemOpinion {
  readonly verdict: ChecklistSystemVerdict;
  readonly because: string | null;
}

const UNKNOWN: SystemOpinion = { verdict: "unknown", because: null };

/**
 * Everything the machine needs to form an opinion, gathered by the caller.
 *
 * Flat and primitive, like `TransitionFacts`, so this module stays pure and
 * the same facts can be assembled by the server inside its transaction and by
 * the screen inside its page query.
 */
export interface ChecklistFacts {
  readonly formComplete: boolean;
  /** The application's own frozen matrix, with live documents counted. */
  readonly documents: readonly {
    readonly documentTypeCode: string;
    readonly required: boolean;
    readonly requiredCount: number;
    readonly suppliedCount: number;
  }[];
  readonly hasProposer: boolean;
  readonly hasSeconder: boolean;
  readonly endorsersInGoodStanding: boolean;
  /**
   * How old the bank account-maintenance certificate is, in days, and the
   * limit from its document type. Null where the certificate carries no issue
   * date, which is itself worth telling the officer about.
   */
  readonly bankCertificateAgeDays: number | null;
  readonly bankCertificateMaxAgeDays: number | null;
}

/** Which document types each item is about, from the definitions table. */
export type ItemDocumentTypes = ReadonlyMap<string, readonly string[]>;

function supply(facts: ChecklistFacts, codes: readonly string[]) {
  const rows = facts.documents.filter((row) => codes.includes(row.documentTypeCode));
  const required = rows.filter((row) => row.required);
  const short = required.filter((row) => row.suppliedCount < row.requiredCount);
  return { rows, required, short };
}

/**
 * Presence, which is all the machine can judge about a document item.
 *
 * A missing required document is a fact and fails. A present one is only a
 * file: whether it is legible, signed, stamped or bears the right business
 * title is exactly the judgement the officer is there to make, so a supplied
 * document yields `unknown` rather than `pass`. Returning `pass` would be the
 * quiet version of this whole module going wrong — the officer would be
 * agreeing with a machine that had checked nothing.
 */
function presenceOpinion(
  facts: ChecklistFacts,
  codes: readonly string[],
): SystemOpinion {
  const { required, short } = supply(facts, codes);

  if (required.length === 0) return UNKNOWN;

  if (short.length > 0) {
    const missing = short
      .map((row) =>
        row.requiredCount > 1
          ? `${row.documentTypeCode} (${row.suppliedCount} of ${row.requiredCount})`
          : row.documentTypeCode,
      )
      .join(", ");
    return { verdict: "fail", because: `Not supplied: ${missing}.` };
  }

  return UNKNOWN;
}

/**
 * What the machine thinks of each item.
 *
 * Keyed by item code rather than by ordinal, so a reordering in Rev 02 does
 * not silently move an opinion onto another item. An item this function has no
 * branch for — one added by a later revision — comes back `unknown`, which is
 * the only safe default: it means the officer decides unaided rather than
 * being advised by nothing in particular.
 */
export function systemOpinion(
  itemCode: string,
  facts: ChecklistFacts,
  documentTypes: ItemDocumentTypes,
): SystemOpinion {
  const codes = documentTypes.get(itemCode) ?? [];

  switch (itemCode) {
    case "incomplete_form":
      // A defect item, so the verdict is in the item's own terms: the machine
      // says `pass` to mean "no defect found", not "the form is incomplete".
      return facts.formComplete
        ? { verdict: "pass", because: "Every required field is answered." }
        : { verdict: "fail", because: "Some required fields are unanswered." };

    case "bank_certificate": {
      const presence = presenceOpinion(facts, codes);
      if (presence.verdict === "fail") return presence;

      const age = facts.bankCertificateAgeDays;
      const limit = facts.bankCertificateMaxAgeDays;
      if (age === null) {
        return {
          verdict: "unknown",
          because: "The certificate carries no issue date, so its age cannot be checked.",
        };
      }
      if (limit !== null && age > limit) {
        return {
          verdict: "fail",
          because: `The certificate is ${age} days old; the form allows ${limit}.`,
        };
      }
      return {
        verdict: "unknown",
        because: `Issued ${age} days ago, within the ${limit ?? 90}-day limit. Whether it bears the business title is yours to judge.`,
      };
    }

    case "endorser_standing": {
      if (!facts.hasProposer || !facts.hasSeconder) {
        return {
          verdict: "fail",
          because: !facts.hasProposer && !facts.hasSeconder
            ? "Neither the proposer nor the seconder has endorsed."
            : !facts.hasProposer
              ? "The proposer has not endorsed."
              : "The seconder has not endorsed.",
        };
      }
      if (!facts.endorsersInGoodStanding) {
        return {
          verdict: "fail",
          because: "A proposer or seconder no longer holds valid membership status.",
        };
      }
      return {
        verdict: "unknown",
        because: "Both endorsers hold valid membership. The signature and stamp are yours to judge.",
      };
    }

    case "company_stamp":
    case "signature_mismatch":
      // Deliberately no opinion. A wet stamp and a signature comparison are
      // what the officer is for, and a machine guess here would be noise
      // dressed as a finding.
      return UNKNOWN;

    default:
      return presenceOpinion(facts, codes);
  }
}

/**
 * Whether the screen should offer `not_applicable` as the obvious answer.
 *
 * Not a verdict and not a default the server applies: it is the application's
 * own frozen document matrix saying this item is about documents a
 * proprietorship never owed. All thirteen items are still shown in the printed
 * order — hiding one would diverge from the controlled form, which is the one
 * thing this module must not do.
 */
export function suggestNotApplicable(
  itemCode: string,
  facts: ChecklistFacts,
  documentTypes: ItemDocumentTypes,
): boolean {
  const codes = documentTypes.get(itemCode) ?? [];
  if (codes.length === 0) return false;

  const { rows, required } = supply(facts, codes);
  // Known to the matrix, and none of them required of this applicant.
  return rows.length > 0 && required.length === 0;
}
