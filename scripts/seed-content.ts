/**
 * Generate the launch content seed.
 *
 *   npm run seed:content         writes migrations/0017_seed_content.sql
 *
 * Same pattern as `seed-rbac.ts` and `seed-calendar.ts`: a generator that
 * emits plain SQL rather than a script that writes to a database. Three
 * reasons, all of them about the host rather than about taste. The launch
 * content has to reach a shared cPanel box the same way every other row does,
 * which is `npm run migrate` over SSH or the authenticated route — there is no
 * step in the release where somebody runs a one-off TypeScript file against
 * production. The result is reviewable as a diff, which matters for copy drawn
 * from genuine chamber items. And it can be pasted into phpMyAdmin on the day
 * SSH will not cooperate, which `DEPLOYMENT.md` assumes will happen.
 *
 * **`INSERT IGNORE`, never an upsert.** Re-running the migration must be a
 * no-op, and specifically must not stamp over a correction an editor has made
 * in the admin. A seed establishes initial content; after that the admin owns
 * it. This is the same reasoning as the `number_sequences` seed in 0015, and
 * it is why editorial changes after launch belong in the CMS rather than in a
 * regenerated file — regenerating this one after it has been applied changes
 * its checksum and the migration runner will refuse it, loudly, which is the
 * correct outcome.
 *
 * **The seed writes no audit events**, and nothing here pretends to have an
 * actor. `systemActor` holds no permissions by design, and inventing a
 * "content created by the system" trail for rows that arrived with the schema
 * would put twelve fictitious editorial decisions at the head of the chain
 * that `audit-verify` checks. The provenance of this content is this file and
 * the commit that added it.
 *
 * Foreign keys resolve through subqueries on natural keys — `media_assets.src`
 * and `content_items (content_type, slug)` — rather than through
 * `LAST_INSERT_ID()`. That is what makes the file idempotent, order-independent
 * within a type, and safe to run against a database where some of these rows
 * already exist.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import type { ImageRef } from "../src/content/types";
import {
  COMMITTEES,
  DEPT,
  EVENTS,
  GALLERY,
  INDICATORS,
  KEY_FIGURES,
  NOTICES,
  PARTNERS,
  POSITIONS,
  PRESS,
  SERVICES,
  TESTIMONIALS,
  VIDEOS,
} from "../src/content/seed-data";

/* -------------------------------------------------------------------------- */
/* Literals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A MySQL string literal.
 *
 * Backslash first, then the quote: reversing them would double-escape every
 * backslash the quote-escaping introduced. MySQL treats `\` as an escape
 * character inside string literals by default (unlike standard SQL), so both
 * are needed — and nothing in this content contains either today, which is
 * exactly why the escaping has to be right rather than tested by the data.
 */
function lit(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function litOrNull(value: string | null | undefined): string {
  return value === undefined || value === null ? "NULL" : lit(value);
}

function num(value: number | null | undefined): string {
  return value === undefined || value === null ? "NULL" : String(value);
}

function bool(value: boolean): string {
  return value ? "1" : "0";
}

/**
 * An ISO instant as a `DATETIME(3)` literal in UTC.
 *
 * The fixtures carry `+05:00` offsets because they were written as Pakistani
 * local times. `DATETIME` stores whatever literal it is given with no zone
 * conversion, so the conversion has to happen here or the site would render
 * every date five hours early. `formatDate` pins rendering to `Asia/Karachi`,
 * which is what makes a UTC column and a Pakistani reader agree.
 */
function instant(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error(`not a date: ${iso}`);
  return lit(at.toISOString().replace("T", " ").replace("Z", ""));
}

/** A `DATE` literal. Already a civil date in the fixtures; validated, not converted. */
function civilDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`not a civil date: ${value}`);
  }
  return lit(value);
}

/* -------------------------------------------------------------------------- */
/* Departments                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The fixtures carry department *labels*; the tables carry codes.
 *
 * Reversed from `DEPT` rather than written out again, so a renamed department
 * is one edit and a label with no code fails here instead of inserting a row
 * that violates the foreign key halfway through the migration.
 */
const DEPARTMENT_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(DEPT).map(([code, label]) => [label, code]),
);

function departmentCode(label: string): string {
  const code = DEPARTMENT_CODE[label];
  if (!code) throw new Error(`no department code for "${label}"`);
  return code;
}

/* -------------------------------------------------------------------------- */
/* Dates with no date                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The publication instant for the content that carries none.
 *
 * Service tiles, committees, partners, testimonials, key figures and
 * indicators have no publication date in their public types, because nothing
 * renders one — but `published_at` is half of the live predicate, so a row
 * without it would be invisible. A fixed past instant rather than "now at
 * generation time", so the generated SQL is deterministic and a regenerated
 * file diffs as empty when nothing has changed.
 *
 * 1 October 2026 is the date the key figures were verified on, which is the
 * nearest thing this content has to an approval date.
 */
const LAUNCH = "2026-10-01T00:00:00+05:00";

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every image the content references, deduplicated by `src`.
 *
 * Collected rather than listed, so an image added to a fixture cannot be
 * forgotten here — a missing `media_assets` row would surface as a foreign key
 * failure mid-migration rather than as a missing picture.
 */
function collectMedia(): ImageRef[] {
  const bySrc = new Map<string, ImageRef>();

  /**
   * Merged, not overwritten.
   *
   * The six newsroom hero photographs and the six gallery photographs are the
   * same six files, described identically — which is the `media_assets` design
   * working — but only the gallery copies carry captions. Writing the second
   * reference over the first would mean the captions surviving or not
   * depending on which loop below runs last, which is the kind of dependency
   * that holds until somebody reorders two lines for tidiness.
   */
  const add = (image: ImageRef | undefined) => {
    if (!image) return;
    const existing = bySrc.get(image.src);
    if (!existing) {
      bySrc.set(image.src, image);
      return;
    }
    if (existing.altEn !== image.altEn) {
      throw new Error(
        `two descriptions for one photograph (${image.src}). Alt text belongs ` +
          `to the image, so one of these is wrong.`,
      );
    }
    if (existing.caption && image.caption && existing.caption !== image.caption) {
      throw new Error(
        `two captions for one photograph (${image.src}). A caption that is ` +
          `genuinely per-placement needs a column on the placement.`,
      );
    }
    bySrc.set(image.src, {
      ...existing,
      caption: existing.caption ?? image.caption,
      altUr: existing.altUr ?? image.altUr,
    });
  };

  for (const release of PRESS) add(release.heroImage);
  for (const release of PRESS) add(release.ogImage);
  for (const video of VIDEOS) add(video.poster);
  for (const partner of PARTNERS) add(partner.logo);
  for (const image of GALLERY.images) add(image);

  return [...bySrc.values()];
}

/* -------------------------------------------------------------------------- */
/* Statements                                                                 */
/* -------------------------------------------------------------------------- */

type Row = {
  type: string;
  slug: string;
  titleEn: string;
  titleUr?: string;
  publishedAt: string;
  department: string;
  sortOrder: number;
  /** Set only on content meant to be kept current. See `reviewBy` below. */
  reviewBy?: string;
};

function itemInsert(rows: readonly Row[]): string {
  const values = rows.map(
    (row) =>
      `  (${lit(row.type)}, ${lit(row.slug)}, ${lit(row.titleEn)}, ` +
      `${litOrNull(row.titleUr)}, 'published', ${instant(row.publishedAt)}, ` +
      `${lit(row.department)}, ${row.reviewBy ? civilDate(row.reviewBy) : "NULL"}, ` +
      `${row.sortOrder}, ${instant(row.publishedAt)})`,
  );

  return [
    "INSERT IGNORE INTO content_items",
    "  (content_type, slug, title_en, title_ur, status, published_at,",
    "   department_code, review_by, sort_order, updated_at)",
    "VALUES",
    values.join(",\n"),
    ";",
  ].join("\n");
}

/** `SELECT id FROM content_items WHERE ...`, as a scalar subquery. */
function itemId(type: string, slug: string): string {
  return `(SELECT id FROM content_items WHERE content_type = ${lit(type)} AND slug = ${lit(slug)})`;
}

/** `SELECT id FROM media_assets WHERE src = ...`, as a scalar subquery. */
function mediaId(src: string | undefined): string {
  return src === undefined ? "NULL" : `(SELECT id FROM media_assets WHERE src = ${lit(src)})`;
}

/**
 * One satellite row.
 *
 * `INSERT ... SELECT` and not `INSERT ... VALUES`, because the primary key is
 * a subquery: `VALUES` cannot hold one in MariaDB. The `WHERE` on the parent's
 * natural key also means a satellite whose parent is somehow absent inserts
 * nothing rather than a row with a NULL key.
 */
function satelliteInsert(
  table: string,
  columns: readonly string[],
  type: string,
  slug: string,
  expressions: readonly string[],
): string {
  return [
    `INSERT IGNORE INTO ${table} (content_item_id, ${columns.join(", ")})`,
    `SELECT ci.id, ${expressions.join(", ")}`,
    `  FROM content_items ci`,
    ` WHERE ci.content_type = ${lit(type)} AND ci.slug = ${lit(slug)};`,
  ].join("\n");
}

/* -------------------------------------------------------------------------- */

/**
 * Which content is meant to be kept current.
 *
 * `review_by` drives B4's "not reviewed in 12 months" report, and setting it
 * on everything would make that report list the newsroom — a press release
 * from October 2026 is not stale in October 2027, it is simply old, and
 * nothing about it needs re-reading. So it is set on the evergreen content
 * only: the service tiles, committees, partners, testimonials and figures that
 * describe the chamber as it is now and silently stop being true.
 *
 * Twelve months because that is the interval section 8.3 names. The economic
 * indicators deserve a far shorter cycle — a policy rate goes stale in weeks,
 * not a year — but the review interval is LCCI's to set per type and inventing
 * one here would be the developer deciding editorial policy. Recorded as an
 * open question rather than guessed.
 */
const EVERGREEN_REVIEW_BY = "2027-10-01";

/**
 * Admin titles for the notices.
 *
 * A notice's content is its message, and `Notice` carries no title because
 * nothing on the public site shows one. `content_items.title_en` is NOT NULL
 * because the admin list has to name every row, so the two notices get short
 * names here. Truncating the message instead would put half a sentence in a
 * column that is meant to hold a name.
 */
const NOTICE_TITLES: Record<string, string> = {
  "n-fraud-2026": "Fraud warning",
  "n-agm-2026": "Annual General Meeting 2026",
};

function main(): number {
  const statements: string[] = [];
  const media = collectMedia();

  /* ---------------------------------------------------------------------- */

  statements.push(
    [
      "-- Every image the content references. `alt_en` is NOT NULL in the schema,",
      "-- so there is no row here without a description.",
      "INSERT IGNORE INTO media_assets",
      "  (src, alt_en, alt_ur, width, height, caption, department_code)",
      "VALUES",
      media
        .map(
          (image) =>
            `  (${lit(image.src)}, ${lit(image.altEn)}, ${litOrNull(image.altUr)}, ` +
            `${image.width}, ${image.height}, ${litOrNull(image.caption)}, 'info')`,
        )
        .join(",\n"),
      ";",
    ].join("\n"),
  );

  /* ---------------------------------------------------------------------- */

  const itemRows: Row[] = [];

  PRESS.forEach((release, index) =>
    itemRows.push({
      type: "press_release",
      slug: release.slug,
      titleEn: release.titleEn,
      titleUr: release.titleUr,
      publishedAt: release.publishedAt,
      department: departmentCode(release.ownerDepartment),
      sortOrder: (index + 1) * 10,
    }),
  );

  EVENTS.forEach((event, index) =>
    itemRows.push({
      type: "event",
      slug: event.slug,
      titleEn: event.titleEn,
      titleUr: event.titleUr,
      publishedAt: event.publishedAt,
      department: departmentCode(event.ownerDepartment),
      sortOrder: (index + 1) * 10,
    }),
  );

  POSITIONS.forEach((position, index) =>
    itemRows.push({
      type: "policy_position",
      slug: position.slug,
      titleEn: position.titleEn,
      titleUr: position.titleUr,
      publishedAt: position.publishedAt,
      department: departmentCode(position.ownerDepartment),
      sortOrder: (index + 1) * 10,
    }),
  );

  NOTICES.forEach((notice, index) => {
    const title = NOTICE_TITLES[notice.id];
    if (!title) throw new Error(`no admin title for notice ${notice.id}`);
    itemRows.push({
      type: "notice",
      slug: notice.id,
      titleEn: title,
      // Published when the editor approved it; live inside its own window.
      publishedAt: notice.startAt,
      department: departmentCode(DEPT.secretariat),
      sortOrder: (index + 1) * 10,
    });
  });

  KEY_FIGURES.forEach((figure, index) =>
    itemRows.push({
      type: "key_figure",
      slug: figure.id,
      titleEn: figure.labelEn,
      publishedAt: LAUNCH,
      department: departmentCode(DEPT.research),
      sortOrder: (index + 1) * 10,
      reviewBy: EVERGREEN_REVIEW_BY,
    }),
  );

  INDICATORS.forEach((indicator, index) =>
    itemRows.push({
      type: "economic_indicator",
      slug: indicator.id,
      titleEn: indicator.labelEn,
      publishedAt: LAUNCH,
      department: departmentCode(DEPT.research),
      sortOrder: (index + 1) * 10,
      reviewBy: EVERGREEN_REVIEW_BY,
    }),
  );

  SERVICES.forEach((service, index) =>
    itemRows.push({
      type: "service_tile",
      slug: service.id,
      titleEn: service.labelEn,
      publishedAt: LAUNCH,
      department: departmentCode(DEPT.secretariat),
      sortOrder: (index + 1) * 10,
      reviewBy: EVERGREEN_REVIEW_BY,
    }),
  );

  COMMITTEES.forEach((committee, index) =>
    itemRows.push({
      type: "committee",
      slug: committee.slug,
      titleEn: committee.nameEn,
      publishedAt: LAUNCH,
      department: departmentCode(DEPT.secretariat),
      sortOrder: (index + 1) * 10,
      reviewBy: EVERGREEN_REVIEW_BY,
    }),
  );

  PARTNERS.forEach((partner, index) =>
    itemRows.push({
      type: "partner",
      slug: partner.id,
      titleEn: partner.name,
      publishedAt: LAUNCH,
      department: departmentCode(DEPT.secretariat),
      sortOrder: (index + 1) * 10,
      reviewBy: EVERGREEN_REVIEW_BY,
    }),
  );

  TESTIMONIALS.forEach((testimonial, index) =>
    itemRows.push({
      type: "testimonial",
      slug: testimonial.id,
      // The admin label, not the quote: a list of six rows all beginning "The
      // certificate of origin used to mean..." cannot be scanned.
      titleEn: `${testimonial.authorName}, ${testimonial.company}`,
      publishedAt: LAUNCH,
      department: departmentCode(DEPT.info),
      sortOrder: (index + 1) * 10,
      reviewBy: EVERGREEN_REVIEW_BY,
    }),
  );

  VIDEOS.forEach((video, index) =>
    itemRows.push({
      type: "video",
      slug: video.id,
      titleEn: video.titleEn,
      titleUr: video.titleUr,
      publishedAt: video.publishedAt,
      department: departmentCode(DEPT.info),
      sortOrder: (index + 1) * 10,
    }),
  );

  itemRows.push({
    type: "gallery_album",
    slug: GALLERY.slug,
    titleEn: GALLERY.titleEn,
    // The album is published when the photographs are, which for one occasion
    // is the occasion itself.
    publishedAt: GALLERY.occurredAt,
    department: departmentCode(DEPT.info),
    sortOrder: 10,
  });

  statements.push(
    [
      "-- The parent rows. `status` is 'published' on every one, because this is",
      "-- the content the site launches with; the workflow starts at 'draft' for",
      "-- everything created afterwards.",
      "--",
      "-- `updated_at` is written explicitly rather than left to its DEFAULT.",
      "-- The fixtures set `updatedAt = publishedAt`, and the advocacy section",
      "-- renders it as \"Updated <date>\" — so letting the default stand would",
      "-- have every seeded position claim it was revised on the day the",
      "-- migration ran, which for content dated weeks earlier is a false",
      "-- statement on the homepage.",
      itemInsert(itemRows),
    ].join("\n"),
  );

  /* ---------------------------------------------------------------------- */

  for (const release of PRESS) {
    statements.push(
      satelliteInsert(
        "content_press_releases",
        ["summary", "hero_image_id", "spokesperson"],
        "press_release",
        release.slug,
        [lit(release.summary), mediaId(release.heroImage?.src), litOrNull(release.spokesperson)],
      ),
    );
  }

  for (const event of EVENTS) {
    statements.push(
      satelliteInsert(
        "content_events",
        [
          "event_type",
          "starts_at",
          "ends_at",
          "venue",
          "fee",
          "capacity",
          "registration_open",
          "registration_deadline",
        ],
        "event",
        event.slug,
        [
          lit(event.type),
          instant(event.start),
          event.end ? instant(event.end) : "NULL",
          lit(event.venue),
          litOrNull(event.fee),
          num(event.capacity),
          bool(event.registrationOpen),
          event.registrationDeadline ? instant(event.registrationDeadline) : "NULL",
        ],
      ),
    );
  }

  for (const position of POSITIONS) {
    statements.push(
      satelliteInsert(
        "content_policy_positions",
        ["issue", "chamber_ask", "position_status"],
        "policy_position",
        position.slug,
        [lit(position.issue), lit(position.chamberAsk), lit(position.positionStatus)],
      ),
    );
  }

  for (const notice of NOTICES) {
    statements.push(
      satelliteInsert(
        "content_notices",
        ["message_en", "message_ur", "href", "level", "starts_at", "ends_at"],
        "notice",
        notice.id,
        [
          lit(notice.messageEn),
          litOrNull(notice.messageUr),
          litOrNull(notice.href),
          lit(notice.level),
          instant(notice.startAt),
          instant(notice.endAt),
        ],
      ),
    );
  }

  for (const figure of KEY_FIGURES) {
    statements.push(
      satelliteInsert(
        "content_key_figures",
        ["figure_value", "suffix", "verified_at"],
        "key_figure",
        figure.id,
        [String(figure.value), litOrNull(figure.suffix), civilDate(figure.verifiedAt)],
      ),
    );
  }

  for (const indicator of INDICATORS) {
    statements.push(
      satelliteInsert(
        "content_economic_indicators",
        ["display_value", "change_pct", "good_when", "source", "measured_at"],
        "economic_indicator",
        indicator.id,
        [
          lit(indicator.value),
          num(indicator.changePct),
          lit(indicator.goodWhen),
          lit(indicator.source),
          civilDate(indicator.updatedAt),
        ],
      ),
    );
  }

  for (const service of SERVICES) {
    statements.push(
      satelliteInsert(
        "content_service_tiles",
        ["description", "href", "icon"],
        "service_tile",
        service.id,
        [lit(service.description), lit(service.href), lit(service.icon)],
      ),
    );
  }

  for (const committee of COMMITTEES) {
    statements.push(
      satelliteInsert(
        "content_committees",
        ["mandate", "member_count"],
        "committee",
        committee.slug,
        [lit(committee.mandate), String(committee.memberCount)],
      ),
    );
  }

  for (const partner of PARTNERS) {
    statements.push(
      satelliteInsert("content_partners", ["tier", "logo_id"], "partner", partner.id, [
        lit(partner.tier),
        mediaId(partner.logo?.src),
      ]),
    );
  }

  for (const testimonial of TESTIMONIALS) {
    statements.push(
      satelliteInsert(
        "content_testimonials",
        ["quote", "author_name", "author_role", "company"],
        "testimonial",
        testimonial.id,
        [
          lit(testimonial.quote),
          lit(testimonial.authorName),
          lit(testimonial.authorRole),
          lit(testimonial.company),
        ],
      ),
    );
  }

  for (const video of VIDEOS) {
    statements.push(
      satelliteInsert(
        "content_videos",
        ["youtube_id", "orientation", "poster_id", "description"],
        "video",
        video.id,
        [
          lit(video.youtubeId),
          lit(video.orientation),
          mediaId(video.poster.src),
          litOrNull(video.description),
        ],
      ),
    );
  }

  statements.push(
    satelliteInsert(
      "content_gallery_albums",
      ["description", "occurred_at"],
      "gallery_album",
      GALLERY.slug,
      [lit(GALLERY.description), instant(GALLERY.occurredAt)],
    ),
  );

  /* ---------------------------------------------------------------------- */

  const topicRows: string[] = [];
  for (const release of PRESS) {
    release.topics.forEach((topic, index) =>
      topicRows.push(
        `INSERT IGNORE INTO content_item_topics (content_item_id, topic_slug, sort_order)\n` +
          `SELECT ci.id, ${lit(topic)}, ${(index + 1) * 10}\n` +
          `  FROM content_items ci\n` +
          ` WHERE ci.content_type = 'press_release' AND ci.slug = ${lit(release.slug)};`,
      ),
    );
  }
  for (const position of POSITIONS) {
    position.topics.forEach((topic, index) =>
      topicRows.push(
        `INSERT IGNORE INTO content_item_topics (content_item_id, topic_slug, sort_order)\n` +
          `SELECT ci.id, ${lit(topic)}, ${(index + 1) * 10}\n` +
          `  FROM content_items ci\n` +
          ` WHERE ci.content_type = 'policy_position' AND ci.slug = ${lit(position.slug)};`,
      ),
    );
  }
  statements.push(...topicRows);

  /* ---------------------------------------------------------------------- */

  GALLERY.images.forEach((image, index) =>
    statements.push(
      [
        "INSERT IGNORE INTO content_gallery_images (album_item_id, media_id, sort_order)",
        `SELECT ${itemId("gallery_album", GALLERY.slug)}, ma.id, ${(index + 1) * 10}`,
        `  FROM media_assets ma`,
        ` WHERE ma.src = ${lit(image.src)};`,
      ].join("\n"),
    ),
  );

  /* ---------------------------------------------------------------------- */

  const header = [
    "-- 0017 — the launch content.",
    "--",
    "-- GENERATED by scripts/seed-content.ts from src/content/seed-data.ts.",
    "-- Edit the fixtures and regenerate; do not edit this file by hand. Once it",
    "-- has been applied its checksum is recorded, so a regeneration that changes",
    "-- it will be refused by the migration runner — which is correct: content",
    "-- that has reached a database is the admin's to change, not a seed's.",
    "--",
    "-- `INSERT IGNORE` throughout, so re-running is a no-op and nothing here can",
    "-- stamp over an editor's correction. Foreign keys resolve through subqueries",
    "-- on natural keys (`media_assets.src`, `content_items (content_type, slug)`)",
    "-- rather than `LAST_INSERT_ID()`, which is what makes that true.",
    "--",
    `-- ${media.length} images, ${itemRows.length} content items, ` +
      `${topicRows.length} topic tags, ${GALLERY.images.length} gallery placements.`,
    "--",
    "-- Every instant is UTC. The fixtures were written as Pakistani local times",
    "-- and converted here, because DATETIME stores a literal with no zone",
    "-- conversion and `formatDate` renders in Asia/Karachi.",
    "",
  ].join("\n");

  const file = path.join(process.cwd(), "migrations", "0017_seed_content.sql");
  writeFileSync(file, `${header}\n${statements.join("\n\n")}\n`, "utf8");

  console.log(
    `Wrote ${path.relative(process.cwd(), file)}: ` +
      `${statements.length} statements, ${itemRows.length} content items, ` +
      `${media.length} images.`,
  );
  return 0;
}

process.exit(main());
