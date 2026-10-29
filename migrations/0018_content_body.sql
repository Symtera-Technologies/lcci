-- 0018 — rich text, now that something writes it.
--
-- Migration 0016 deliberately shipped without a `body` column: no editor
-- existed, no detail page rendered one, and the storage format was not yet a
-- decision anybody had had to make. Guessing it then would most likely have
-- bought a second migration rather than saved one. The editor arrives with
-- this change, so the decision is now live and is recorded here.
--
-- **The format is a narrow subset of HTML**, sanitised on write by
-- `src/content/sanitise.ts` and stored sanitised. Not Markdown, and not a
-- structured document format. Three reasons:
--
--   1. The ~890 legacy press releases being imported are HTML. Converting them
--      to anything else is a lossy pass over content nobody can proofread at
--      that volume.
--   2. The public pages render with `dangerouslySetInnerHTML`, and the thing
--      that makes that safe is the sanitiser, which has to run somewhere
--      regardless of the format. A Markdown pipeline would still need it,
--      because Markdown permits inline HTML.
--   3. The public CSP carries `'unsafe-inline'` for `script-src` — the honest
--      cost of keeping the site statically generated, since the App Router
--      emits per-page inline bootstraps. What makes that tolerable is the
--      absence of an injection sink, and this column is the only place on the
--      public site where editor-supplied markup reaches a page. Sanitising on
--      **write** rather than on render means a bypassed render path cannot
--      produce an unsanitised page, and means the stored bytes are the audited
--      bytes.
--
-- `MEDIUMTEXT` and not `TEXT`: `TEXT` caps at 65,535 **bytes**, and utf8mb4
-- Urdu runs to three bytes a character, so a long Urdu release would truncate
-- silently at roughly 21,000 characters. Silent truncation of editorial copy
-- is the kind of defect nobody reports for months.
--
-- No `FULLTEXT` index here yet. Search is behind its own adapter and the
-- plan's open question on Urdu tokenisation is unanswered — MySQL's `ngram`
-- parser is CJK-only, so an index added now would be built on the wrong
-- analyser for half the content.

ALTER TABLE content_press_releases
  ADD COLUMN body_en MEDIUMTEXT NULL AFTER summary,
  ADD COLUMN body_ur MEDIUMTEXT NULL AFTER body_en;

-- Events and policy positions get one too. An event page that can only say
-- where and when is the legacy site's events page; a position whose argument
-- cannot be set out is a headline with an ask under it.
ALTER TABLE content_events
  ADD COLUMN body_en MEDIUMTEXT NULL AFTER venue,
  ADD COLUMN body_ur MEDIUMTEXT NULL AFTER body_en;

ALTER TABLE content_policy_positions
  ADD COLUMN body_en MEDIUMTEXT NULL AFTER chamber_ask,
  ADD COLUMN body_ur MEDIUMTEXT NULL AFTER body_en;
