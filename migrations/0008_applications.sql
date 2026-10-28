-- 0008 — the membership application aggregate.
--
-- One narrow, hot `applications` row that the admin queue reads, with the
-- sixty-odd form fields in a 1:1 satellite that autosave hammers. Splitting
-- them is not premature optimisation: the queue lists and filters on state,
-- tier, assignee and deadline, and autosave writes the satellite every few
-- seconds per open draft. Keeping them in one table would mean the queue
-- scanning rows carrying a paragraph of address text each.
--
-- The single most important property in this file: **every typed particulars
-- column is nullable**. Autosave and NOT NULL cannot coexist. The committed
-- behaviour is that a half-finished form survives a reload, so the schema
-- cannot be the thing that enforces completeness — that happens at the submit
-- transition, against a zod schema, in `src/membership/`. A NOT NULL turnover
-- column throws a parse error on the applicant's third keystroke.

CREATE TABLE applications (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Assigned at submission, never before: a draft has nothing to quote and an
  -- abandoned draft must not consume a reference. NULL until then, UNIQUE
  -- after, which is why the index allows nulls.
  public_ref VARCHAR(30) NULL,

  -- The internal machine. `public_stage` is derived from this and never
  -- stored: the applicant sees four labels, the back office has twelve states,
  -- and storing both invites them to disagree.
  state ENUM(
    'DRAFT',
    'SUBMITTED',
    'UNDER_VERIFICATION',
    'VERIFIED',
    'PENDING_APPROVAL',
    'AWAITING_APPLICANT',
    'APPROVED',
    'REJECTED',
    'WITHDRAWAL_REQUESTED',
    'WITHDRAWN',
    'DRAFT_EXPIRED',
    'CLOSED_NO_RESPONSE'
  ) NOT NULL DEFAULT 'DRAFT',

  -- Optimistic concurrency. Every transition is
  -- `UPDATE ... WHERE id = ? AND state = ? AND version = ?`, and zero affected
  -- rows means a concurrent actor moved it first. Not defensive programming:
  -- Passenger runs several worker processes, so two officers in the same queue
  -- are two processes racing on one row, and the loser must be told to reload
  -- rather than silently overwrite a decision it never saw.
  version INT UNSIGNED NOT NULL DEFAULT 1,

  created_by BIGINT UNSIGNED NOT NULL,
  -- Set when the applicant is acting for an existing company record. Null for
  -- a brand new applicant, which is the common case.
  company_id BIGINT UNSIGNED NULL,

  -- Self-declared, and checked against turnover at verification. An applicant
  -- who files as Corporate on Rs 12m turnover has already drawn a pay order
  -- for the wrong amount; whether that is a re-classification with a top-up or
  -- a deficiency return is an open question for LCCI.
  membership_class    ENUM('corporate','associate') NULL,
  processing_tier     ENUM('regular','urgent','executive') NULL,
  company_status_code VARCHAR(30) NULL,

  -- Snapshotted at submission, all three. The form revision because the
  -- application was answered against that wording; the fee row because the
  -- pay order was drawn for that amount and the bank-match control compares
  -- it; the surcharge flag because it decides whether a second payment row
  -- exists at all.
  form_revision_id       SMALLINT UNSIGNED NULL,
  fee_schedule_id        SMALLINT UNSIGNED NULL,
  requires_itd_surcharge TINYINT(1) NOT NULL DEFAULT 0,

  -- Both tracks are offered and the applicant chooses: the two members endorse
  -- in the portal, or a signed and stamped sheet is uploaded.
  endorsement_mode ENUM('in_app','signed_sheet') NULL,

  assigned_to BIGINT UNSIGNED NULL,

  -- Values that could not be coerced into their typed column at all — "approx
  -- 60m" in the turnover box, a date the applicant is still editing. Autosave
  -- keeps them here so the draft survives a reload without the schema having
  -- to accept nonsense in a DECIMAL. Cleared field by field as each one parses.
  wizard_scratch JSON NULL,
  -- Which step the applicant last had open, so returning lands them there.
  wizard_step    TINYINT UNSIGNED NOT NULL DEFAULT 1,

  submitted_at DATETIME(3) NULL,
  decided_at   DATETIME(3) NULL,
  -- Set by the draft-expiry job. A draft is deleted with its documents after
  -- ninety days, which matters as much for PII minimisation as for disk quota.
  expires_at   DATETIME(3) NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_app_public_ref (public_ref),
  -- The queue's own index: officers filter by state and sort by age.
  KEY idx_app_queue (state, processing_tier, submitted_at),
  KEY idx_app_applicant (created_by, state),
  KEY idx_app_assigned (assigned_to, state),
  -- The draft-expiry sweep.
  KEY idx_app_expiry (state, expires_at),
  CONSTRAINT fk_app_created_by FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_app_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE SET NULL,
  CONSTRAINT fk_app_assigned FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_app_status FOREIGN KEY (company_status_code) REFERENCES company_statuses (code),
  CONSTRAINT fk_app_form_rev FOREIGN KEY (form_revision_id) REFERENCES form_revisions (id),
  CONSTRAINT fk_app_fee FOREIGN KEY (fee_schedule_id) REFERENCES fee_schedule (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The sixteen numbered fields of the printed form, one row per application.
--
-- Every column nullable, for the reason at the top of this file. CNIC, passport
-- and NTN are stored encrypted with a separate HMAC column for lookup, because
-- a CNIC is the single most sensitive field in the system and an index on the
-- plaintext would defeat the encryption entirely.
CREATE TABLE application_company (
  application_id BIGINT UNSIGNED NOT NULL,

  -- 1-2: the firm and who represents it.
  firm_name           VARCHAR(200) NULL,
  representative_name VARCHAR(160) NULL,

  -- 3-4: identity. Ciphertext plus a peppered HMAC for equality lookup, never
  -- an index on the plaintext.
  representative_cnic_enc      VARBINARY(255) NULL,
  representative_cnic_hmac     CHAR(64) NULL,
  representative_passport_enc  VARBINARY(255) NULL,
  representative_passport_hmac CHAR(64) NULL,

  -- 5-6: the representative's own particulars. A civil date, so DATE — the
  -- pool returns it as a string and nothing converts it through a timezone.
  representative_dob         DATE NULL,
  representative_birthplace  VARCHAR(120) NULL,
  representative_nationality VARCHAR(80) NULL,

  -- 7-8: where the business is.
  postal_address VARCHAR(400) NULL,
  premises_tenure ENUM('owned','rented') NULL,
  email           VARCHAR(190) NULL,

  -- 9-10: how to reach it.
  office_phone_1     VARCHAR(30) NULL,
  office_phone_2     VARCHAR(30) NULL,
  fax                VARCHAR(30) NULL,
  representative_mobile_1 VARCHAR(30) NULL,
  representative_mobile_2 VARCHAR(30) NULL,

  -- 11-12: the numbers that decide the membership class. DECIMAL, not float:
  -- these are rupees, and the Corporate threshold is Rs 50 million exactly.
  paid_up_capital  DECIMAL(16,2) NULL,
  annual_turnover  DECIMAL(16,2) NULL,
  employee_count   INT UNSIGNED NULL,

  -- 13: tax registration.
  ntn_enc    VARBINARY(255) NULL,
  ntn_hmac   CHAR(64) NULL,
  strn_registered TINYINT(1) NULL,
  strn_enc   VARBINARY(255) NULL,

  -- 14-15: what the business does. Sector and sub-sector are free text, as on
  -- the printed form: the chamber's own taxonomy is an open question and
  -- inventing a sector list here would put invented reference data in front of
  -- every applicant. A lookup table arrives with the directory.
  business_sector     VARCHAR(120) NULL,
  business_sub_sector VARCHAR(120) NULL,
  main_commodity      VARCHAR(200) NULL,

  -- 16: the bank. Both halves of the pay-order control start here.
  bank_name   VARCHAR(160) NULL,
  bank_branch VARCHAR(160) NULL,

  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (application_id),
  KEY idx_appco_cnic_hmac (representative_cnic_hmac),
  KEY idx_appco_ntn_hmac (ntn_hmac),
  CONSTRAINT fk_appco_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The multi-select. A join table rather than a bitmask or a comma-separated
-- column, because the directory will filter on it and a bitmask cannot be
-- joined, indexed or explained.
CREATE TABLE application_business_types (
  application_id     BIGINT UNSIGNED NOT NULL,
  business_type_code VARCHAR(30) NOT NULL,
  PRIMARY KEY (application_id, business_type_code),
  CONSTRAINT fk_abt_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_abt_type FOREIGN KEY (business_type_code) REFERENCES business_types (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Directors and partners. Unbounded.
--
-- The printed form fits five and says "use photocopy of this page" for more.
-- The document list says "CNIC of ALL directors", so the digital version has
-- no cap — confirm with LCCI that there is no policy maximum.
CREATE TABLE application_directors (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  -- Display order, so the list reads back as the applicant entered it.
  position       SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  full_name   VARCHAR(160) NULL,
  designation VARCHAR(120) NULL,
  -- An existing LCCI membership number, where the director already holds one.
  membership_no VARCHAR(30) NULL,
  cell        VARCHAR(30) NULL,

  cnic_enc     VARBINARY(255) NULL,
  cnic_hmac    CHAR(64) NULL,
  passport_enc VARBINARY(255) NULL,
  ntn_enc      VARBINARY(255) NULL,

  -- True where this person is a foreign national, which is what triggers the
  -- passport requirement and the ITD surcharge.
  is_foreign_national TINYINT(1) NOT NULL DEFAULT 0,

  -- The attestation on the printed form is by a director *other than* the
  -- representative, so the one who signs it is marked rather than inferred.
  attests TINYINT(1) NOT NULL DEFAULT 0,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_dir_app (application_id, position),
  KEY idx_dir_cnic_hmac (cnic_hmac),
  CONSTRAINT fk_dir_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Proposer and seconder.
--
-- Two existing members, and the office checklist requires they hold "valid
-- membership status" — today eyeballed, which the digital version can enforce.
-- Standing is recorded twice on purpose: at endorsement and again at approval.
-- A proposer who endorses in February lapses on 31 March before an April
-- grant, so a single check at either end would be wrong.
--
-- A digital endorsement stores the OTP challenge that authenticated it, the
-- address it came from and the exact wording agreed to. A digital signature is
-- only evidence if the evidence is kept.
CREATE TABLE application_endorsements (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  role           ENUM('proposer','seconder') NOT NULL,

  -- As typed by the applicant, before the member is matched.
  firm_name           VARCHAR(200) NULL,
  membership_no       VARCHAR(30) NULL,
  representative_name VARCHAR(160) NULL,
  mobile              VARCHAR(30) NULL,
  email               VARCHAR(190) NULL,

  -- Resolved once the membership number matches a record.
  endorser_user_id    BIGINT UNSIGNED NULL,

  state ENUM('invited','endorsed','declined','expired','superseded') NOT NULL DEFAULT 'invited',

  -- Standing at the moment of endorsement, and again at approval.
  standing_at_endorsement ENUM('active','lapsed','suspended','unknown') NULL,
  standing_at_approval    ENUM('active','lapsed','suspended','unknown') NULL,

  -- The evidence, for an in-app endorsement.
  endorsed_at          DATETIME(3) NULL,
  otp_challenge_id     BIGINT UNSIGNED NULL,
  endorsed_ip_hash     CHAR(64) NULL,
  endorsed_ua_hash     CHAR(64) NULL,
  -- The precise text agreed to, stored rather than referenced, because the
  -- wording will be revised and an endorsement must keep the words it was
  -- given.
  declaration_text     TEXT NULL,

  invited_at  DATETIME(3) NULL,
  reminded_at DATETIME(3) NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  -- One live proposer and one live seconder per application. A superseded row
  -- is kept, so this is not unique on (application_id, role) alone.
  KEY idx_end_app (application_id, role, state),
  KEY idx_end_user (endorser_user_id),
  CONSTRAINT fk_end_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_end_user FOREIGN KEY (endorser_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The declaration and the second director's attestation.
--
-- Whether an OTP-authenticated declaration is equivalent to a wet signature
-- and a company stamp is an open question for LCCI: the Electronic
-- Transactions Ordinance 2002 recognises electronic signatures, but the
-- chamber's own ISO procedure asks for a stamp. Built for the stricter
-- reading — the signed letterhead upload stays mandatory — while recording the
-- electronic acceptance alongside it, so that if LCCI accepts the electronic
-- form the evidence is already there.
CREATE TABLE application_authorisation (
  application_id BIGINT UNSIGNED NOT NULL,

  declaration_accepted_at DATETIME(3) NULL,
  declaration_text        TEXT NULL,
  declared_by             BIGINT UNSIGNED NULL,
  declared_ip_hash        CHAR(64) NULL,
  declared_ua_hash        CHAR(64) NULL,

  -- The attesting director, who must not be the representative.
  attested_by_director_id BIGINT UNSIGNED NULL,
  attested_at             DATETIME(3) NULL,

  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (application_id),
  CONSTRAINT fk_auth_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_auth_declared_by FOREIGN KEY (declared_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_auth_director FOREIGN KEY (attested_by_director_id) REFERENCES application_directors (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which documents this application actually has to supply.
--
-- A snapshot of `document_requirements` taken at submission, not a live join.
-- The office's matrix will change; an application already in flight must keep
-- the list it was told to satisfy, or a policy edit retroactively makes a
-- complete application deficient.
CREATE TABLE application_required_documents (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id     BIGINT UNSIGNED NOT NULL,
  document_type_code VARCHAR(40) NOT NULL,
  cardinality        ENUM('one','all_directors','optional') NOT NULL,
  -- Resolved at snapshot time: 'all_directors' against a five-person board is
  -- five, and the applicant should be told five rather than "one per
  -- director".
  required_count     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  note_en            VARCHAR(300) NULL,
  satisfied_at       DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_appreq (application_id, document_type_code),
  CONSTRAINT fk_appreq_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_appreq_type FOREIGN KEY (document_type_code) REFERENCES document_types (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every move the application makes, including the ones it was refused.
--
-- The audit log carries these too, but this table is the application's own
-- history: it is what the applicant's tracker and the officer's sidebar read,
-- and it is joined and filtered in ways a polymorphic log is the wrong shape
-- for. The two are written in the same transaction.
CREATE TABLE application_state_transitions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  from_state     VARCHAR(30) NULL,
  to_state       VARCHAR(30) NOT NULL,
  transition_code VARCHAR(40) NOT NULL,
  -- NULL for the system actor: draft expiry and no-response closure have no
  -- user behind them.
  actor_user_id  BIGINT UNSIGNED NULL,
  actor_role_code VARCHAR(40) NULL,
  reason         VARCHAR(500) NULL,
  request_id     VARCHAR(26) NOT NULL,
  occurred_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ast_app (application_id, occurred_at),
  CONSTRAINT fk_ast_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_ast_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The immutable record of what was submitted.
--
-- This replaces generating and storing a PDF per submission, which on this
-- host would be an off-box job. Canonical JSON of every field plus every
-- document's SHA-256, keys sorted, the whole thing hashed. That *is* the ISO
-- auditable record; the human-readable artefact is an HTML view of this
-- snapshot with a print stylesheet, at essentially no memory cost.
--
-- One row per round: answering a deficiency produces round 2 rather than
-- editing round 1, so an auditor sees each successive version of the truth.
CREATE TABLE submission_snapshots (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id   BIGINT UNSIGNED NOT NULL,
  round            SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  form_revision_id SMALLINT UNSIGNED NOT NULL,
  -- Canonical JSON: object keys sorted, no insignificant whitespace, so the
  -- hash is reproducible by anyone who has the data.
  payload_json     JSON NOT NULL,
  payload_sha256   CHAR(64) NOT NULL,
  -- Who caused this snapshot to exist, and under which request.
  created_by       BIGINT UNSIGNED NULL,
  request_id       VARCHAR(26) NOT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_snapshot_round (application_id, round),
  CONSTRAINT fk_snap_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_snap_form_rev FOREIGN KEY (form_revision_id) REFERENCES form_revisions (id),
  CONSTRAINT fk_snap_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The foreign key 0002 deliberately deferred.
--
-- `documents.application_id` was left unconstrained so that migration could
-- apply to a database with no membership schema. The table now exists, so the
-- constraint goes on. ON DELETE CASCADE is right here: a draft deleted by the
-- expiry sweep must take its uploaded identity documents with it, and that is
-- the single most important deletion in the system for PII minimisation.
ALTER TABLE documents
  ADD CONSTRAINT fk_doc_application
  FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE;
