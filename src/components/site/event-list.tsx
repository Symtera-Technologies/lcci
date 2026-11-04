import { CalendarDays, Coins, MapPin, Users } from "lucide-react";
import type { EventItem } from "@/content/types";
import { Tag } from "@/components/ui/tag";
import { Prose } from "./prose";
import { dateParts, formatDateRange, formatTime } from "@/lib/format";

/**
 * The events calendar: what is coming, then what has been.
 *
 * Both halves on one page rather than two routes, because the question a
 * visitor arrives with is "is there anything on" and the answer is short — the
 * chamber runs a few events at a time, not a catalogue. The past list is
 * underneath and smaller, which is the honest ranking: it is a record, useful
 * for finding the seminar you attended, not something to browse.
 *
 * The date is a stacked day-and-month block to the left of each event, the
 * same device the homepage uses, so an event is scannable by date without
 * reading a sentence.
 */

const EVENT_TYPES: Record<EventItem["type"], string> = {
  seminar: "Seminar",
  training: "Training",
  agm: "AGM",
  delegation: "Delegation",
  exhibition: "Exhibition",
};

const META = "flex items-center gap-1.5 text-[0.875rem] text-ink-700";
const ICON = "h-4 w-4 shrink-0 text-brand-600";

export function EventList({
  upcoming,
  past,
}: {
  upcoming: readonly EventItem[];
  past: readonly EventItem[];
}) {
  return (
    <div className="space-y-14">
      <section aria-labelledby="events-upcoming">
        <h2
          id="events-upcoming"
          className="font-display text-xl font-semibold text-ink-950"
        >
          Coming up
        </h2>

        {upcoming.length === 0 ? (
          <p className="mt-4 max-w-[68ch] rounded-xl border border-dashed border-stone-300 bg-stone-50 p-6 text-ink-800">
            Nothing is scheduled at the moment. Events are announced here and in
            the chamber&rsquo;s circulars.
          </p>
        ) : (
          <ul className="mt-6 space-y-5">
            {upcoming.map((event) => (
              <li key={event.id}>
                <EventRow event={event} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {past.length > 0 ? (
        <section aria-labelledby="events-past">
          <h2
            id="events-past"
            className="font-display text-xl font-semibold text-ink-950"
          >
            Already held
          </h2>
          <ul className="mt-6 divide-y divide-stone-200">
            {past.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-3">
                <time
                  dateTime={event.start}
                  className="w-32 shrink-0 text-[0.875rem] text-ink-600"
                >
                  {formatDateRange(event.start, event.end)}
                </time>
                <span className="font-medium text-ink-900">{event.titleEn}</span>
                <span className="text-[0.875rem] text-ink-600">{event.venue}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: EventItem }) {
  const { day, month } = dateParts(event.start);

  return (
    <article className="flex gap-5 rounded-[20px] border border-brand-300 bg-white p-5 shadow-depth-1 sm:p-6">
      <div
        aria-hidden
        className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-brand-50 ring-1 ring-inset ring-brand-200"
      >
        <span className="font-display text-xl font-semibold leading-none text-brand-800">
          {day}
        </span>
        <span className="mt-0.5 text-[0.6875rem] font-medium uppercase tracking-wide text-brand-700">
          {month}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Tag tone="ink">{EVENT_TYPES[event.type]}</Tag>
          {/* Never colour alone: the label says "Registration open", and the
              tone only reinforces it. */}
          {event.registrationOpen ? (
            <Tag tone="success">Registration open</Tag>
          ) : (
            <Tag>Registration closed</Tag>
          )}
        </div>

        <h3 className="mt-2 font-display text-lg font-semibold leading-snug text-ink-950">
          {event.titleEn}
        </h3>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          <p className={META}>
            <CalendarDays className={ICON} aria-hidden />
            {/* The date block beside this is `aria-hidden`, so this is the
                only place a screen reader hears the date. It carries the full
                range and the start time for that reason. */}
            <time dateTime={event.start}>
              {formatDateRange(event.start, event.end)}, {formatTime(event.start)}
            </time>
          </p>
          <p className={META}>
            <MapPin className={ICON} aria-hidden />
            {event.venue}
          </p>
          {event.fee ? (
            <p className={META}>
              <Coins className={ICON} aria-hidden />
              {event.fee}
            </p>
          ) : null}
          {event.capacity !== undefined ? (
            <p className={META}>
              <Users className={ICON} aria-hidden />
              {event.capacity} places
            </p>
          ) : null}
        </div>

        {event.bodyEn ? (
          <div className="mt-4">
            <Prose html={event.bodyEn} />
          </div>
        ) : null}
      </div>
    </article>
  );
}
