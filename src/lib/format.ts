const TZ = "Asia/Karachi";

/**
 * Every dated item on the site goes through these helpers. The timezone is
 * pinned so server and client render the same string — and so a date never
 * silently shifts a day for a reader abroad.
 */

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: TZ,
  }).format(new Date(iso));
}

export function formatDateShort(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TZ,
  }).format(new Date(iso));
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TZ,
  }).format(new Date(iso));
}

/** "6 Nov" / "18–24 Nov" for event cards. */
export function formatDateRange(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  if (!endIso) return formatDateShort(startIso);

  const end = new Date(endIso);
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return formatDateShort(startIso);

  const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: TZ });
  const monthYearFmt = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: TZ,
  });

  const sameMonth =
    start.getUTCMonth() === end.getUTCMonth() &&
    start.getUTCFullYear() === end.getUTCFullYear();

  return sameMonth
    ? `${dayFmt.format(start)}–${dayFmt.format(end)} ${monthYearFmt.format(end)}`
    : `${formatDateShort(startIso)} – ${formatDateShort(endIso)}`;
}

/** Splits a date for the stacked day/month block on event cards. */
export function dateParts(iso: string): { day: string; month: string } {
  const d = new Date(iso);
  return {
    day: new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: TZ }).format(d),
    month: new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: TZ }).format(d),
  };
}

/**
 * A fee, as the Chamber writes it.
 *
 * `DECIMAL(14,2)` arrives from mysql2 as a string and is kept as one all the
 * way here: the six published fees are exact amounts an applicant draws a pay
 * order for, and routing them through a float to format them is how
 * `10650.00` becomes `10649.999999999998` in somebody's email.
 *
 * So the grouping is done on the digits. Whole amounts lose their `.00` —
 * every published fee is a whole number of rupees and "Rs 10,650.00" reads
 * like a bank statement rather than a fee — and anything with paisa keeps
 * them, because dropping them would understate what is owed.
 *
 * `Rs` for rupees, the ISO code for everything else. The USD 750 surcharge is
 * quoted in the form as a dollar equivalent and is better left looking foreign
 * than dressed up with a symbol the applicant's bank will not use.
 */
export function formatMoney(amount: string, currency: string): string {
  const [whole = "0", fraction = ""] = amount.trim().split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;

  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const paisa = /^0*$/.test(fraction) ? "" : `.${fraction.padEnd(2, "0").slice(0, 2)}`;
  const unit = currency.toUpperCase() === "PKR" ? "Rs" : currency.toUpperCase();

  return `${unit} ${negative ? "-" : ""}${grouped}${paisa}`;
}
