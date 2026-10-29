-- The note a reviewer leaves when sending an item back.
--
-- The audit log already records that the item was returned to draft and by
-- whom, and it keeps that history forever. What it cannot do is be read by the
-- editor who has to act on it: the log is a permissioned screen, it is
-- append-only and chained, and finding "the reason my press release came back"
-- in it means knowing to look. So the current note lives on the row, where the
-- editor opening the item sees it without being told to go and look.
--
-- The log is still the history. This is the state, and the two are not the
-- same thing — exactly as `users.mfa_required_by` is the current requirement
-- while the audit log holds every change to it.
ALTER TABLE content_items
  -- TEXT rather than VARCHAR: the useful version of this note is two or three
  -- sentences naming what to fix, and a reviewer who hits a length limit
  -- writes a less useful note rather than a shorter one.
  ADD COLUMN review_note TEXT NULL AFTER last_reviewed_at,
  ADD COLUMN review_note_by BIGINT UNSIGNED NULL AFTER review_note,
  ADD COLUMN review_note_at DATETIME(3) NULL AFTER review_note_by,
  -- ON DELETE SET NULL: a reviewer leaving the chamber must not delete the
  -- feedback somebody else is still working from. The note survives without
  -- an author, and the screen says "a reviewer" when it cannot name one.
  ADD CONSTRAINT fk_content_items_review_note_by
    FOREIGN KEY (review_note_by) REFERENCES users (id) ON DELETE SET NULL;

-- Nothing is backfilled. Every existing row is either a draft nobody has
-- reviewed or seeded launch content that went straight to published, and
-- inventing a review note for either would be inventing a review.
