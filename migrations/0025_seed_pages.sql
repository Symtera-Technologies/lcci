-- The About section's rows, with no content in them.
--
-- **This migration deliberately writes not one word of copy.** The pages on
-- lcci.com.pk keep their own text, and LCCI maintains it from the admin; our
-- job is the site, not the writing. What a developer can usefully do is make
-- sure the row an editor needs already exists, at the one address the route
-- will look for it at.
--
-- That address is the only thing here that can go wrong invisibly. A route
-- reads its prose from a slug derived mechanically from its path --
-- `/about/history` is `about-history`, see `src/content/page-slug.ts` -- and a
-- row created under any other slug renders a page that looks finished and is
-- permanently blank, because `getPage` returns null, which is also what "not
-- written yet" returns. Nothing throws and nothing logs. Seeding the eight
-- rows here removes that trap for the About section entirely: the editor opens
-- Content -> Site pages, finds all eight already listed, and types into them.
--
-- Every row is `draft`, which is why this is not a content decision:
--
--   * a draft does not satisfy the live predicate, so nothing new appears on
--     the public site when this runs;
--   * each route goes on rendering its heading, description and breadcrumb
--     from the typed IA, with the "being prepared" panel where its body will
--     be, exactly as it did before this file existed;
--   * the moment an editor pastes the real text in and presses publish, the
--     page is live -- no migration, no deploy.
--
-- `title_en` is the page's name from `src/components/site/nav-data.ts`, which
-- the route already falls back to and the header and footer already render. It
-- is here so the admin's list is readable rather than eight bare slugs; an
-- editor renaming a page overwrites it, which is a legitimate editorial act.
--
-- `INSERT IGNORE`, so re-running is a no-op and cannot stamp over an edit.

INSERT IGNORE INTO content_items
  (content_type, slug, title_en, status, published_at, department_code,
   sort_order, updated_at)
VALUES
  -- Ordered as the navigation orders them, so the admin's list reads in the
  -- same order as the section it serves.
  ('page', 'about',                 'About the chamber', 'draft', NULL, 'info',        10, '2026-10-01 05:00:00.000'),
  ('page', 'about-history',         'History & mission', 'draft', NULL, 'info',        20, '2026-10-01 05:00:00.000'),
  ('page', 'about-leadership',      'Leadership',        'draft', NULL, 'info',        30, '2026-10-01 05:00:00.000'),
  ('page', 'about-committees',      'Committees',        'draft', NULL, 'research',    40, '2026-10-01 05:00:00.000'),
  ('page', 'about-past-leadership', 'Past leadership',   'draft', NULL, 'info',        50, '2026-10-01 05:00:00.000'),
  ('page', 'about-secretariat',     'Secretariat',       'draft', NULL, 'secretariat', 60, '2026-10-01 05:00:00.000'),
  ('page', 'about-careers',         'Careers',           'draft', NULL, 'secretariat', 70, '2026-10-01 05:00:00.000'),
  ('page', 'about-contact',         'Contact',           'draft', NULL, 'secretariat', 80, '2026-10-01 05:00:00.000')
;

-- The satellite row, entirely empty. `content_pages` is a 1:1 table and the
-- editor's save writes to it by `content_item_id`, so the row has to exist
-- before there is anything to put in it. Every column on it is nullable
-- precisely so that this is possible.
INSERT IGNORE INTO content_pages
  (content_item_id, standfirst_en, standfirst_ur, body_en, body_ur, hero_image_id)
SELECT ci.id, NULL, NULL, NULL, NULL, NULL
  FROM content_items ci
 WHERE ci.content_type = 'page'
   AND ci.slug IN (
     'about', 'about-history', 'about-leadership', 'about-committees',
     'about-past-leadership', 'about-secretariat', 'about-careers',
     'about-contact'
   );
