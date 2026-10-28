-- 0002 — uploaded documents and the access log.
--
-- `application_id` and `membership_id` are nullable and carry no foreign key
-- yet: those tables arrive with the membership track. The constraints are
-- added in that migration rather than here, so this file applies cleanly on a
-- database that has no membership schema at all.

CREATE TABLE documents (
  -- A UUID, and the only identifier ever exposed. Unguessable ids are defence
  -- in depth; the actual control is the per-request ownership check in
  -- authorizeDocument(). Both, not either.
  id                     CHAR(36) NOT NULL,
  application_id         BIGINT UNSIGNED NULL,
  membership_id          BIGINT UNSIGNED NULL,
  document_type_code     VARCHAR(40) NOT NULL,
  subject_kind           ENUM('company','representative','director','endorser','payment') NOT NULL,
  -- Which director, which endorser. Null for company-level documents.
  subject_id             BIGINT UNSIGNED NULL,
  -- The name the client sent. Data, never a path component: the stored path
  -- derives from the UUID alone. It is also frequently the PII itself, since
  -- a file called 42201-1234567-8.jpg is a CNIC number — which is the second
  -- reason it is never logged.
  original_filename      VARCHAR(255) NOT NULL,
  -- Relative to PRIVATE_UPLOAD_ROOT, which env.ts asserts is outside the app
  -- root and outside public/.
  storage_key            VARCHAR(300) NOT NULL,
  -- The sniffed type, never the declared one. Serving maps from this through a
  -- hardcoded allowlist, so a tampered row cannot change a response's type.
  mime_type              VARCHAR(100) NOT NULL,
  byte_size              INT UNSIGNED NOT NULL,
  sha256                 CHAR(64) NOT NULL,
  -- Header-parsed only. No pixel decode anywhere at runtime: a 300 dpi A4
  -- scan is roughly 215 MB of raw RGBA in a decoder, and the worker dies.
  pixel_width            SMALLINT UNSIGNED NULL,
  pixel_height           SMALLINT UNSIGNED NULL,
  page_count             SMALLINT UNSIGNED NULL,
  -- For the "bank account-maintenance certificate not older than 3 months"
  -- rule, which is reference data on the document type rather than a constant.
  issued_on              DATE NULL,
  -- Which cipher layout the stored bytes use. 1 = chunked AES-256-GCM, 64 KB
  -- plaintext chunks, each chunk sealed with its own tag and its AAD binding
  -- the file header, this row's id, the chunk index and a final-chunk flag.
  -- There are deliberately no per-file IV or tag columns: the IV prefix is in
  -- the file header and every chunk carries its own tag. Whole-file GCM would
  -- have needed those two columns and would have made Range requests
  -- impossible, which pdf.js and every native viewer rely on to render page
  -- one of a 40-page SECP filing. See src/server/documents/cipher.ts.
  cipher_version         TINYINT UNSIGNED NULL,
  -- The data key, wrapped with the master key from the environment. Envelope
  -- encryption protects against filesystem exposure — a backup tarball leaving
  -- the server, cPanel's own backup store — and not against app compromise.
  encrypted_data_key     VARBINARY(255) NULL,
  scan_state             ENUM('pending','clean','infected','skipped') NOT NULL DEFAULT 'skipped',
  review_state           ENUM('uploaded','accepted','rejected','superseded') NOT NULL DEFAULT 'uploaded',
  review_note            VARCHAR(500) NULL,
  reviewed_by            BIGINT UNSIGNED NULL,
  reviewed_at            DATETIME(3) NULL,
  -- A re-upload answering a deficiency supersedes its predecessor; it never
  -- overwrites it. The audit trail has to show both.
  supersedes_document_id CHAR(36) NULL,
  uploaded_by            BIGINT UNSIGNED NULL,
  uploaded_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Soft only. Evidence is hard-deleted by the retention sweep and by nothing
  -- else, and the sweep leaves a manifest row behind.
  deleted_at             DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_doc_app (application_id, document_type_code, review_state),
  KEY idx_doc_membership (membership_id),
  KEY idx_doc_subject (subject_kind, subject_id),
  -- Earns its keep as a fraud signal, not just for deduplication: the same
  -- CNIC scan appearing under two unrelated firms is worth a reviewer's
  -- attention, and this makes it a one-line query.
  KEY idx_doc_hash (sha256),
  KEY idx_doc_retention (deleted_at, uploaded_at),
  CONSTRAINT fk_doc_supersedes FOREIGN KEY (supersedes_document_id) REFERENCES documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_doc_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_doc_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Written on every fetch, allowed or refused. A chamber holding identity
-- documents will eventually be asked "who looked at my CNIC", and this is the
-- only thing that can answer. It also lets checklist item 3 require that the
-- officer actually opened the original before ticking it.
--
-- `outcome` separates served from denied from not-found, because the HTTP
-- response deliberately does not: a 403 on a real id and a 404 on a fake one
-- is an existence oracle, so both return 404 and the distinction is recorded
-- only here.
CREATE TABLE document_access_log (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id  CHAR(36) NOT NULL,
  user_id      BIGINT UNSIGNED NULL,
  outcome      ENUM('served','denied','not_found') NOT NULL,
  range_header VARCHAR(80) NULL,
  ip_hash      CHAR(64) NULL,
  request_id   CHAR(26) NOT NULL,
  at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_dal_document (document_id, at),
  KEY idx_dal_user (user_id, at),
  KEY idx_dal_retention (at)
  -- Deliberately no foreign key to documents: the retention sweep hard-deletes
  -- a document while the record that it was viewed must survive. The log keeps
  -- the event after the evidence is destroyed, which is the point.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
