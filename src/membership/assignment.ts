import "server-only";

import { getDb } from "@/db/client";
import type { Queryable } from "@/db/client";
import type { ActorContext } from "@/server/actor";
import { ForbiddenError } from "@/server/actor";
import { writeAudit } from "@/server/audit";

/**
 * Who is working on an application.
 *
 * Assignment is not a state transition and deliberately does **not** touch
 * `applications.version`. The version is the token a transition compares and
 * bumps; bumping it here would make a colleague's half-finished verification
 * fail with "this application has changed, reload" merely because somebody
 * picked the application up, which teaches staff to ignore that message —
 * and that message is load-bearing.
 *
 * Instead each operation is guarded on the assignee it expects. Claiming
 * requires the application to be unassigned (or already mine); releasing
 * requires it to be mine. Two officers pressing "assign to me" at the same
 * instant therefore produce one winner and one honest refusal, rather than
 * the later click silently stealing the row.
 */

export type AssignOutcome =
  | { readonly ok: true; readonly alreadyMine: boolean }
  | { readonly ok: false; readonly reason: "taken" | "not_mine" | "missing" };

export async function claimApplication(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<AssignOutcome> {
  if (!actor.permissions.has("application.assign")) {
    throw new ForbiddenError("application.assign");
  }
  if (actor.userId === null) throw new ForbiddenError("application.assign");
  const userId = actor.userId;

  return db.transaction().execute(async (tx) => {
    const current = await tx
      .selectFrom("applications")
      .select(["id", "assigned_to"])
      .where("id", "=", applicationId)
      .executeTakeFirst();

    if (!current) return { ok: false, reason: "missing" } as const;
    if (current.assigned_to === userId) {
      return { ok: true, alreadyMine: true } as const;
    }

    const claimed = await tx
      .updateTable("applications")
      .set({ assigned_to: userId })
      .where("id", "=", applicationId)
      .where("assigned_to", "is", null)
      .executeTakeFirst();

    if (Number(claimed.numUpdatedRows) !== 1) {
      return { ok: false, reason: "taken" } as const;
    }

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.assigned",
        summary: `Application #${applicationId} assigned to ${actor.roleCode ?? "staff"} user ${userId}`,
        before: { assignedTo: null },
        after: { assignedTo: userId },
      },
      tx,
    );

    return { ok: true, alreadyMine: false } as const;
  });
}

export async function releaseApplication(
  actor: ActorContext,
  applicationId: number,
  db: Queryable = getDb(),
): Promise<AssignOutcome> {
  if (!actor.permissions.has("application.assign")) {
    throw new ForbiddenError("application.assign");
  }
  if (actor.userId === null) throw new ForbiddenError("application.assign");
  const userId = actor.userId;

  return db.transaction().execute(async (tx) => {
    const released = await tx
      .updateTable("applications")
      .set({ assigned_to: null })
      .where("id", "=", applicationId)
      .where("assigned_to", "=", userId)
      .executeTakeFirst();

    if (Number(released.numUpdatedRows) !== 1) {
      return { ok: false, reason: "not_mine" } as const;
    }

    await writeAudit(
      actor,
      {
        entityType: "application",
        entityId: applicationId,
        action: "application.unassigned",
        summary: `Application #${applicationId} released by user ${userId}`,
        before: { assignedTo: userId },
        after: { assignedTo: null },
      },
      tx,
    );

    return { ok: true, alreadyMine: false } as const;
  });
}
