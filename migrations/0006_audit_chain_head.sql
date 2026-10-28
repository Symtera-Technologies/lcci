-- The audit chain's head pointer.
--
-- A hash chain can only be appended to by one writer at a time: two writers
-- that read the same tail both claim to follow it, and the result is not a
-- chain. The intended lock was `SELECT ... FROM audit_log ORDER BY id DESC
-- LIMIT 1 FOR UPDATE`, which has a hole in it — on an empty table there is no
-- row to lock, so every concurrent writer reads "no predecessor" and every one
-- of them writes a genesis row. That is precisely the state the table is in on
-- a fresh install, and on this host it is also the state after any restore.
--
-- A single permanent row gives every writer something to lock, empty log or
-- not, and makes reading the head an O(1) primary-key lookup instead of an
-- index scan to the end of a growing table.
--
-- This table is a pointer, not evidence. `audit_log` remains the record, and
-- the application's MySQL user keeps INSERT-only on it; this row is rebuildable
-- from the log at any time, so granting UPDATE here costs nothing that the
-- INSERT-only grant was protecting.

CREATE TABLE audit_chain_head (
  -- Always 1. A one-row table, keyed so that it stays one row.
  id         TINYINT UNSIGNED NOT NULL,
  head_hash  CHAR(64) NULL,
  head_id    BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seeded NULL: an empty chain has no head, which is different from not knowing
-- what the head is.
INSERT INTO audit_chain_head (id, head_hash, head_id, updated_at)
VALUES (1, NULL, NULL, UTC_TIMESTAMP(3));
