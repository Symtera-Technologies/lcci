/**
 * The membership year, as arithmetic on civil dates.
 *
 * No `server-only` and no database: the 31 March rule is the single piece of
 * policy in this system most likely to be got wrong by a timezone, and the way
 * to be sure it is not is to compute it on strings and test it on strings. A
 * `Date` here would mean `new Date("2027-03-31")` is midnight UTC, which is
 * 29 March in Honolulu and 31 March in Lahore — and this value is printed on a
 * certificate. So nothing below ever constructs a `Date`.
 *
 * The rule itself comes from the printed form and is absolute: **membership
 * expires 31 March every year regardless of the date of grant.** Taken
 * literally a grant on 20 February buys 39 days for the full fee. That is what
 * the form says and so it is what ships; inventing a kinder rule in code is
 * not a developer's call. It is one row in `membership_year_policy`, so LCCI
 * can set a carry-forward cut-off without a deploy — see open question 11.
 */

/** The policy row, narrowed to what the arithmetic needs. */
export interface MembershipYearPolicy {
  readonly expiresOnMonth: number;
  readonly expiresOnDay: number;
  /**
   * A grant on or after this month and day is credited to the *following*
   * membership year rather than the current one.
   *
   * Null means the literal rule from the form, which is what ships. Setting it
   * to 1 January, say, would mean a January grant runs to 31 March of the year
   * after next rather than buying ten weeks.
   */
  readonly carryForwardMonth: number | null;
  readonly carryForwardDay: number | null;
}

/** The default: the form's rule, with no carry-forward. */
export const LITERAL_POLICY: MembershipYearPolicy = {
  expiresOnMonth: 3,
  expiresOnDay: 31,
  carryForwardMonth: null,
  carryForwardDay: null,
};

export interface MembershipYear {
  /** The grant date, or 1 April for a renewal year. */
  readonly startsOn: string;
  /** The date on the certificate. */
  readonly validUntil: string;
  /** "2026–27" for a year ending 31 March 2027. */
  readonly label: string;
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parse(civilDate: string): Parts {
  const match = CIVIL_DATE.exec(civilDate.trim());
  if (!match) {
    throw new Error(
      `Expected a civil date as YYYY-MM-DD, got "${civilDate}". This value is ` +
        "printed on a certificate; it is never a timestamp.",
    );
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function format(parts: Parts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

/** Is (month, day) on or after (cutMonth, cutDay)? Day-of-year comparison. */
function onOrAfter(
  month: number,
  day: number,
  cutMonth: number,
  cutDay: number,
): boolean {
  return month > cutMonth || (month === cutMonth && day >= cutDay);
}

/**
 * The year a grant on `grantedOn` buys.
 *
 * The expiry is the next occurrence of the policy's month and day that is
 * strictly after the grant — "next occurrence" and not "this calendar year's",
 * because a grant on 15 June 2026 expires 31 March 2027, while one on 20
 * February 2027 expires 31 March 2027 as well. Both are the same membership
 * year; they simply bought different amounts of it.
 *
 * A grant *on* the expiry day gets that day's year and expires the same day,
 * which is one day of membership. That is the literal reading, it is
 * vanishingly rare, and the alternative — silently granting a whole extra
 * year — is the kind of generosity that should come from LCCI in writing
 * rather than from an inequality in this function.
 */
export function membershipYearFor(
  grantedOn: string,
  policy: MembershipYearPolicy = LITERAL_POLICY,
): MembershipYear {
  const granted = parse(grantedOn);

  // The expiry in the grant's own calendar year; roll forward if it has passed.
  let expiryYear = granted.year;
  if (
    onOrAfter(
      granted.month,
      granted.day,
      policy.expiresOnMonth,
      policy.expiresOnDay,
    ) &&
    !(
      granted.month === policy.expiresOnMonth &&
      granted.day === policy.expiresOnDay
    )
  ) {
    expiryYear += 1;
  }

  // Carry-forward: a grant late in the year is credited to the next one.
  //
  // Compared against the cut-off *within the membership year*, which is why
  // this is not simply "after the cut-off date in this calendar year". A year
  // running April to March crosses a December, so a cut-off of 1 January means
  // January, February and March grants carry forward while the preceding
  // October's does not.
  if (policy.carryForwardMonth !== null && policy.carryForwardDay !== null) {
    const carried = withinCarryForwardWindow(granted, policy);
    if (carried) expiryYear += 1;
  }

  const validUntil = format({
    year: expiryYear,
    month: policy.expiresOnMonth,
    day: policy.expiresOnDay,
  });

  return {
    startsOn: format(granted),
    validUntil,
    label: yearLabel(expiryYear),
  };
}

/**
 * Whether the grant falls in the stretch the cut-off carries forward.
 *
 * The window runs from the cut-off to the expiry. Both endpoints are
 * month-and-day pairs with no year, so the comparison is done inside the
 * membership year by asking whether the cut-off itself sits before or after
 * the expiry in the calendar.
 */
function withinCarryForwardWindow(
  granted: Parts,
  policy: MembershipYearPolicy,
): boolean {
  const cutMonth = policy.carryForwardMonth as number;
  const cutDay = policy.carryForwardDay as number;

  const cutBeforeExpiry = !onOrAfter(
    cutMonth,
    cutDay,
    policy.expiresOnMonth,
    policy.expiresOnDay,
  );

  if (cutBeforeExpiry) {
    // Cut-off and expiry are in the same calendar part of the year, as with a
    // 1 January cut-off against a 31 March expiry: the window is the stretch
    // between them.
    return (
      onOrAfter(granted.month, granted.day, cutMonth, cutDay) &&
      !onOrAfter(
        granted.month,
        granted.day,
        policy.expiresOnMonth,
        policy.expiresOnDay,
      )
    );
  }

  // Cut-off falls after the expiry — a 1 December cut-off against a 31 March
  // expiry — so the window wraps the new year and is "on or after the cut-off"
  // alone. December, January, February and March all carry.
  return (
    onOrAfter(granted.month, granted.day, cutMonth, cutDay) ||
    !onOrAfter(
      granted.month,
      granted.day,
      policy.expiresOnMonth,
      policy.expiresOnDay,
    )
  );
}

/**
 * "2026–27" for a year ending 31 March 2027.
 *
 * An en dash, not a hyphen, because this is prose that reaches a certificate
 * and correspondence. Stored rather than derived at every call site for the
 * usual reason: two derivations are two chances to disagree.
 */
export function yearLabel(expiryYear: number): string {
  const start = expiryYear - 1;
  return `${start}–${String(expiryYear).slice(-2)}`;
}

/**
 * Whether a membership year has run out, as of a civil date.
 *
 * A string comparison, which is correct for ISO civil dates and is the same
 * arithmetic MySQL does for `valid_until < CURDATE()`. `lapsed` is never
 * stored: it is this, evaluated on read, so no job can fall behind and leave a
 * lapsed member reading as active.
 */
export function hasLapsed(validUntil: string, asOf: string): boolean {
  // Parsed and reformatted rather than compared raw, so a malformed value
  // throws here instead of silently sorting wrong.
  return format(parse(asOf)) > format(parse(validUntil));
}

/** How many days of membership a grant actually bought. */
export function daysOfMembership(startsOn: string, validUntil: string): number {
  const a = parse(startsOn);
  const b = parse(validUntil);
  // Date.UTC on parsed parts, not Date parsing of the string: the two
  // endpoints are converted identically so the difference is exact, and the
  // result is a count rather than an instant.
  const ms =
    Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}
