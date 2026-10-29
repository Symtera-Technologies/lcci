-- 0015 — the member register: what approval actually produces.
--
-- Up to here the system has been about an application. This is the first
-- schema that outlives one: a membership is the thing the chamber grants, the
-- thing a certificate is printed from, the thing a proposer quotes, and the
-- thing a member signs in against. Four properties of that shape everything
-- below.
--
-- **The number is externally meaningful, so it is allocated under a lock and
-- never reused.** Not AUTO_INCREMENT, not MAX(..)+1: `number_sequences` is
-- read `FOR UPDATE` inside the approval transaction, and `uq_membership_no` is
-- the backstop that turns a mistake into a failed approval rather than two
-- members holding one number. A reversed approval sets `status = 'cancelled'`
-- and keeps the number forever, because it has already been quoted.
--
-- **The membership year is policy, not arithmetic in code.** The printed form's
-- rule is absolute — expiry on 31 March regardless of the date of grant — and
-- it lives in `membership_year_policy` (migration 0007) so LCCI can choose a
-- carry-forward cut-off without a deploy. `membership_years` stores the
-- computed window per year rather than recomputing it, because `valid_until`
-- is printed on a certificate and a policy edit must not silently reprint a
-- date somebody is holding on paper.
--
-- **A decision is a record, not a state change.** `applications.state` says
-- where the file is now; `application_decisions` says who decided what, when,
-- under which role, and on what reasoning. The state can be moved again by
-- `reopen_for_correction`; the decision row never changes.
--
-- **Separation of duties has to be able to be broken, visibly.** The form's
-- separate staff and cashier signatures exist to keep verification, receipting
-- and approval in three pairs of hands, and `conflict_waivers` is the honest
-- answer for a secretariat where one officer may be the only person in the
-- building. The alternative is staff learning to share logins, which destroys
-- the audit log altogether. A waiver is super-admin only, names the guard it
-- waives, and demands a reason.

/* -------------------------------------------------------------------------- */
/* The membership number sequence                                             */
/* -------------------------------------------------------------------------- */

-- PROVISIONAL, and must be set before go-live.
--
-- Open question 5 — "membership number format and the highest number in use" —
-- is unanswered, and the plan's instruction is to pick nothing without it: a
-- scheme invented now and corrected after go-live means reissuing
-- certificates. So the mechanism ships and the values do not pretend to be
-- final.
--
-- `LCCI-{seq}` with six digits and no yearly reset is the shape a permanent
-- register number takes — a year prefix would be wrong here, because the
-- number outlives the year it was issued in, unlike an application reference.
-- Two things must change once LCCI answers:
--
--   1. `pattern`, if their numbers are not of this shape.
--   2. `next_value`, which MUST be set above the highest number already in use
--      in the existing system, or the legacy import collides with numbers this
--      system has already issued. `uq_membership_no` will refuse the
--      collision rather than allow it, which means a failed import or a failed
--      approval — loud, but still a day nobody needs.
--
-- Both are one UPDATE on this row. Neither is a deploy.
-- `INSERT IGNORE`, matching 0005's role grants: if this file half-applies
-- (MySQL does not roll DDL back, so a later CREATE TABLE failing leaves an
-- earlier INSERT committed) the re-run must not fail on its own row. It also
-- means a re-run cannot stamp over a pattern an administrator has already
-- corrected, which matters precisely because these values are placeholders.
INSERT IGNORE INTO number_sequences (name, pattern, next_value, pad_width, resets, period_key, updated_at) VALUES
  ('membership_no', 'LCCI-{seq}', 1, 6, 'never', NULL, UTC_TIMESTAMP(3));

/* -------------------------------------------------------------------------- */
/* The register                                                               */
/* -------------------------------------------------------------------------- */

-- One row per membership, keyed on the company rather than the application.
--
-- `company_id` and not `application_id` as the identity, because a membership
-- renews for twenty years against one company and was granted by exactly one
-- application. `granted_by_application_id` keeps the provenance and is
-- deliberately not the key.
--
-- The company row itself is created *at approval*. Before that there is an
-- applicant and a firm name on a form; there is no member. Creating it earlier
-- would put unapproved firms in the table the directory reads.
CREATE TABLE memberships (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id                BIGINT UNSIGNED NOT NULL,
  -- Issued at approval, never later, never reused. NOT NULL: a membership
  -- without a number is not a state this register has.
  membership_no             VARCHAR(40) NOT NULL,
  membership_class          ENUM('corporate','associate') NOT NULL,
  -- `lapsed` is reached by time, not by an actor: the 31 March expiry is
  -- evaluated on read against `membership_years.valid_until`, the same way
  -- notice expiry already is, so nothing needs a timer. `suspended` is an act
  -- — today only a dishonoured fee reaches it.
  status                    ENUM('active','lapsed','suspended','cancelled') NOT NULL DEFAULT 'active',
  granted_on                DATE NOT NULL,
  granted_by                BIGINT UNSIGNED NULL,
  granted_by_application_id BIGINT UNSIGNED NULL,

  suspended_at              DATETIME(3) NULL,
  suspend_reason            VARCHAR(300) NULL,
  suspended_by              BIGINT UNSIGNED NULL,

  -- A reversal. The number stays in the column and the row stays in the
  -- table; only the status says it is no longer a membership.
  cancelled_at              DATETIME(3) NULL,
  cancel_reason             VARCHAR(300) NULL,
  cancelled_by              BIGINT UNSIGNED NULL,

  version                   INT UNSIGNED NOT NULL DEFAULT 1,
  created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_membership_no (membership_no),
  -- Not unique: a company whose membership was cancelled and granted again
  -- has two rows, and the second is a different membership with a different
  -- number. Which one is live is `status`.
  KEY idx_membership_company (company_id, status),
  KEY idx_membership_status (status),
  KEY idx_membership_application (granted_by_application_id),
  CONSTRAINT fk_membership_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_membership_granted_by FOREIGN KEY (granted_by) REFERENCES users (id),
  CONSTRAINT fk_membership_application FOREIGN KEY (granted_by_application_id) REFERENCES applications (id),
  CONSTRAINT fk_membership_suspended_by FOREIGN KEY (suspended_by) REFERENCES users (id),
  CONSTRAINT fk_membership_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per membership year, computed once and then fixed.
--
-- `valid_until` is the date on the certificate. It is materialised rather than
-- derived on read for exactly that reason: if LCCI later sets a carry-forward
-- cut-off in `membership_year_policy`, every certificate already printed must
-- keep saying what it says. A derived expiry would quietly reprint history.
--
-- `label` is the human form — "2026–27" for a year ending 31 March 2027 —
-- stored because it is quoted in correspondence and because deriving it twice
-- in two places is how the two come to disagree.
CREATE TABLE membership_years (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  membership_id BIGINT UNSIGNED NOT NULL,
  label         VARCHAR(20) NOT NULL,
  starts_on     DATE NOT NULL,
  valid_until   DATE NOT NULL,
  -- Which event bought this year. Renewal is Track B7; today every row is a
  -- grant, and the column exists so that B7 adds rows rather than a column.
  source        ENUM('grant','renewal') NOT NULL DEFAULT 'grant',
  -- The fee that paid for it, so a dishonoured payment can be traced to the
  -- year it bought. Nullable because a waived fee buys a year too.
  payment_id    BIGINT UNSIGNED NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- One row per membership per year. A second grant for a year already paid
  -- for is a double charge, and this refuses it.
  UNIQUE KEY uq_membership_year (membership_id, valid_until),
  KEY idx_membership_year_expiry (valid_until, membership_id),
  CONSTRAINT fk_membership_year_membership FOREIGN KEY (membership_id) REFERENCES memberships (id),
  CONSTRAINT fk_membership_year_payment FOREIGN KEY (payment_id) REFERENCES payments (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

-- Who decided what, and why. Append-only by convention and by the absence of
-- any code that updates it.
--
-- `decided_by_role_code` is snapshotted rather than joined, for the same
-- reason the audit log snapshots it: the role someone held when they approved
-- is a historical fact, and joining would rewrite it on every promotion.
CREATE TABLE application_decisions (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id       BIGINT UNSIGNED NOT NULL,
  -- `returned` is a decision too. An approver who sends a file back has
  -- exercised judgement, and leaving it out of this table would make the
  -- approval history read as though nothing happened between two approvals.
  decision             ENUM('approved','rejected','returned') NOT NULL,
  decided_by           BIGINT UNSIGNED NOT NULL,
  decided_by_role_code VARCHAR(40) NULL,
  decided_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Required for a rejection or a return, optional for an approval: refusing
  -- somebody needs a reason, granting to a clear file does not.
  reason               VARCHAR(600) NULL,
  -- The membership this decision created, where it created one.
  membership_id        BIGINT UNSIGNED NULL,
  created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_decision_application (application_id, decided_at),
  KEY idx_decision_actor (decided_by, decided_at),
  CONSTRAINT fk_decision_application FOREIGN KEY (application_id) REFERENCES applications (id),
  CONSTRAINT fk_decision_actor FOREIGN KEY (decided_by) REFERENCES users (id),
  CONSTRAINT fk_decision_membership FOREIGN KEY (membership_id) REFERENCES memberships (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Breaking separation of duties, on the record.
--
-- Super-admin only, one guard at a time, reason mandatory. Scoped to a single
-- application on purpose: a standing waiver would be indistinguishable from
-- removing the guard, and the whole value of this table is that somebody had
-- to decide, by name, for this file.
--
-- `expires_at` is absent deliberately. A waiver applies to one decision on one
-- application and is consumed by it; a waiver with a lifetime is a window in
-- which the control is simply off.
CREATE TABLE conflict_waivers (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  -- The guard code from `src/membership/workflow.ts` — today
  -- `not_the_verifier` or `not_the_cashier`. A free string rather than an ENUM
  -- because the guard vocabulary is TypeScript's closed union and adding a
  -- guard should not need a migration; the application layer refuses a code it
  -- does not know.
  waived_guard   VARCHAR(60) NOT NULL,
  reason         VARCHAR(600) NOT NULL,
  granted_by     BIGINT UNSIGNED NOT NULL,
  granted_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Who the waiver was granted *for*. A waiver is not a general exemption:
  -- it permits one named person to take one decision they would otherwise be
  -- barred from, and a different approver gets no benefit from it.
  granted_for    BIGINT UNSIGNED NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_waiver (application_id, waived_guard, granted_for),
  KEY idx_waiver_application (application_id),
  CONSTRAINT fk_waiver_application FOREIGN KEY (application_id) REFERENCES applications (id),
  CONSTRAINT fk_waiver_granted_by FOREIGN KEY (granted_by) REFERENCES users (id),
  CONSTRAINT fk_waiver_granted_for FOREIGN KEY (granted_for) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
