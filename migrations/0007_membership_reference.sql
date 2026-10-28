-- 0007 — controlled reference data for the membership application.
--
-- Everything here is data the chamber owns and will change without a deploy:
-- the fee table, the document matrix, the processing-tier promises, the
-- membership year. It is seeded from the printed form
-- (Doc # QDP/7.5/MSD/F-01, Rev.# 01) and nothing else — where the form is
-- silent, these tables are left empty rather than guessed at.
--
-- Engine-neutral, as 0001: no CHECK constraints, no JSON indexes, no
-- utf8mb4_0900 collation.

-- The form is a controlled document under LCCI's ISO 9001 quality system, so
-- the digital version needs a revision identifier of its own and every
-- submission has to record which revision it was made against. Without this,
-- a reworded Rev 02 silently rewrites the meaning of every application already
-- in the system.
CREATE TABLE form_revisions (
  id             SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  iso_doc_code   VARCHAR(60) NOT NULL,
  revision       VARCHAR(10) NOT NULL,
  effective_from DATE NOT NULL,
  retired_on     DATE NULL,
  note           VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_form_revision (iso_doc_code, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO form_revisions (iso_doc_code, revision, effective_from, note) VALUES
  ('QDP/7.5/MSD/F-01', '01', '2026-01-01',
   'Digitised from the printed membership form. Authorising a Rev 02 belongs to the chamber quality system, not to this application.');

-- Proprietorship / Partnership / Corporation / Company, as the form words it.
-- "Corporation" and "Company" overlap in ordinary use; both are kept because
-- the form offers both and an applicant will tick whichever their paperwork
-- says.
CREATE TABLE company_statuses (
  code       VARCHAR(30) NOT NULL,
  label_en   VARCHAR(80) NOT NULL,
  label_ur   VARCHAR(160) NULL,
  sort_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO company_statuses (code, label_en, sort_order) VALUES
  ('proprietorship', 'Proprietorship', 1),
  ('partnership',    'Partnership',    2),
  ('corporation',    'Corporation',    3),
  ('company',        'Company',        4);

-- The eight values the form prints, multi-select.
--
-- Open question for LCCI: the specification lists six different values
-- (Manufacturer, Exporter, Importer, Trader, Services, Indenting Agent). The
-- application form and the member directory must share one taxonomy, and the
-- Research Department has to arbitrate before the directory is built. The form
-- wins here because it is what applicants are answering today.
CREATE TABLE business_types (
  code       VARCHAR(30) NOT NULL,
  label_en   VARCHAR(80) NOT NULL,
  label_ur   VARCHAR(160) NULL,
  sort_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO business_types (code, label_en, sort_order) VALUES
  ('trading',            'Trading',            1),
  ('importer',           'Importer',           2),
  ('exporter',           'Exporter',           3),
  ('services',           'Services',           4),
  ('manufacturer',       'Manufacturer',       5),
  ('retailer',           'Retailer',           6),
  ('wholesaler',         'Wholesaler',         7),
  ('departmental_store', 'Departmental Store', 8);

-- The kinds of document the office asks for.
--
-- `subject_kind` says what a document of this type is *about*, which is how a
-- single `cnic` type serves the proprietor, every partner and every director
-- rather than needing three near-identical codes. The ENUM matches
-- `documents.subject_kind` from 0002 and must stay in step with it.
CREATE TABLE document_types (
  code               VARCHAR(40) NOT NULL,
  label_en           VARCHAR(120) NOT NULL,
  label_ur           VARCHAR(240) NULL,
  subject_kind       ENUM('company','representative','director','endorser','payment') NOT NULL,
  -- Set for the bank account-maintenance certificate: the form requires it to
  -- be no more than three months old. Reference data rather than a constant in
  -- code, because "three months" is chamber policy and policy changes.
  max_age_days       SMALLINT UNSIGNED NULL,
  -- True where `documents.issued_on` must be supplied, which is exactly the
  -- types carrying an age limit.
  requires_issued_on TINYINT(1) NOT NULL DEFAULT 0,
  -- The CNIC type is per-person, so one application legitimately holds many.
  allows_multiple    TINYINT(1) NOT NULL DEFAULT 0,
  guidance_en        VARCHAR(400) NULL,
  sort_order         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  active             TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO document_types
  (code, label_en, subject_kind, max_age_days, requires_issued_on, allows_multiple, guidance_en, sort_order) VALUES
  ('letterhead_application', 'Application on company letterhead', 'company', NULL, 0, 0,
   'Signed and stamped by the proprietor, managing partner or managing director as applicable.', 1),
  ('cnic', 'CNIC', 'representative', NULL, 0, 1,
   'Both sides, on A4, clearly readable. One for each proprietor, partner or director.', 2),
  ('passport', 'Passport', 'representative', NULL, 0, 1,
   'Required where the representative, a partner or a director is a foreign national.', 3),
  ('ntn_certificate', 'NTN certificate', 'company', NULL, 0, 1,
   'Issued by RTO or CTO Lahore and bearing the title of the business.', 4),
  ('strn_certificate', 'Sales tax registration (STRN)', 'company', NULL, 0, 0,
   'Where the concern is registered for sales tax.', 5),
  ('partnership_deed', 'Partnership deed', 'company', NULL, 0, 0,
   'On Rs 1,000 stamp paper.', 6),
  ('form_c', 'Form C', 'company', NULL, 0, 0,
   'Where the partnership is registered.', 7),
  ('incorporation_certificate', 'Certificate of incorporation', 'company', NULL, 0, 0,
   'Certified by SECP.', 8),
  ('moa_aoa', 'Memorandum and Articles of Association', 'company', NULL, 0, 0,
   'Certified by SECP.', 9),
  ('form_9', 'Form 9 (latest)', 'company', NULL, 0, 0,
   'Most recent filing, certified by SECP.', 10),
  ('form_ii', 'Form II', 'company', NULL, 0, 0,
   'Certified by SECP, where applicable.', 11),
  ('utility_bill', 'Utility bill for the business premises', 'company', NULL, 0, 0,
   'Electricity bill for the premises named in the application.', 12),
  ('bank_certificate', 'Bank account-maintenance certificate', 'company', 90, 1, 0,
   'From a Lahore bank, bearing the title of the business, not more than three months old. The pay order must be drawn on this same account.', 13),
  ('photo', 'Photograph', 'representative', NULL, 0, 1,
   '35 x 45 mm, white background. One for the representative and one for each director or partner.', 14),
  ('pay_order', 'Pay order', 'payment', NULL, 1, 1,
   'Drawn on the account named in the bank certificate.', 15),
  ('endorsement_sheet', 'Signed proposer and seconder sheet', 'endorser', NULL, 0, 0,
   'Only where the proposer and seconder sign on paper instead of endorsing in the portal.', 16);

-- Which documents each company status has to supply.
--
-- A table rather than branching code: the matrix belongs to the office, it
-- differs per status in ways the form spells out, and it is snapshotted onto
-- each application at submission so a later policy change cannot retroactively
-- make a submitted application incomplete.
CREATE TABLE document_requirements (
  id                  SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_status_code VARCHAR(30) NOT NULL,
  document_type_code  VARCHAR(40) NOT NULL,
  -- 'all_directors' means one per person on the directors list, which is why
  -- the uploader is unbounded: the form says "CNIC of ALL directors".
  cardinality         ENUM('one','all_directors','optional') NOT NULL DEFAULT 'one',
  note_en             VARCHAR(300) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_doc_req (company_status_code, document_type_code),
  CONSTRAINT fk_doc_req_status FOREIGN KEY (company_status_code) REFERENCES company_statuses (code),
  CONSTRAINT fk_doc_req_type FOREIGN KEY (document_type_code) REFERENCES document_types (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO document_requirements (company_status_code, document_type_code, cardinality, note_en) VALUES
  ('proprietorship', 'letterhead_application', 'one',      'Signed by the proprietor.'),
  ('proprietorship', 'cnic',                   'one',      'Of the proprietor.'),
  ('proprietorship', 'ntn_certificate',        'one',      'As a business individual, bearing the business title.'),
  ('proprietorship', 'utility_bill',           'one',      NULL),
  ('proprietorship', 'bank_certificate',       'one',      NULL),
  ('proprietorship', 'photo',                  'one',      'Of the representative.'),
  ('proprietorship', 'pay_order',              'one',      NULL),
  ('proprietorship', 'strn_certificate',       'optional', 'Where registered for sales tax.'),
  ('proprietorship', 'passport',               'optional', 'Where the representative is a foreign national.'),

  ('partnership', 'letterhead_application', 'one',           'Signed by the managing partner.'),
  ('partnership', 'cnic',                   'all_directors', 'Of all partners.'),
  ('partnership', 'ntn_certificate',        'all_directors', 'Of the firm and of all partners.'),
  ('partnership', 'partnership_deed',       'one',           'On Rs 1,000 stamp paper.'),
  ('partnership', 'form_c',                 'optional',      'Where the partnership is registered.'),
  ('partnership', 'utility_bill',           'one',           NULL),
  ('partnership', 'bank_certificate',       'one',           NULL),
  ('partnership', 'photo',                  'all_directors', NULL),
  ('partnership', 'pay_order',              'one',           NULL),
  ('partnership', 'strn_certificate',       'optional',      NULL),
  ('partnership', 'passport',               'optional',      'Where a partner is a foreign national.'),

  ('corporation', 'letterhead_application',    'one',           'Signed by the managing director.'),
  ('corporation', 'cnic',                      'all_directors', 'Of all directors.'),
  ('corporation', 'ntn_certificate',           'one',           'Of the company.'),
  ('corporation', 'incorporation_certificate', 'one',           'Certified by SECP.'),
  ('corporation', 'moa_aoa',                   'one',           'Certified by SECP.'),
  ('corporation', 'form_9',                    'one',           'Latest, certified by SECP.'),
  ('corporation', 'form_ii',                   'optional',      'Certified by SECP.'),
  ('corporation', 'utility_bill',              'one',           NULL),
  ('corporation', 'bank_certificate',          'one',           NULL),
  ('corporation', 'photo',                     'all_directors', NULL),
  ('corporation', 'pay_order',                 'one',           NULL),
  ('corporation', 'strn_certificate',          'optional',      NULL),
  ('corporation', 'passport',                  'optional',      'Where a director is a foreign national.'),

  ('company', 'letterhead_application',    'one',           'Signed by the managing director.'),
  ('company', 'cnic',                      'all_directors', 'Of all directors.'),
  ('company', 'ntn_certificate',           'one',           'Of the company.'),
  ('company', 'incorporation_certificate', 'one',           'Certified by SECP.'),
  ('company', 'moa_aoa',                   'one',           'Certified by SECP.'),
  ('company', 'form_9',                    'one',           'Latest, certified by SECP.'),
  ('company', 'form_ii',                   'optional',      'Certified by SECP.'),
  ('company', 'utility_bill',              'one',           NULL),
  ('company', 'bank_certificate',          'one',           NULL),
  ('company', 'photo',                     'all_directors', NULL),
  ('company', 'pay_order',                 'one',           NULL),
  ('company', 'strn_certificate',          'optional',      NULL),
  ('company', 'passport',                  'optional',      'Where a director is a foreign national.');

-- The fee table, exactly as printed.
--
-- `working_days` is not decoration: the tier is a paid promise of 40, 15 or 3
-- working days, so it is an SLA the system has to track and report against.
-- Whether the chamber's approval cadence can keep the three-day Executive
-- promise is an open question for LCCI, because a breached Executive
-- application took Rs 20,000 for an undelivered promise.
--
-- Amounts are DECIMAL with an explicit currency. The ITD surcharge is its own
-- `fee_kind` rather than a seventh class/tier row, because it applies *in
-- addition* to whichever membership fee was chosen and is paid by a separate
-- pay order.
CREATE TABLE fee_schedule (
  id               SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  fee_kind         ENUM('membership','itd_surcharge') NOT NULL DEFAULT 'membership',
  membership_class ENUM('corporate','associate') NULL,
  processing_tier  ENUM('regular','urgent','executive') NULL,
  amount           DECIMAL(14,2) NOT NULL,
  currency         CHAR(3) NOT NULL DEFAULT 'PKR',
  working_days     SMALLINT UNSIGNED NULL,
  effective_from   DATE NOT NULL,
  effective_to     DATE NULL,
  label_en         VARCHAR(120) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fee (fee_kind, membership_class, processing_tier, effective_from),
  KEY idx_fee_lookup (fee_kind, effective_from, effective_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO fee_schedule
  (fee_kind, membership_class, processing_tier, amount, currency, working_days, effective_from, label_en) VALUES
  ('membership', 'corporate', 'regular',   10650.00, 'PKR', 40, '2026-01-01', 'Corporate — regular (40 working days)'),
  ('membership', 'corporate', 'urgent',    15100.00, 'PKR', 15, '2026-01-01', 'Corporate — urgent (15 working days)'),
  ('membership', 'corporate', 'executive', 20000.00, 'PKR',  3, '2026-01-01', 'Corporate — executive (3 working days)'),
  ('membership', 'associate', 'regular',    4450.00, 'PKR', 40, '2026-01-01', 'Associate — regular (40 working days)'),
  ('membership', 'associate', 'urgent',     7300.00, 'PKR', 15, '2026-01-01', 'Associate — urgent (15 working days)'),
  ('membership', 'associate', 'executive', 10000.00, 'PKR',  3, '2026-01-01', 'Associate — executive (3 working days)'),
  ('itd_surcharge', NULL, NULL, 750.00, 'USD', NULL, '2026-01-01',
   'International Trade Development — firms represented by, or in partnership with, a foreign national');

-- When membership expires, as policy rather than as a hardcoded date.
--
-- The form's rule is absolute: membership expires on 31 March every year
-- regardless of the date of grant. Taken literally, a grant on 20 February
-- buys 39 days of membership for the full fee. That is what the form says and
-- so it is what ships; inventing a kinder rule in code is not a developer's
-- call. It is one row, so LCCI can choose a carry-forward cut-off without a
-- deploy. Pro-rating is recommended against without instruction, because the
-- pay order has already been drawn for one of exactly six published amounts
-- and the bank-match control compares that amount.
CREATE TABLE membership_year_policy (
  id                  TINYINT UNSIGNED NOT NULL,
  expires_on_month    TINYINT UNSIGNED NOT NULL,
  expires_on_day      TINYINT UNSIGNED NOT NULL,
  -- Non-null means a grant on or after this month and day is credited to the
  -- following membership year instead of the current one.
  carry_forward_month TINYINT UNSIGNED NULL,
  carry_forward_day   TINYINT UNSIGNED NULL,
  note                VARCHAR(300) NULL,
  updated_at          DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO membership_year_policy
  (id, expires_on_month, expires_on_day, carry_forward_month, carry_forward_day, note, updated_at) VALUES
  (1, 3, 31, NULL, NULL,
   'The literal rule from the printed form: expiry on 31 March regardless of the date of grant, no carry-forward.',
   UTC_TIMESTAMP(3));

-- Working days, as editable data.
--
-- Pakistani public holidays cannot be computed. Eid, Ashura and Eid
-- Milad-un-Nabi are lunar and officially notified only days in advance, Eid
-- routinely shifts on moon sighting, bank holidays matter because pay orders
-- cannot be issued or realised on them, and Lahore adds ad-hoc closures for
-- security and smog. Any attempt to calculate this is the most likely source
-- of a missed *paid* deadline in the whole system.
--
-- So the calendar is reference data with an admin screen. `confidence` is
-- 'provisional' for lunar dates until the notification lands, and `source`
-- names whoever said so.
--
-- Whether the secretariat works a five or six day week seeds every deadline
-- here and is an open question for LCCI; the generated seed assumes Monday to
-- Friday and marks itself provisional accordingly.
CREATE TABLE working_day_calendar (
  cal_date       DATE NOT NULL,
  is_working_day TINYINT(1) NOT NULL,
  label_en       VARCHAR(120) NULL,
  confidence     ENUM('confirmed','provisional') NOT NULL DEFAULT 'provisional',
  source         VARCHAR(160) NULL,
  notified_on    DATE NULL,
  updated_at     DATETIME(3) NOT NULL,
  PRIMARY KEY (cal_date),
  -- The nth-working-day query is `WHERE is_working_day = 1 AND cal_date > ?
  -- ORDER BY cal_date LIMIT 1 OFFSET n-1`, so this index is what makes SLA
  -- arithmetic a single indexed lookup rather than a scan.
  KEY idx_calendar_working (is_working_day, cal_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Gapless, externally meaningful counters.
--
-- Not MAX(col) + 1. A membership number is printed on certificates, quoted by
-- proposers and used to sign in, so format control and gaplessness outweigh
-- throughput at tens of approvals a week. Allocation is `SELECT ... FOR UPDATE`
-- on the row here, inside the transaction that needs the number, with a UNIQUE
-- index on the destination column as the backstop.
CREATE TABLE number_sequences (
  name       VARCHAR(40) NOT NULL,
  -- Carries {yyyy} and {seq}, the latter zero-padded to `pad_width`.
  pattern    VARCHAR(60) NOT NULL,
  next_value BIGINT UNSIGNED NOT NULL DEFAULT 1,
  pad_width  TINYINT UNSIGNED NOT NULL DEFAULT 6,
  -- Set where the counter restarts each period, so {seq} is per-year.
  resets     ENUM('never','yearly') NOT NULL DEFAULT 'never',
  -- The period the counter is currently in, e.g. '2026'. Rolling it over is
  -- part of the same locked allocation, so two approvals either side of
  -- midnight on 1 January cannot both take sequence 1.
  period_key VARCHAR(10) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The public reference an applicant quotes while the application is in flight.
--
-- Deliberately not the membership number: that is issued at approval and never
-- before, so a reference that has to exist from the moment of submission is
-- its own series.
--
-- The membership number sequence is NOT seeded here. Its format and the
-- highest number already in use are an open question for LCCI and blocking for
-- the legacy import — inventing a scheme now and correcting it after go-live
-- means reissuing certificates.
INSERT INTO number_sequences (name, pattern, next_value, pad_width, resets, period_key, updated_at) VALUES
  ('application_ref', 'LCCI-APP-{yyyy}-{seq}', 1, 5, 'yearly', NULL, UTC_TIMESTAMP(3));
