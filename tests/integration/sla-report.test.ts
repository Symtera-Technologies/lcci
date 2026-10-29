import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { ForbiddenError, type ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import type { ProcessingTier, SlaOutcome } from "@/db/schema";
import { slaReport } from "@/membership/sla-report";
import {
  createUser,
  databaseAvailable,
  reseedCalendar,
  resetTables,
  seedAllWorkingDays,
  skipReason,
  teardown,
} from "./helpers";

/**
 * Whether the chamber kept the promises it sold.
 *
 * Run against a calendar where every day is a working day, so "started twelve
 * days ago" means twelve working days elapsed and the assertions are numbers
 * rather than another call to the function under test. The holiday arithmetic
 * has its own suite; mixing the two here would mean a failure could be either
 * and the test would not say which.
 *
 * The claim that matters most is the pair of figures. "Thirty-two working days
 * elapsed, eleven of them waiting on the applicant" is the sentence this
 * report exists to produce, and it is the answer when a member complains about
 * a missed Executive promise. Elapsed alone makes the office look slow for
 * time it never held the file; paused alone hides a file that sat on a desk.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping SLA report tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

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
    roleCode: "membership_officer",
    roleCodes: ["membership_officer"],
    permissions: new Set(permissions),
    requestId: newUlid(),
    ipHash: "a".repeat(64),
    userAgentHash: "b".repeat(64),
    onBehalfOfUserId: null,
  };
}

function isoDaysFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

interface ClockSpec {
  readonly tier: ProcessingTier;
  readonly workingDays: number;
  /** Negative is in the past. */
  readonly startedDaysAgo: number;
  readonly dueInDays: number;
  readonly clockState?: "running" | "paused" | "stopped";
  readonly outcome?: SlaOutcome;
  readonly stoppedDaysAgo?: number;
  readonly pausedWorkingDays?: number;
  readonly needsRecompute?: boolean;
  readonly firmName?: string;
}

async function clocked(spec: ClockSpec): Promise<number> {
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
      processing_tier: spec.tier,
      public_ref: `LCCI-APP-R-${Math.floor(Math.random() * 1e6)}`,
      submitted_at: new Date(Date.now() - spec.startedDaysAgo * 86_400_000),
    })
    .executeTakeFirstOrThrow();

  const applicationId = Number(inserted.insertId);

  await db
    .insertInto("application_company")
    .values({
      application_id: applicationId,
      firm_name: spec.firmName ?? "Mall Road Exports",
      representative_name: "A. Representative",
    })
    .execute();

  await db
    .insertInto("sla_clocks")
    .values({
      application_id: applicationId,
      processing_tier: spec.tier,
      working_days: spec.workingDays,
      started_at: new Date(Date.now() - spec.startedDaysAgo * 86_400_000),
      due_date: isoDaysFromToday(spec.dueInDays),
      state: (spec.clockState ?? "running") as never,
      outcome: spec.outcome ?? null,
      stopped_at:
        spec.stoppedDaysAgo === undefined
          ? null
          : new Date(Date.now() - spec.stoppedDaysAgo * 86_400_000),
      paused_working_days: spec.pausedWorkingDays ?? 0,
      needs_recompute: spec.needsRecompute ? 1 : 0,
    })
    .execute();

  return applicationId;
}

async function officer(): Promise<ActorContext> {
  const id = await createUser(`officer-${randomUUID()}@lcci.org.pk`);
  return staffActor(id, ["application.read"]);
}

describe.skipIf(!available)("promises outstanding", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await seedAllWorkingDays();
  });

  it("counts the days elapsed and the days that were not the chamber's", async () => {
    const actor = await officer();
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 32,
      dueInDays: 19,
      pausedWorkingDays: 11,
    });

    const report = await slaReport(actor);
    const row = report.open[0];

    expect(row).toBeDefined();
    // The sentence, as two numbers: 32 working days elapsed, 11 of them
    // waiting on the applicant. Neither means anything without the other.
    expect(row?.elapsedWorkingDays).toBe(32);
    expect(row?.pausedWorkingDays).toBe(11);
    expect(row?.breached).toBe(false);
    expect(row?.workingDaysToDue).toBe(19);
  });

  it("puts the late ones first, whatever their tier", async () => {
    const actor = await officer();
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 5,
      dueInDays: 35,
      firmName: "Not late",
    });
    await clocked({
      tier: "executive",
      workingDays: 3,
      startedDaysAgo: 9,
      dueInDays: -6,
      firmName: "Six days late",
    });
    await clocked({
      tier: "urgent",
      workingDays: 15,
      startedDaysAgo: 17,
      dueInDays: -2,
      firmName: "Two days late",
    });

    const report = await slaReport(actor);

    expect(report.open.map((row) => row.firmName)).toEqual([
      "Six days late",
      "Two days late",
      "Not late",
    ]);
    expect(report.open.map((row) => row.breached)).toEqual([true, true, false]);
    // Negative once the date has passed, so the screen can say "6 working days
    // late" in words rather than colouring the row red and hoping.
    expect(report.open[0]?.workingDaysToDue).toBe(-6);
  });

  it("says which files are with the applicant rather than with the chamber", async () => {
    const actor = await officer();
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 10,
      dueInDays: 30,
      clockState: "paused",
    });

    const report = await slaReport(actor);
    expect(report.open[0]?.clockState).toBe("paused");
  });

  it("leaves out the decided, whose promise is already settled", async () => {
    const actor = await officer();
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 50,
      dueInDays: -10,
      clockState: "stopped",
      outcome: "met",
      stoppedDaysAgo: 12,
    });

    const report = await slaReport(actor);
    expect(report.open).toEqual([]);
  });
});

describe.skipIf(!available)("promises missed", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await seedAllWorkingDays();
  });

  it("reads the outcome frozen on the day of the decision", async () => {
    // Not recomputed from the dates. A clock stopped *before* its due date and
    // marked breached stays breached: whether the chamber kept its word is a
    // fact about that day, and a later calendar edit must not rewrite it.
    const actor = await officer();
    await clocked({
      tier: "executive",
      workingDays: 3,
      startedDaysAgo: 20,
      dueInDays: 5,
      clockState: "stopped",
      outcome: "breached",
      stoppedDaysAgo: 2,
      firmName: "Decided late",
    });

    const report = await slaReport(actor);

    expect(report.breaches).toHaveLength(1);
    expect(report.breaches[0]?.firmName).toBe("Decided late");
    expect(report.breaches[0]?.outcome).toBe("breached");
  });

  it("counts only decisions inside the window", async () => {
    const actor = await officer();
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 500,
      dueInDays: -460,
      clockState: "stopped",
      outcome: "breached",
      stoppedDaysAgo: 450,
      firmName: "Long ago",
    });
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 60,
      dueInDays: -20,
      clockState: "stopped",
      outcome: "breached",
      stoppedDaysAgo: 10,
      firmName: "Recent",
    });

    const report = await slaReport(actor);
    expect(report.breaches.map((row) => row.firmName)).toEqual(["Recent"]);

    const widened = await slaReport(actor, { since: "2020-01-01" });
    expect(widened.breaches.map((row) => row.firmName)).toEqual([
      "Recent",
      "Long ago",
    ]);
  });
});

describe.skipIf(!available)("each tier", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await seedAllWorkingDays();
  });

  it("counts the open and the decided separately", async () => {
    // The distinction the card exists for. A tier with no breaches and two
    // applications already past their date is not a tier being met — it is one
    // whose bad news has not been written down yet, and a report that showed
    // only closed outcomes would read best exactly when things were worst.
    const actor = await officer();
    await clocked({
      tier: "executive",
      workingDays: 3,
      startedDaysAgo: 8,
      dueInDays: -5,
    });
    await clocked({
      tier: "executive",
      workingDays: 3,
      startedDaysAgo: 6,
      dueInDays: -3,
    });
    await clocked({
      tier: "executive",
      workingDays: 3,
      startedDaysAgo: 1,
      dueInDays: 2,
    });
    await clocked({
      tier: "executive",
      workingDays: 3,
      startedDaysAgo: 30,
      dueInDays: -27,
      clockState: "stopped",
      outcome: "met",
      stoppedDaysAgo: 28,
    });

    const report = await slaReport(actor);
    const executive = report.byTier.find((row) => row.tier === "executive");

    expect(executive).toMatchObject({
      promisedWorkingDays: 3,
      met: 1,
      breached: 0,
      open: 3,
      openBreached: 2,
    });
  });

  it("names every tier, including the ones nobody has bought", async () => {
    const actor = await officer();
    const report = await slaReport(actor);

    // A tier missing from the table reads as "no data" where the truth is
    // "nobody has bought this", and an empty Executive tier is itself worth
    // seeing — it is the one open question 2 is about.
    expect(report.byTier.map((row) => row.tier)).toEqual([
      "regular",
      "urgent",
      "executive",
    ]);
    expect(report.byTier.every((row) => row.open === 0)).toBe(true);
  });

  it("narrows to one tier when asked", async () => {
    const actor = await officer();
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 5,
      dueInDays: 35,
    });
    await clocked({
      tier: "urgent",
      workingDays: 15,
      startedDaysAgo: 5,
      dueInDays: 10,
    });

    const report = await slaReport(actor, { tier: "urgent" });

    expect(report.open).toHaveLength(1);
    expect(report.open[0]?.tier).toBe("urgent");
    expect(report.byTier.map((row) => row.tier)).toEqual(["urgent"]);
  });
});

describe.skipIf(!available)("deadlines waiting on a recompute", () => {
  beforeEach(async () => {
    await resetTables(TABLES);
    await seedAllWorkingDays();
  });

  it("counts them, because during the gap this report and the applicant disagree", async () => {
    const actor = await officer();
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 5,
      dueInDays: 35,
      needsRecompute: true,
    });
    await clocked({
      tier: "regular",
      workingDays: 40,
      startedDaysAgo: 5,
      dueInDays: 35,
    });

    const report = await slaReport(actor);

    expect(report.awaitingRecompute).toBe(1);
    expect(report.open.filter((row) => row.needsRecompute)).toHaveLength(1);
  });

  it("refuses an actor who may not read applications", async () => {
    const id = await createUser(`stranger-${randomUUID()}@lcci.org.pk`);
    const stranger = staffActor(id, ["payment.read"]);

    await expect(slaReport(stranger)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
