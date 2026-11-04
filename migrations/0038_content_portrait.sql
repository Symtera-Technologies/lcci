-- A photograph of a named person, so the chamber's people can have faces.
--
-- lcci.com.pk publishes a portrait beside each of its office-bearers and each
-- of its sixty-one former presidents. The rebuild imported those pages' words
-- and none of their faces, for a specific reason: `sanitiseBody` drops `<img>`
-- on write, because an image with no alt text is how an undescribed
-- photograph reaches a page. That is the right rule and this is the way round
-- it — a picture with a name, a description and an owner, stored as content
-- rather than smuggled through a rich-text field.
--
-- ## Why the person's name is the title, and the roster is still prose
--
-- The former presidents' names, years and firms are *already* on
-- `/about/past-leadership`, as the body text lifted off `presidents.php`.
-- Those words cannot move: `scripts/verify-migrated-text.ts` holds every run
-- of six consecutive words from the legacy page to the built page.
--
-- So a portrait is not a second copy of the roster. It is a photograph keyed
-- by the name it belongs to: `content_items.title_en` is the person's name as
-- the chamber writes it, `slug` is that name slugified, and the page looks up
-- each name it is already printing. A name with no portrait renders without
-- one; a portrait whose name appears on no page sits in the admin doing
-- nothing. Neither is an error, and neither can corrupt the other.
--
-- That also means an editor adding a photograph of a new office-bearer does
-- it in one place and it appears wherever that person is named, which is the
-- behaviour somebody would expect and the reason not to model this as a field
-- on each page.
--
-- Appended to the ENUM rather than inserted, for the reason 0022 gives: MySQL
-- stores an ENUM as the ordinal of its value, so adding at the end is
-- metadata-only and inserting in the middle rewrites every row.
ALTER TABLE content_items
  MODIFY content_type ENUM(
    'press_release','event','policy_position','notice',
    'key_figure','economic_indicator','service_tile',
    'committee','partner','testimonial','video',
    'gallery_album','hero','page','portrait'
  ) NOT NULL;

CREATE TABLE content_portraits (
  content_item_id BIGINT UNSIGNED NOT NULL,

  -- What the chamber calls the post, as it writes it: "President", "Senior
  -- Vice President". Null for a former president, because the roster prints
  -- the year instead and inventing "Former President" for sixty-one people
  -- would be this repository asserting a title nobody published.
  role            VARCHAR(80) NULL,

  -- The year as the roster prints it, "Year 2023-24". A string and not a pair
  -- of integers: a third of these entries carry no year at all, several give
  -- one year where the term plainly spanned two, and one man is listed twice
  -- for consecutive years. Parsing that into a date range would mean deciding
  -- things the source does not say.
  term            VARCHAR(40) NULL,

  -- NOT NULL, unlike every other image on the site. A page with no banner is
  -- a page with no banner; a portrait with no photograph is a row with no
  -- reason to exist, and allowing one would put an empty frame on a page of
  -- faces.
  photo_id        BIGINT UNSIGNED NOT NULL,

  PRIMARY KEY (content_item_id),
  KEY idx_portrait_photo (photo_id),
  CONSTRAINT fk_portrait_item FOREIGN KEY (content_item_id) REFERENCES content_items (id) ON DELETE CASCADE,
  -- Restrict, not cascade: deleting a photograph out from under a published
  -- portrait would leave the row violating its own NOT NULL. The media library
  -- must refuse, and say which portrait is using it.
  CONSTRAINT fk_portrait_photo FOREIGN KEY (photo_id) REFERENCES media_assets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
