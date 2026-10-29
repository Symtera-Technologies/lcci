import "server-only";

import { transaction } from "@/db/client";
import type { ContentKind, ContentStatus } from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { ConcurrencyError, ForbiddenError } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { CONTENT_FORMS } from "@/content/fields";
import { ContentInvalidError } from "@/content/admin";
import {
  canTransitionContent,
  requiresNote,
  type ContentTransitionCode,
} from "@/content/workflow";

/**
 * Moving content between statuses.
 *
 * The counterpart to `src/content/admin.ts`, which writes field values and
 * deliberately never touches `status`. Everything that changes what the public
 * can see goes through this one function, so "who published this, and had
 * anybody read it first" has a single answer rather than one per screen.
 *
 * Three properties, each of them load-bearing:
 *
 * **The decision is made by the pure table, not here.** `canTransitionContent`
 * in `src/content/workflow.ts` says whether the move is allowed; this function
 * only carries it out and translates a refusal into the right error. The admin
 * screen asks the same table which buttons to draw, so a button that appears
 * is a button that works, and one that does not appear is one the server would
 * have refused.
 *
 * **The guard conditions are repeated as SQL predicates.** The `UPDATE` carries
 * `status`, `version` and — where the actor is departmentally scoped — the
 * department, in its `WHERE`. The checks above it are not trusted to be the
 * only thing standing between two concurrent reviewers, because under
 * Passenger there are several workers and the newsroom has more than one
 * person in it. Zero affected rows means somebody else moved it first, and the
 * caller is told to reload rather than having their decision applied to a
 * state they never saw.
 *
 * **Every move writes one audit event, inside the same transaction.** A
 * publication that happened with no record of who approved it is the failure
 * this whole module exists to prevent, so the event cannot be a best-effort
 * write after the fact.
 */

/* -------------------------------------------------------------------------- */
/* What each move writes                                                      */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */

export interface TransitionResult {
  readonly status: ContentStatus;
  readonly version: number;
}

/**
 * The reviewer's note, trimmed and bounded.
 *
 * Required on the one transition that is a refusal, because "sent back" with
 * no words is a round trip the editor cannot act on. Bounded at 2000
 * characters so that a note pasted from a document cannot overflow the audit
 * summary it is quoted into.
 */
function cleanNote(code: ContentTransitionCode, raw: string | undefined): string | null {
  const note = (raw ?? "").trim();

  if (requiresNote(code)) {
    if (note.length === 0) {
      throw new ContentInvalidError({
        note: "Say what needs changing — the editor only sees this note.",
      });
    }
    if (note.length > 2000) {
      throw new ContentInvalidError({
        note: "Keep this under 2000 characters.",
      });
    }
    return note;
  }

  // Every other transition ignores whatever arrived in the field, rather than
  // storing a note against a move that is not a refusal.
  return null;
}

export async function transitionContentItem(
  actor: ActorContext,
  kind: ContentKind,
  id: number,
  expectedVersion: number,
  code: ContentTransitionCode,
  rawNote?: string,
): Promise<TransitionResult> {
  if (!actor.userId) {
    throw new ForbiddenError(null, "Your session has ended. Sign in again.");
  }

  const note = cleanNote(code, rawNote);
  const form = CONTENT_FORMS[kind];
  const now = new Date();

  return await transaction(async (tx) => {
    const existing = await tx
      .selectFrom("content_items")
      .select([
        "id",
        "content_type",
        "slug",
        "title_en",
        "status",
        "department_code",
        "published_at",
        "version",
      ])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();

    // Not found and not-this-type answer the same way as everywhere else in
    // the CMS: nothing that distinguishes a real item from an invented one.
    if (!existing || existing.content_type !== kind) {
      throw new ContentInvalidError({ form: "This item no longer exists." });
    }

    const decision = canTransitionContent(
      { status: existing.status, departmentCode: existing.department_code },
      code,
      { permissions: actor.permissions, departmentScopes: actor.departmentScopes },
    );

    if (decision.unknown) {
      // The item is not in a state this move leaves from — which, by the time
      // a form has been submitted, almost always means somebody else moved it.
      throw new ConcurrencyError("This item");
    }

    if (decision.missingPermission) {
      throw new ForbiddenError(
        decision.missingPermission,
        `This account cannot ${decision.transition?.label.toLowerCase() ?? "do that"}.`,
      );
    }

    if (!decision.allowed) {
      throw new ForbiddenError(null, decision.reasons.join(" "));
    }

    const transition = decision.transition;
    if (!transition) throw new ConcurrencyError("This item");

    const nextVersion = existing.version + 1;

    let update = tx
      .updateTable("content_items")
      .set({
        status: transition.to,
        version: nextVersion,
        updated_at: now,

        // Stamped on the first publish and never again. Republishing a
        // correction must not re-date the item: the newsroom orders by this
        // column, so a typo fixed in March would otherwise jump a January
        // press release to the top of the page.
        published_at:
          transition.to === "published" ? (existing.published_at ?? now) : undefined,
        published_by: transition.to === "published" ? actor.userId : undefined,

        // A publish out of review and a send-back are both acts of review, and
        // both are what `last_reviewed_*` records. A publish straight from
        // draft is not, and leaves the columns alone rather than claiming a
        // review that did not happen.
        last_reviewed_by:
          transition.from === "in_review" ? actor.userId : undefined,
        last_reviewed_at: transition.from === "in_review" ? now : undefined,

        // The note is the reviewer's current objection. Submitting again
        // clears it, because it described a version that has since been
        // revised; publishing clears it for the same reason.
        review_note:
          code === "return_to_draft"
            ? note
            : code === "submit_review" || transition.to === "published"
              ? null
              : undefined,
        review_note_by:
          code === "return_to_draft"
            ? actor.userId
            : code === "submit_review" || transition.to === "published"
              ? null
              : undefined,
        review_note_at:
          code === "return_to_draft"
            ? now
            : code === "submit_review" || transition.to === "published"
              ? null
              : undefined,
      })
      .where("id", "=", id)
      .where("version", "=", expectedVersion)
      // The state the decision was made against, repeated as a predicate.
      //
      // Redundant today and kept deliberately: every status change in this
      // module bumps `version`, so the version clause above already decides
      // the race between two reviewers and this one can never be the clause
      // that refuses. Removing it and rerunning the suite proves exactly that
      // — 14 of 14 still pass. It stays because the day some other writer
      // changes a status without bumping the version, this is the difference
      // between a stale decision being rejected and being applied.
      .where("status", "=", transition.from);

    // Defence in depth, exactly as in `updateContentItem`: a scoped actor's
    // write carries the scope, so a bug in the guard cannot become a
    // cross-department publication.
    //
    // No test can reach this clause through the public function, because the
    // guard above it reads the same field and refuses first — so it was
    // verified by temporarily making `departmentInScope` return true and
    // confirming the move was still refused, by this statement, as a
    // concurrency failure. If you change either layer, that is the check to
    // repeat; a passing suite will not tell you this clause has stopped
    // working.
    if (actor.departmentScopes.length > 0) {
      update = update.where("department_code", "in", actor.departmentScopes);
    }

    const result = await update.executeTakeFirst();
    if (result.numUpdatedRows === 0n) throw new ConcurrencyError("This item");

    const singular = form.singular.toLowerCase();
    const title = existing.title_en.length > 60
      ? `${existing.title_en.slice(0, 57)}…`
      : existing.title_en;

    await writeAudit(
      actor,
      {
        entityType: "content",
        entityId: id,
        action: auditAction(code),
        summary: summaryFor(code, singular, title),
        before: { status: transition.from },
        after: { status: transition.to },
        context: {
          contentType: kind,
          departmentCode: existing.department_code,
          slug: existing.slug,
          from: transition.from,
          to: transition.to,
          /**
           * Whether this publication was ever read by somebody other than
           * whoever wrote it.
           *
           * The single most audit-relevant fact about a content publication,
           * and not recoverable afterwards: the row only knows it is
           * published, not which edge it came along.
           */
          skippedReview: transition.to === "published" && transition.from === "draft",
          note,
        },
      },
      tx,
    );

    return { status: transition.to, version: nextVersion };
  });
}

function auditAction(code: ContentTransitionCode): string {
  switch (code) {
    case "submit_review":
      return "content.submitted_for_review";
    case "return_to_draft":
      return "content.returned_to_draft";
    case "publish":
      return "content.published";
    case "unpublish":
      return "content.unpublished";
    case "archive":
      return "content.archived";
    case "restore":
      return "content.restored";
  }
}

function summaryFor(
  code: ContentTransitionCode,
  singular: string,
  title: string,
): string {
  switch (code) {
    case "submit_review":
      return `Submitted ${singular} "${title}" for review`;
    case "return_to_draft":
      return `Sent ${singular} "${title}" back to its author`;
    case "publish":
      return `Published ${singular} "${title}"`;
    case "unpublish":
      return `Took ${singular} "${title}" off the site`;
    case "archive":
      return `Archived ${singular} "${title}"`;
    case "restore":
      return `Restored ${singular} "${title}" to draft`;
  }
}
