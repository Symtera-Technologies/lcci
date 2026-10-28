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
