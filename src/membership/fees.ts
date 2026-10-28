/**
 * Fees, classes and tiers.
 *
 * No `server-only` and no database import: the thresholds and the class
 * reasoning are needed by the wizard's own UI as much as by the server, and
 * the eligibility logic is the kind of thing that should be testable without a
 * MySQL server. Reading the actual amounts is a query and lives in
 * `repository.ts`; this module is the rules around them.
 */

import type { MembershipClass, ProcessingTier } from "@/db/schema";

/**
 * The turnover above which a concern is Corporate rather than Associate.
 *
 * Rs 50 million, from the form's own definition: a body corporate or
 * multinational, *or* a sales-tax-registered manufacturing or business concern
 * with annual turnover of Rs 50 million or more. A string compared as a number
 * at the boundary, because turnover is DECIMAL and arrives as a string.
 */
export const CORPORATE_TURNOVER_THRESHOLD = 50_000_000;

export const MEMBERSHIP_CLASSES: readonly MembershipClass[] = ["corporate", "associate"];
export const PROCESSING_TIERS: readonly ProcessingTier[] = [
  "regular",
  "urgent",
  "executive",
];

export const CLASS_LABELS: Record<MembershipClass, string> = {
  corporate: "Corporate",
  associate: "Associate",
};

export const TIER_LABELS: Record<ProcessingTier, string> = {
  regular: "Regular",
  urgent: "Urgent",
  executive: "Executive",
};

/**
 * What the class declaration is checked against.
 *
 * Advisory, not enforcing, and the distinction is the whole point. Class is
 * self-declared on the printed form and an applicant has already drawn a pay
 * order for one of exactly six published amounts by the time anyone looks. So
 * this returns a *suggestion* and a reason, the wizard shows it before the
 * applicant commits, and verification raises it as a finding rather than the
 * schema refusing the submission.
 *
 * What happens when the declaration is wrong — re-classification with a fee
 * top-up, or a deficiency return — is an open question for LCCI. It will
 * happen regularly, and a `class_corrections` flow with a second pay order is
 * kinder than bouncing the applicant.
 */
export interface ClassAssessment {
  readonly suggested: MembershipClass;
  readonly agrees: boolean;
  readonly reason: string;
}

export function assessClass(
  declared: MembershipClass | null,
  facts: {
    readonly annualTurnover: number | null;
    readonly isBodyCorporate: boolean;
    readonly isMultinational: boolean;
    readonly strnRegistered: boolean | null;
  },
): ClassAssessment {
  const { annualTurnover, isBodyCorporate, isMultinational, strnRegistered } = facts;

  if (isBodyCorporate || isMultinational) {
    return {
      suggested: "corporate",
      agrees: declared === "corporate",
      reason:
        "A body corporate or a multinational is Corporate regardless of turnover.",
    };
  }

  if (
    annualTurnover !== null &&
    annualTurnover >= CORPORATE_TURNOVER_THRESHOLD &&
    strnRegistered === true
  ) {
    return {
      suggested: "corporate",
      agrees: declared === "corporate",
      reason:
        "A sales-tax-registered concern with annual turnover of Rs 50 million or more is Corporate.",
    };
  }

  // Turnover over the threshold without sales tax registration does not meet
  // the form's definition, which requires both. Worth saying out loud, because
  // the obvious reading of the fee table is turnover alone.
  if (annualTurnover !== null && annualTurnover >= CORPORATE_TURNOVER_THRESHOLD) {
    return {
      suggested: "associate",
      agrees: declared === "associate",
      reason:
        "Turnover is above Rs 50 million, but the Corporate definition also requires sales tax registration.",
    };
  }

  return {
    suggested: "associate",
    agrees: declared === "associate",
    reason: "Medium and small concerns that are not a body corporate are Associate.",
  };
}

/**
 * Whether the USD 750 International Trade Development surcharge applies.
 *
 * The form's trigger is a firm represented by a foreign national, or with
 * foreign partners. Either is enough, which is why this is an `||` over two
 * separate facts rather than a single "is foreign" flag — a Pakistani
 * representative with one foreign partner still owes it.
 */
export function requiresItdSurcharge(facts: {
  readonly representativeIsForeign: boolean;
  readonly anyDirectorIsForeign: boolean;
}): boolean {
  return facts.representativeIsForeign || facts.anyDirectorIsForeign;
}

/**
 * Parse a DECIMAL-as-string into a number, or null.
 *
 * Money crosses the driver boundary as a string so that nothing rounds it.
 * Comparing it against a threshold needs a number, and that conversion is
 * safe here specifically because the threshold is coarse: Rs 50 million is
 * nowhere near the precision where a double misbehaves. It would not be safe
 * for arithmetic on an invoice, which is why there is no general-purpose
 * "decimal to number" helper for anyone to reach for.
 */
export function decimalToNumber(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
