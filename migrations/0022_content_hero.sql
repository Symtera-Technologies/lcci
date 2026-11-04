-- The homepage hero, as content rather than as code.
--
-- Everything a visitor reads above the fold -- the badge, the headline, the
-- three photographs, both buttons, the caption chip and the stat chip -- was
-- hard-coded in `src/components/v2/hero.tsx`. That made the single most
-- visible text on the site the only text on the site that needed a developer,
-- a build and a deploy to change, which is backwards: a chamber whose
-- president changes annually and whose headline figure is quoted in press
-- releases needs to edit this more often than it edits a press release.
--
-- It is a content type rather than a settings table because the chamber
-- already has a workflow for content and none for settings. As a content type
-- the hero inherits draft -> in review -> published, department scoping, the
-- audit log, scheduled publication, the stale-content report and the media
-- library, all of which it needs and none of which a `site_settings` row
-- would have had.

-- Appended, never inserted. MySQL stores an ENUM as the ordinal of its value,
-- so adding 'hero' at the end is a metadata-only change, while slipping it in
-- alphabetically would renumber every existing row's type in place -- a full
-- table rebuild, and a silent corruption if it were ever interrupted.
ALTER TABLE content_items
  MODIFY content_type ENUM(
    'press_release','event','policy_position','notice',
    'key_figure','economic_indicator','service_tile',
    'committee','partner','testimonial','video',
    'gallery_album','hero'
  ) NOT NULL;

-- One row is live at a time, and which one is decided by the publication date
-- rather than by a flag. That is deliberate: `published_at` is already
-- scheduled, audited and reversible, so "this hero goes up on Monday" needs
-- no new column and no new screen, and reverting is republishing the previous
-- row. A `is_active` boolean would have been a second, unscheduled, unaudited
-- answer to a question the workflow already answers.
CREATE TABLE content_heroes (
  content_item_id BIGINT UNSIGNED NOT NULL,

  -- The small capitalised line above the headline.
  badge_en        VARCHAR(120) NOT NULL,

  -- The h1, in full and as one string.
  --
  -- `headline_highlight_en` is the phrase inside it that renders in brand
  -- green. Stored as a phrase and matched at render rather than as three
  -- columns of lead/highlight/tail: three columns make the editor responsible
  -- for the spaces between them, and a missing space is invisible in the form
  -- and obvious on the homepage. A phrase that does not occur in the headline
  -- renders the headline plain, which is a legible failure rather than a
  -- broken one.
  headline_en     VARCHAR(300) NOT NULL,
  headline_ur     VARCHAR(400) NULL,
  headline_highlight_en VARCHAR(120) NULL,

  subhead_en      VARCHAR(600) NOT NULL,
  subhead_ur      VARCHAR(800) NULL,

  -- Urdu on the headline and the subhead only, which is where the prose is.
  -- The badge, the button labels and the two chips are short structural
  -- strings, and the rest of the schema does not translate those either --
  -- `content_videos.description` has no Urdu column for the same reason.
  -- Adding them later is an ALTER and four field specs.

  primary_cta_label_en   VARCHAR(80) NOT NULL,
  primary_cta_href       VARCHAR(300) NOT NULL,
  -- Both halves nullable together: a hero with one button is a legitimate
  -- choice, and the renderer omits the second entirely when the label is
  -- absent.
  secondary_cta_label_en VARCHAR(80) NULL,
  secondary_cta_href     VARCHAR(300) NULL,

  -- The quiet line under the buttons, for members who already have an
  -- account. Its destination is editable because it is the one link here that
  -- has already been wrong: the component shipped pointing at `/portal`,
  -- which is not a route this app serves.
  member_prompt_en       VARCHAR(160) NULL,
  member_link_label_en   VARCHAR(80) NULL,
  member_link_href       VARCHAR(300) NULL,

  -- The glass chip on the lead photograph, naming the occasion.
  caption_en      VARCHAR(120) NULL,

  -- The second chip: a figure and what it counts. A string, not an integer --
  -- the chamber writes "103" this year and may write "100+" next.
  stat_value_en   VARCHAR(12) NULL,
  stat_label_en   VARCHAR(80) NULL,

  -- Three planes, three photographs, all required.
  --
  -- The composition's depth is shadow, scale and perspective across exactly
  -- three frames; with two it reads as a mistake rather than as staging. So
  -- these are NOT NULL and the editor demands all three, rather than the
  -- renderer guessing at a two-frame layout that was never designed.
  --
  -- Alt text is not here. It lives on `media_assets`, which is the only place
  -- it can be right: the same photograph used in the hero and in a press
  -- release must describe itself the same way, and a second copy of the
  -- description is a second copy to get wrong.
  lead_image_id   BIGINT UNSIGNED NOT NULL,
  behind_image_id BIGINT UNSIGNED NOT NULL,
  front_image_id  BIGINT UNSIGNED NOT NULL,

  PRIMARY KEY (content_item_id),
  KEY idx_hero_lead (lead_image_id),
  KEY idx_hero_behind (behind_image_id),
  KEY idx_hero_front (front_image_id),
  CONSTRAINT fk_hero_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  -- No ON DELETE: deleting a photograph that the homepage is currently
  -- displaying should be refused by the database, not cascade into a hero
  -- with a missing plane or silently null it out.
  CONSTRAINT fk_hero_lead FOREIGN KEY (lead_image_id) REFERENCES media_assets (id),
  CONSTRAINT fk_hero_behind FOREIGN KEY (behind_image_id) REFERENCES media_assets (id),
  CONSTRAINT fk_hero_front FOREIGN KEY (front_image_id) REFERENCES media_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
