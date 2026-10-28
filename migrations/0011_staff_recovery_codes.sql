-- 0011 — staff two-factor recovery codes.
--
-- Staff authenticate with a password and an authenticator app. That pair has
-- one failure mode that has nothing to do with an attacker: a lost or wiped
-- phone. Without recovery codes the only way back in is someone editing
-- `users.totp_secret_enc` by hand in phpMyAdmin — which is both the least
-- auditable operation available on this host and an excellent social
-- engineering target ("I've lost my phone, can you clear my 2FA?").
--
-- Ten codes, scrypt-hashed, single use. Hashed and not encrypted because
-- nothing ever needs to read them back: a code is presented and compared, so
-- a reversible store would be a store of live credentials for no benefit.
-- scrypt rather than SHA-256 because these are low-entropy enough to be worth
-- brute-forcing if the table leaks, and the same reason staff passwords use
-- it.
--
-- `used_at` rather than a DELETE, so "this account burned four recovery codes
-- last month" stays answerable. That is the signal that someone is struggling
-- with their authenticator — or that someone else is using their codes.

CREATE TABLE staff_recovery_codes (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id   BIGINT UNSIGNED NOT NULL,
  -- scrypt digest, same format as `users.password_hash`.
  code_hash VARCHAR(255) NOT NULL,
  -- The position in the printed set (1-10), so the staff member can be told
  -- which code they just spent without the code itself being stored.
  ordinal   TINYINT UNSIGNED NOT NULL,
  used_at   DATETIME(3) NULL,
  used_ip_hash CHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Enrolment replaces the whole set, so (user_id, ordinal) is not unique
  -- across time; the index is for the lookup, not a constraint.
  KEY idx_recovery_user (user_id, used_at),
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
