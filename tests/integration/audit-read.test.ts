import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, sql } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { systemActor, type ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import { writeAudit } from "@/server/audit";
import { auditEntityTypes, auditIntegrity, auditPage } from "@/server/audit-read";
import { createUser, databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * Reading the audit log back, against the database.
 *
 * The grouping and the hash arithmetic could be tested on fabricated objects,
 * and that is exactly what would make the tests worthless. The claims here are
 * all claims about what happens when somebody *changes the table* — and a
 * fabricated row cannot be tampered with in the way a real one can, because
 * the thing being verified is the relationship between the stored hash and the
 * stored content.
 *
 * So each integrity test commits real events through `writeAudit`, then reaches
 * past the application and alters the rows the way someone with database
 * credentials would, and asserts the screen notices. A verification test that
 * never sees a tampered row proves only that clean data reads as clean, which
 * is the one outcome nobody needed reassurance about.
 *
 * The three checks are tested apart from each other on purpose, because they
 * do not substitute for one another: a deletion from the end leaves every
 * surviving link correct, and a page of filtered rows must not report the gaps
 * between them as breaks.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping audit-read tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(teardown);

/**
 * Everything holding a foreign key to `users`, not only the two tables this
 * suite writes.
 *
 * `resetTables` empties with `FOREIGN_KEY_CHECKS = 0` and resets each table's
 * auto-increment, so clearing `users` alone leaves another suite's rows —
 * decisions, checklists, payments — pointing at ids this suite then reissues to
 * different people. The symptom is the one test that deletes an account failing
 * on a constraint from a table it has never heard of, which is a confusing way
 * to learn that a test suite's reset list has to cover the shape of the schema
 * rather than the shape of the test.
 */
const TABLES = [
  "deficiency_items",
  "application_deficiencies",
  "verification_checklist_items",
  "verification_checklists",
  "application_decisions",
  "conflict_waivers",
  "membership_years",
  "memberships",
  "application_endorsements",
  "application_authorisation",
  "application_state_transitions",
  "submission_snapshots",
  "pay_orders",
  "payments",
  "sla_pauses",
  "sla_clocks",
  "application_company",
  "applications",
  "documents",
  "company_users",
  "companies",
  "otp_challenges",
  "staff_recovery_codes",
  "staff_totp_used",
  "user_roles",
  "email_outbox",
  "audit_log",
  "users",
];

const AUDITOR: readonly PermissionCode[] = ["audit.read"];

function staffActor(
  userId: number | null,
  permissions: readonly PermissionCode[],
  roleCode: string | null = "super_admin",
  requestId = newUlid(),
): ActorContext {
  return {
    userId,
    userType: "staff",
    roleCode,
    roleCodes: roleCode ? [roleCode] : [],
    permissions: new Set(permissions),
    requestId,
    ipHash: "a".repeat(64),
    userAgentHash: "b".repeat(64),
    onBehalfOfUserId: null,
  };
}

/**
 * Put the chain head back where an empty log expects it.
 *
 * `resetTables` empties `audit_log` but cannot touch `audit_chain_head`, which
 * has no insert path outside the migration — so without this every suite would
 * start with a head naming a row that no longer exists, and the tail check
 * would report rows missing before a single test had run. Which is, strictly,
 * true: rows were removed. It is just not the thing under test.
 */
async function resetChainHead(): Promise<void> {
  await sql`
    UPDATE audit_chain_head
       SET head_hash = NULL, head_id = NULL, updated_at = UTC_TIMESTAMP(3)
     WHERE id = 1
  `.execute(getDb());
}

describe.runIf(available)("the audit log, read back", () => {
  let auditorId: number;
  let auditor: ActorContext;

  beforeEach(async () => {
    await resetTables(TABLES);
    await resetChainHead();
    auditorId = await createUser("auditor@test.lcci", "staff", "Amina Rashid");
    auditor = staffActor(auditorId, AUDITOR);
  });

  describe("what a reader is shown", () => {
    it("groups the events of one request and keeps their order", async () => {
      // One approval, as the real thing writes it: four events, one request.
      const approver = await createUser("approver@test.lcci", "staff", "Imran Qureshi");
      const request = newUlid();
      const actor = staffActor(approver, ["application.approve"], "membership_approver", request);

      for (const action of [
        "application.approved",
        "membership.created",
        "membership.number_allocated",
        "sla.clock_stopped",
      ]) {
        await writeAudit(actor, {
          entityType: "application",
          entityId: 41,
          action,
          summary: `${action} happened`,
        });
      }

      const page = await auditPage(auditor, {});

      expect(page.groups).toHaveLength(1);
      const group = page.groups[0];
      expect(group.requestId).toBe(request);
      // Written order, not the newest-first order of the page. A grant reads
      // as decision, membership, number, clock — reversing it inside the group
      // would make the number look as if it preceded the decision.
      expect(group.entries.map((entry) => entry.action)).toEqual([
        "application.approved",
        "membership.created",
        "membership.number_allocated",
        "sla.clock_stopped",
      ]);
      expect(group.actor.name).toBe("Imran Qureshi");
      expect(group.actor.roleCode).toBe("membership_approver");
    });

    it("puts the newest request first and does not merge two requests", async () => {
      const actor = (request: string) => staffActor(auditorId, AUDITOR, "super_admin", request);

      const first = newUlid();
      const second = newUlid();

      await writeAudit(actor(first), {
        entityType: "application",
        entityId: 1,
        action: "application.submitted",
        summary: "first",
      });
      await writeAudit(actor(second), {
        entityType: "application",
        entityId: 2,
        action: "application.submitted",
        summary: "second",
      });

      const page = await auditPage(auditor, {});

      expect(page.groups.map((group) => group.requestId)).toEqual([second, first]);
    });

    it("names the system where a job acted, and holds no role for it", async () => {
      await writeAudit(systemActor(newUlid()), {
        entityType: "application",
        entityId: 7,
        action: "application.closed_no_response",
        summary: "Closed after no response",
      });

      const page = await auditPage(auditor, {});

      expect(page.groups[0].actor.kind).toBe("system");
      expect(page.groups[0].actor.userId).toBeNull();
      expect(page.groups[0].actor.roleCode).toBeNull();
    });

    /**
     * The trap `ActorKind` exists for.
     *
     * `actor_user_id` is `ON DELETE SET NULL`, and a null actor is also how the
     * system actor is recorded — so the obvious reading of "no user" reattributes
     * a dismissed officer's approvals to a cron job. The snapshotted role is
     * what keeps them apart, and this is the test that would have caught it.
     */
    it("does not mistake a deleted account for the system", async () => {
      const officer = await createUser("leaver@test.lcci", "staff", "Sana Tariq");

      await writeAudit(
        staffActor(officer, ["application.verify"], "membership_officer"),
        {
          entityType: "application",
          entityId: 9,
          action: "application.verification_completed",
          summary: "Verified",
        },
      );

      await getDb().deleteFrom("users").where("id", "=", officer).execute();

      const page = await auditPage(auditor, {});
      const actor = page.groups[0].actor;

      expect(actor.kind).toBe("deleted");
      expect(actor.userId).toBeNull();
      // The name is gone with the account; the role is not, because it was
      // snapshotted rather than joined. Which role verified a file is most of
      // the answer when the question is whether the right person did.
      expect(actor.name).toBeNull();
      expect(actor.roleCode).toBe("membership_officer");
    });
  });

  describe("whether the record holds together", () => {
    async function writeChain(count: number): Promise<void> {
      for (let i = 1; i <= count; i += 1) {
        await writeAudit(auditor, {
          entityType: "application",
          entityId: i,
          action: "application.submitted",
          summary: `event ${i}`,
          after: { state: "SUBMITTED" },
        });
      }
    }

    it("reads a clean chain as clean", async () => {
      await writeChain(4);

      const page = await auditPage(auditor, {});
      const integrity = await auditIntegrity(auditor);

      expect(page.altered).toEqual([]);
      expect(page.linkage).toEqual({ kind: "checked", brokenAfterId: null });
      expect(integrity.tail).toBe("intact");
      expect(integrity.newestId).toBe(integrity.headId);
    });

    it("catches a row whose contents were edited", async () => {
      await writeChain(3);

      // What tampering actually looks like: the summary is rewritten and the
      // hashes are left alone, because recomputing them would need the writer.
      await sql`
        UPDATE audit_log SET summary = 'event 2 (altered)' WHERE id = 2
      `.execute(getDb());

      const page = await auditPage(auditor, {});

      expect(page.altered).toEqual([2]);

      const entry = page.groups
        .flatMap((group) => group.entries)
        .find((candidate) => candidate.id === 2);
      expect(entry?.integrity).toBe("altered");

      // And the rows either side are untouched, so the screen points at one
      // line rather than condemning the page.
      const others = page.groups
        .flatMap((group) => group.entries)
        .filter((candidate) => candidate.id !== 2);
      expect(others.map((candidate) => candidate.integrity)).toEqual(["intact", "intact"]);
    });

    it("catches an edit to a payload, not only to the summary", async () => {
      await writeChain(2);

      // The JSON columns are in the hash too. An approval whose `after` was
      // quietly changed from one membership number to another would otherwise
      // read as a clean record of the wrong fact.
      await sql`
        UPDATE audit_log
           SET after_json = JSON_OBJECT('state', 'APPROVED')
         WHERE id = 1
      `.execute(getDb());

      const page = await auditPage(auditor, {});

      expect(page.altered).toEqual([1]);
    });

    it("catches a row deleted from the middle", async () => {
      await writeChain(4);

      await sql`DELETE FROM audit_log WHERE id = 2`.execute(getDb());

      const page = await auditPage(auditor, {});

      // Row 3 claims row 2 as its predecessor and row 2 is gone, so the pair
      // that fails to join is (1, 3) — named by the older of the two, which is
      // the last row a reader can still trust.
      expect(page.linkage).toEqual({ kind: "checked", brokenAfterId: 1 });
      // Every surviving row is individually intact. Deletion is invisible to
      // the per-row hash, which is why linkage is a separate check.
      expect(page.altered).toEqual([]);
    });

    it("catches rows deleted from the end, which linkage cannot see", async () => {
      await writeChain(4);

      await sql`DELETE FROM audit_log WHERE id = 4`.execute(getDb());

      const page = await auditPage(auditor, {});
      const integrity = await auditIntegrity(auditor);

      // This is the pairing that justifies three checks rather than one. The
      // remaining rows link perfectly and each hashes correctly: removing the
      // last row breaks nothing that the chain itself can see.
      expect(page.linkage).toEqual({ kind: "checked", brokenAfterId: null });
      expect(page.altered).toEqual([]);
      // Only the head pointer, advanced in the same transaction as the row it
      // names, still remembers that a fourth event existed.
      expect(integrity.tail).toBe("rows_missing");
      expect(integrity.headId).toBe(4);
      expect(integrity.newestId).toBe(3);
    });

    it("does not claim adjacency on a filtered page", async () => {
      await writeChain(4);

      const page = await auditPage(auditor, { entityId: "2" });

      expect(page.filtered).toBe(true);
      // Two selected rows are not meant to be neighbours, so reporting the gap
      // between them as a break would cry tampering on every normal search —
      // and a warning that fires on every search is one nobody reads.
      expect(page.linkage).toEqual({ kind: "not_checked" });
      expect(page.altered).toEqual([]);
    });

    it("reports an empty log as empty rather than as broken", async () => {
      const integrity = await auditIntegrity(auditor);

      expect(integrity.tail).toBe("empty");
      expect(integrity.newestId).toBeNull();
      expect(integrity.lastSweep).toBeNull();
    });
  });

  describe("narrowing and paging", () => {
    beforeEach(async () => {
      const officer = await createUser("officer@test.lcci", "staff", "Bilal Ahmed");

      await writeAudit(staffActor(officer, AUDITOR, "membership_officer"), {
        entityType: "application",
        entityId: 11,
        action: "application.verification_completed",
        summary: "Verified application 11",
      });
      await writeAudit(auditor, {
        entityType: "membership",
        entityId: 5,
        action: "membership.created",
        summary: "Membership LCCI-000005 created",
      });
      await writeAudit(auditor, {
        entityType: "application",
        entityId: 11,
        action: "application.approved",
        summary: "Approved application 11",
      });
    });

    it("filters by the kind of thing", async () => {
      const page = await auditPage(auditor, { entityType: "membership" });

      expect(page.groups.flatMap((group) => group.entries).map((entry) => entry.action)).toEqual([
        "membership.created",
      ]);
    });

    it("filters to one record's whole history", async () => {
      const page = await auditPage(auditor, { entityType: "application", entityId: "11" });

      expect(page.groups.flatMap((group) => group.entries).map((entry) => entry.action)).toEqual([
        "application.approved",
        "application.verification_completed",
      ]);
    });

    it("filters by who did it", async () => {
      const page = await auditPage(auditor, { actorUserId: auditorId });

      const actions = page.groups.flatMap((group) => group.entries).map((entry) => entry.action);
      expect(actions).toContain("membership.created");
      expect(actions).not.toContain("application.verification_completed");
    });

    it("filters by action", async () => {
      const page = await auditPage(auditor, { action: "application.approved" });

      expect(page.groups).toHaveLength(1);
      expect(page.groups[0].entries[0].summary).toBe("Approved application 11");
    });

    it("includes the whole of the day named as the upper bound", async () => {
      const today = new Date().toISOString().slice(0, 10);

      // The bound is a civil date against a DATETIME(3). A half-open
      // comparison would make "from today to today" return nothing, which is
      // the first thing anybody types.
      const page = await auditPage(auditor, { from: today, to: today });

      expect(page.groups.flatMap((group) => group.entries)).toHaveLength(3);
    });

    it("pages on the id without repeating or skipping a row", async () => {
      const first = await auditPage(auditor, { limit: 2 });
      expect(first.groups.flatMap((group) => group.entries)).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = await auditPage(auditor, {
        limit: 2,
        before: first.nextCursor ?? undefined,
      });

      const firstIds = first.groups.flatMap((group) => group.entries).map((entry) => entry.id);
      const secondIds = second.groups.flatMap((group) => group.entries).map((entry) => entry.id);

      expect(secondIds).toHaveLength(1);
      expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
      expect([...firstIds, ...secondIds].sort((a, b) => a - b)).toEqual([1, 2, 3]);
      // Nothing left, so no "older" link is offered on a page that would be
      // empty — the end of the log should not look like a loading failure.
      expect(second.nextCursor).toBeNull();
    });

    it("lists the kinds of thing the log actually holds", async () => {
      expect(await auditEntityTypes(auditor)).toEqual(["application", "membership"]);
    });
  });

  describe("who may read it", () => {
    it("refuses an actor without the grant", async () => {
      const officer = await createUser("nosy@test.lcci", "staff", "Nadia Khan");
      const without = staffActor(officer, ["application.read"], "membership_officer");

      await expect(auditPage(without, {})).rejects.toThrow();
      await expect(auditIntegrity(without)).rejects.toThrow();
      await expect(auditEntityTypes(without)).rejects.toThrow();
    });
  });
});
