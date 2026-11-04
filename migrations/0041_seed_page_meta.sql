-- The heading chips for the pages that have been given the designed header.
--
-- 0039 added the column; this fills it for the pages already using it, so an
-- editor opening one of them in the admin finds the words that are on the page
-- rather than an empty box and no clue what belongs in it. A page whose chips
-- are blank renders without them, which is why this seeds only the pages that
-- have them today.
--
-- The values are the chamber's own standing facts, quoted from lcci.com.pk:
-- 1923 is the founding year the old site prints, and Lahore is where it is.
-- Nothing editorial, nothing computed.
--
-- `WHERE meta_en IS NULL` so re-applying this against a database where an
-- editor has since written their own chips does not overwrite their work.
UPDATE content_pages p
   JOIN content_items ci ON ci.id = p.content_item_id
    SET p.meta_en = 'Established 1923 | Lahore'
  WHERE ci.content_type = 'page'
    AND ci.slug = 'about-history'
    AND p.meta_en IS NULL;
