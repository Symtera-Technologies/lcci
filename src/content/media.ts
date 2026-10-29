import "server-only";

import { getDb, transaction } from "@/db/client";
import type { ActorContext } from "@/server/actor";
import { requirePermission } from "@/server/actor";
import { writeAudit } from "@/server/audit";
import { ContentInvalidError } from "@/content/admin";

/**
 * The media library.
 *
 * One row per image, with alt text that cannot be skipped — `alt_en` is NOT
 * NULL and there is no path through this module that writes a blank one. That
 * is the whole reason images are rows here rather than paths typed into a body
 * field: the `<img>` tag is not in the sanitiser's allowlist, so the only way
 * a photograph reaches a page is through a record that has been described.
 *
 * **What this does not do yet: accept an upload.** Every asset registered here
 * names a file that is already being served — the launch photography under
 * `/photos/`, placed by a deploy. A runtime upload needs somewhere for the
 * bytes to live, and the two obvious answers are both wrong: `public/` is
 * inside the app root, and the release does `rm -rf .next` and copies over the
 * tree, so one `--delete` takes every photograph the chamber has uploaded;
 * and the private document root is encrypted, `no-store` and served as an
 * attachment, which is the opposite of what a hero image needs. The plan's
 * answer is object storage behind an adapter, and until that is decided this
 * module manages the records and the descriptions rather than pretending to
 * manage the files.
 *
 * So an editor can describe, re-describe, credit and retire an image, and see
 * where it is used before changing it. Adding a new photograph still needs a
 * deploy. That is a real limitation, stated here rather than discovered.
 */

export interface MediaAsset {
  readonly id: number;
  readonly src: string;
  readonly altEn: string;
  readonly altUr: string | null;
  readonly width: number;
  readonly height: number;
  readonly caption: string | null;
  readonly departmentCode: string | null;
  readonly updatedAt: Date;
}

/** Where one asset is used, so nothing is re-described blind. */
export interface MediaUse {
  readonly contentItemId: number;
  readonly contentType: string;
  readonly titleEn: string;
  readonly status: string;
  /** Which slot it fills: the sharing image, the hero, the poster, the logo… */
  readonly role: string;
}

const SRC_PATTERN = /^\/[A-Za-z0-9._\-/]+\.(?:jpg|jpeg|png|webp|svg)$/;

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

function likeContains(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (character) => "\\" + character);
  return `%${escaped}%`;
}

/**
 * The library, newest first.
 *
 * **Not scoped by department.** `media_assets.department_code` records who
 * contributed an image, not who may use it: the same photograph of a
 * delegation belongs in a press release from Information and a report from
 * Research, and a library that hid it from one of them would be a library
 * people worked around by registering the file twice under two ids. Alt text
 * is a description of a picture, not a departmental secret.
 */
export async function listMedia(
  actor: ActorContext,
  options: { readonly search?: string; readonly limit?: number; readonly offset?: number } = {},
): Promise<MediaAsset[]> {
  requirePermission(actor, "content.read_draft");

  let query = getDb()
    .selectFrom("media_assets")
    .select([
      "id",
      "src",
      "alt_en",
      "alt_ur",
      "width",
      "height",
      "caption",
      "department_code",
      "updated_at",
    ])
    .orderBy("id", "desc")
    .limit(options.limit ?? 48)
    .offset(options.offset ?? 0);

  if (options.search) {
    // Across the description and the path: an editor looking for a photograph
    // remembers what is in it far more often than what it is called.
    query = query.where((eb) =>
      eb.or([
        eb("alt_en", "like", likeContains(options.search as string)),
        eb("src", "like", likeContains(options.search as string)),
      ]),
    );
  }

  const rows = await query.execute();

  return rows.map((row) => ({
    id: row.id,
    src: row.src,
    altEn: row.alt_en,
    altUr: row.alt_ur,
    width: row.width,
    height: row.height,
    caption: row.caption,
    departmentCode: row.department_code,
    updatedAt: row.updated_at,
  }));
}

export async function countMedia(
  actor: ActorContext,
  options: { readonly search?: string } = {},
): Promise<number> {
  requirePermission(actor, "content.read_draft");

  let query = getDb()
    .selectFrom("media_assets")
    .select(({ fn }) => fn.countAll<number>().as("n"));

  if (options.search) {
    query = query.where((eb) =>
      eb.or([
        eb("alt_en", "like", likeContains(options.search as string)),
        eb("src", "like", likeContains(options.search as string)),
      ]),
    );
  }

  const row = await query.executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** One asset. */
export async function getMediaAsset(
  actor: ActorContext,
  id: number,
): Promise<MediaAsset | null> {
  const rows = await listMediaByIds(actor, [id]);
  return rows[0] ?? null;
}

async function listMediaByIds(
  actor: ActorContext,
  ids: readonly number[],
): Promise<MediaAsset[]> {
  requirePermission(actor, "content.read_draft");
  if (ids.length === 0) return [];

  const rows = await getDb()
    .selectFrom("media_assets")
    .select([
      "id",
      "src",
      "alt_en",
      "alt_ur",
      "width",
      "height",
      "caption",
      "department_code",
      "updated_at",
    ])
    .where("id", "in", ids)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    src: row.src,
    altEn: row.alt_en,
    altUr: row.alt_ur,
    width: row.width,
    height: row.height,
    caption: row.caption,
    departmentCode: row.department_code,
    updatedAt: row.updated_at,
  }));
}

/**
 * Everywhere one image is used.
 *
 * Five slots across four tables plus the gallery. One query per slot rather
 * than a five-way `UNION`: the result is the same, the statements are each
 * readable on their own, and the tables hold a few dozen rows between them —
 * so the cost of the extra round trips is nothing against the cost of a union
 * nobody can safely change.
 *
 * It exists because changing alt text is not a local act. The same photograph
 * can be the hero of one release and the sharing image of another, and an
 * editor rewriting "Delegation at the chamber" needs to see both before
 * deciding whether the new words still describe what is on each page.
 */
export async function mediaUsage(actor: ActorContext, id: number): Promise<MediaUse[]> {
  requirePermission(actor, "content.read_draft");

  const db = getDb();

  const [sharing, heroes, posters, logos, gallery] = await Promise.all([
    db
      .selectFrom("content_items as ci")
      .select(["ci.id", "ci.content_type", "ci.title_en", "ci.status"])
      .where("ci.og_image_id", "=", id)
      .execute(),
    db
      .selectFrom("content_press_releases as pr")
      .innerJoin("content_items as ci", "ci.id", "pr.content_item_id")
      .select(["ci.id", "ci.content_type", "ci.title_en", "ci.status"])
      .where("pr.hero_image_id", "=", id)
      .execute(),
    db
      .selectFrom("content_videos as v")
      .innerJoin("content_items as ci", "ci.id", "v.content_item_id")
      .select(["ci.id", "ci.content_type", "ci.title_en", "ci.status"])
      .where("v.poster_id", "=", id)
      .execute(),
    db
      .selectFrom("content_partners as p")
      .innerJoin("content_items as ci", "ci.id", "p.content_item_id")
      .select(["ci.id", "ci.content_type", "ci.title_en", "ci.status"])
      .where("p.logo_id", "=", id)
      .execute(),
    db
      .selectFrom("content_gallery_images as gi")
      .innerJoin("content_items as ci", "ci.id", "gi.album_item_id")
      .select(["ci.id", "ci.content_type", "ci.title_en", "ci.status"])
      .where("gi.media_id", "=", id)
      .execute(),
  ]);

  const label = (
    rows: { id: number; content_type: string; title_en: string; status: string }[],
    role: string,
  ): MediaUse[] =>
    rows.map((row) => ({
      contentItemId: row.id,
      contentType: row.content_type,
      titleEn: row.title_en,
      status: row.status,
      role,
    }));

  return [
    ...label(sharing, "Sharing image"),
    ...label(heroes, "Photograph"),
    ...label(posters, "Video poster"),
    ...label(logos, "Logo"),
    ...label(gallery, "In an album"),
  ];
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export interface MediaInput {
  readonly src: string;
  readonly altEn: string;
  readonly altUr?: string | null;
  readonly width: number;
  readonly height: number;
  readonly caption?: string | null;
  readonly departmentCode?: string | null;
}

function validate(input: MediaInput, { requireSrc }: { requireSrc: boolean }): void {
  const errors: Record<string, string> = {};

  if (requireSrc) {
    if (!SRC_PATTERN.test(input.src)) {
      errors.src =
        "A path on this site, starting with / and ending in .jpg, .png, .webp or .svg.";
    }
    // `..` cannot appear — the pattern allows `.` but a traversal needs two in
    // sequence, and a path that escapes the served tree would either 404 or,
    // worse, serve something that was never meant to be public.
    if (input.src.includes("..")) errors.src = "That path is not allowed.";
  }

  const alt = input.altEn.trim();
  if (alt === "") {
    errors.altEn = "Required. Describe what is in the picture.";
  } else if (alt.length > 500) {
    errors.altEn = "Keep it under 500 characters.";
  } else if (/^(?:image|photo|picture|img)\b/i.test(alt)) {
    // A screen reader already says "image". Alt text that starts by repeating
    // it spends the listener's attention before saying anything.
    errors.altEn = 'Start with what it shows, not with "image" or "photo".';
  }

  if (!Number.isSafeInteger(input.width) || input.width < 1 || input.width > 65_535) {
    errors.width = "The pixel width of the file.";
  }
  if (!Number.isSafeInteger(input.height) || input.height < 1 || input.height > 65_535) {
    errors.height = "The pixel height of the file.";
  }

  if (Object.keys(errors).length > 0) throw new ContentInvalidError(errors);
}

/**
 * Register a file that is already being served.
 *
 * Deliberately not called `uploadMedia`: nothing is uploaded. The caller gives
 * a path under the served tree and the dimensions, and the row describes it.
 * The dimensions are asked for rather than measured because measuring means
 * decoding, and a decoder on this host is how the worker runs out of memory —
 * a 300 dpi A4 JPEG is around 215 MB of raw pixels, and the failure would be
 * site-wide.
 */
export async function registerMediaAsset(
  actor: ActorContext,
  input: MediaInput,
): Promise<number> {
  requirePermission(actor, "content.media.manage");
  validate(input, { requireSrc: true });

  try {
    return await transaction(async (tx) => {
      const inserted = await tx
        .insertInto("media_assets")
        .values({
          src: input.src.trim(),
          alt_en: input.altEn.trim(),
          alt_ur: emptyToNull(input.altUr),
          width: input.width,
          height: input.height,
          caption: emptyToNull(input.caption),
          department_code: emptyToNull(input.departmentCode),
          uploaded_by: actor.userId,
        })
        .executeTakeFirstOrThrow();

      const id = Number(inserted.insertId);

      await writeAudit(
        actor,
        {
          entityType: "media",
          entityId: id,
          action: "media.registered",
          summary: `Registered image ${input.src.trim()}`,
          after: { src: input.src.trim(), altEn: input.altEn.trim() },
        },
        tx,
      );

      return id;
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ER_DUP_ENTRY"
    ) {
      throw new ContentInvalidError({
        src: "That file is already in the library. Edit the existing entry instead.",
      });
    }
    throw error;
  }
}

/**
 * Re-describe an image.
 *
 * `src` is not editable. Changing it would silently repoint every page using
 * the asset at a different photograph while keeping the old description — the
 * one change that can turn correct alt text into a lie. A new file is a new
 * row, and the usage list is there so an editor can see what would have to
 * move.
 */
export async function updateMediaAsset(
  actor: ActorContext,
  id: number,
  input: Omit<MediaInput, "src">,
): Promise<void> {
  requirePermission(actor, "content.media.manage");
  validate({ ...input, src: "" }, { requireSrc: false });

  await transaction(async (tx) => {
    const before = await tx
      .selectFrom("media_assets")
      .select(["src", "alt_en", "alt_ur", "caption", "width", "height", "department_code"])
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();

    if (!before) throw new ContentInvalidError({ form: "That image is no longer in the library." });

    await tx
      .updateTable("media_assets")
      .set({
        alt_en: input.altEn.trim(),
        alt_ur: emptyToNull(input.altUr),
        width: input.width,
        height: input.height,
        caption: emptyToNull(input.caption),
        department_code: emptyToNull(input.departmentCode),
      })
      .where("id", "=", id)
      .execute();

    await writeAudit(
      actor,
      {
        entityType: "media",
        entityId: id,
        action: "media.updated",
        summary: `Re-described image ${before.src}`,
        before: { altEn: before.alt_en, altUr: before.alt_ur, caption: before.caption },
        after: { altEn: input.altEn.trim(), altUr: input.altUr ?? null, caption: input.caption ?? null },
      },
      tx,
    );
  });
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
