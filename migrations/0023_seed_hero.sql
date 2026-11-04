-- The launch hero: exactly what `src/components/v2/hero.tsx` hard-coded.
--
-- Copied verbatim rather than rewritten, so that moving the hero into the CMS
-- is a change of *where the text lives* and not a change to the text. Anything
-- else would conflate two reviews -- "does the editor work?" and "is the new
-- headline right?" -- and the second one belongs to LCCI, not to this
-- migration. The 20,000 figure and the 1923 date are both approved copy.
--
-- A separate file rather than a regeneration of 0017, which is already applied
-- on the staging host: the runner is checksummed, so editing an applied
-- migration is refused -- correctly, and loudly.
--
-- `INSERT IGNORE`, so re-running is a no-op and cannot stamp over an edit an
-- editor has since made in the admin. A seed establishes the first hero; after
-- that the admin owns it.
--
-- Images are referenced through `media_assets.src`, which 0017 already
-- registered with these exact descriptions. That is the point of the natural
-- key: no `LAST_INSERT_ID()`, so this file can be pasted into phpMyAdmin on
-- its own.

INSERT IGNORE INTO content_items
  (content_type, slug, title_en, title_ur, status, published_at,
   department_code, review_by, sort_order, updated_at)
VALUES
  -- `title_en` is the admin's label for this row and is never shown to a
  -- visitor -- the headline is. Dated 2026-10-01 so it sits behind every
  -- seeded press release, which matters only to the admin's ordering.
  --
  -- `review_by` is set, unlike most seeded rows: the hero carries a headline
  -- figure and a year count that both go stale on a schedule nobody is
  -- reminded of, so B4's stale-content report is exactly the right place for
  -- it to resurface.
  ('hero', 'launch-hero', 'Launch hero — 20,000 businesses', NULL, 'published',
   '2026-10-01 05:00:00.000', 'info', '2027-04-01', 10, '2026-10-01 05:00:00.000')
;

INSERT IGNORE INTO content_heroes
  (content_item_id,
   badge_en,
   headline_en, headline_ur, headline_highlight_en,
   subhead_en, subhead_ur,
   primary_cta_label_en, primary_cta_href,
   secondary_cta_label_en, secondary_cta_href,
   member_prompt_en, member_link_label_en, member_link_href,
   caption_en,
   stat_value_en, stat_label_en,
   lead_image_id, behind_image_id, front_image_id)
SELECT
  ci.id,
  'Serving Lahore’s businesses since 1923',
  'The chamber that speaks for 20,000 businesses in Lahore.',
  NULL,
  -- Must occur in the headline exactly; the renderer greens the first match
  -- and falls back to a plain headline when it finds none.
  '20,000 businesses',
  'Join or renew online, get your certificates of origin and attestation without a trip across the city, and put your case to government through the chamber’s committees.',
  NULL,
  'Join LCCI', '/membership/apply',
  'Smart Services', '/services',
  -- The component shipped pointing this at `/portal`, which this app does not
  -- serve. Corrected here to the route that exists.
  'Already a member?', 'Sign in to renew or track a request', '/membership/sign-in',
  'Annual General Meeting',
  '103', 'years of advocacy',
  (SELECT id FROM media_assets WHERE src = '/photos/hero-6.jpg'),
  (SELECT id FROM media_assets WHERE src = '/photos/hero-1.jpg'),
  (SELECT id FROM media_assets WHERE src = '/photos/hero-2.jpg')
  FROM content_items ci
 WHERE ci.content_type = 'hero' AND ci.slug = 'launch-hero';
