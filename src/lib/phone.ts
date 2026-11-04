/**
 * Telephone numbers, reduced to the one form `users.mobile_e164` promises.
 *
 * The wizard's sixty fields keep numbers exactly as the applicant typed them,
 * and that is right there: `042-111-222-333` is how the firm prints it on its
 * letterhead, the printed form has boxes for it, and an officer comparing the
 * screen against a photocopy needs to see the same characters. Nothing in the
 * system dials those numbers.
 *
 * The account's own mobile is the opposite case. It is the number the
 * secretariat rings when an application stalls, and the number an SMS channel
 * would send to the day one is chosen — so the column is named `_e164` and the
 * value in it has to deserve the name. One stored form, decided here, rather
 * than eleven variations of the same number spread across twenty thousand rows
 * for a later migration to guess at.
 *
 * No `server-only`: it is a string function with no secrets in it, it runs in
 * the browser for the same check the action makes, and it is worth testing
 * directly with nothing stubbed.
 *
 * **Not a validation of whether the number exists.** It decides whether the
 * digits can be written in E.164 at all. A number that normalises cleanly and
 * rings nobody is a problem only an SMS send or a telephone call can find, and
 * refusing a real number is worse than accepting an unreachable one — an
 * applicant who cannot get past this field does not apply.
 */

/** Punctuation in a dialled number, noise in a column. */
const SEPARATORS = /[\s().\-/]/g;

/** `+` and digits only, after the separators are gone. */
const DIALLABLE = /^\+?\d+$/;

/**
 * The international range, from the shortest national number in service to
 * E.164's own ceiling. Both ends are there to reject a typo rather than a
 * country: eight digits refuses a dropped prefix, fifteen refuses a CNIC
 * pasted into the wrong box.
 */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

/** Pakistan. The only country code this file is allowed to assume. */
const PK = "92";

/**
 * Reduce a typed number to `+<digits>`, or say it cannot be.
 *
 * Four shapes get in, and they are the four a Pakistani applicant actually
 * types:
 *
 * - `+923001234567` — already E.164. Kept.
 * - `00923001234567` — the international prefix dialled from a landline. The
 *   `00` becomes `+`, which is the same number.
 * - `923001234567` — the country code with nothing in front of it. Accepted
 *   **only** for Pakistan and only at the exact length a Pakistani number is,
 *   because a bare `92…` is otherwise indistinguishable from a national number
 *   in a country whose area codes start 92.
 * - `03001234567` / `042-37654321` — the national form, which is what almost
 *   everybody types. The trunk `0` is dropped and `+92` put in front.
 *
 * Anything else returns null, including a bare number with no leading zero and
 * no country code: `3001234567` is probably a mobile with the zero left off,
 * and probably is not good enough to stamp a country code onto a number the
 * Chamber will ring.
 *
 * Deliberately not restricted to mobile prefixes. `03xx` is the mobile form,
 * but a one-man concern lists a landline as its contact number and a foreign
 * applicant lists neither; a check that insisted on `03` would refuse all
 * three. The field asks for a mobile, the label says so, and the Chamber can
 * see what arrived.
 */
export function toE164(raw: string): string | null {
  const cleaned = raw.replace(SEPARATORS, "");
  if (cleaned === "" || !DIALLABLE.test(cleaned)) return null;

  const digits = toDigits(cleaned);
  if (digits === null) return null;
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;

  // A leading zero survives none of the branches below; if one ever does, the
  // result is not E.164 and must not be stored as though it were.
  if (digits.startsWith("0")) return null;

  return `+${digits}`;
}

/** The country-coded digit string, with no `+`, or null if it cannot be read. */
function toDigits(cleaned: string): string | null {
  if (cleaned.startsWith("+")) return cleaned.slice(1);
  if (cleaned.startsWith("00")) return cleaned.slice(2);

  if (cleaned.startsWith("0")) {
    const national = cleaned.slice(1);
    // Nine to eleven digits after the trunk zero: `0300 1234567` is ten and
    // `042 37654321` is ten, a four-digit area code with a five-digit
    // subscriber is nine, and anything longer is not a Pakistani number.
    if (national.length < 9 || national.length > 11) return null;
    return `${PK}${national}`;
  }

  // Bare `92…`, at exactly the length a Pakistani number has: the country
  // code plus a ten-digit national number.
  if (cleaned.startsWith(PK) && cleaned.length === PK.length + 10) return cleaned;

  return null;
}

/**
 * How it is shown back to the person who typed it.
 *
 * `+923001234567` is correct and unreadable. A Pakistani *mobile* has one
 * universal grouping — `+92 300 1234567`, a three-digit network code and seven
 * digits — so that one is spaced out and everything else is printed exactly as
 * stored.
 *
 * Only mobiles, and the restriction is not fussiness. Pakistani area codes are
 * two, three or four digits (`42` for Lahore, `300` is not an area code at
 * all), so the same three-and-seven split turns `+92 42 37654321` into `+92
 * 423 7654321` — a Lahore landline regrouped into something that is not a
 * number. Guessing another country's grouping has the same shape of failure,
 * shown to the one person who knows it is wrong.
 */
export function formatE164(value: string): string {
  // `3` is the mobile prefix for every Pakistani network. A landline national
  // number never starts with it.
  const match = /^\+92(3\d{2})(\d{7})$/.exec(value);
  return match ? `+92 ${match[1]} ${match[2]}` : value;
}
