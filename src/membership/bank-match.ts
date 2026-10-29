/**
 * The pay-order / bank-certificate control, as arithmetic.
 *
 * The printed form requires the fee to be paid by a pay order "drawn on the
 * same bank account" as the attached account-maintenance certificate. That is
 * an anti-fraud control, and this module is the half of it a machine can do.
 *
 * No `server-only` and no database import, deliberately. The normalisation and
 * the comparison are the parts most likely to be wrong, so they are pure
 * functions tested as arithmetic rather than through a form, a transaction and
 * a MySQL server — the same reason `checklist.ts` is pure.
 *
 * Two things this module is careful never to do.
 *
 * It never *decides*. `systemBankMatch` returns an advisory verdict with its
 * reasoning attached; the cashier renders `bank_match_verdict` and approval is
 * guarded on that human judgement. "HBL", "Habib Bank Ltd" and "H.B.L Gulberg
 * III" are the same bank, and no normalisation gets every such pair right, so
 * a confident machine here would be a machine that refuses legitimate
 * applications.
 *
 * And it never lets the editable half of the normalisation reach the
 * fingerprint. See `instrumentFingerprint`.
 */

import { createHash } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Bank names as they are actually written on Pakistani instruments.
 *
 * Every key is the short form a cashier or an applicant types; the value is the
 * canonical long form. This is a *comparison aid only* — it is read by
 * `systemBankMatch` and never by `instrumentFingerprint`, because an alias list
 * is the kind of thing that grows, and a fingerprint that changes when the list
 * grows stops catching duplicates across the release that changed it.
 *
 * It belongs in reference data with an admin screen once LCCI answers the open
 * question about what the cashier physically compares today. Until then it is a
 * short list in code, which is honest about being provisional and cheap to
 * move.
 */
const BANK_ALIASES: ReadonlyMap<string, string> = new Map([
  ["HBL", "HABIB BANK"],
  ["HABIB BANK LIMITED", "HABIB BANK"],
  ["UBL", "UNITED BANK"],
  ["UNITED BANK LIMITED", "UNITED BANK"],
  ["MCB", "MCB BANK"],
  ["MUSLIM COMMERCIAL BANK", "MCB BANK"],
  ["NBP", "NATIONAL BANK OF PAKISTAN"],
  ["ABL", "ALLIED BANK"],
  ["ALLIED BANK LIMITED", "ALLIED BANK"],
  ["BAFL", "BANK ALFALAH"],
  ["ALFALAH BANK", "BANK ALFALAH"],
  ["BAHL", "BANK AL HABIB"],
  ["AKBL", "ASKARI BANK"],
  ["SCB", "STANDARD CHARTERED BANK"],
  ["STANDARD CHARTERED", "STANDARD CHARTERED BANK"],
  ["MEBL", "MEEZAN BANK"],
  ["HMB", "HABIB METROPOLITAN BANK"],
  ["HABIB METRO", "HABIB METROPOLITAN BANK"],
  ["BOP", "BANK OF PUNJAB"],
  ["THE BANK OF PUNJAB", "BANK OF PUNJAB"],
  ["DIB", "DUBAI ISLAMIC BANK"],
  ["JS BANK LIMITED", "JS BANK"],
  ["FAYSAL BANK LIMITED", "FAYSAL BANK"],
  ["SONERI BANK LIMITED", "SONERI BANK"],
  ["BANKISLAMI PAKISTAN", "BANKISLAMI"],
]);

/**
 * Words that carry no identifying information in a bank or business name.
 *
 * Dropped before comparison, never before hashing. "Mall Road Exports" and
 * "M/s Mall Road Exports (Pvt) Limited" are the same business, and a control
 * that calls them different produces a mismatch the cashier then has to
 * override on every second application — at which point overriding stops being
 * a judgement and becomes a reflex.
 */
const NOISE_WORDS: ReadonlySet<string> = new Set([
  "LIMITED",
  "LTD",
  "PVT",
  "PRIVATE",
  "COMPANY",
  "CO",
  "CORPORATION",
  "CORP",
  "INC",
  "MS", // "M/s", which survives punctuation stripping as MS
  "MESSRS",
  "THE",
  "AND",
  "OF",
  "BRANCH",
  "BR",
  "MAIN",
]);

/**
 * Case, punctuation and spacing only.
 *
 * The conservative half of the normalisation: it removes the differences that
 * are unambiguously meaningless — "H.B.L." and "HBL", "ABC  Traders" and "ABC
 * Traders" — and nothing else. `&` becomes `AND` first so that "Smith & Co" and
 * "Smith and Co" agree before punctuation is stripped.
 *
 * This is the only normalisation the fingerprint uses.
 */
export function squash(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** `squash`, then drop every space. Used where a space is pure noise. */
function tighten(raw: string): string {
  return squash(raw).replace(/ /g, "");
}

/**
 * Rejoin a run of single letters into the abbreviation it was written as.
 *
 * `squash` turns punctuation into a space, which is right for "Smith&Co" and
 * wrong for "H.B.L." — the latter arrives as three tokens, so it would compare
 * unequal to "HBL" and the alias list would never see it. Pakistani bank names
 * are abbreviated with dots as often as without, and "M/s" in front of a
 * business title has the same shape, so this is the common case rather than an
 * edge one.
 *
 * Only runs of two or more are joined. A single stray letter — the "A" in
 * "A Traders" — is a word of the name and stays one.
 */
function joinInitials(squashed: string): string {
  const out: string[] = [];
  let run: string[] = [];

  const flush = () => {
    if (run.length >= 2) out.push(run.join(""));
    else out.push(...run);
    run = [];
  };

  for (const word of squashed.split(" ")) {
    if (word.length === 1 && /[A-Z]/.test(word)) run.push(word);
    else {
      flush();
      out.push(word);
    }
  }
  flush();

  return out.filter((word) => word !== "").join(" ");
}

/**
 * The comparison form of a bank name: squashed, de-aliased, de-noised.
 *
 * Alias expansion runs on the squashed string *and* on the de-noised one,
 * because both "HABIB BANK LIMITED" and "HABIB BANK LTD" have to reach the same
 * canonical value and only one of them is a literal key.
 */
export function canonicalBankName(raw: string): string {
  const squashed = joinInitials(squash(raw));
  const aliased = BANK_ALIASES.get(squashed) ?? squashed;
  const denoised = dropNoise(aliased);
  return dropNoise(BANK_ALIASES.get(denoised) ?? denoised);
}

/** The comparison form of an account title or a business name. */
export function canonicalTitle(raw: string): string {
  return dropNoise(joinInitials(squash(raw)));
}

/** The comparison form of a branch, which is a title with no legal suffixes. */
export function canonicalBranch(raw: string): string {
  return dropNoise(joinInitials(squash(raw)));
}

function dropNoise(squashed: string): string {
  const kept = squashed.split(" ").filter((word) => word !== "" && !NOISE_WORDS.has(word));
  // A name made entirely of noise words keeps its squashed form rather than
  // becoming the empty string, which would compare equal to every other
  // all-noise name.
  return kept.length > 0 ? kept.join(" ") : squashed;
}

/**
 * The instrument number, reduced to what is actually printed.
 *
 * Leading zeros are kept: a pay order numbered `000412` and one numbered `412`
 * are different instruments, and the bank that issued them prints the zeros.
 * Only the separators a human adds when typing — spaces, dashes, slashes — come
 * out.
 */
export function canonicalInstrumentNo(raw: string): string {
  return tighten(raw);
}

/* -------------------------------------------------------------------------- */
/* The fingerprint                                                            */
/* -------------------------------------------------------------------------- */

/**
 * SHA-256 of the normalised (bank, instrument number, date) triple.
 *
 * What it buys is `UNIQUE KEY uq_payorder_fingerprint`: the same physical pay
 * order presented on two applications is refused by the database rather than
 * noticed by whoever reconciles a bank statement. A composite unique index on
 * the three columns would be 803 bytes in utf8mb4 and will not fit the 767-byte
 * prefix limit that older InnoDB row formats impose — and on a shared host the
 * row format is not ours to choose.
 *
 * It uses the punctuation-and-spacing normalisation only — **never**
 * `canonicalBankName`. That is the load-bearing decision in this module. A
 * fingerprint has to mean the same thing in five years as it does today,
 * because the rows it protects are already in the table; if it went through the
 * alias list, then adding one alias would silently re-partition every future
 * insert and the same pay order typed before and after that release would
 * produce two different fingerprints and no collision.
 *
 * The cost is stated rather than hidden: a duplicate typed as "HBL" on one
 * application and "Habib Bank Ltd" on another does not collide. The instrument
 * number is the part that discriminates, and `systemBankMatch` plus the
 * near-duplicate lookup in `payments.ts` cover that case advisorily. A
 * guarantee that holds exactly and a warning that catches the rest is a better
 * trade than a guarantee that quietly stops holding.
 */
export function instrumentFingerprint(input: {
  readonly bankName: string;
  readonly instrumentNo: string;
  /** `YYYY-MM-DD`. A `DATE` column, so never an instant. */
  readonly instrumentDate: string;
}): string {
  const parts = [
    // Space-free, so "H.B.L.", "H B L" and "HBL" are one instrument. Spacing
    // inside a bank name is pure typing noise, and the whole promise of the
    // fingerprint is that the same pay order typed twice collides.
    tighten(input.bankName),
    canonicalInstrumentNo(input.instrumentNo),
    input.instrumentDate.trim(),
  ];
  // A unit separator rather than a hyphen or a slash, because both of those
  // survive in the date and could otherwise let two different triples produce
  // one joined string.
  return createHash("sha256").update(parts.join("\u001f"), "utf8").digest("hex");
}

/**
 * SHA-256 of the normalised instrument number and date, with no bank name.
 *
 * The companion to `instrumentFingerprint`, and the reason it exists is the
 * cost that function documents: because the fingerprint deliberately does not
 * run the bank name through the alias list, one physical pay order typed as
 * "United Bank Limited" on one application and "U.B.L." on another produces two
 * fingerprints and no collision. That was not hypothetical — it happened the
 * first time two applications were receipted by hand.
 *
 * So the discriminating half gets a key of its own. It is **not** unique: two
 * banks can legitimately issue instrument 000412 on the same day, which is
 * exactly why this backs a refusal the cashier can clear rather than a
 * constraint that would turn an honest coincidence into a rejected
 * application.
 */
export function instrumentKey(input: {
  readonly instrumentNo: string;
  /** `YYYY-MM-DD`. */
  readonly instrumentDate: string;
}): string {
  return createHash("sha256")
    .update(
      [canonicalInstrumentNo(input.instrumentNo), input.instrumentDate.trim()].join(""),
      "utf8",
    )
    .digest("hex");
}

/* -------------------------------------------------------------------------- */
/* The advisory comparison                                                    */
/* -------------------------------------------------------------------------- */

export type BankMatchSystemVerdict = "match" | "mismatch" | "uncertain";

/** One side of the comparison, as captured. */
export interface BankSide {
  readonly bankName: string | null;
  readonly branch: string | null;
  readonly accountTitle: string | null;
}

export interface BankMatchAdvice {
  readonly verdict: BankMatchSystemVerdict;
  /** What the cashier is shown, in the order it should be read. */
  readonly reasons: readonly string[];
  /** Each field the comparison could run, and whether it agreed. */
  readonly fields: readonly {
    readonly field: "bank" | "branch" | "account_title";
    readonly agrees: boolean | null;
    readonly instrument: string | null;
    readonly certificate: string | null;
  }[];
}

/**
 * Compare the instrument against the certificate it was supposedly drawn on.
 *
 * The three verdicts are not three degrees of confidence; they are three
 * different statements.
 *
 * `mismatch` means the two names are plainly different institutions. That is
 * the only confident negative available, and it is the one the cashier should
 * be stopped by.
 *
 * `match` means every field that could be compared agreed. It is still
 * advisory: the officer may know the certificate is forged.
 *
 * `uncertain` means the comparison could not conclude — the certificate side
 * was never captured, or the bank agrees while the branch or the title does
 * not. A pay order is issued *at* a branch, which need not be the branch the
 * account is held at, and a business is written a dozen ways, so a difference
 * there is a thing for a human to look at rather than a finding.
 */
export function systemBankMatch(
  instrument: BankSide,
  certificate: BankSide,
): BankMatchAdvice {
  const fields: BankMatchAdvice["fields"] = [
    compare("bank", instrument.bankName, certificate.bankName, canonicalBankName),
    compare("branch", instrument.branch, certificate.branch, canonicalBranch),
    compare(
      "account_title",
      instrument.accountTitle,
      certificate.accountTitle,
      canonicalTitle,
    ),
  ];

  const bank = fields[0];
  const reasons: string[] = [];

  if (bank.agrees === null) {
    reasons.push(
      certificate.bankName === null || certificate.bankName.trim() === ""
        ? "The account-maintenance certificate's bank has not been recorded, so there is nothing to compare."
        : "The pay order's bank has not been recorded, so there is nothing to compare.",
    );
    return { verdict: "uncertain", reasons, fields };
  }

  if (!bank.agrees) {
    reasons.push(
      `The pay order is drawn on ${bank.instrument} and the certificate is for an account at ${bank.certificate}.`,
    );
    return { verdict: "mismatch", reasons, fields };
  }

  reasons.push(`Both name ${bank.certificate}.`);

  const unresolved = fields.slice(1).filter((field) => field.agrees !== true);

  for (const field of unresolved) {
    if (field.agrees === null) {
      reasons.push(
        field.field === "branch"
          ? "The branch is recorded on only one side."
          : "The account title is recorded on only one side.",
      );
      continue;
    }
    reasons.push(
      field.field === "branch"
        ? `The pay order was issued at ${field.instrument} and the account is held at ${field.certificate}. A pay order can be issued at a different branch of the same bank, so this is not by itself a mismatch.`
        : `The pay order is in the name of ${field.instrument} and the certificate is in the name of ${field.certificate}.`,
    );
  }

  if (unresolved.length === 0) {
    reasons.push("The branch and the account title agree too.");
    return { verdict: "match", reasons, fields };
  }

  return { verdict: "uncertain", reasons, fields };
}

function compare(
  field: "bank" | "branch" | "account_title",
  left: string | null,
  right: string | null,
  canonical: (raw: string) => string,
): BankMatchAdvice["fields"][number] {
  const l = left === null || left.trim() === "" ? null : canonical(left);
  const r = right === null || right.trim() === "" ? null : canonical(right);
  return {
    field,
    agrees: l === null || r === null ? null : l === r,
    instrument: l,
    certificate: r,
  };
}

/* -------------------------------------------------------------------------- */
/* The two numeric checks beside it                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether the instrument is drawn for the fee that is owed.
 *
 * Compared as strings scaled to paisa rather than as floats, because the
 * amounts cross the driver boundary as `DECIMAL` strings and a cent of
 * floating-point error in a fee comparison is the kind of bug that is
 * invisible until it is a receipt.
 *
 * This is where open question 10 lands in practice: class is self-declared, so
 * an applicant who files as Corporate with Rs 12m turnover has already drawn a
 * pay order for the wrong amount. The cashier is shown the difference and can
 * receipt anyway with a stated reason — which is recorded, so the shortfall is
 * a fact in the audit log rather than a note in somebody's drawer.
 */
export function amountAgrees(owed: string, instrument: string): boolean {
  return toPaisa(owed) === toPaisa(instrument);
}

/** Signed difference in the smallest unit: positive where the instrument is short. */
export function shortfallPaisa(owed: string, instrument: string): bigint {
  return toPaisa(owed) - toPaisa(instrument);
}

function toPaisa(decimal: string): bigint {
  const trimmed = decimal.trim();
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  const scaled = BigInt(`${whole || "0"}${fraction.padEnd(2, "0").slice(0, 2)}`);
  return negative ? -scaled : scaled;
}

/**
 * The form's "original, not older than 3 months" rule, in days.
 *
 * Three months is read as 92 days rather than as calendar months, because a
 * certificate issued on 30 November and presented on 28 February is either
 * inside or outside the window depending on which reading is used — and a rule
 * the cashier cannot reproduce on their fingers is a rule that gets applied
 * inconsistently. 92 is the longest three consecutive months, so it is the
 * reading that never refuses a certificate the strict reading would allow.
 */
export const CERTIFICATE_MAX_AGE_DAYS = 92;

export function certificateAgeDays(issuedOn: string, on: Date): number | null {
  const issued = Date.parse(`${issuedOn}T00:00:00Z`);
  if (Number.isNaN(issued)) return null;
  const today = Date.parse(`${on.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today - issued) / 86_400_000);
}
