-- The order the chamber's office-bearers are listed in.
--
-- `sort_order` is on `content_items` and defaults to 0, so without this the
-- three office-bearers come out alphabetically — "Mr. Ali Hussam Asghar, Mr.
-- Khadim Hussain, Sardar Usman Ghani" — which puts the Vice President ahead of
-- the Senior Vice President. That is the one piece of order on these rows that
-- is not alphabetical and not arbitrary, so it is written down.
--
-- Matched on the post rather than the name: a term ends and the names change,
-- and the next holder of the post should inherit its place in the band without
-- anybody remembering this file exists.
UPDATE content_portraits p
   JOIN content_items ci ON ci.id = p.content_item_id
    SET ci.sort_order = CASE p.role
          WHEN 'President' THEN 1
          WHEN 'Senior Vice President' THEN 2
          WHEN 'Vice President' THEN 3
          ELSE ci.sort_order
        END
  WHERE ci.content_type = 'portrait'
    AND p.role IN ('President', 'Senior Vice President', 'Vice President')
    AND ci.sort_order = 0;
