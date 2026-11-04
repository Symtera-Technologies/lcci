-- The heading chips for the About section's landing page.
--
-- Same two standing facts as /about/history, and the same reasoning as
-- 0041: the route carries them as a default so a page nobody has edited still
-- shows the right thing, and this fills the column so that an editor opening
-- the page in the admin can see and change what is on it.
--
-- Not seeded for the rest of About, deliberately. Leadership, the roll of
-- past presidents, the minutes and the secretariat have no standing fact that
-- is theirs rather than the chamber's: a count of former presidents would be
-- this repository asserting a number nobody published, and the one thing worse
-- than a page with no chips is a page with a wrong one on it.
UPDATE content_pages p
   JOIN content_items ci ON ci.id = p.content_item_id
    SET p.meta_en = 'Established 1923 | Lahore'
  WHERE ci.content_type = 'page'
    AND ci.slug = 'about'
    AND p.meta_en IS NULL;
