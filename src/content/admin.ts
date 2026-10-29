import "server-only";

import { getDb, sql, transaction } from "@/db/client";
import type { Queryable, Tx } from "@/db/client";
import type { ContentKind } from "@/db/schema";
import type { ActorContext } from "@/server/actor";
import { ConcurrencyError, ForbiddenError, requirePermission } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { sha256Hex } from "@/server/crypto";
import { CONTENT_FORMS, allFields, contentFormSchema, instantFromLocal } from "@/content/fields";
import type { FieldSpec } from "@/content/fields";
import { sanitiseBody } from "@/content/sanitise";

/**
 * Writing content.
 *
 * The one place anything in the CMS changes a row. Three properties hold it
 * together, and each of them is a decision rather than a style:
 *
 * **Column names come only from the field specs.** The satellite tables differ
 * twelve ways, so the `INSERT` and `UPDATE` statements here are assembled at
 * run time — and the names in them are taken from `CONTENT_FORMS`, which is
 * TypeScript, never from the submitted keys. An unknown key in the form data
 * is dropped, not written. That is what keeps dynamic SQL from being an
 * injection: the identifiers are a closed set decided at compile time and the
 * values are always parameters.
 *
 * **Every update is guarded on `version`.** `UPDATE … WHERE id = ? AND
 * version = ?`, and zero affected rows means another editor saved while this
 * one had the form open. The caller gets `ConcurrencyError` and the screen
 * says so, because the alternative — last write wins — silently discards
 * somebody's work, and under Passenger there are several workers and more than
 * one person in the newsroom.
 *
 * **Department scope is checked before the write and again as a predicate.**
 * An actor scoped to `info` cannot create a row owned by `research`, and
 * cannot edit one either. The `UPDATE` carries the scope in its `WHERE` rather
 * than relying on the check above it, so a bug in the check cannot become a
 * cross-department write.
 *
 * **What this module deliberately does not do.** It does not move anything
 * between statuses. A new row lands at the schema's `draft` default and stays
 * there until B3's workflow — which owns Draft → In review → Published,
 * `published_at`, `published_by` and the review permissions — moves it. So
 * `saveContentItem` on a published row edits published copy in place with no
 * review step; that is the gap B3 closes, and it is recorded here rather than
 * left to be discovered.
 *
 * It also keeps no version history of bodies. The audit log records *that* a
 * body changed, with its length and digest, not its successive texts — see
 * `digestOf` for why. Recovering an earlier draft is not a capability this
 * system has, and nobody has asked for one.
 */

/* -------------------------------------------------------------------------- */
/* Failure as a value                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Raised when the submitted content cannot be saved as given.
 *
 * Carries per-field messages, in the same shape `withAction` puts into
 * `ActionState.fieldErrors`, so an editor is told which control is wrong
 * rather than being handed "could not save".
 */
export class ContentInvalidError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(fieldErrors: Record<string, string>, message = "Please check the highlighted fields.") {
    super(message);
    this.name = "ContentInvalidError";
    this.fieldErrors = fieldErrors;
  }
}

export interface SavedContentItem {
  readonly id: number;
  readonly slug: string;
  readonly version: number;
}

/* -------------------------------------------------------------------------- */
/* Value coercion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One validated field value, as the column wants it.
 *
 * The schema has already decided the value is acceptable; this decides how it
 * is stored. The cases that matter:
 *
 * - **richtext** goes through the sanitiser *here*, on the write path, so
 *   there is no route to the column that bypasses it.
 * - **datetime** arrives as `2026-11-06T10:00` from a `datetime-local`
 *   control and is read as Pakistani time, because that is what the person
 *   typing it meant.
 * - **checkbox** becomes 1 or 0: mysql2 hands `TINYINT(1)` back as a number,
 *   and writing `true` would store 1 while reading back `1` — the asymmetry
 *   that makes a `=== true` comparison somewhere else quietly false.
 * - **empty string becomes NULL**, so a cleared optional field is absent
 *   rather than present-and-blank. `COALESCE`, `IS NULL` and the public
 *   renderers all then agree about what "no value" is.
 */
function dbValue(field: FieldSpec, value: unknown): unknown {
  switch (field.kind) {
    case "richtext":
      return sanitiseBody(typeof value === "string" ? value : null);

    case "checkbox":
      return value === true ? 1 : 0;

    case "datetime":
      return typeof value === "string" ? instantFromLocal(value) : null;

    case "integer":
    case "decimal":
    case "media":
      return typeof value === "number" ? value : null;

    case "date":
    case "text":
    case "slug":
    case "textarea":
    case "url":
    case "select":
    case "department": {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    }
  }
}

/**
 * What a rich-text body contributes to the audit log.
 *
 * A press release body is tens of kilobytes. Writing it twice — `before` and
 * `after` — on every save would make the audit log mostly editorial copy, on a
 * table whose rows are never deleted and whose point is to be cheap enough to
 * write on every action. The digest answers the question an auditor actually
 * asks of this table ("did the text change, when, and by whom") at forty
 * bytes, and the current text is in `content_press_releases` where it belongs.
 *
 * `chars` is there because it is the one thing a digest cannot tell you: a
 * body that went from 4,000 characters to 12 is a deletion, and that reads at
 * a glance in a log line.
 */
function digestOf(value: unknown): { chars: number; sha256: string } | null {
  if (typeof value !== "string" || value === "") return null;
  return { chars: value.length, sha256: sha256Hex(value).slice(0, 16) };
}

/**
 * What goes into an audit event for one field.
 *
 * Both sides of the diff pass through here, which is the point: the stored
 * value of a `DATETIME` is a `Date` and the submitted one is the local string
 * `2027-02-11T10:00`, so comparing them as they arrive reports every dated
 * field as changed on every save. Normalising both to an instant is what makes
 * "nothing changed" expressible.
 */
function auditValue(field: FieldSpec, value: unknown): unknown {
  if (field.kind === "richtext") return digestOf(value);

  if (field.kind === "datetime") {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "string") return instantFromLocal(value)?.toISOString() ?? null;
    return null;
  }

  if (value instanceof Date) return value.toISOString();

  // An emptied optional control submits `""`, and `dbValue` stores that as
  // NULL — so the two sides of the diff have to agree that they are the same
  // absence. Without this every save of a form with five blank optional
  // fields reports five changes, and the audit summary reads "Edited Headline
  // (Urdu), Check again by, Search-result title…" for a one-word fix to the
  // summary. A log that says everything changed says nothing.
  if (typeof value === "string" && value.trim() === "") return null;

  return value;
}

/**
 * A summary that fits `audit_log.summary`, which is VARCHAR(400).
 *
 * A headline may be 300 characters and an edit may touch a dozen fields, so
 * the obvious template overflows the column — and under strict mode that is
 * not a truncated log line, it is a failed save of content the editor had
 * already written.
 */
function summaryLine(parts: string): string {
  return parts.length <= 400 ? parts : `${parts.slice(0, 397)}...`;
}

/** A title short enough to read in a log line. */
function brief(title: string): string {
  return title.length <= 120 ? title : `${title.slice(0, 117)}...`;
}

/* -------------------------------------------------------------------------- */
/* Authorisation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * May this actor file content under this department?
 *
 * Empty scopes mean the whole chamber, exactly as in `preview.ts`: access is
 * decided by the permission, and the scope list narrows it where one is
 * granted. The thrown error names the department because an editor who picked
 * the wrong one from a picker needs to know which choice was refused.
 */
function assertDepartmentInScope(actor: ActorContext, code: string): void {
  if (actor.departmentScopes.length === 0) return;
  if (actor.departmentScopes.includes(code)) return;
  throw new ForbiddenError(null, `This account cannot file content under ${code}.`);
}

async function assertDepartmentExists(db: Queryable, code: string): Promise<void> {
  const row = await db
    .selectFrom("departments")
    .select("code")
    .where("code", "=", code)
    .where("active", "=", 1)
    .executeTakeFirst();

  if (!row) {
    throw new ContentInvalidError({ department_code: "Pick a department that is still in use." });
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                */
/* -------------------------------------------------------------------------- */

interface SplitValues {
  readonly parent: Record<string, unknown>;
  readonly satellite: Record<string, unknown>;
  readonly topics: readonly string[];
  /** Field values for the audit event, parent and satellite in one map. */
  readonly audit: Record<string, unknown>;
}

const PARENT_COLUMNS = new Set([
  "slug",
  "title_en",
  "title_ur",
  "department_code",
  "sort_order",
  "review_by",
  "scheduled_unpublish_at",
  "seo_title",
  "seo_description",
  "og_image_id",
]);

/**
 * Validate a submitted form and split it by table.
 *
 * Unknown keys never reach either half: the loop walks the *spec*, so a
 * submitted `is_admin` or `status` is simply not looked at. That is the reason
 * the dynamic column list is safe, and it also means the editor cannot be
 * made to set a status by adding a hidden input — status changes live in B3's
 * workflow behind their own permissions.
 */
function validate(kind: ContentKind, raw: Record<string, unknown>): SplitValues {
  const parsed = contentFormSchema(kind).safeParse(raw);

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "form";
      fieldErrors[key] ??= issue.message;
    }
    throw new ContentInvalidError(fieldErrors);
  }

  const values = parsed.data as Record<string, unknown>;
  const parent: Record<string, unknown> = {};
  const satellite: Record<string, unknown> = {};
  const audit: Record<string, unknown> = {};

  for (const field of allFields(kind)) {
    const stored = dbValue(field, values[field.name]);
    if (PARENT_COLUMNS.has(field.name)) parent[field.name] = stored;
    else satellite[field.name] = stored;
    audit[field.name] = auditValue(field, values[field.name]);
  }

  // `sort_order` is NOT NULL with a default; an empty control must not try to
  // write NULL over it.
  if (parent.sort_order === null || parent.sort_order === undefined) {
    parent.sort_order = 100;
  }

  const topics = CONTENT_FORMS[kind].hasTopics
    ? ((values.topics as string[] | undefined) ?? [])
    : [];
  if (CONTENT_FORMS[kind].hasTopics) audit.topics = topics;

  return { parent, satellite, topics, audit };
}

/* -------------------------------------------------------------------------- */
/* Dynamic satellite SQL                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `INSERT` into a satellite table whose name and columns come from the spec.
 *
 * Kysely's types cannot follow a table chosen at run time, so this drops to
 * the `sql` template — but identifiers go through `sql.id`/`sql.table` and
 * every value is a parameter, so nothing about the statement is concatenated
 * from input.
 */
async function insertSatellite(
  tx: Tx,
  table: string,
  itemId: number,
  values: Record<string, unknown>,
): Promise<void> {
  const names = Object.keys(values);
  const columns = ["content_item_id", ...names].map((name) => sql.id(name));
  const parameters = [itemId, ...names.map((name) => values[name])];

  await sql`insert into ${sql.table(table)} (${sql.join(columns)}) values (${sql.join(parameters)})`.execute(
    tx,
  );
}

async function updateSatellite(
  tx: Tx,
  table: string,
  itemId: number,
  values: Record<string, unknown>,
): Promise<void> {
  const assignments = Object.keys(values).map((name) => sql`${sql.id(name)} = ${values[name]}`);
  if (assignments.length === 0) return;

  await sql`update ${sql.table(table)} set ${sql.join(assignments)} where content_item_id = ${itemId}`.execute(
    tx,
  );
}

async function readSatellite(
  db: Queryable,
  table: string,
  itemId: number,
): Promise<Record<string, unknown> | null> {
  const result = await sql<Record<string, unknown>>`
    select * from ${sql.table(table)} where content_item_id = ${itemId}
  `.execute(db);

  return result.rows[0] ?? null;
}

/**
 * Replace a row's topic tags.
 *
 * Delete-then-insert rather than a diff: there are at most eight topics, the
 * pair runs inside the save transaction, and a diff would be more code
 * carrying more ways to be wrong than the write it replaces.
 */
async function setTopics(tx: Tx, itemId: number, topics: readonly string[]): Promise<void> {
  await tx.deleteFrom("content_item_topics").where("content_item_id", "=", itemId).execute();

  const unique = [...new Set(topics)];
  if (unique.length === 0) return;

  await tx
    .insertInto("content_item_topics")
    .values(unique.map((slug) => ({ content_item_id: itemId, topic_slug: slug })))
    .execute();
}

function isDuplicateSlug(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ER_DUP_ENTRY" &&
    String((error as { message?: unknown }).message ?? "").includes("uq_content_slug")
  );
}

function isUnknownTopic(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ER_NO_REFERENCED_ROW_2" &&
    String((error as { message?: unknown }).message ?? "").includes("content_item_topics")
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a content item. It lands as a draft.
 *
 * Not "create and publish". The status column's default is `draft` and nothing
 * here overrides it, so there is no path through this function that puts
 * something on the public site — which is what makes it safe to give
 * `content.create` to a department editor.
 */
export async function createContentItem(
  actor: ActorContext,
  kind: ContentKind,
  raw: Record<string, unknown>,
): Promise<SavedContentItem> {
  requirePermission(actor, "content.create");

  const form = CONTENT_FORMS[kind];
  const { parent, satellite, topics, audit } = validate(kind, raw);
  const department = String(parent.department_code);

  assertDepartmentInScope(actor, department);
  await assertDepartmentExists(getDb(), department);

  try {
    return await transaction(async (tx) => {
      const inserted = await tx
        .insertInto("content_items")
        .values({
          content_type: kind,
          slug: String(parent.slug),
          title_en: String(parent.title_en),
          title_ur: parent.title_ur as string | null,
          department_code: department,
          seo_title: (parent.seo_title ?? null) as string | null,
          seo_description: (parent.seo_description ?? null) as string | null,
          og_image_id: (parent.og_image_id ?? null) as number | null,
          review_by: (parent.review_by ?? null) as string | null,
          scheduled_unpublish_at: (parent.scheduled_unpublish_at ?? null) as Date | null,
          sort_order: parent.sort_order as number,
          created_by: actor.userId,
        })
        .executeTakeFirstOrThrow();

      const id = Number(inserted.insertId);

      await insertSatellite(tx, form.table, id, satellite);
      if (form.hasTopics) await setTopics(tx, id, topics);

      await writeAudit(
        actor,
        {
          entityType: "content",
          entityId: id,
          action: "content.created",
          summary: summaryLine(
            `Created ${form.singular.toLowerCase()} "${brief(String(parent.title_en))}" as a draft`,
          ),
          after: audit,
          context: { contentType: kind, departmentCode: department, slug: parent.slug },
        },
        tx,
      );

      return { id, slug: String(parent.slug), version: 1 };
    });
  } catch (error) {
    throw translateWriteError(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Update                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Save an existing content item.
 *
 * `expectedVersion` is the version the editor loaded. If the row has moved on,
 * nothing is written and `ConcurrencyError` is thrown — the screen reloads and
 * the editor decides, rather than this function guessing which of two people
 * meant what.
 *
 * The status is not touched. Saving a published item therefore changes what
 * the public sees, with no review; B3's workflow is what will put a gate in
 * front of that.
 */
export async function updateContentItem(
  actor: ActorContext,
  kind: ContentKind,
  id: number,
  expectedVersion: number,
  raw: Record<string, unknown>,
): Promise<SavedContentItem> {
  requirePermission(actor, "content.edit");

  const form = CONTENT_FORMS[kind];
  const { parent, satellite, topics, audit } = validate(kind, raw);
  const department = String(parent.department_code);

  assertDepartmentInScope(actor, department);
  await assertDepartmentExists(getDb(), department);

  try {
    return await transaction(async (tx) => {
      const existing = await tx
        .selectFrom("content_items")
        .select([
          "id",
          "content_type",
          "slug",
          "title_en",
          "title_ur",
          "status",
          "department_code",
          "seo_title",
          "seo_description",
          "og_image_id",
          "review_by",
          "scheduled_unpublish_at",
          "sort_order",
          "version",
        ])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();

      if (!existing) throw new ContentInvalidError({ form: "This item no longer exists." });

      // The content type decides which satellite table is written. A caller
      // that validated against the wrong one would write the right values into
      // the wrong table, so this is checked rather than trusted.
      if (existing.content_type !== kind) {
        throw new ConcurrencyError("This item");
      }

      // Both sides of a department move must be in scope: moving a row *out*
      // of your own department would otherwise be a way to hand it to somebody
      // else and lose sight of it.
      assertDepartmentInScope(actor, existing.department_code);

      const before = await readSatellite(tx, form.table, id);
      const topicRows = form.hasTopics
        ? await tx
            .selectFrom("content_item_topics")
            .select("topic_slug")
            .where("content_item_id", "=", id)
            .execute()
        : [];

      const result = await tx
        .updateTable("content_items")
        .set({
          slug: String(parent.slug),
          title_en: String(parent.title_en),
          title_ur: parent.title_ur as string | null,
          department_code: department,
          seo_title: (parent.seo_title ?? null) as string | null,
          seo_description: (parent.seo_description ?? null) as string | null,
          og_image_id: (parent.og_image_id ?? null) as number | null,
          review_by: (parent.review_by ?? null) as string | null,
          scheduled_unpublish_at: (parent.scheduled_unpublish_at ?? null) as Date | null,
          sort_order: parent.sort_order as number,
          version: existing.version + 1,
        })
        .where("id", "=", id)
        .where("version", "=", expectedVersion)
        .executeTakeFirst();

      if (result.numUpdatedRows === 0n) {
        throw new ConcurrencyError("This item");
      }

      await updateSatellite(tx, form.table, id, satellite);
      if (form.hasTopics) await setTopics(tx, id, topics);

      const changed = changedFields(kind, existing, before, topicRows.map((r) => r.topic_slug), audit);

      await writeAudit(
        actor,
        {
          entityType: "content",
          entityId: id,
          action: "content.updated",
          summary: summaryLine(
            changed.names.length === 0
              ? `Saved ${form.singular.toLowerCase()} "${brief(String(parent.title_en))}" with no changes`
              : `Edited ${changed.names.join(", ")} on ${form.singular.toLowerCase()} "${brief(String(parent.title_en))}"`,
          ),
          before: changed.before,
          after: changed.after,
          context: {
            contentType: kind,
            departmentCode: department,
            status: existing.status,
            /**
             * Whether this edit changed what visitors can already see.
             *
             * The most audit-relevant fact about a content edit, and not
             * derivable later: by the time anybody reads the log the status may
             * have moved on several times.
             */
            editedWhilePublished: existing.status === "published",
          },
        },
        tx,
      );

      return { id, slug: String(parent.slug), version: existing.version + 1 };
    });
  } catch (error) {
    throw translateWriteError(error);
  }
}

/**
 * The fields that actually changed, with their old and new values.
 *
 * Storing the whole form twice on every save would make the common case — one
 * typo fixed in a headline — indistinguishable from a rewrite, and the log is
 * read far more often than it is written. A diff also makes the summary line
 * say something ("Edited Headline, Summary") instead of "Saved".
 *
 * Comparison is on the audit shape rather than the stored shape, so a date
 * compares as an ISO string on both sides and a body compares by digest.
 */
function changedFields(
  kind: ContentKind,
  existingParent: Record<string, unknown>,
  existingSatellite: Record<string, unknown> | null,
  existingTopics: readonly string[],
  submitted: Record<string, unknown>,
): { names: string[]; before: Record<string, unknown>; after: Record<string, unknown> } {
  const names: string[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const field of allFields(kind)) {
    const raw = PARENT_COLUMNS.has(field.name)
      ? existingParent[field.name]
      : existingSatellite?.[field.name];

    const old = auditValue(field, normaliseStored(field, raw));
    const next = submitted[field.name] ?? null;

    if (JSON.stringify(old ?? null) === JSON.stringify(next ?? null)) continue;

    names.push(field.label);
    before[field.name] = old ?? null;
    after[field.name] = next ?? null;
  }

  if (CONTENT_FORMS[kind].hasTopics) {
    const was = [...existingTopics].sort();
    const now = [...((submitted.topics as string[] | undefined) ?? [])].sort();
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      names.push("Topics");
      before.topics = was;
      after.topics = now;
    }
  }

  return { names, before, after };
}

/**
 * A stored value, in the shape the submitted one arrives in.
 *
 * Without this every save would report every field as changed, because
 * mysql2 returns a `TINYINT(1)` as `0`, a `DECIMAL` as a **string** and a
 * `DATETIME` as a `Date`, while the form submits a boolean, a number and a
 * local string. The diff would then be useless and the audit log would be
 * full of noise — which is the failure mode that makes people stop reading it.
 */
function normaliseStored(field: FieldSpec, value: unknown): unknown {
  if (value === null || value === undefined) return null;

  switch (field.kind) {
    case "checkbox":
      return value === 1 || value === true;
    case "decimal":
      return typeof value === "string" ? Number(value) : value;
    case "integer":
    case "media":
      return typeof value === "string" ? Number(value) : value;
    default:
      return value;
  }
}

/* -------------------------------------------------------------------------- */
/* Delete a draft                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Delete a draft that was never published.
 *
 * The only deletion in the CMS. Published items are archived instead — they
 * keep resolving at their URL, because roughly 890 legacy press URLs are being
 * 301'd into this space and archiving must not manufacture 404s. But a row
 * created by mistake, with no public address anybody could have linked to, has
 * nothing to preserve and leaving it in the list forever is how a queue
 * becomes unusable.
 *
 * The audit event carries the **whole** row, body included, because after this
 * runs the audit log is the only record that it existed.
 */
export async function deleteDraftContentItem(
  actor: ActorContext,
  kind: ContentKind,
  id: number,
): Promise<void> {
  requirePermission(actor, "content.edit");

  const form = CONTENT_FORMS[kind];

  await transaction(async (tx) => {
    const existing = await tx
      .selectFrom("content_items")
      .selectAll()
      .where("id", "=", id)
      .where("content_type", "=", kind)
      .forUpdate()
      .executeTakeFirst();

    if (!existing) throw new ContentInvalidError({ form: "This item no longer exists." });

    assertDepartmentInScope(actor, existing.department_code);

    if (existing.status !== "draft" || existing.published_at !== null) {
      throw new ContentInvalidError(
        { form: "Only a draft that has never been published can be deleted. Archive it instead." },
        "This item cannot be deleted.",
      );
    }

    const satellite = await readSatellite(tx, form.table, id);

    await writeAudit(
      actor,
      {
        entityType: "content",
        entityId: id,
        action: "content.deleted",
        summary: summaryLine(
          `Deleted unpublished ${form.singular.toLowerCase()} "${brief(existing.title_en)}"`,
        ),
        before: { ...existing, satellite },
        context: { contentType: kind, departmentCode: existing.department_code },
      },
      tx,
    );

    // The satellite and the topic rows go with it: both are
    // `ON DELETE CASCADE` from `content_items`, declared in migration 0016.
    await tx.deleteFrom("content_items").where("id", "=", id).execute();
  });
}

/* -------------------------------------------------------------------------- */
/* Error translation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn a database constraint into the field error it actually is.
 *
 * A duplicate slug is not a server fault: it is two people naming the same
 * thing the same way, and the editor can fix it in the control it came from.
 * Anything unrecognised is re-thrown unchanged — swallowing it would hide a
 * real defect behind a plausible validation message.
 */
function translateWriteError(error: unknown): unknown {
  if (isDuplicateSlug(error)) {
    return new ContentInvalidError({
      slug: "Another item of this type already uses this address.",
    });
  }
  if (isUnknownTopic(error)) {
    return new ContentInvalidError({ topics: "One of those topics no longer exists." });
  }
  return error;
}
