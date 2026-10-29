-- 0016 — the content tables, and the first schema where `status` means something.
--
-- `src/content/types.ts` has declared `status` and `ownerDepartment` on every
-- content type since the first commit, and nothing has read either: the
-- repository returned fixtures, so a "draft" press release was a value in an
-- object literal that no code branch tested. This migration is what makes them
-- load-bearing. The four consequences are stated in the plan and all of them
-- live behind `src/content/repository.ts`, whose public signatures do not
-- change:
--
--   1. Every list read gains `status = 'published' AND published_at <= NOW()`,
--      so a scheduled publish needs no cron for *correctness*. Cron only
--      triggers cache revalidation, which is why `published_at` is an instant
--      and not a date.
--   2. Preview is a separate permissioned path, not a query parameter.
--   3. `archived` is excluded from lists and the sitemap but still resolves at
--      its own URL. ~890 legacy press URLs are being 301'd into this space and
--      archiving must not manufacture 404s — so archived rows stay here, with
--      their slugs, for ever.
--   4. `department_code` is the row-scoping predicate for `department_editor`,
--      matching `user_roles.scope_value` where `scope_kind = 'department'`.
--
-- **One parent table, one satellite per type.** Twelve independent tables each
-- carrying its own copy of the workflow columns would mean twelve copies of the
-- Draft to In review to Published machine, twelve department predicates and
-- twelve audit entity types, and the admin's "what is waiting for review"
-- screen would be a twelve-way UNION. `content_items` carries everything the
-- workflow touches and the satellites carry only what is theirs. The public
-- reads pay one join each, against tables holding a few dozen rows apiece and
-- 890 press releases at the far end of the import — which is nothing.
--
-- **The parent's `title_en` is the single human label**, so no satellite
-- repeats it. A committee's name, a service tile's label, a key figure's label
-- and a partner's name are all that column; the public types expose them under
-- their own field names and the mapping lives in the repository. Two columns
-- holding one string is how the two come to disagree.
--
-- **`sort_order` is not decoration.** Key figures, indicators, service tiles,
-- committees, partners and testimonials have no date to order by, and their
-- fixture order was editorial. Without this column the homepage's order becomes
-- whatever InnoDB returns, which is stable enough to pass review and change
-- later for no reason anyone can trace.
--
-- **No `body` column yet, deliberately.** A press release detail page does not
-- exist and no editor writes rich text, so the storage format — HTML, Markdown,
-- or a structured document — is not yet a decision anyone has had to make.
-- Guessing it here would most likely buy a second migration rather than save
-- one. B2 adds the column alongside the editor and the server-side sanitiser
-- that the plan requires, which is also the first moment the sanitiser has a
-- writer to attach to.

/* -------------------------------------------------------------------------- */
/* Departments: the RBAC scope, with a code instead of prose                  */
/* -------------------------------------------------------------------------- */

-- `BaseContent.ownerDepartment` is a free string today and the fixtures hold
-- display names ("Information Department"). A scope value has to be a stable
-- code: `user_roles.scope_value` is compared, not rendered, and renaming a
-- department must not silently revoke every editor's grant. So the code is the
-- key, the label is data, and the repository returns the label so the public
-- type keeps the shape its callers already read.
CREATE TABLE departments (
  code        VARCHAR(40) NOT NULL,
  name_en     VARCHAR(120) NOT NULL,
  name_ur     VARCHAR(200) NULL,
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The three departments the fixtures name. `INSERT IGNORE` because MySQL does
-- not roll DDL back: a later CREATE TABLE failing leaves this committed, and
-- the re-run must not fail on its own row.
INSERT IGNORE INTO departments (code, name_en, sort_order) VALUES
  ('info',        'Information Department', 10),
  ('research',    'Research Department',    20),
  ('secretariat', 'Secretariat',            30);

/* -------------------------------------------------------------------------- */
/* Topics                                                                     */
/* -------------------------------------------------------------------------- */

-- The eight slugs of `TopicSlug`, as reference data the admin's topic picker
-- can read. The labels are duplicated from `TOPIC_LABELS` in
-- `src/components/ui/tag.tsx`, which is where the public site reads them and
-- where they stay: the union is compile-checked there and a database label
-- cannot be. `tests/content-topics.test.ts` fails if the two sets diverge.
CREATE TABLE content_topics (
  slug        VARCHAR(40) NOT NULL,
  label_en    VARCHAR(120) NOT NULL,
  label_ur    VARCHAR(200) NULL,
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO content_topics (slug, label_en, sort_order) VALUES
  ('taxation-budget',     'Taxation & Budget',   10),
  ('energy',              'Energy',              20),
  ('exports-trade',       'Exports & Trade',     30),
  ('regulation',          'Regulation',          40),
  ('law-order',           'Law & Order',         50),
  ('smes',                'SMEs',                60),
  ('women-entrepreneurs', 'Women Entrepreneurs', 70),
  ('infrastructure',      'Infrastructure',      80);

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

-- One row per image, because `ImageRef` makes `altEn` non-optional and alt text
-- belongs to the photograph rather than to the page that shows it. Storing the
-- alt text beside each reference instead would mean the same hero photograph
-- described three different ways on three screens, and one of them left empty.
--
-- `alt_en NOT NULL` with no default is the schema keeping that promise: there
-- is no way to register an image here without describing it.
--
-- `src` is the served path under `public/` today. The media library (B2) adds
-- upload, and at that point `src` becomes a `DocumentStore` key for new rows
-- while the editorial photographs already in `public/` keep their paths — which
-- is why this is a path column and not a foreign key into `documents`. Those
-- two stores have different access rules: a press photograph is public by
-- design and a CNIC must never be.
--
-- `caption` sits here and not on the reference because today's only captions
-- are the gallery's, and they describe the photograph. A caption that is
-- genuinely per-placement is a column on the placement when one appears.
CREATE TABLE media_assets (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  src             VARCHAR(400) NOT NULL,
  alt_en          VARCHAR(500) NOT NULL,
  alt_ur          VARCHAR(700) NULL,
  width           SMALLINT UNSIGNED NOT NULL,
  height          SMALLINT UNSIGNED NOT NULL,
  caption         VARCHAR(400) NULL,
  -- Who owns it, so the media library can scope the same way content does.
  department_code VARCHAR(40) NULL,
  uploaded_by     BIGINT UNSIGNED NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- One row per file. Registering the same photograph twice is how it acquires
  -- two descriptions.
  UNIQUE KEY uq_media_src (src),
  KEY idx_media_department (department_code),
  CONSTRAINT fk_media_department FOREIGN KEY (department_code) REFERENCES departments (code),
  -- The image outlives the person who uploaded it.
  CONSTRAINT fk_media_uploader FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* -------------------------------------------------------------------------- */
/* The parent: identity, workflow, SEO                                        */
/* -------------------------------------------------------------------------- */

-- `published_at` is NULL while a row has never been published, and the live
-- predicate is `status = 'published' AND published_at <= UTC_TIMESTAMP(3)`.
-- NULL fails that comparison, so a draft cannot leak through a missing date —
-- the absence of a publication date is not a publication date of zero.
--
-- Three columns section 8.3 commits to and `BaseContent` was missing:
--
--   `review_by`              — without it the "content not updated in 12
--                              months" report of B4 cannot be built as
--                              specified, because "updated" is the row's edit
--                              time and says nothing about whether anyone
--                              read it and agreed with it.
--   `scheduled_unpublish_at` — the other half of scheduled publishing. A
--                              notice has its own window; everything else
--                              needed somewhere to put an end date.
--   `published_by` /
--   `last_reviewed_by`       — the actors. `last_reviewed_at` comes with the
--                              second, because a reviewer's name without a
--                              date cannot answer "is this still current".
--
-- The actor columns are `ON DELETE SET NULL`: content outlives staff, and a
-- departed editor must not be able to block a row's deletion or take a press
-- release with them. The audit log holds the name that was snapshotted at the
-- time, which is where that history belongs.
CREATE TABLE content_items (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_type           ENUM(
                           'press_release','event','policy_position','notice',
                           'key_figure','economic_indicator','service_tile',
                           'committee','partner','testimonial','video',
                           'gallery_album'
                         ) NOT NULL,
  slug                   VARCHAR(160) NOT NULL,
  -- The one human label. The public types expose it as `titleEn`, `nameEn`,
  -- `labelEn` or `name` depending on the type; the mapping is the
  -- repository's, not a second column's.
  title_en               VARCHAR(300) NOT NULL,
  title_ur               VARCHAR(400) NULL,
  status                 ENUM('draft','in_review','published','archived') NOT NULL DEFAULT 'draft',
  published_at           DATETIME(3) NULL,
  department_code        VARCHAR(40) NOT NULL,

  seo_title              VARCHAR(300) NULL,
  seo_description        VARCHAR(500) NULL,
  og_image_id            BIGINT UNSIGNED NULL,

  review_by              DATE NULL,
  scheduled_unpublish_at DATETIME(3) NULL,
  published_by           BIGINT UNSIGNED NULL,
  last_reviewed_by       BIGINT UNSIGNED NULL,
  last_reviewed_at       DATETIME(3) NULL,

  -- Editorial order for the types with no date to sort by.
  sort_order             SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  -- Optimistic concurrency, the same shape the application machine uses: two
  -- editors in one record is a near certainty in a secretariat of fifteen.
  version                INT UNSIGNED NOT NULL DEFAULT 1,
  created_by             BIGINT UNSIGNED NULL,
  created_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at             DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Per type, because `/news/{slug}` and `/events/{slug}` are different spaces
  -- and a seminar may legitimately share a slug with the press release
  -- announcing it.
  UNIQUE KEY uq_content_slug (content_type, slug),
  -- The shape of every public list read.
  KEY idx_content_live (content_type, status, published_at),
  -- The shape of the admin list under a department scope.
  KEY idx_content_department (department_code, status, content_type),
  -- B4's two reports.
  KEY idx_content_review_by (review_by),
  KEY idx_content_unpublish (scheduled_unpublish_at),
  CONSTRAINT fk_content_department FOREIGN KEY (department_code) REFERENCES departments (code),
  CONSTRAINT fk_content_og_image FOREIGN KEY (og_image_id) REFERENCES media_assets (id),
  CONSTRAINT fk_content_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_content_published_by FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_content_reviewed_by FOREIGN KEY (last_reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Topics on the two types that carry them. A join table rather than a JSON
-- array because "every press release tagged Energy" is the newsroom's main
-- filter and the plan forbids relying on JSON indexing on a host that is as
-- likely to be MariaDB as MySQL.
CREATE TABLE content_item_topics (
  content_item_id BIGINT UNSIGNED NOT NULL,
  topic_slug      VARCHAR(40) NOT NULL,
  sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (content_item_id, topic_slug),
  -- The filter direction.
  KEY idx_topic_items (topic_slug, content_item_id),
  CONSTRAINT fk_item_topic_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_item_topic_topic FOREIGN KEY (topic_slug) REFERENCES content_topics (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* -------------------------------------------------------------------------- */
/* Satellites                                                                 */
/* -------------------------------------------------------------------------- */

-- Each satellite's primary key IS its parent's id: one row, never two, deleted
-- with it. `ON DELETE CASCADE` throughout, because a press release's summary
-- has no meaning without the press release.

CREATE TABLE content_press_releases (
  content_item_id BIGINT UNSIGNED NOT NULL,
  summary         VARCHAR(700) NOT NULL,
  hero_image_id   BIGINT UNSIGNED NULL,
  -- Named in the release itself. Not a user id: the spokesperson is usually
  -- the President or a Senior Vice President, who has no account here.
  spokesperson    VARCHAR(200) NULL,
  PRIMARY KEY (content_item_id),
  KEY idx_press_hero (hero_image_id),
  CONSTRAINT fk_press_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_press_hero FOREIGN KEY (hero_image_id) REFERENCES media_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `fee` is prose, not money, and that is what the public type says: the
-- fixtures hold phrases rather than amounts. Event bookings (B9) need an
-- amount and a currency to charge against, which is a different pair of
-- columns added then — not this one reinterpreted.
CREATE TABLE content_events (
  content_item_id       BIGINT UNSIGNED NOT NULL,
  event_type            ENUM('seminar','training','agm','delegation','exhibition') NOT NULL,
  starts_at             DATETIME(3) NOT NULL,
  ends_at               DATETIME(3) NULL,
  venue                 VARCHAR(300) NOT NULL,
  fee                   VARCHAR(160) NULL,
  capacity              SMALLINT UNSIGNED NULL,
  registration_open     TINYINT(1) NOT NULL DEFAULT 0,
  registration_deadline DATETIME(3) NULL,
  PRIMARY KEY (content_item_id),
  -- `getUpcomingEvents` is `starts_at >= now ORDER BY starts_at`.
  KEY idx_event_start (starts_at),
  CONSTRAINT fk_event_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `position_status` and not `status`: the parent already owns `status`, which
-- is the editorial workflow, and this is where the chamber's ask has got to
-- with government. A row can be a published position about an unresolved
-- issue, or a draft about an accepted one, and collapsing the two would make
-- "accepted" unpublishable.
CREATE TABLE content_policy_positions (
  content_item_id BIGINT UNSIGNED NOT NULL,
  issue           VARCHAR(500) NOT NULL,
  chamber_ask     VARCHAR(900) NOT NULL,
  position_status ENUM('raised','under_review','accepted','resolved') NOT NULL DEFAULT 'raised',
  PRIMARY KEY (content_item_id),
  CONSTRAINT fk_position_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `ends_at NOT NULL` is the structural fix the type comment describes: the
-- legacy homepage stacked four modal pop-ups with no expiry, and the schema is
-- where "a notice cannot exist without an end date" stops being a convention.
--
-- The notice's own window is separate from the parent's publication state. A
-- notice is published when an editor has approved it; it is *live* when now
-- falls inside its window. `getActiveNotice` requires both.
CREATE TABLE content_notices (
  content_item_id BIGINT UNSIGNED NOT NULL,
  message_en      VARCHAR(600) NOT NULL,
  message_ur      VARCHAR(900) NULL,
  href            VARCHAR(400) NULL,
  level           ENUM('info','urgent') NOT NULL DEFAULT 'info',
  starts_at       DATETIME(3) NOT NULL,
  ends_at         DATETIME(3) NOT NULL,
  PRIMARY KEY (content_item_id),
  KEY idx_notice_window (starts_at, ends_at),
  CONSTRAINT fk_notice_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `verified_at` is a civil date, not an instant: it is rendered as a "figures
-- verified on" stamp, and a timezone must never turn 30 September into the
-- 29th for a reader abroad. The same reasoning as `memberships.valid_until`.
CREATE TABLE content_key_figures (
  content_item_id BIGINT UNSIGNED NOT NULL,
  -- The counter's target. INT and not DECIMAL: every figure is a count.
  figure_value    INT NOT NULL,
  -- Rendered after the counter: "+", "k+".
  suffix          VARCHAR(8) NULL,
  verified_at     DATE NOT NULL,
  PRIMARY KEY (content_item_id),
  CONSTRAINT fk_key_figure_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `measured_at` is the date the *figure* is current to, and it is deliberately
-- not `content_items.updated_at`. The ticker renders it as "checked 24 Oct",
-- so mapping it to the row's edit time would make correcting a typo claim the
-- State Bank republished its reserves. The public type calls it `updatedAt`;
-- the repository maps it, and this column's name is the reminder.
CREATE TABLE content_economic_indicators (
  content_item_id BIGINT UNSIGNED NOT NULL,
  -- Prose, as the type says: the unit is part of the figure and the source
  -- quotes it that way.
  display_value   VARCHAR(60) NOT NULL,
  change_pct      DECIMAL(6,2) NULL,
  -- Which direction is good news, so colour cannot mislead: inflation falling
  -- and exports rising are both green.
  good_when       ENUM('up','down','neutral') NOT NULL DEFAULT 'neutral',
  source          VARCHAR(200) NOT NULL,
  measured_at     DATE NOT NULL,
  PRIMARY KEY (content_item_id),
  CONSTRAINT fk_indicator_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `icon` is an ENUM and not a free string because the component maps it to one
-- of five drawn SVGs. A sixth value typed into an admin field would render
-- nothing, silently, which is the same failure mode as an undefined Tailwind
-- token. Adding an icon is a migration and a component change, together.
CREATE TABLE content_service_tiles (
  content_item_id BIGINT UNSIGNED NOT NULL,
  description     VARCHAR(600) NOT NULL,
  href            VARCHAR(300) NOT NULL,
  icon            ENUM('renew','certificate','attestation','circular','directory') NOT NULL,
  PRIMARY KEY (content_item_id),
  CONSTRAINT fk_service_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_committees (
  content_item_id BIGINT UNSIGNED NOT NULL,
  mandate         VARCHAR(700) NOT NULL,
  member_count    SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (content_item_id),
  CONSTRAINT fk_committee_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_partners (
  content_item_id BIGINT UNSIGNED NOT NULL,
  tier            ENUM('strategic','gold','silver') NOT NULL,
  -- Nullable because today every partner is a typeset wordmark pending
  -- artwork, and a row that claimed a logo it has not got would render a
  -- broken image on the homepage.
  logo_id         BIGINT UNSIGNED NULL,
  PRIMARY KEY (content_item_id),
  KEY idx_partner_logo (logo_id),
  CONSTRAINT fk_partner_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_partner_logo FOREIGN KEY (logo_id) REFERENCES media_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_testimonials (
  content_item_id BIGINT UNSIGNED NOT NULL,
  quote           VARCHAR(900) NOT NULL,
  author_name     VARCHAR(200) NOT NULL,
  author_role     VARCHAR(200) NOT NULL,
  company         VARCHAR(250) NOT NULL,
  PRIMARY KEY (content_item_id),
  CONSTRAINT fk_testimonial_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `orientation` travels with the content for the reason the type says: the
-- channel mixes landscape films with vertical Shorts, YouTube pads a Short's
-- thumbnail out to 16:9 with a blurred copy of itself, and a section that
-- cannot tell them apart frames half its items wrongly.
--
-- `poster_id NOT NULL`: the poster is what the facade shows before a visitor
-- plays, and a video without one would fetch its thumbnail from Google —
-- which is exactly what the facade exists to prevent, and what keeps YouTube
-- out of the public CSP's `img-src`.
CREATE TABLE content_videos (
  content_item_id BIGINT UNSIGNED NOT NULL,
  youtube_id      VARCHAR(24) NOT NULL,
  orientation     ENUM('landscape','portrait') NOT NULL,
  poster_id       BIGINT UNSIGNED NOT NULL,
  -- Editorial standfirst, carried by the feature film only.
  description     VARCHAR(900) NULL,
  PRIMARY KEY (content_item_id),
  -- The same film featured twice is an editing mistake, not a decision.
  UNIQUE KEY uq_video_youtube (youtube_id),
  KEY idx_video_poster (poster_id),
  CONSTRAINT fk_video_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_video_poster FOREIGN KEY (poster_id) REFERENCES media_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- `occurred_at` is when the photographs were taken, which is not when the
-- album was published. The legacy "Picture Gallery" had neither, so there was
-- no way to tell a photograph from last month from one from 2015.
CREATE TABLE content_gallery_albums (
  content_item_id BIGINT UNSIGNED NOT NULL,
  description     VARCHAR(900) NOT NULL,
  occurred_at     DATETIME(3) NOT NULL,
  PRIMARY KEY (content_item_id),
  KEY idx_album_occurred (occurred_at),
  CONSTRAINT fk_album_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A placement, not a copy: the photograph and its alt text live in
-- `media_assets` and may appear in a second album without being described
-- again.
CREATE TABLE content_gallery_images (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  album_item_id BIGINT UNSIGNED NOT NULL,
  media_id      BIGINT UNSIGNED NOT NULL,
  sort_order    SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (id),
  -- The same photograph placed twice in one album is a duplicate on screen.
  UNIQUE KEY uq_gallery_placement (album_item_id, media_id),
  KEY idx_gallery_album (album_item_id, sort_order),
  KEY idx_gallery_media (media_id),
  CONSTRAINT fk_gallery_album FOREIGN KEY (album_item_id) REFERENCES content_gallery_albums (content_item_id) ON DELETE CASCADE,
  CONSTRAINT fk_gallery_media FOREIGN KEY (media_id) REFERENCES media_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
