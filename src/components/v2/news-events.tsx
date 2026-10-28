import Image from "next/image";
import Link from "next/link";
import { ArrowRight, CalendarDays, MapPin, Users } from "lucide-react";
import { getLatestPressReleases, getUpcomingEvents } from "@/content/repository";
import { TiltCard } from "@/components/v2/primitives";
import { ButtonLink } from "@/components/ui/button";
import { Tag, TOPIC_LABELS } from "@/components/ui/tag";
import { dateParts, formatDate, formatDateRange, formatTime } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { EventItem, PressRelease } from "@/content/types";

/** Spelt out, because "agm" in a card is institutional shorthand nobody owes. */
const EVENT_TYPES: Record<EventItem["type"], string> = {
  seminar: "Seminar",
  training: "Training",
  agm: "Annual General Meeting",
  delegation: "Trade delegation",
  exhibition: "Exhibition",
};

/**
 * Newsroom and events — variant 2.
 *
 * The two columns get deliberately different treatments, because the content
 * is of two different kinds:
 *
 *  - Events are discrete objects with a date, a place and a price. They are
 *    cards, and they tilt like the rest of the variant.
 *  - Press releases are continuous editorial text. They are a list on one
 *    floating sheet, divided by hairlines. Boxing each item put a border and a
 *    shadow around every paragraph of dense prose and made this column read far
 *    heavier than the three cards beside it — the client rejected that on the
 *    first variant and they were right to. The depth here belongs to the sheet
 *    the list sits on, not to the items.
 *
 * Every item shows its publication date. On the legacy site not one press
 * release did, which is why nothing on the page could be judged current.
 *
 * The photographs follow the same logic. The lede carries a wide image inside
 * the text column; the rest carry a thumbnail in a trailing column. Giving all
 * four a full-width photograph would reintroduce exactly the weight that made
 * the boxed version of this list fail — the hierarchy has to come from the
 * pictures too, not only the type.
 */
export async function NewsEventsV2() {
  const [press, events] = await Promise.all([
    getLatestPressReleases(4),
    getUpcomingEvents(3),
  ]);

  return (
    <section className="container-page py-20 lg:py-24">
      <div className="grid gap-14 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-7">
          <SectionHead
            id="v2-news-heading"
            title="From the newsroom"
            href="/news/press-releases"
            linkLabel="All press releases"
          />

          {/* One sheet, lifted off the stage. `v2-reveal` goes here and not on
              the items: four rules sliding in one after another turns a page of
              news into a slot machine. */}
          <div className="v2-reveal mt-7 rounded-2xl border border-stone-200 bg-white p-6 shadow-depth-2 sm:p-8">
            <ul aria-labelledby="v2-news-heading" className="divide-y divide-stone-200">
              {press.map((item, index) => (
                <li key={item.id} className="py-7 first:pt-0 last:pb-0">
                  {/* The first item is the lede: larger headline, full-size
                      summary. Rhythm is what makes a list read as edited
                      rather than as a dump. */}
                  <PressItem item={item} lede={index === 0} />
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="lg:col-span-5">
          <SectionHead
            id="v2-events-heading"
            title="Upcoming events"
            href="/trade/events"
            linkLabel="Full calendar"
          />

          <ul aria-labelledby="v2-events-heading" className="mt-7 space-y-5">
            {events.map((ev) => (
              // The reveal sits on the item and the tilt on the card inside it.
              // They would in fact compose — `v2-rise` drives `translate`
              // precisely so it can — but keeping them on separate elements
              // means the tilt reads against an untouched box, and the card's
              // own hover transition never has a scroll animation running
              // through the same property.
              <li key={ev.id} className="v2-reveal">
                <EventCard event={ev} />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Newsroom                                                                   */
/* -------------------------------------------------------------------------- */

function PressItem({ item, lede }: { item: PressRelease; lede: boolean }) {
  const photo = item.heroImage;

  return (
    <article
      className={cn(
        "grid gap-x-7 gap-y-2.5",
        // The lede's photograph sits inside the text column, so that column
        // keeps the full width. Every other item puts a thumbnail in a third
        // column instead: a wide photograph on each of four items would turn an
        // edited list back into the stack of cards this column deliberately is
        // not.
        lede ? "sm:grid-cols-[7rem_1fr]" : "sm:grid-cols-[7rem_1fr_auto]",
      )}
    >
      {/* A date rail, set against the text column. It costs a little width and
          buys the thing the legacy newsroom never had: you can scan how current
          the chamber is without reading a single headline. */}
      <time
        dateTime={item.publishedAt}
        className="text-xs font-medium uppercase tracking-[0.08em] text-stone-600 tabular-nums sm:pt-1 sm:text-end"
      >
        {formatDate(item.publishedAt)}
      </time>

      {!lede && photo && (
        <div className="relative h-[4.5rem] w-28 shrink-0 overflow-hidden rounded-lg bg-stone-100 shadow-depth-1 sm:col-start-3 sm:row-start-1">
          <Image
            src={photo.src}
            alt={photo.altEn}
            fill
            sizes="7rem"
            className="object-cover"
          />
        </div>
      )}

      <div className="min-w-0 sm:col-start-2 sm:row-start-1">
        {lede && photo && (
          // Not wrapped in a link. The headline beside it already points at the
          // article, and a second link to the same place is one more tab stop
          // that announces the same destination twice.
          <div className="relative mb-4 aspect-[16/9] overflow-hidden rounded-xl bg-stone-100 shadow-depth-1">
            <Image
              src={photo.src}
              alt={photo.altEn}
              fill
              sizes="(min-width: 1024px) 34rem, (min-width: 640px) calc(100vw - 10rem), calc(100vw - 4rem)"
              className="object-cover"
            />
          </div>
        )}

        {item.topics.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {item.topics.slice(0, 2).map((t) => (
              <li key={t}>
                <Tag tone="clay">{TOPIC_LABELS[t]}</Tag>
              </li>
            ))}
          </ul>
        )}

        <h3
          className={cn(
            "mt-2.5 font-display font-semibold leading-snug",
            lede ? "text-display-sm" : "text-xl",
          )}
        >
          <Link
            href={`/news/${item.slug}`}
            className="text-ink-950 decoration-brand-500 decoration-2 underline-offset-4 hover:underline"
          >
            {item.titleEn}
          </Link>
        </h3>

        <p
          className={cn(
            "mt-2 leading-relaxed text-stone-600",
            lede ? "text-base" : "text-[0.9375rem]",
          )}
        >
          {item.summary}
        </p>

        {item.spokesperson && (
          <p className="mt-3.5 border-s-2 border-clay-300 ps-3 text-[0.8125rem] leading-relaxed text-stone-600">
            Quoted:{" "}
            <span className="font-medium text-ink-800">{item.spokesperson}</span>
          </p>
        )}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function EventCard({ event: ev }: { event: EventItem }) {
  const { day, month } = dateParts(ev.start);

  // Joined here rather than inline so a missing capacity cannot leave a
  // dangling separator, and a capacity of 0 cannot render as a bare "0".
  const places = [ev.capacity ? `${ev.capacity} places` : null, ev.fee]
    .filter(Boolean)
    .join(" · ");

  return (
    <TiltCard
      maxTilt={5}
      lift={6}
      className={cn(
        "rounded-2xl border border-stone-200 bg-white shadow-depth-1",
        "hover:shadow-depth-3 hover:border-brand-500",
        // `TiltCard` renders a div, so the card can never take focus itself.
        // Without focus-within the whole treatment would be pointer-only.
        "focus-within:border-brand-500 focus-within:shadow-depth-3",
      )}
    >
      <article className="flex gap-5 p-5">
        {/* aria-hidden: the full, unambiguous date is in the list below, and a
            screen reader does not need "6" then "Nov" as loose fragments. */}
        <div
          aria-hidden
          className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-ink-950 shadow-depth-1"
        >
          <span className="font-display text-xl font-semibold leading-none text-white">
            {day}
          </span>
          <span className="mt-1 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-brand-300">
            {month}
          </span>
        </div>

        <div className="min-w-0">
          <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-stone-600">
            {EVENT_TYPES[ev.type]}
          </p>

          <h3 className="mt-1.5 font-display text-base font-semibold leading-snug">
            <Link
              href={`/trade/events/${ev.slug}`}
              className="text-ink-950 decoration-brand-500 decoration-2 underline-offset-4 hover:underline"
            >
              {ev.titleEn}
            </Link>
          </h3>

          <dl className="mt-2.5 space-y-1.5 text-[0.8125rem] text-stone-600">
            <div className="flex items-start gap-2">
              <dt className="sr-only">Date</dt>
              <CalendarDays
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500"
                aria-hidden
              />
              <dd>
                <time dateTime={ev.start}>
                  {formatDateRange(ev.start, ev.end)}
                </time>
                {/* A single-day event without an end time is really a start
                    time, so say so rather than implying it runs all day. */}
                {!ev.end && <>, {formatTime(ev.start)}</>}
              </dd>
            </div>

            <div className="flex items-start gap-2">
              <dt className="sr-only">Venue</dt>
              <MapPin
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500"
                aria-hidden
              />
              <dd>{ev.venue}</dd>
            </div>

            {places && (
              <div className="flex items-start gap-2">
                <dt className="sr-only">Places and fee</dt>
                <Users
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stone-500"
                  aria-hidden
                />
                <dd>{places}</dd>
              </div>
            )}
          </dl>

          {ev.registrationOpen ? (
            <ButtonLink
              href={`/trade/events/${ev.slug}`}
              size="sm"
              variant="secondary"
              className="mt-4"
            >
              Book a place
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </ButtonLink>
          ) : (
            // Said plainly rather than by omitting the button: a card with no
            // call to action reads as an oversight.
            <p className="mt-4">
              <Tag>Registration closed</Tag>
            </p>
          )}
        </div>
      </article>
    </TiltCard>
  );
}

/* -------------------------------------------------------------------------- */

function SectionHead({
  id,
  title,
  href,
  linkLabel,
}: {
  id: string;
  title: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-ink-900 pb-3">
      <h2
        id={id}
        className="font-display text-display-sm font-semibold text-ink-950"
      >
        {title}
      </h2>
      <Link
        href={href}
        className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-ink-700 underline-offset-4 hover:text-ink-950 hover:underline"
      >
        {linkLabel}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </Link>
    </div>
  );
}
