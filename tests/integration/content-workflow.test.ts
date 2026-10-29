import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { newUlid } from "@/server/crypto";
import { ConcurrencyError, ForbiddenError, type ActorContext } from "@/server/actor";
import type { PermissionCode } from "@/server/permissions";
import { permissionsForRole } from "@/server/permissions";
import { ContentInvalidError, createContentItem } from "@/content/admin";
import { transitionContentItem } from "@/content/transitions";
import { loadForEditing } from "@/content/preview";
import { createUser, databaseAvailable, resetTables, skipReason, teardown } from "./helpers";

/**
 * Moving content between statuses, against a real database.
 *
 * `tests/content-workflow.test.ts` already pins *whether* a move is allowed —
 * that is a pure table and needs no server. What can only be tested here is
 * what the move actually writes: the version and status predicates that decide
 * a race, the publication date that must be stamped once and never again, the
 * review note's lifecycle, and the audit event that has to be in the same
 * transaction as the status change.
 *
 * `audit_log` is deliberately not reset between tests, for the same reason as
 * in `content-admin.test.ts`: it is hash-chained, and deleting rows would
 * leave the chain head pointing at a hash that no longer exists.
 */

const available = await databaseAvailable();
if (!available) {
  console.warn(`[integration] skipping content workflow tests: ${await skipReason()}`);
}

if (available) await runMigrations("integration-test");

afterAll(async () => {
  await teardown();
});

const TABLES = [
  "content_item_topics",
  "content_press_releases",
  "content_items",
];

let editorId = 0;
let reviewerId = 0;

beforeEach(async () => {
  if (!available) return;
  await resetTables(TABLES);
  // Real rows, because `published_by` and `review_note_by` are foreign keys —
  // a fabricated id would make every write in this file fail for a reason
  // that has nothing to do with the workflow.
  editorId = await createUser(`editor-${newUlid()}@lcci.test`, "staff", "E. Editor");
  reviewerId = await createUser(`reviewer-${newUlid()}@lcci.test`, "staff", "R. Reviewer");
});

function actor(
  userId: number,
  permissions: readonly PermissionCode[],
  departmentScopes: readonly string[] = [],
): ActorContext {
  return {
    userId,
    userType: "staff",
    roleCode: "content_editor",
    roleCodes: ["content_editor"],
    permissions: new Set(permissions),
    departmentScopes,
    requestId: newUlid(),
    ipHash: null,
    userAgentHash: null,
    onBehalfOfUserId: null,
  };
}

function editor(scopes: readonly string[] = ["info"]): ActorContext {
  return actor(editorId, permissionsForRole("department_editor"), scopes);
}

function reviewer(): ActorContext {
  return actor(reviewerId, permissionsForRole("reviewer"));
}

function admin(): ActorContext {
  return actor(reviewerId, permissionsForRole("super_admin"));
}

async function aDraft(slug = "chamber-welcomes-tariff-review"): Promise<number> {
  const saved = await createContentItem(editor(), "press_release", {
    slug,
    title_en: "Chamber welcomes tariff review",
    department_code: "info",
    summary: "The chamber welcomed the review announced on Tuesday.",
  });
  return saved.id;
}

async function row(id: number) {
  const found = await getDb()
    .selectFrom("content_items")
    .select([
      "status",
      "version",
      "published_at",
      "published_by",
      "last_reviewed_by",
      "last_reviewed_at",
      "review_note",
      "review_note_by",
      "review_note_at",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!found) throw new Error(`no content item ${id}`);
  return found;
}

async function latestEvent(id: number) {
  const found = await getDb()
    .selectFrom("audit_log")
    .select(["action", "summary", "before_json", "after_json", "context_json"])
    .where("entity_type", "=", "content")
    .where("entity_id", "=", String(id))
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (!found) throw new Error(`no audit event for ${id}`);
  return found;
}

describe.skipIf(!available)("submitting for review", () => {
  it("moves a draft and bumps the version", async () => {
    const id = await aDraft();
    const before = await row(id);

    const result = await transitionContentItem(
      editor(), "press_release", id, before.version, "submit_review",
    );

    expect(result.status).toBe("in_review");
    const after = await row(id);
    expect(after.status).toBe("in_review");
    expect(after.version).toBe(before.version + 1);
    // Nothing about review has happened yet; claiming otherwise would make the
    // stale-content report count a submission as a review.
    expect(after.last_reviewed_at).toBeNull();
  });

  it("writes one audit event naming where it came from and went", async () => {
    const id = await aDraft();
    await transitionContentItem(
      editor(), "press_release", id, (await row(id)).version, "submit_review",
    );

    const event = await latestEvent(id);
    expect(event.action).toBe("content.submitted_for_review");
    expect(event.before_json).toMatchObject({ status: "draft" });
    expect(event.after_json).toMatchObject({ status: "in_review" });
    expect(event.summary).toMatch(/Submitted press release/i);
  });

  it("refuses a stale version rather than applying the move anyway", async () => {
    const id = await aDraft();
    const version = (await row(id)).version;

    await transitionContentItem(editor(), "press_release", id, version, "submit_review");
    await transitionContentItem(reviewer(), "press_release", id, version + 1, "return_to_draft", "Fix the date.");

    // The editor's screen was rendered before either of those happened.
    await expect(
      transitionContentItem(editor(), "press_release", id, version, "submit_review"),
    ).rejects.toBeInstanceOf(ConcurrencyError);
  });
});

describe.skipIf(!available)("sending back", () => {
  it("stores the note, its author and the moment", async () => {
    const id = await aDraft();
    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");

    await transitionContentItem(
      reviewer(), "press_release", id, (await row(id)).version, "return_to_draft",
      "  The tariff figure is wrong in paragraph two.  ",
    );

    const after = await row(id);
    expect(after.status).toBe("draft");
    expect(after.review_note).toBe("The tariff figure is wrong in paragraph two.");
    expect(after.review_note_by).toBe(reviewerId);
    expect(after.review_note_at).toBeInstanceOf(Date);
    // Sending back is an act of review, and is recorded as one.
    expect(after.last_reviewed_by).toBe(reviewerId);
  });

  it("refuses an empty note rather than sending back in silence", async () => {
    const id = await aDraft();
    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");
    const version = (await row(id)).version;

    await expect(
      transitionContentItem(reviewer(), "press_release", id, version, "return_to_draft", "   "),
    ).rejects.toBeInstanceOf(ContentInvalidError);

    // And nothing moved.
    expect((await row(id)).status).toBe("in_review");
  });

  it("clears the note when the editor submits again", async () => {
    const id = await aDraft();
    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");
    await transitionContentItem(
      reviewer(), "press_release", id, (await row(id)).version, "return_to_draft", "Fix paragraph two.",
    );

    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");

    const after = await row(id);
    expect(after.review_note).toBeNull();
    expect(after.review_note_by).toBeNull();
    expect(after.review_note_at).toBeNull();
  });

  it("reaches the editing screen so the author can read it", async () => {
    const id = await aDraft();
    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");
    await transitionContentItem(
      reviewer(), "press_release", id, (await row(id)).version, "return_to_draft", "Fix paragraph two.",
    );

    const loaded = await loadForEditing(editor(), "press_release", id);
    expect(loaded?.review?.note).toBe("Fix paragraph two.");
    expect(loaded?.review?.byName).toBe("R. Reviewer");
  });
});

describe.skipIf(!available)("publishing", () => {
  it("stamps the publication date and who approved it", async () => {
    const id = await aDraft();
    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");

    await transitionContentItem(reviewer(), "press_release", id, (await row(id)).version, "publish");

    const after = await row(id);
    expect(after.status).toBe("published");
    expect(after.published_at).toBeInstanceOf(Date);
    expect(after.published_by).toBe(reviewerId);
    expect(after.last_reviewed_by).toBe(reviewerId);
  });

  /**
   * The one that would reorder the newsroom. A correction published in March
   * must not re-date a January release to the top of the list.
   */
  it("keeps the original publication date when something is republished", async () => {
    const id = await aDraft();
    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");
    await transitionContentItem(reviewer(), "press_release", id, (await row(id)).version, "publish");
    const first = (await row(id)).published_at;

    await transitionContentItem(reviewer(), "press_release", id, (await row(id)).version, "unpublish");
    await transitionContentItem(reviewer(), "press_release", id, (await row(id)).version, "publish");

    expect((await row(id)).published_at).toEqual(first);
  });

  it("records whether anybody other than the author read it first", async () => {
    const reviewed = await aDraft("reviewed-release");
    await transitionContentItem(editor(), "press_release", reviewed, (await row(reviewed)).version, "submit_review");
    await transitionContentItem(reviewer(), "press_release", reviewed, (await row(reviewed)).version, "publish");
    expect((await latestEvent(reviewed)).context_json).toMatchObject({ skippedReview: false });

    const direct = await aDraft("direct-release");
    await transitionContentItem(admin(), "press_release", direct, (await row(direct)).version, "publish");
    expect((await latestEvent(direct)).context_json).toMatchObject({ skippedReview: true });
  });

  it("leaves the review columns alone when a draft is published directly", async () => {
    const id = await aDraft();
    await transitionContentItem(admin(), "press_release", id, (await row(id)).version, "publish");

    const after = await row(id);
    expect(after.status).toBe("published");
    // Publishing one's own draft is not a review, and must not be recorded as
    // one — the stale-content report reads these columns.
    expect(after.last_reviewed_by).toBeNull();
    expect(after.last_reviewed_at).toBeNull();
  });

  it("refuses an editor who holds no publish grant", async () => {
    const id = await aDraft();
    const version = (await row(id)).version;

    await expect(
      transitionContentItem(editor(), "press_release", id, version, "publish"),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect((await row(id)).status).toBe("draft");
  });
});

describe.skipIf(!available)("department scope", () => {
  it("refuses a move on another department's item", async () => {
    const id = await aDraft();
    const version = (await row(id)).version;

    // Scoped to research; the item belongs to info.
    await expect(
      transitionContentItem(editor(["research"]), "press_release", id, version, "submit_review"),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect((await row(id)).status).toBe("draft");
  });

});

describe.skipIf(!available)("races", () => {
  /**
   * Two reviewers with the same submission open. Exactly one may win, and the
   * loser must be told to reload rather than having their decision applied to
   * a state they never saw.
   */
  it("lets only one of two concurrent decisions land", async () => {
    const id = await aDraft();
    await transitionContentItem(editor(), "press_release", id, (await row(id)).version, "submit_review");
    const version = (await row(id)).version;

    const outcomes = await Promise.allSettled([
      transitionContentItem(reviewer(), "press_release", id, version, "publish"),
      transitionContentItem(reviewer(), "press_release", id, version, "return_to_draft", "Not yet."),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const loser = outcomes.find((o) => o.status === "rejected");
    expect(loser?.reason).toBeInstanceOf(ConcurrencyError);
  });
});
