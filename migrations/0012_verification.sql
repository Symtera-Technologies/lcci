-- 0012 — the thirteen-item verification checklist and the deficiency round.
--
-- Page 5 of the printed form carries a thirteen-item "OBSERVATIONS (For office
-- use)" list with a date and a staff signature. That list *is* the chamber's
-- existing verification model, so this schema implements it directly rather
-- than inventing one. Everything here follows from three properties of that
-- piece of paper.
--
-- **It is rows, not thirteen boolean columns and not a JSON blob.** The form is
-- ISO-controlled at `QDP/7.5/MSD/F-01 Rev. 01`; Rev 02 will reword items, and
-- with columns every revision is a migration whose old column names lie about
-- what the old form asked. Rows also carry the per-item note, the officer, the
-- timestamp and a link to the *document* the tick refers to, and they make
-- "which item fails most often" a GROUP BY instead of a thirteen-way UNION.
-- The cost is thirteen rows per round — roughly fifteen thousand rows per
-- thousand applications, which is nothing.
--
-- **It is immutable once signed.** A completed checklist is never edited.
-- Re-verification after a deficiency creates round N+1 and supersedes the
-- previous one, so an auditor sees every successive judgement rather than only
-- the last. This is why there is no "uncomplete" path anywhere below.
--
-- **Two of the thirteen items are inverted.** Item 1 "Incomplete form" and
-- item 13 "Signatures do not match with CNIC" are *defects*: a tick blocks,
-- where a tick on item 2 clears. Flattening all thirteen into "checked = good"
-- silently inverts two of them, and an application with a signature mismatch
-- would read as verified. That is the single easiest way to get this module
-- quietly, dangerously wrong, which is why `polarity` is a column on the
-- definition, is snapshotted onto every recorded item, and has a test of its
-- own.

/* -------------------------------------------------------------------------- */
/* Reference data: the items themselves                                       */
/* -------------------------------------------------------------------------- */

-- The thirteen items, as controlled reference data keyed by form revision.
--
-- Keyed by revision rather than being a bare lookup, because the wording is
-- part of the controlled document. When Rev 02 reworks item 4, it is seeded as
-- a new set against the new revision and every checklist already written keeps
-- pointing at the words its officer actually read.
CREATE TABLE checklist_item_definitions (
  id               SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  form_revision_id SMALLINT UNSIGNED NOT NULL,

  -- Stable across revisions where the item survives a rewording, so the
  -- "which item fails most often" report can span revisions. The printed
  -- ordinal is separate for exactly that reason: it is the position on one
  -- version of one piece of paper.
  code    VARCHAR(40) NOT NULL,
  ordinal TINYINT UNSIGNED NOT NULL,

  label_en VARCHAR(300) NOT NULL,
  -- Urdu-ready by construction: the column exists and is empty at launch, so
  -- adding Urdu is a translation task rather than a migration.
  label_ur VARCHAR(600) NULL,

  -- 'compliance': a tick clears the item. 'defect': a tick blocks it.
  --
  -- Items 1 and 13 are defects. Read the note at the top of this file before
  -- touching this column.
  polarity ENUM('compliance','defect') NOT NULL DEFAULT 'compliance',

  -- Whether the officer must have actually opened one of the linked documents
  -- before this item can be decided, proved by a `document_access_log` row.
  --
  -- Set on item 3 alone, and deliberately not on every document-bearing item.
  -- Item 3's entire content is "I looked at the scan and it is legible", so a
  -- tick without a view is the one case where the record asserts something the
  -- officer demonstrably did not do. Attaching the same requirement to all
  -- nine document items would turn it into friction the office learns to
  -- route around by opening every file in sequence without reading any.
  requires_document_view TINYINT(1) NOT NULL DEFAULT 0,

  -- Whether a failing outcome must carry a note. True everywhere: a failed
  -- item becomes a line in an email to the applicant, and "item 4 failed" is
  -- not something anyone can act on.
  note_required_on_fail TINYINT(1) NOT NULL DEFAULT 1,

  active TINYINT(1) NOT NULL DEFAULT 1,

  PRIMARY KEY (id),
  UNIQUE KEY uq_cid_revision_code (form_revision_id, code),
  KEY idx_cid_revision_ordinal (form_revision_id, ordinal),
  CONSTRAINT fk_cid_form_rev FOREIGN KEY (form_revision_id) REFERENCES form_revisions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which uploaded document types each item is about.
--
-- Two jobs, both for the officer rather than for the machine. It pre-filters
-- the "which document did you look at" picker to the files that could possibly
-- answer this item, instead of offering all twenty. And because
-- `application_required_documents` already records what *this* application
-- owes, it lets the screen pre-suggest `not_applicable` for the partnership
-- deed on a proprietorship — a suggestion, never a hiding: the officer is
-- shown all thirteen items in the printed order, because diverging from the
-- controlled form is the one thing this module must not do.
CREATE TABLE checklist_item_document_types (
  definition_id      SMALLINT UNSIGNED NOT NULL,
  document_type_code VARCHAR(40) NOT NULL,
  PRIMARY KEY (definition_id, document_type_code),
  CONSTRAINT fk_cidt_definition FOREIGN KEY (definition_id)
    REFERENCES checklist_item_definitions (id) ON DELETE CASCADE,
  CONSTRAINT fk_cidt_type FOREIGN KEY (document_type_code)
    REFERENCES document_types (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* -------------------------------------------------------------------------- */
/* The checklist                                                              */
/* -------------------------------------------------------------------------- */

-- One round of verification.
--
-- `round` rather than an `is_current` flag: the question asked of this table is
-- "show me each successive judgement", and a flag answers only "show me the
-- last one". The unique key on (application_id, round) is what stops two
-- officers opening round 2 at the same time — the loser gets a duplicate-key
-- error, which is the correct outcome and is caught and reported as "somebody
-- else has already started this round".
CREATE TABLE verification_checklists (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  round          SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- The revision whose wording this round was decided against. Snapshotted
  -- from the application, which snapshotted it at submission.
  form_revision_id SMALLINT UNSIGNED NOT NULL,

  -- 'superseded' is set when a later round opens. There is no path back to
  -- 'in_progress' from 'completed': a change of mind is round N+1.
  state ENUM('in_progress','completed','superseded') NOT NULL DEFAULT 'in_progress',

  -- Derived from the items at completion and then frozen, not recomputed on
  -- read. The items carry the polarity they were decided under, so a
  -- recomputation after a Rev 02 polarity correction would quietly restate a
  -- past officer's conclusion.
  outcome ENUM('clear','deficient') NULL,

  started_by  BIGINT UNSIGNED NULL,
  started_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- The staff signature and date the printed form asks for.
  completed_by BIGINT UNSIGNED NULL,
  completed_at DATETIME(3) NULL,
  -- Snapshotted, not joined: the role someone held when they signed is a
  -- historical fact, and joining would rewrite it on every promotion.
  completed_by_role_code VARCHAR(40) NULL,

  request_id VARCHAR(26) NOT NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_vc_app_round (application_id, round),
  KEY idx_vc_app_state (application_id, state),
  KEY idx_vc_completed_by (completed_by),
  CONSTRAINT fk_vc_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_vc_form_rev FOREIGN KEY (form_revision_id) REFERENCES form_revisions (id),
  CONSTRAINT fk_vc_started_by FOREIGN KEY (started_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_vc_completed_by FOREIGN KEY (completed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One decided item.
--
-- The label, ordinal and polarity are **copied here**, not joined. That is the
-- whole reason this schema can survive Rev 02: a checklist from 2026 renders
-- with the words its officer read, from this row alone, after the definitions
-- table has moved on.
--
-- Two columns record the officer's action where one might seem enough:
--
--   `marked`  — literally whether the box on the form was ticked.
--   `outcome` — what that means, given the polarity.
--
-- `outcome` is authoritative and is what every query reads; `marked` is the
-- evidence of what was actually on the form. Keeping both is what makes a
-- later polarity correction safe: the stored outcome stays as decided, and a
-- reader can still see the tick it came from.
CREATE TABLE verification_checklist_items (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  checklist_id BIGINT UNSIGNED NOT NULL,

  item_code VARCHAR(40) NOT NULL,
  ordinal   TINYINT UNSIGNED NOT NULL,
  label_en  VARCHAR(300) NOT NULL,
  polarity  ENUM('compliance','defect') NOT NULL,

  marked  TINYINT(1) NOT NULL DEFAULT 0,
  outcome ENUM('pass','fail','not_applicable') NOT NULL,

  -- Required when the outcome is 'fail', because this sentence is what the
  -- applicant is sent.
  note VARCHAR(500) NULL,

  -- What the machine thought, alongside what the officer decided.
  --
  -- 'unknown' for the items no machine can judge — a wet signature, a company
  -- stamp. Stored rather than recomputed for the report, because the question
  -- is "did the officer disagree with the system at the time", and the system's
  -- opinion changes as the application does.
  system_verdict ENUM('pass','fail','unknown') NOT NULL DEFAULT 'unknown',

  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_vci_checklist_item (checklist_id, item_code),
  -- The "which item fails most often" report.
  KEY idx_vci_item_outcome (item_code, outcome),
  CONSTRAINT fk_vci_checklist FOREIGN KEY (checklist_id)
    REFERENCES verification_checklists (id) ON DELETE CASCADE,
  CONSTRAINT fk_vci_decided_by FOREIGN KEY (decided_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which document a tick actually refers to.
--
-- The single most useful column in this file for a dispute six months later:
-- "item 3 passed" is an opinion, and "item 3 passed against these two CNIC
-- scans, whose SHA-256 is on the documents row" is a record. No foreign key to
-- documents with CASCADE, because the retention sweep hard-deletes a scan at
-- twenty-four months while the record that it was examined must outlive it.
CREATE TABLE verification_item_documents (
  checklist_item_id BIGINT UNSIGNED NOT NULL,
  document_id       CHAR(36) NOT NULL,
  PRIMARY KEY (checklist_item_id, document_id),
  KEY idx_vid_document (document_id),
  CONSTRAINT fk_vid_item FOREIGN KEY (checklist_item_id)
    REFERENCES verification_checklist_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* -------------------------------------------------------------------------- */
/* The deficiency round                                                       */
/* -------------------------------------------------------------------------- */

-- An application returned to the applicant for more information.
--
-- One row per round raised. It is the thing that unlocks editing: between
-- submission and a decision the applicant cannot touch the form at all, and a
-- deficiency opens *exactly* the fields and documents its items name. Not the
-- whole form — an applicant who can re-edit turnover after an officer verified
-- it leaves the officer's checklist referring to a form that no longer exists.
CREATE TABLE application_deficiencies (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  round          SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  -- The checklist round that produced it. Nullable because an officer may
  -- return an application for something the thirteen items do not cover.
  checklist_id BIGINT UNSIGNED NULL,

  state ENUM('open','answered','cancelled') NOT NULL DEFAULT 'open',

  -- The officer's covering sentence, above the itemised list.
  summary VARCHAR(1000) NULL,

  raised_by BIGINT UNSIGNED NULL,
  raised_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  -- When the applicant must answer by, and the nudge sequence that chases it.
  -- A civil date: it is quoted in an email and must not shift a day.
  respond_by     DATE NULL,
  reminder_count TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_reminded_at DATETIME(3) NULL,

  answered_at DATETIME(3) NULL,

  -- The pause this deficiency opened on the SLA clock, so resuming closes the
  -- right stretch rather than the most recent one.
  sla_pause_id BIGINT UNSIGNED NULL,

  request_id VARCHAR(26) NOT NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_def_app_round (application_id, round),
  -- At most one open deficiency per application, enforced by the state machine
  -- rather than by a partial index MySQL does not have. This index is what
  -- makes that check and the reminder sweep cheap.
  KEY idx_def_app_state (application_id, state),
  KEY idx_def_chase (state, respond_by),
  CONSTRAINT fk_def_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_def_checklist FOREIGN KEY (checklist_id)
    REFERENCES verification_checklists (id) ON DELETE SET NULL,
  CONSTRAINT fk_def_raised_by FOREIGN KEY (raised_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_def_pause FOREIGN KEY (sla_pause_id) REFERENCES sla_pauses (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What the applicant has to do, one row per thing.
--
-- These rows are simultaneously the email the applicant receives, the edit
-- permission they are granted, and the list the officer checks off on their
-- return. One representation for all three, because the alternative is a
-- prose email whose relationship to what the form actually unlocks is
-- maintained by hand.
CREATE TABLE deficiency_items (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  deficiency_id BIGINT UNSIGNED NOT NULL,

  kind ENUM('document','field','other') NOT NULL,

  -- For kind='document': which type, and whose. `subject_id` names the
  -- director whose CNIC is illegible, so one partner's bad scan does not
  -- reopen the whole board's documents.
  document_type_code VARCHAR(40) NULL,
  subject_kind ENUM('company','representative','director','endorser','payment') NULL,
  subject_id   BIGINT UNSIGNED NULL,

  -- For kind='field': the form field name, in the same vocabulary the wizard's
  -- zod schemas and `stepForField` use, so unlocking one field and landing the
  -- applicant on the right step are the same string.
  field_name VARCHAR(80) NULL,

  -- Which checklist item produced this, where one did. Nullable for an item
  -- the officer added by hand.
  checklist_item_code VARCHAR(40) NULL,

  -- What the applicant is told to do. Written by the officer, usually seeded
  -- from the checklist item's note, and sent verbatim.
  instruction VARCHAR(600) NOT NULL,

  resolved_at DATETIME(3) NULL,
  -- The re-upload that answered it. Nullable for a field correction and for an
  -- item the officer resolved by hand.
  resolved_document_id CHAR(36) NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_defitem_deficiency (deficiency_id),
  -- The lookup the upload gate performs on every file an applicant sends
  -- while the application is AWAITING_APPLICANT.
  KEY idx_defitem_unlock (deficiency_id, kind, document_type_code),
  CONSTRAINT fk_defitem_def FOREIGN KEY (deficiency_id)
    REFERENCES application_deficiencies (id) ON DELETE CASCADE,
  CONSTRAINT fk_defitem_type FOREIGN KEY (document_type_code)
    REFERENCES document_types (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* -------------------------------------------------------------------------- */
/* Seed: the thirteen items of Rev 01                                         */
/* -------------------------------------------------------------------------- */

-- Verbatim from page 5 of QDP/7.5/MSD/F-01 Rev. 01, in the printed order.
--
-- The wording is the chamber's, not ours, including where it is terse. Item 5
-- says "and Form C or D" and item 4 writes "NTN/STN" where the rest of the
-- form says STRN; both are reproduced as printed, because an officer
-- cross-checking the screen against the paper must find the same sentence.
INSERT INTO checklist_item_definitions
  (form_revision_id, code, ordinal, label_en, polarity, requires_document_view) VALUES
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'incomplete_form', 1,
   'Incomplete form', 'defect', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'letterhead_signed', 2,
   'Letterhead application with representative signature and stamp', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'cnic_readable', 3,
   'Clear readable CNIC of proprietor/partners/directors', 'compliance', 1),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'ntn_title', 4,
   'NTN/STN (RTO Lahore) bearing title of business', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'bank_certificate', 5,
   'Bank account-maintenance certificate and Form C or D', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'partnership_deed', 6,
   'Partnership deed', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'secp_documents', 7,
   'Incorporation certificate, MoA & AoA, Form 9, Form II certified by SECP', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'utility_bill', 8,
   'Electricity bill of business premises', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'photographs', 9,
   'Studio pictures with white background', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'endorser_standing', 10,
   'Signature and stamp of proposer and seconder having valid membership status', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'company_stamp', 11,
   'Firm''s/company''s stamp', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'pay_order', 12,
   'Pay order', 'compliance', 0),
  ((SELECT id FROM form_revisions ORDER BY id DESC LIMIT 1),
   'signature_mismatch', 13,
   'Signatures do not match with CNIC', 'defect', 0);

-- Which document types each item is about. Items 1, 11 and 13 link to none:
-- completeness is a property of the form, and a stamp and a signature
-- comparison are judgements across several documents rather than about one.
INSERT INTO checklist_item_document_types (definition_id, document_type_code)
SELECT d.id, m.document_type_code
  FROM checklist_item_definitions d
  JOIN (
        SELECT 'letterhead_signed' AS code, 'letterhead_application' AS document_type_code
  UNION SELECT 'cnic_readable',      'cnic'
  UNION SELECT 'cnic_readable',      'passport'
  UNION SELECT 'ntn_title',          'ntn_certificate'
  UNION SELECT 'ntn_title',          'strn_certificate'
  UNION SELECT 'bank_certificate',   'bank_certificate'
  UNION SELECT 'bank_certificate',   'form_c'
  UNION SELECT 'partnership_deed',   'partnership_deed'
  UNION SELECT 'secp_documents',     'incorporation_certificate'
  UNION SELECT 'secp_documents',     'moa_aoa'
  UNION SELECT 'secp_documents',     'form_9'
  UNION SELECT 'secp_documents',     'form_ii'
  UNION SELECT 'utility_bill',       'utility_bill'
  UNION SELECT 'photographs',        'photo'
  UNION SELECT 'endorser_standing',  'endorsement_sheet'
  UNION SELECT 'pay_order',          'pay_order'
  ) m ON m.code = d.code;
