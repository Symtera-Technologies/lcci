-- A page of prose, as content.
--
-- The site's information architecture has 48 public pages behind it, and most
-- of them are a title, an introduction and some editorial copy: history and
-- mission, why join, what attestation costs, how to book a delegation, the
-- privacy policy. Giving each of those a content type of its own would mean
-- 30-odd near-identical satellite tables; hard-coding their copy would put the
-- chamber's own words behind a deploy, which is what the hero migration just
-- finished undoing.
--
-- So one type, used many times, keyed by slug. A route file decides *where* a
-- page appears and what structured extras sit around it; this table holds what
-- somebody writes.
--
-- **This is not a page builder.** There is no layout field, no block list and
-- no way for an editor to decide where anything goes. The route files are the
-- IA — reviewable as a diff, with typed hrefs and a breadcrumb that cannot
-- point somewhere that does not exist — and a slug that no route reads renders
-- nowhere. That boundary is the point: LCCI owns the words, the repository
-- owns the structure.

-- Appended, for the reason 0022 gives: MySQL stores an ENUM as the ordinal of
-- its value, so adding at the end is metadata-only and inserting in the middle
-- rewrites every row.
ALTER TABLE content_items
  MODIFY content_type ENUM(
    'press_release','event','policy_position','notice',
    'key_figure','economic_indicator','service_tile',
    'committee','partner','testimonial','video',
    'gallery_album','hero','page'
  ) NOT NULL;

CREATE TABLE content_pages (
  content_item_id BIGINT UNSIGNED NOT NULL,

  -- The line under the heading. Separate from the body so it can be styled as
  -- a standfirst and reused as the link description on a section index without
  -- parsing the first paragraph out of the markup.
  standfirst_en   VARCHAR(600) NULL,
  standfirst_ur   VARCHAR(800) NULL,

  -- Sanitised on write by `src/content/sanitise.ts`, stored sanitised, and
  -- MEDIUMTEXT rather than TEXT for the reason 0018 sets out: TEXT caps at
  -- 65,535 *bytes* and utf8mb4 Urdu runs to three bytes a character, so a long
  -- Urdu page would truncate silently.
  --
  -- Nullable, like `content_press_releases.body_en`. A page is routinely
  -- created before anybody has written it, and the editor autosaves from the
  -- first keystroke.
  body_en         MEDIUMTEXT NULL,
  body_ur         MEDIUMTEXT NULL,

  -- An optional banner. Most of these pages are text and want none, which is
  -- why there is no NOT NULL here and no placeholder behind it: a page with no
  -- image renders as a page with no image, not as a grey rectangle.
  hero_image_id   BIGINT UNSIGNED NULL,

  PRIMARY KEY (content_item_id),
  KEY idx_page_hero (hero_image_id),
  CONSTRAINT fk_page_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_page_hero FOREIGN KEY (hero_image_id) REFERENCES media_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
