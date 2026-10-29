import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, sql } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { ForbiddenError, type ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import {
  calendarReach,
  extendCalendar,
  listDeviations,
  recomputeFlaggedClocks,
  setCalendarDay,
} from "@/membership/calendar";
import {
  nthWorkingDayAfter,
  startSlaClock,
  workingDaysBetween,
} from "@/membership/sla";
import {
  createUser,
  databaseAvailable,
  reseedCalendar,
  resetTables,
  skipReason,
  teardown,
} from "./helpers";

/**
 * The working-day calendar, and the deadlines that move with it.
 *
 * This suite is unusual in one respect and it matters: `resetTables` does not
 * touch `working_day_calendar`, because the calendar is seeded reference data
 * every other suite's SLA arithmetic reads. So these tests work in a window
 * far from the dates anything else uses, and put it back afterwards. A test
 * that closed next Tuesday and left it closed would change the answer to
 * "when is this application due" in every other file, days later, with nothing
 * pointing back here.
 *
 * What is actually being claimed:
 *
 * **An edit inside a running window moves the deadline, and says so.** The
 * promise is in working days, so removing one from the middle makes the
 * fortieth later than the date already in the applicant's inbox. Correct, and
 * never silent.
 *
 * **An edit outside it does not.** Including, especially, a holiday notified
 * after an application was decided: `stopSlaClock` froze the outcome on the
 * day of the decision, and nothing may reach back and turn a breach into a
 * success.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping calendar tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

/** Far from every other suite, which works within days of today. */
const WINDOW_YEAR = 2029;

afterAll(async () => {
  if (available) await reseedCalendar();
  await teardown();
});

const TABLES = [
  "application_state_transitions",
  "application_company",
  "sla_pauses",
  "sla_clocks",
  "applications",
  "audit_log",
  "users",
];

function staffActor(
  userId: number,
  permissions: readonly PermissionCode[],
): ActorContext {
  return {
    userId,
    userType: "staff",
    roleCode: "super_admin",
    roleCodes: ["super_admin"],
    permissions: new Set(permissions),
    requestId: newUlid(),
    ipHash: "a".repeat(64),
    userAgentHash: "b".repeat(64),
    onBehalfOfUserId: null,
  };
}

async function admin(): Promise<ActorContext> {
  const id = await createUser(`calendar-${randomUUID()}@lcci.org.pk`);
  return staffActor(id, ["calendar.manage", "application.read"]);
}

/** A submitted application with a running clock of `workingDays`. */
async function clockedApplication(
  startedOn: string,
  workingDays: number,
): Promise<{ applicationId: number; dueDate: string }> {
  const db = getDb();
  const applicantId = await createUser(
    `applicant-${randomUUID()}@example.com.pk`,
    "portal",
  );

  const inserted = await db
    .insertInto("applications")
    .values({
      state: "UNDER_VERIFICATION" as never,
      created_by: applicantId,
      membership_class: "corporate",
      processing_tier: "regular",
      public_ref: `LCCI-APP-C-${Math.floor(Math.random() * 1e6)}`,
      submitted_at: new Date(`${startedOn}T06:00:00Z`),
    })
    .executeTakeFirstOrThrow();

  const applicationId = Number(inserted.insertId);

  const { dueDate } = await startSlaClock(db, {
    applicationId,
    processingTier: "regular",
    workingDays,
    startedAt: new Date(`${startedOn}T06:00:00Z`),
  });

  return { applicationId, dueDate };
}

/** The nth working day strictly after a date, read back from the calendar. */
async function workingDayAfter(from: string, n: number): Promise<string> {
  return nthWorkingDayAfter(getDb(), from, n);
}

describe.skipIf(!available)("recording a day", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await reseedCalendar();
  });

  it("closes a day and flags the applications running across it", async () => {
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    const { applicationId, dueDate } = await clockedApplication(start, 10);

    // The third working day of the window: comfortably inside, and chosen from
    // the calendar rather than guessed, so the test does not quietly depend on
    // which weekday the 3rd of September fell on.
    const holiday = await workingDayAfter(start, 3);

    const result = await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Eid-ul-Fitr (second day)",
      confidence: "confirmed",
      source: "Cabinet Division notification",
      notifiedOn: `${WINDOW_YEAR}-08-20`,
    });

    expect(result.changed).toBe(true);
    expect(result.clocksFlagged).toBe(1);

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["needs_recompute", "due_date"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(Number(clock.needs_recompute)).toBe(1);
    // Flagged, not yet moved. The edit is cheap on purpose: a secretary
    // entering five days of Eid should not wait on five recomputes.
    expect(clock.due_date).toBe(dueDate);
  });

  it("leaves alone an application that finishes before the holiday", async () => {
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    await clockedApplication(start, 5);

    const afterTheDeadline = await workingDayAfter(start, 20);

    const result = await setCalendarDay(actor, {
      date: afterTheDeadline,
      isWorkingDay: false,
      label: "Quaid-e-Azam Day",
      confidence: "confirmed",
      source: "notification",
      notifiedOn: null,
    });

    expect(result.changed).toBe(true);
    expect(result.clocksFlagged).toBe(0);
  });

  it("never reaches back into a decided application", async () => {
    // The whole reason `outcome` is written on the day of the decision rather
    // than derived on read. A holiday notified in December must not turn
    // November's breach into a success.
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    const { applicationId } = await clockedApplication(start, 10);

    await getDb()
      .updateTable("sla_clocks")
      .set({ state: "stopped", outcome: "breached", stopped_at: new Date() })
      .where("application_id", "=", applicationId)
      .execute();

    const holiday = await workingDayAfter(start, 3);
    const result = await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Ashura",
      confidence: "confirmed",
      source: "notification",
      notifiedOn: null,
    });

    expect(result.clocksFlagged).toBe(0);

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["needs_recompute", "outcome"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(Number(clock.needs_recompute)).toBe(0);
    expect(clock.outcome).toBe("breached");
  });

  it("flags nothing when only the wording changes", async () => {
    // Promoting a provisional date to confirmed, or fixing a typo in its name,
    // changes no arithmetic. Flagging for those would put a recompute and an
    // audit event behind every correction.
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    await clockedApplication(start, 10);

    const holiday = await workingDayAfter(start, 3);
    await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Eid holiday",
      confidence: "provisional",
      source: "expected",
      notifiedOn: null,
    });

    await getDb()
      .updateTable("sla_clocks")
      .set({ needs_recompute: 0 })
      .execute();

    const second = await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Eid-ul-Azha (second day)",
      confidence: "confirmed",
      source: "Cabinet Division notification of 3 August",
      notifiedOn: `${WINDOW_YEAR}-08-03`,
    });

    expect(second.changed).toBe(false);
    expect(second.clocksFlagged).toBe(0);
  });

  it("refuses an actor without the grant", async () => {
    const id = await createUser(`officer-${randomUUID()}@lcci.org.pk`);
    const officer = staffActor(id, ["application.read"]);

    await expect(
      setCalendarDay(officer, {
        date: `${WINDOW_YEAR}-09-10`,
        isWorkingDay: false,
        label: "unauthorised",
        confidence: "provisional",
        source: null,
        notifiedOn: null,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("shows the day it recorded, and not the 300 it did not", async () => {
    const actor = await admin();
    const holiday = await workingDayAfter(`${WINDOW_YEAR}-09-03`, 3);

    await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Eid-ul-Fitr",
      confidence: "confirmed",
      source: "notification",
      notifiedOn: null,
    });

    const deviations = await listDeviations(actor, WINDOW_YEAR);
    const dates = deviations.map((day) => day.date);

    expect(dates).toContain(holiday);
    // A weekday closure is a deviation; the 250 ordinary weekdays around it
    // are the assumption, stated once at the top of the screen.
    expect(deviations.length).toBeLessThan(10);
    expect(deviations.find((day) => day.date === holiday)?.label).toBe(
      "Eid-ul-Fitr",
    );
  });
});

describe.skipIf(!available)("moving the deadlines", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await reseedCalendar();
  });

  it("pushes the promised date out by exactly one working day", async () => {
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    const { applicationId, dueDate } = await clockedApplication(start, 10);

    const holiday = await workingDayAfter(start, 4);
    await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Eid-ul-Fitr",
      confidence: "confirmed",
      source: "notification",
      notifiedOn: null,
    });

    const result = await recomputeFlaggedClocks(actor);
    expect(result.examined).toBe(1);
    expect(result.moved).toBe(1);
    expect(result.more).toBe(false);

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["due_date", "needs_recompute"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(Number(clock.needs_recompute)).toBe(0);
    expect(clock.due_date > dueDate).toBe(true);
    // One working day removed from the interior means the tenth working day is
    // the next working day after the one it was. Asserted as a count rather
    // than a date, so the claim is about the arithmetic and not about which
    // weekday September started on.
    expect(await workingDaysBetween(getDb(), dueDate, clock.due_date)).toBe(1);
  });

  it("writes one audit event naming both dates", async () => {
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    const { applicationId, dueDate } = await clockedApplication(start, 10);

    const holiday = await workingDayAfter(start, 4);
    await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Eid-ul-Fitr",
      confidence: "confirmed",
      source: "notification",
      notifiedOn: null,
    });
    await recomputeFlaggedClocks(actor);

    const event = await getDb()
      .selectFrom("audit_log")
      .select(["action", "summary", "before_json", "after_json"])
      .where("action", "=", "sla.deadline_recomputed")
      .where("entity_id", "=", String(applicationId))
      .executeTakeFirstOrThrow();

    expect(event.summary).toContain(dueDate);
    expect(event.before_json).toMatchObject({ due_date: dueDate });
    // A deadline that became later with no record of why is the audit failure
    // this event exists to prevent: the old date is in the applicant's inbox.
    expect(event.after_json).not.toMatchObject({ due_date: dueDate });
  });

  it("counts a pause back in, so the file keeps the days it was owed", async () => {
    // The identity the recompute depends on: the deadline is the
    // (promised + paused)th working day after arrival, because the cth working
    // day after the Nth is the (N+c)th. If this breaks, every application that
    // was ever returned to its applicant silently loses that time.
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    const { applicationId } = await clockedApplication(start, 10);

    await getDb()
      .updateTable("sla_clocks")
      .set({ paused_working_days: 4, due_date: await workingDayAfter(start, 14) })
      .where("application_id", "=", applicationId)
      .execute();

    const holiday = await workingDayAfter(start, 2);
    await setCalendarDay(actor, {
      date: holiday,
      isWorkingDay: false,
      label: "Ashura",
      confidence: "confirmed",
      source: "notification",
      notifiedOn: null,
    });

    await recomputeFlaggedClocks(actor);

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["due_date"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(clock.due_date).toBe(await workingDayAfter(start, 14));
  });

  it("clears the flag without an audit event where nothing moved", async () => {
    // A holiday on a Sunday. The clock is flagged because the date is inside
    // its window, and the arithmetic then says the deadline is unchanged.
    // Without the flag being cleared the job re-reads the row on every tick
    // for ever; with an audit event, the log fills with non-events.
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    const { applicationId, dueDate } = await clockedApplication(start, 10);

    await getDb()
      .updateTable("sla_clocks")
      .set({ needs_recompute: 1 })
      .where("application_id", "=", applicationId)
      .execute();

    const result = await recomputeFlaggedClocks(actor);
    expect(result.examined).toBe(1);
    expect(result.moved).toBe(0);

    const clock = await getDb()
      .selectFrom("sla_clocks")
      .select(["due_date", "needs_recompute"])
      .where("application_id", "=", applicationId)
      .executeTakeFirstOrThrow();

    expect(clock.due_date).toBe(dueDate);
    expect(Number(clock.needs_recompute)).toBe(0);

    const events = await getDb()
      .selectFrom("audit_log")
      .select(sql<number>`COUNT(*)`.as("n"))
      .where("action", "=", "sla.deadline_recomputed")
      .executeTakeFirstOrThrow();
    expect(Number(events.n)).toBe(0);
  });

  it("stops at the batch size and says there is more", async () => {
    const actor = await admin();
    const start = `${WINDOW_YEAR}-09-03`;
    await clockedApplication(start, 10);
    await clockedApplication(start, 12);
    await clockedApplication(start, 14);

    await getDb()
      .updateTable("sla_clocks")
      .set({ needs_recompute: 1 })
      .execute();

    const first = await recomputeFlaggedClocks(actor, 2);
    expect(first.examined).toBe(2);
    expect(first.more).toBe(true);

    const second = await recomputeFlaggedClocks(actor, 2);
    expect(second.examined).toBe(1);
    expect(second.more).toBe(false);
  });
});

describe.skipIf(!available)("how far it reaches", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await reseedCalendar();
  });

  it("answers per tier, because the cheapest promise fails first", async () => {
    const actor = await admin();
    const reach = await calendarReach(actor);

    expect(reach.lastDate).not.toBeNull();
    expect(reach.years).toContain(WINDOW_YEAR);

    const regular = reach.tierHorizon.regular;
    const executive = reach.tierHorizon.executive;
    expect(regular).not.toBeNull();
    expect(executive).not.toBeNull();

    // Forty working days of headroom runs out before three do, so a Regular
    // application stops being acceptable while an Executive one still is.
    // Backwards from how anyone would guess, which is why it is three rows on
    // the screen and not one sentence.
    expect(regular! < executive!).toBe(true);
  });

  it("extends without reopening a holiday already entered", async () => {
    const actor = await admin();

    // A chamber told in October about next March's bank holiday records it
    // before anyone has extended into that year. An extend that silently
    // reopened it would delete the one piece of real information in the range.
    const future = `${WINDOW_YEAR + 1}-03-23`;
    await setCalendarDay(actor, {
      date: future,
      isWorkingDay: false,
      label: "Pakistan Day",
      confidence: "confirmed",
      source: "notification",
      notifiedOn: null,
    });

    const result = await extendCalendar(actor, WINDOW_YEAR + 1);

    // 365, not 283. Filling from `MAX(cal_date)` would have started the day
    // after the holiday just entered and left January and February missing —
    // and a calendar with a hole does not fail, it shortens every deadline
    // that crosses it, because the arithmetic counts rows.
    expect(result.added).toBe(365);
    expect(result.through).toBe(`${WINDOW_YEAR + 1}-12-31`);

    const count = await getDb()
      .selectFrom("working_day_calendar")
      .select(sql<number>`COUNT(*)`.as("n"))
      .where("cal_date", ">=", `${WINDOW_YEAR + 1}-01-01`)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(365);

    const day = await getDb()
      .selectFrom("working_day_calendar")
      .select(["is_working_day", "label_en"])
      .where("cal_date", "=", future)
      .executeTakeFirstOrThrow();

    expect(Number(day.is_working_day)).toBe(0);
    expect(day.label_en).toBe("Pakistan Day");
  });

  it("writes Monday to Friday, and says in the row that it assumed it", async () => {
    const actor = await admin();
    await extendCalendar(actor, WINDOW_YEAR + 1);

    const sample = await sql<{ cal_date: string; is_working_day: number; source: string | null }>`
      SELECT cal_date, is_working_day, source
        FROM working_day_calendar
       WHERE YEAR(cal_date) = ${WINDOW_YEAR + 1}
         AND DAYOFWEEK(cal_date) = 1
       LIMIT 1
    `.execute(getDb());

    const sunday = sample.rows[0];
    expect(sunday).toBeDefined();
    expect(Number(sunday?.is_working_day)).toBe(0);
    // Open question 8: many Pakistani chambers work a six-day week. The rows
    // say they were assumed rather than looking authoritative.
    expect(sunday?.source).toContain("not yet confirmed");
  });
});
