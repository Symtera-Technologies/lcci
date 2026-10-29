import "server-only";

import { getDb, sql } from "@/db/client";
import { CONTENT_FORMS, allFields, localFromInstant } from "@/content/fields";
import type { ContentKind, ContentStatus } from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { requirePermission } from "@/server/actor";

/**
 * Reading content that is not published.
 *
 * Preview is a **separate permissioned path**, not a query parameter on the
 * public read. That distinction is the whole point. A `?preview=1` that the
 * repository honours is a secret anybody can guess, it leaks the existence of
 * every draft slug, and the moment it exists somebody shares a preview link
 * with an external contributor and it becomes the chamber's accidental
 * publishing channel. So drafts live behind a function that cannot be reached
 * without an actor.
 *
 * **Why this is a module of its own and not an option on `repository.ts`.**
 * Every public page imports the repository; it is in the homepage's dependency
 * graph. Putting authorisation behind that seam would drag the auth DAL, the
 * permission vocabulary and `server-only` into a module whose whole purpose is
 * to be swappable and actor-free — which is the same reason the plan keeps
 * membership out from behind it. The plan sketches this as
 * `getPressRelease(slug, { preview: true })`; the actor has to come from
 * somewhere, and an explicit first argument is the project's established shape
 * for every function that authorises. Nothing about the intent changes.
 *
 * **Department scoping is a `WHERE`, never a `.filter()`.** A post-fetch
 * filter has already read the row, and will leak it through a count, an
 * export, an error message or a log line. The predicate is built here and the
 * database never returns what the actor may not see.
 */

/** What the editor's preview screen needs: the item, and why it is not public. */
export interface PreviewItem {
  readonly id: number;
  readonly contentType: ContentKind;
  readonly slug: string;
  readonly titleEn: string;
  readonly titleUr: string | null;
  readonly status: ContentStatus;
  /** NULL until first published; a future date is a scheduled publish. */
  readonly publishedAt: Date | null;
  readonly scheduledUnpublishAt: Date | null;
  readonly updatedAt: Date;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly reviewBy: string | null;
  readonly version: number;
  /**
   * Whether a visitor would see this right now.
   *
   * Computed from the same three conditions `liveItems` applies, so a preview
   * screen can say "this is live" or "this publishes on Friday" without
   * reimplementing the predicate and drifting from it.
   */
  readonly isLive: boolean;
  /**
   * The type's own visibility window, where it has one.
   *
   * `isLive` is the parent predicate — status, publication date, scheduled
   * unpublish — and for two types that is not the whole story. A notice is
   * shown between its `starts_at` and `ends_at`, and an event drops off the
   * upcoming list once its date passes; both stay `published` throughout. A
   * list that cannot tell an expired notice from the live one is the defect
   * the old site had, where a notice stayed up for months because nothing on
   * any screen said it had finished.
   *
   * Populated for notices and events, absent for everything else.
   */
  readonly typeWindow?: { readonly startsAt: Date | null; readonly endsAt: Date | null };
}

/**
 * Is this actor's draft access limited to particular departments?
 *
 * Empty scopes mean unscoped — the whole chamber — which is correct for
 * `super_admin` and `reviewer`, who are granted globally. It is **not** a
 * fallback for "no access": that is decided by `content.read_draft`, which
 * `requirePermission` checks first. An actor without the permission never
 * reaches this function, and an actor with it and no departmental grant holds
 * it site-wide, which is what `scope_kind = 'global'` means in `user_roles`.
 */
function scopedDepartments(actor: ActorContext): readonly string[] | null {
  return actor.departmentScopes.length > 0 ? actor.departmentScopes : null;
}

/**
 * A `LIKE` pattern from what somebody typed.
 *
 * `%` and `_` are wildcards, so an editor searching for "100%" or "form_c"
 * would get matches they never asked for. Escaped rather than stripped,
 * because both characters do appear in titles. The backslash goes first, or it
 * would escape the escapes added after it.
 */
function likeContains(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (character) => "\\" + character);
  return `%${escaped}%`;
}

/**
 * One content item by type and slug, whatever its status.
 *
 * Returns null for "not found" and for "not yours" alike. 403-on-real and
 * 404-on-fake is an existence oracle — it would let a department editor
 * enumerate another department's unpublished slugs one guess at a time, which
 * on a chamber's embargoed press releases is exactly the thing worth
 * protecting.
 */
export async function previewItem(
  actor: ActorContext,
  contentType: ContentKind,
  slug: string,
): Promise<PreviewItem | null> {
  requirePermission(actor, "content.read_draft");

  const scopes = scopedDepartments(actor);

  let query = getDb()
    .selectFrom("content_items as ci")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    // Left, not inner: a note outlives the account that left it, because the
    // FK is ON DELETE SET NULL. An inner join here would make the note vanish
    // along with the reviewer, which is the one moment it matters most.
    .leftJoin("users as rn", "rn.id", "ci.review_note_by")
    .select([
      "ci.id",
      "ci.content_type",
      "ci.slug",
      "ci.title_en",
      "ci.title_ur",
      "ci.status",
      "ci.published_at",
      "ci.scheduled_unpublish_at",
      "ci.updated_at",
      "ci.department_code",
      "ci.review_by",
      "ci.version",
      "d.name_en as department_name",
    ])
    .where("ci.content_type", "=", contentType)
    .where("ci.slug", "=", slug);

  if (scopes) query = query.where("ci.department_code", "in", scopes);

  const row = await query.executeTakeFirst();
  if (!row) return null;

  const now = new Date();
  const isLive =
    row.status === "published" &&
    row.published_at !== null &&
    row.published_at <= now &&
    (row.scheduled_unpublish_at === null || row.scheduled_unpublish_at > now);

  return {
    id: row.id,
    contentType: row.content_type,
    slug: row.slug,
    titleEn: row.title_en,
    titleUr: row.title_ur,
    status: row.status,
    publishedAt: row.published_at,
    scheduledUnpublishAt: row.scheduled_unpublish_at,
    updatedAt: row.updated_at,
    departmentCode: row.department_code,
    departmentName: row.department_name,
    reviewBy: row.review_by,
    version: row.version,
    isLive,
  };
}

/**
 * Every item of a type the actor may see, newest first, published or not.
 *
 * The admin list's query. Ordered by `updated_at` rather than `published_at`,
 * because a queue of drafts has no publication dates to sort by and the thing
 * an editor is looking for is what was touched last.
 */
export async function previewList(
  actor: ActorContext,
  contentType: ContentKind,
  options: {
    readonly status?: ContentStatus;
    readonly limit?: number;
    readonly offset?: number;
    /** Matches the English title. Not the body: there is no index for that. */
    readonly search?: string;
  } = {},
): Promise<PreviewItem[]> {
  requirePermission(actor, "content.read_draft");

  const scopes = scopedDepartments(actor);

  let query = getDb()
    .selectFrom("content_items as ci")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    // Left, not inner: a note outlives the account that left it, because the
    // FK is ON DELETE SET NULL. An inner join here would make the note vanish
    // along with the reviewer, which is the one moment it matters most.
    .leftJoin("users as rn", "rn.id", "ci.review_note_by")
    .select([
      "ci.id",
      "ci.content_type",
      "ci.slug",
      "ci.title_en",
      "ci.title_ur",
      "ci.status",
      "ci.published_at",
      "ci.scheduled_unpublish_at",
      "ci.updated_at",
      "ci.department_code",
      "ci.review_by",
      "ci.version",
      "d.name_en as department_name",
    ])
    .where("ci.content_type", "=", contentType)
    .orderBy("ci.updated_at", "desc")
    .limit(options.limit ?? 50)
    .offset(options.offset ?? 0);

  if (scopes) query = query.where("ci.department_code", "in", scopes);
  if (options.status) query = query.where("ci.status", "=", options.status);
  if (options.search) query = query.where("ci.title_en", "like", likeContains(options.search));

  const rows = await query.execute();
  const now = new Date();
  const windows = await typeWindows(contentType, rows.map((row) => row.id));

  return rows.map((row) => ({
    id: row.id,
    contentType: row.content_type,
    slug: row.slug,
    titleEn: row.title_en,
    titleUr: row.title_ur,
    status: row.status,
    publishedAt: row.published_at,
    scheduledUnpublishAt: row.scheduled_unpublish_at,
    updatedAt: row.updated_at,
    departmentCode: row.department_code,
    departmentName: row.department_name,
    reviewBy: row.review_by,
    version: row.version,
    isLive:
      row.status === "published" &&
      row.published_at !== null &&
      row.published_at <= now &&
      (row.scheduled_unpublish_at === null || row.scheduled_unpublish_at > now),
    ...(windows.has(row.id) ? { typeWindow: windows.get(row.id) } : {}),
  }));
}

/**
 * The satellite windows for the two types that have one.
 *
 * A second query rather than a join, because the join would differ per type
 * and Kysely cannot type a conditional one — and because for ten of the twelve
 * types there is nothing to fetch, so the common case costs a single `if`.
 *
 * Only notices and events. Their satellites carry dates that decide whether a
 * visitor sees the row while the status stays `published` throughout: a notice
 * runs between `starts_at` and `ends_at`, and an event leaves the upcoming
 * list once its date passes. Every other type is governed by the parent
 * predicate alone.
 */
async function typeWindows(
  contentType: ContentKind,
  ids: readonly number[],
): Promise<Map<number, { startsAt: Date | null; endsAt: Date | null }>> {
  const windows = new Map<number, { startsAt: Date | null; endsAt: Date | null }>();
  if (ids.length === 0) return windows;

  if (contentType === "notice") {
    const rows = await getDb()
      .selectFrom("content_notices")
      .select(["content_item_id", "starts_at", "ends_at"])
      .where("content_item_id", "in", ids)
      .execute();

    for (const row of rows) {
      windows.set(row.content_item_id, { startsAt: row.starts_at, endsAt: row.ends_at });
    }
    return windows;
  }

  if (contentType === "event") {
    const rows = await getDb()
      .selectFrom("content_events")
      .select(["content_item_id", "starts_at"])
      .where("content_item_id", "in", ids)
      .execute();

    for (const row of rows) {
      // No end: an event's own `ends_at` is when the session finishes, not
      // when the page stops being listed. `starts_at` is the date the
      // upcoming list compares against.
      windows.set(row.content_item_id, { startsAt: row.starts_at, endsAt: null });
    }
  }

  return windows;
}

/**
 * The departments an actor may file content under.
 *
 * The admin's department picker reads this rather than the whole table, so an
 * editor scoped to `info` cannot create a row owned by `research` and then
 * find they can no longer open it. Unscoped actors get every active
 * department.
 */
export async function editableDepartments(
  actor: ActorContext,
): Promise<{ code: string; nameEn: string }[]> {
  requirePermission(actor, "content.read_draft");

  const scopes = scopedDepartments(actor);

  let query = getDb()
    .selectFrom("departments")
    .select(["code", "name_en"])
    .where("active", "=", 1)
    .orderBy("sort_order");

  if (scopes) query = query.where("code", "in", scopes);

  const rows = await query.execute();
  return rows.map((row) => ({ code: row.code, nameEn: row.name_en }));
}

/* -------------------------------------------------------------------------- */
/* Counts                                                                     */
/* -------------------------------------------------------------------------- */

export type StatusCounts = Readonly<Record<ContentStatus, number>> & { readonly total: number };

/**
 * How many items of each type and status this actor can see.
 *
 * One grouped query rather than twelve counts, and it carries the same
 * department predicate as the lists — so the number on the hub is the number
 * of rows the editor will find when they open it. A count that includes rows
 * the list then hides is the kind of discrepancy people report as data loss.
 */
export async function contentCounts(
  actor: ActorContext,
): Promise<Record<ContentKind, StatusCounts>> {
  requirePermission(actor, "content.read_draft");

  const scopes = scopedDepartments(actor);

  let query = getDb()
    .selectFrom("content_items")
    .select(({ fn }) => ["content_type", "status", fn.countAll<number>().as("n")])
    .groupBy(["content_type", "status"]);

  if (scopes) query = query.where("department_code", "in", scopes);

  const rows = await query.execute();
  const counts = {} as Record<ContentKind, StatusCounts>;

  for (const row of rows) {
    const existing: StatusCounts =
      counts[row.content_type] ??
      { draft: 0, in_review: 0, published: 0, archived: 0, total: 0 };

    counts[row.content_type] = {
      ...existing,
      [row.status]: Number(row.n),
      total: existing.total + Number(row.n),
    } as StatusCounts;
  }

  return counts;
}

/** How many items match a list view, for its pager. */
export async function countForList(
  actor: ActorContext,
  contentType: ContentKind,
  options: { readonly status?: ContentStatus; readonly search?: string } = {},
): Promise<number> {
  requirePermission(actor, "content.read_draft");

  const scopes = scopedDepartments(actor);

  let query = getDb()
    .selectFrom("content_items")
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .where("content_type", "=", contentType);

  if (scopes) query = query.where("department_code", "in", scopes);
  if (options.status) query = query.where("status", "=", options.status);
  if (options.search) query = query.where("title_en", "like", likeContains(options.search));

  const row = await query.executeTakeFirst();
  return Number(row?.n ?? 0);
}

/* -------------------------------------------------------------------------- */
/* For the editor                                                             */
/* -------------------------------------------------------------------------- */

/** An item, its satellite values in form shape, and its topic tags. */
/**
 * The reviewer's standing objection, where there is one.
 *
 * Only ever the current note. The audit log holds every note ever left, and
 * showing a history of superseded objections on the editing screen would bury
 * the one the editor has to act on.
 */
export interface ReviewNote {
  readonly note: string;
  /** Null when the reviewer's account has since been removed. */
  readonly byName: string | null;
  readonly at: Date;
}

export interface EditorItem {
  readonly item: PreviewItem;
  /**
   * Keyed by field name, in the shape the controls want: strings for text and
   * numbers, booleans for checkboxes, `datetime-local` strings for instants.
   *
   * Converted here rather than in the page, because the conversion depends on
   * the field's kind and the kinds are known here. A `DATETIME` rendered
   * straight into a `datetime-local` control shows the UTC instant, which
   * silently moves every event five hours earlier the first time somebody
   * saves without touching it.
   */
  readonly values: Record<string, string | boolean>;
  readonly topics: readonly string[];
  readonly review: ReviewNote | null;
}

export async function loadForEditing(
  actor: ActorContext,
  contentType: ContentKind,
  id: number,
): Promise<EditorItem | null> {
  requirePermission(actor, "content.read_draft");

  const scopes = scopedDepartments(actor);

  let parentQuery = getDb()
    .selectFrom("content_items as ci")
    .innerJoin("departments as d", "d.code", "ci.department_code")
    // Left, not inner: a note outlives the account that left it, because the
    // FK is ON DELETE SET NULL. An inner join here would make the note vanish
    // along with the reviewer, which is the one moment it matters most.
    .leftJoin("users as rn", "rn.id", "ci.review_note_by")
    .select([
      "ci.id",
      "ci.content_type",
      "ci.slug",
      "ci.title_en",
      "ci.title_ur",
      "ci.status",
      "ci.published_at",
      "ci.scheduled_unpublish_at",
      "ci.updated_at",
      "ci.department_code",
      "ci.review_by",
      "ci.version",
      "ci.seo_title",
      "ci.seo_description",
      "ci.og_image_id",
      "ci.sort_order",
      "ci.review_note",
      "ci.review_note_at",
      "d.name_en as department_name",
      "rn.full_name as review_note_by_name",
    ])
    .where("ci.id", "=", id)
    .where("ci.content_type", "=", contentType);

  if (scopes) parentQuery = parentQuery.where("ci.department_code", "in", scopes);

  const parent = await parentQuery.executeTakeFirst();
  // Null for "not found" and for "not yours" alike, the same as `previewItem`:
  // a 403 on a real id and a 404 on a made-up one is an existence oracle, and
  // an embargoed press release's existence is the thing worth protecting.
  if (!parent) return null;

  const satelliteResult = await sql<Record<string, unknown>>`
    select * from ${sql.table(CONTENT_FORMS[contentType].table)}
    where content_item_id = ${id}
  `.execute(getDb());
  const satellite = satelliteResult.rows[0] ?? {};

  const topics = CONTENT_FORMS[contentType].hasTopics
    ? (
        await getDb()
          .selectFrom("content_item_topics")
          .select("topic_slug")
          .where("content_item_id", "=", id)
          .execute()
      ).map((row) => row.topic_slug)
    : [];

  const source: Record<string, unknown> = { ...satellite, ...parent };
  const values: Record<string, string | boolean> = {};

  for (const field of allFields(contentType)) {
    const raw = source[field.name] ?? null;

    switch (field.kind) {
      case "checkbox":
        values[field.name] = raw === 1 || raw === true;
        break;
      case "datetime":
        values[field.name] = raw instanceof Date ? localFromInstant(raw) : "";
        break;
      default:
        values[field.name] = raw === null || raw === undefined ? "" : String(raw);
    }
  }

  const now = new Date();

  return {
    item: {
      id: parent.id,
      contentType: parent.content_type,
      slug: parent.slug,
      titleEn: parent.title_en,
      titleUr: parent.title_ur,
      status: parent.status,
      publishedAt: parent.published_at,
      scheduledUnpublishAt: parent.scheduled_unpublish_at,
      updatedAt: parent.updated_at,
      departmentCode: parent.department_code,
      departmentName: parent.department_name,
      reviewBy: parent.review_by,
      version: parent.version,
      isLive:
        parent.status === "published" &&
        parent.published_at !== null &&
        parent.published_at <= now &&
        (parent.scheduled_unpublish_at === null || parent.scheduled_unpublish_at > now),
    },
    values,
    topics,
    review:
      parent.review_note !== null && parent.review_note_at !== null
        ? {
            note: parent.review_note,
            byName: parent.review_note_by_name,
            at: parent.review_note_at,
          }
        : null,
  };
}

/**
 * The topic vocabulary, from the table rather than the UI constant.
 *
 * `TOPIC_LABELS` in `src/components/ui/tag.tsx` is the public site's English
 * labels; `content_topics` is the vocabulary the foreign key enforces and the
 * place an Urdu label will live. The editor reads the table, so it can never
 * offer a tag the database would refuse.
 */
export async function listTopics(): Promise<{ slug: string; label: string }[]> {
  const rows = await getDb()
    .selectFrom("content_topics")
    .select(["slug", "label_en"])
    .orderBy("sort_order")
    .execute();

  return rows.map((row) => ({ slug: row.slug, label: row.label_en }));
}
