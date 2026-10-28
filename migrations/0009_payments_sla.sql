-- 0009 — payments, the pay-order control, and the SLA clock.
--
-- Payment is a *guard*, not a state of the application. The pay order arrives
-- with the form, so cashier receipting runs in parallel with document
-- verification; the machine simply asks "is every applicable payment receipted
-- or better?" before leaving VERIFIED. Serialising it would model a queue that
-- does not exist and stall verification behind the cashier's desk.

CREATE TABLE payments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,

  -- Two rows per application where a foreign national is involved: the
  -- membership fee and the USD 750 International Trade Development surcharge,
  -- which the form requires by a *separate* pay order.
  fee_kind        ENUM('membership','itd_surcharge') NOT NULL,
  fee_schedule_id SMALLINT UNSIGNED NULL,

  amount   DECIMAL(14,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'PKR',

  -- The USD surcharge is "equivalent", and at which rate on which date is a
  -- question for Finance. The rate actually used is recorded on the row rather
  -- than recomputed, so a receipt can be reproduced years later.
  fx_rate      DECIMAL(14,6) NULL,
  fx_rate_date DATE NULL,
  fx_authority VARCHAR(120) NULL,
  amount_pkr   DECIMAL(14,2) NULL,

  -- `dishonoured` is the state the paper process has no answer for. Here it
  -- drives a membership into suspension and writes an audited event, rather
  -- than being discovered when someone reconciles a bank statement.
  state ENUM(
    'due',
    'instrument_received',
    'receipted',
    'dishonoured',
    'refunded',
    'waived',
    'cancelled'
  ) NOT NULL DEFAULT 'due',

  method ENUM('pay_order','cash','cheque','online') NULL,

  -- Separation of duties: whoever receipts a payment may not also approve the
  -- application it belongs to. Enforced in SQL inside the approval
  -- transaction, which is why the receipting cashier is recorded here.
  received_at   DATETIME(3) NULL,
  receipted_at  DATETIME(3) NULL,
  receipted_by  BIGINT UNSIGNED NULL,
  receipt_no    VARCHAR(30) NULL,

  dishonoured_at     DATETIME(3) NULL,
  dishonour_reason   VARCHAR(300) NULL,

  -- What happens to a receipted payment when the application is rejected,
  -- withdrawn or closed for no response is an open question for LCCI. The
  -- three transitions set this flag; until there is a policy it records that a
  -- decision is owed rather than pretending one was made.
  refund_disposition ENUM('pending_decision','refund_due','forfeited','refunded') NULL,

  version INT UNSIGNED NOT NULL DEFAULT 1,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_pay_app_kind (application_id, fee_kind),
  UNIQUE KEY uq_pay_receipt_no (receipt_no),
  KEY idx_pay_state (state, created_at),
  KEY idx_pay_cashier (receipted_by),
  CONSTRAINT fk_pay_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_fee FOREIGN KEY (fee_schedule_id) REFERENCES fee_schedule (id),
  CONSTRAINT fk_pay_receipted_by FOREIGN KEY (receipted_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The pay order, and the anti-fraud control the printed form builds in.
--
-- The form requires the fee to be paid by a pay order "drawn on the same bank
-- account" as the attached account-maintenance certificate. That pairing is a
-- control, so both sides of the comparison are stored as data and the
-- comparison itself is modelled rather than left to whoever is at the counter.
--
-- A pay order prints the issuing bank and branch, not the drawer's account
-- number, so what the cashier can actually compare today is probably "same
-- bank and branch, and the account title matches the business title". That is
-- what these columns hold. Exactly what is compared in practice is an open
-- question for LCCI — both sides are stored either way, but modelling the
-- wrong fields would build a check nobody can perform.
CREATE TABLE pay_orders (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_id BIGINT UNSIGNED NOT NULL,

  -- As printed on the instrument.
  drawee_bank_name    VARCHAR(160) NOT NULL,
  drawee_branch       VARCHAR(160) NULL,
  instrument_no       VARCHAR(40) NOT NULL,
  instrument_date     DATE NOT NULL,
  instrument_amount   DECIMAL(14,2) NOT NULL,
  instrument_currency CHAR(3) NOT NULL DEFAULT 'PKR',
  account_title       VARCHAR(200) NULL,

  -- As printed on the account-maintenance certificate, copied here at
  -- receipting so the comparison has two fixed sides and does not drift when
  -- the applicant later edits their particulars.
  certificate_bank_name     VARCHAR(160) NULL,
  certificate_branch        VARCHAR(160) NULL,
  certificate_account_title VARCHAR(200) NULL,
  certificate_issued_on     DATE NULL,

  -- The machine's opinion, advisory only. "HBL", "Habib Bank Ltd" and
  -- "H.B.L Gulberg III" are the same branch, so a normalised string compare
  -- can suggest and must never decide.
  bank_match_system ENUM('match','mismatch','uncertain') NULL,

  -- The officer's judgement, which is what approval is actually guarded on.
  bank_match_verdict    ENUM('match','mismatch') NULL,
  bank_match_verdict_by BIGINT UNSIGNED NULL,
  bank_match_verdict_at DATETIME(3) NULL,
  bank_match_note       VARCHAR(400) NULL,

  -- SHA-256 of the normalised (bank, instrument number, date) triple.
  --
  -- A composite unique index on those three columns would be 803 bytes in
  -- utf8mb4 and will not fit the 767-byte prefix limit older InnoDB row
  -- formats impose — and on a shared host the row format is not ours to
  -- choose. Hashing also lets the normalisation (case, spacing, punctuation)
  -- live in one tested function instead of in a collation. What it catches is
  -- the same pay order presented on two applications.
  instrument_fingerprint CHAR(64) NOT NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_payorder_fingerprint (instrument_fingerprint),
  KEY idx_payorder_payment (payment_id),
  CONSTRAINT fk_payorder_payment FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE CASCADE,
  CONSTRAINT fk_payorder_verdict_by FOREIGN KEY (bank_match_verdict_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The processing-tier promise, as a clock.
--
-- `due_date` is materialised at submission and recomputed only on pause,
-- resume, or a calendar edit that lands inside a running window. Breach is
-- then evaluated on read — `due_date < CURDATE()` — exactly as the public
-- site already evaluates notice expiry. Nothing needs a timer, which matters
-- on a host that cannot run one.
--
-- A late-notified holiday sets `needs_recompute` on every clock spanning that
-- date, and the next cron tick recomputes in a bounded batch with an audit
-- event per change. A deadline quietly becoming later without a record would
-- be the audit failure, not the fix.
CREATE TABLE sla_clocks (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,

  processing_tier ENUM('regular','urgent','executive') NOT NULL,
  working_days    SMALLINT UNSIGNED NOT NULL,

  started_at DATETIME(3) NOT NULL,
  -- The civil date the promise falls due. DATE, not DATETIME: it is quoted to
  -- the applicant and must not shift a day when rendered in another zone.
  due_date   DATE NOT NULL,

  -- Whether the clock is running, and how it ended.
  state   ENUM('running','paused','stopped') NOT NULL DEFAULT 'running',
  outcome ENUM('met','breached') NULL,

  stopped_at DATETIME(3) NULL,

  -- Reported separately, because "32 working days elapsed, 11 of them waiting
  -- on the applicant" is the number that matters when a member complains
  -- about a missed Executive promise.
  elapsed_working_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  paused_working_days  SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  needs_recompute TINYINT(1) NOT NULL DEFAULT 0,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  -- One clock per application. A deficiency pauses it; it does not start a
  -- second one.
  UNIQUE KEY uq_sla_app (application_id),
  -- The breach report and the nudge job both read this.
  KEY idx_sla_due (state, due_date),
  KEY idx_sla_recompute (needs_recompute),
  CONSTRAINT fk_sla_app FOREIGN KEY (application_id) REFERENCES applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each stretch the clock was stopped, and what it cost.
--
-- Kept as rows rather than as a running total on the clock, because the
-- question asked of this data is "why was this late", and a total cannot
-- answer it.
CREATE TABLE sla_pauses (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sla_clock_id BIGINT UNSIGNED NOT NULL,
  reason       ENUM(
    'awaiting_applicant',
    'awaiting_originals',
    'awaiting_endorsement',
    'awaiting_payment',
    'office_closure',
    'other'
  ) NOT NULL,
  note               VARCHAR(300) NULL,
  paused_at          DATETIME(3) NOT NULL,
  resumed_at         DATETIME(3) NULL,
  working_days_cost  SMALLINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY idx_pause_clock (sla_clock_id, paused_at),
  CONSTRAINT fk_pause_clock FOREIGN KEY (sla_clock_id) REFERENCES sla_clocks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
