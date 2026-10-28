import Link from "next/link";
import { ArrowRight, CalendarDays, MapPin, Users } from "lucide-react";
import { getLatestPressReleases, getUpcomingEvents } from "@/content/repository";
import { Tag, TOPIC_LABELS } from "@/components/ui/tag";
import { ButtonLink } from "@/components/ui/button";
import { CARD_BASE, CARD_FOCUS_WITHIN, CARD_GRID } from "@/components/ui/card";
import { dateParts, formatDate, formatDateRange, formatTime } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * Newsroom and events, side by side.
 *
 * Every item shows its publication date. On the legacy site not one press
 * release did, which is why nothing on the page could be judged current.
 */
export async function NewsAndEvents() {
  const [press, events] = await Promise.all([
    getLatestPressReleases(4),
    getUpcomingEvents(3),
  ]);

  return (
    <section className="container-page py-20">
      <div className="grid gap-14 lg:grid-cols-12 lg:gap-12">
        {/* Newsroom */}
        <div className="lg:col-span-7">
          <SectionHead
            title="From the newsroom"
            href="/news/press-releases"
            linkLabel="All press releases"
          />

          <ul className="mt-8 space-y-7">
            {press.map((item, index) => (
              <li
                key={item.id}
                className={index > 0 ? "border-t border-stone-200 pt-7" : undefined}
              >
                <article>
                  <div className="flex flex-wrap items-center gap-2">
                    <time
                      dateTime={item.publishedAt}
                      className="text-xs font-medium uppercase tracking-wide text-stone-500"
                    >
                      {formatDate(item.publishedAt)}
                    </time>
                    {item.topics.slice(0, 2).map((t) => (
                      <Tag key={t} tone="clay">
                        {TOPIC_LABELS[t]}
                      </Tag>
                    ))}
                  </div>

                  <h3 className="mt-2.5 font-display text-xl font-semibold leading-snug">
                    <Link
                      href={`/news/${item.slug}`}
                      className="text-ink-950 decoration-brand-400 decoration-2 underline-offset-4 hover:underline"
                    >
                      {item.titleEn}
                    </Link>
                  </h3>

                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-stone-600">
                    {item.summary}
                  </p>

                  {item.spokesperson && (
                    <p className="mt-2.5 text-[0.8125rem] text-stone-500">
                      Quoted: {item.spokesperson}
                    </p>
                  )}
                </article>
              </li>
            ))}
          </ul>
        </div>

        {/* Events */}
        <div className="lg:col-span-5">
          <SectionHead
            title="Upcoming events"
            href="/trade/events"
            linkLabel="Full calendar"
          />

          <ul className={cn("mt-8 space-y-4", CARD_GRID)}>
            {events.map((ev) => {
              const { day, month } = dateParts(ev.start);
              return (
                <li key={ev.id}>
                  <article
                    className={cn(
                      "flex gap-5 p-5",
                      CARD_BASE,
                      CARD_FOCUS_WITHIN,
                    )}
                  >
                    <div
                      className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-lg bg-ink-950 text-white"
                      aria-hidden
                    >
                      <span className="font-display text-xl font-semibold leading-none">
                        {day}
                      </span>
                      <span className="mt-1 text-[0.625rem] font-medium uppercase tracking-[0.1em] text-brand-300">
                        {month}
                      </span>
                    </div>

                    <div className="min-w-0">
                      <h3 className="font-display text-base font-semibold leading-snug">
                        <Link
                          href={`/trade/events/${ev.slug}`}
                          className="text-ink-950 decoration-brand-400 decoration-2 underline-offset-4 hover:underline"
                        >
                          {ev.titleEn}
                        </Link>
                      </h3>

                      <dl className="mt-2 space-y-1 text-[0.8125rem] text-stone-600">
                        <div className="flex items-center gap-2">
                          <dt className="sr-only">Date</dt>
                          <CalendarDays className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
                          <dd>
                            <time dateTime={ev.start}>
                              {formatDateRange(ev.start, ev.end)}
                            </time>
                            {!ev.end && <>, {formatTime(ev.start)}</>}
                          </dd>
                        </div>
                        <div className="flex items-center gap-2">
                          <dt className="sr-only">Venue</dt>
                          <MapPin className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
                          <dd className="truncate">{ev.venue}</dd>
                        </div>
                        {ev.capacity && (
                          <div className="flex items-center gap-2">
                            <dt className="sr-only">Capacity</dt>
                            <Users className="h-3.5 w-3.5 shrink-0 text-stone-400" aria-hidden />
                            <dd>
                              {ev.capacity} places
                              {ev.fee && <> · {ev.fee}</>}
                            </dd>
                          </div>
                        )}
                      </dl>

                      {ev.registrationOpen && (
                        <ButtonLink
                          href={`/trade/events/${ev.slug}`}
                          size="sm"
                          variant="ghost"
                          className="mt-3.5"
                        >
                          Book a place
                        </ButtonLink>
                      )}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function SectionHead({
  title,
  href,
  linkLabel,
}: {
  title: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div className="flex items-end justify-between gap-4 border-b border-ink-950 pb-3">
      <h2 className="font-display text-display-sm font-semibold text-ink-950">
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
