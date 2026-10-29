/**
 * What is scheduled, and how often.
 *
 * Deliberately separate from the handlers in `registry.ts`, and deliberately
 * free of `server-only` and of any import that touches the database: the
 * crontab generator runs under `tsx` with no bundler, and the admin panel's
 * "what is supposed to be running" screen has no business pulling in the
 * mailer and the audit log to render a list of names.
 *
 * `JobName` is derived from this map, and `registry.ts` declares its handlers
 * as `satisfies Record<JobName, JobHandler>` — so a schedule with no handler,
 * or a handler with no schedule, is a type error rather than a job that either
 * never runs or cannot be reached.
 */

export interface JobSchedule {
  /** The crontab schedule, as it should actually be installed. */
  readonly schedule: string;
  /** What it does and why it has to exist, in a sentence someone else reads. */
  readonly description: string;
  /**
   * Wall-clock budget. Default 45 s, comfortably inside the point at which a
   * shared plan starts killing requests, and well inside cPanel's own timeout.
   * A job that budgets more than it will be given does not fail cleanly — it
   * is killed mid-run, leaving its row `running` with a cold heartbeat.
   */
  readonly budgetMs?: number;
}

export const JOB_SCHEDULE = {
  /**
   * Five minutes rather than one: `enqueue` already sends inline after the
   * response, so this tick only ever picks up failures and anything queued
   * outside a request. A one-minute tick would be 1,440 mostly empty runs a
   * day, each a process spawn and a database connection, on a plan that
   * charges for both.
   */
  "email-outbox": {
    schedule: "*/5 * * * *",
    description: "Drain the email outbox, retrying failures with backoff.",
  },

  /**
   * Overnight, because it rewrites rows rather than reading them and there is
   * no reason for it to contend with a working day.
   */
  "outbox-prune": {
    schedule: "40 3 * * *",
    description: "Remove rendered payloads from sent mail older than 30 days.",
  },

  /**
   * Hourly, and not optional housekeeping: the sliding-window table takes one
   * row per login attempt and per OTP request, so without this it grows
   * without bound and the window query it exists to serve gets slower every
   * single day.
   */
  "rate-limit-sweep": {
    schedule: "20 * * * *",
    description: "Delete expired rate-limit counters and events.",
  },

  /**
   * Weekly. The chain is verified in pages across runs, so a weekly tick walks
   * the whole table over time rather than reading seven years of events in one
   * request it would be killed in the middle of.
   */
  "audit-verify": {
    schedule: "10 4 * * 1",
    description: "Verify the audit log's hash chain, paged across runs.",
  },

  /**
   * Every fifteen minutes during the working day, and not at all overnight.
   *
   * It only has work when somebody has just edited the calendar, and the
   * person who edited it is the one waiting to see the deadlines follow. A
   * nightly tick would mean a secretary entering an Eid notification at ten in
   * the morning watches the breach report disagree with the applicants' inboxes
   * until the next day.
   */
  "sla-recompute": {
    schedule: "*/15 6-20 * * *",
    description:
      "Recompute promised dates flagged by a working-day calendar change.",
  },

  /**
   * Hourly. This is the monitoring on a host that has none, so its cadence is
   * "how late is it acceptable to learn that mail stopped working" — and the
   * answer for a system that emails sign-in codes is not "tomorrow".
   */
  health: {
    schedule: "0 * * * *",
    description: "Report dead mail, stalled jobs and configuration problems.",
  },
} as const satisfies Record<string, JobSchedule>;

export type JobName = keyof typeof JOB_SCHEDULE;

/**
 * One job's schedule, widened to the interface.
 *
 * `as const satisfies` above keeps the literal keys — which is what makes
 * `JobName` a union rather than `string` — but it also narrows each value to
 * exactly the properties written, so `JOB_SCHEDULE[name].budgetMs` is a type
 * error on an entry that omits it. Reading through here restores the declared
 * shape, optional properties included.
 */
export function jobSchedule(name: JobName): JobSchedule {
  return JOB_SCHEDULE[name];
}

export const JOB_NAMES = Object.keys(JOB_SCHEDULE) as JobName[];

/**
 * Narrow a URL path segment to a job name.
 *
 * `hasOwnProperty` rather than `in`: the value arrives as a path segment, and
 * `in` would accept `constructor` and `toString`, after which `JOB_SCHEDULE[name]`
 * hands the runner a function it tries to use as a job definition.
 */
export function isJobName(value: string): value is JobName {
  return Object.prototype.hasOwnProperty.call(JOB_SCHEDULE, value);
}

/**
 * The crontab, generated from the schedule.
 *
 * Printed by `npm run cron:print`. Three things it bakes in on purpose.
 *
 * The secret is read from a file rather than written into the crontab: cPanel
 * crontabs are world-readable in some configurations, and an inlined secret
 * also lands in the mail cron sends about its own output.
 *
 * The URL carries no token. A query-string secret ends up in Apache's access
 * log and in the `Referer` of anything the response links to.
 *
 * `-s -o /dev/null` keeps cron silent on success, because a cron job that
 * mails on every run trains its recipient to filter it, which is the same as
 * having no alerting at all.
 */
export function crontabLines(siteOrigin: string, secretPath: string): string[] {
  return JOB_NAMES.flatMap((name) => [
    `# ${JOB_SCHEDULE[name].description}`,
    `${JOB_SCHEDULE[name].schedule} curl -s -o /dev/null -X POST ` +
      `-H "Authorization: Bearer $(cat ${secretPath})" ` +
      `${siteOrigin}/api/cron/${name}`,
  ]);
}
