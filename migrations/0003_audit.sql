-- 0003 — the audit log.
--
-- One polymorphic, append-only, hash-chained table covering content and
-- membership alike, so spec section 8.3's "full audit log of changes" has one
-- implementation rather than two that drift.
--
-- Single table with before/after JSON rather than a per-field child table: the
-- real use case is chronological, per-entity reading ("show me everything that
-- happened to application 4512"), which idx_audit_entity serves exactly.
-- Per-field querying is rare and MariaDB's JSON support is weak, so the
-- documented upgrade path is an `audit_log_fields` child table populated by
-- the same writer — if and when the chamber asks for it. Building it now would
-- be normalisation of data nobody has needed to query.
--
-- OPERATIONAL REQUIREMENT, not expressible in DDL: the application's MySQL
-- user must hold INSERT on this table and NOT UPDATE or DELETE. cPanel's
-- phpMyAdmin supports table-level grants, and this is the cheapest
-- tamper-resistance available — it makes altering history require database
-- credentials rather than merely an application compromise.
--
--   REVOKE UPDATE, DELETE ON <db>.audit_log FROM '<user>'@'localhost';
--
-- The retention sweep therefore cannot prune this table; pruning is a
-- deliberate DBA action, which is correct for a seven-year record.

CREATE TABLE audit_log (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  occurred_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- One ULID per HTTP request. A single approval writes a decision event, a
  -- membership-created event, a number-allocated event and an SLA-stopped
  -- event; without this they are four unrelated rows in a table of millions.
  request_id            CHAR(26) NOT NULL,
  -- NULL means the actor was the system: a cron job closing an application
  -- for no response, or expiring a draft.
  actor_user_id         BIGINT UNSIGNED NULL,
  -- Snapshotted, not joined. The role someone held when they approved
  -- something is a historical fact; their current roles are not, and joining
  -- to user_roles would rewrite history on every promotion.
  actor_role_code       VARCHAR(40) NULL,
  actor_ip_hash         CHAR(64) NULL,
  actor_user_agent_hash CHAR(64) NULL,
  -- Set when staff act for an applicant, e.g. entering a postal application.
  on_behalf_of_user_id  BIGINT UNSIGNED NULL,
  entity_type           VARCHAR(40) NOT NULL,
  -- VARCHAR because entity ids are heterogeneous: a BIGINT application, a
  -- CHAR(36) document, a slug for a press release.
  entity_id             VARCHAR(64) NOT NULL,
  action                VARCHAR(60) NOT NULL,
  -- Human-readable, written once, never recomputed. A summary derived at read
  -- time from current data would describe the present, not the event.
  summary               VARCHAR(400) NOT NULL,
  before_json           JSON NULL,
  after_json            JSON NULL,
  context_json          JSON NULL,
  -- Which controlled revision of the membership form was in force. This is
  -- what makes a verification record ISO-defensible.
  form_revision_id      TINYINT UNSIGNED NULL,
  -- Hash chain over the canonical event JSON. It does not prevent tampering;
  -- it makes tampering detectable, which is the claim a dispute actually
  -- needs. Verified weekly by cron, which alerts on a break.
  prev_hash             CHAR(64) NULL,
  row_hash              CHAR(64) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id, occurred_at),
  KEY idx_audit_actor (actor_user_id, occurred_at),
  KEY idx_audit_action (action, occurred_at),
  KEY idx_audit_request (request_id),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_on_behalf FOREIGN KEY (on_behalf_of_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
