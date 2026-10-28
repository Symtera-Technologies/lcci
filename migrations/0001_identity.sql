-- 0001 — identity and access.
--
-- One `users` table rather than separate staff and member tables. Two reasons:
-- the audit log needs a single foreign-key target for "actor", and the OTP
-- machinery is identical for both. The difference between a member and a staff
-- account is `user_type` plus which roles are granted.
--
-- Engine-neutral by design: cPanel ships MariaDB far more often than MySQL 8,
-- so there are no CHECK constraints (not enforced before MariaDB 10.2.1 and
-- MySQL 8.0.16), no JSON functional indexes, and no utf8mb4_0900 collation.
-- Run SELECT VERSION() on the target host before trusting anything here.

CREATE TABLE users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_type         ENUM('staff','portal') NOT NULL,
  -- 190 chars: utf8mb4 is 4 bytes per character, so 190 fits a unique index
  -- under the 767-byte prefix limit older InnoDB row formats impose.
  email             VARCHAR(190) NOT NULL,
  mobile_e164       VARCHAR(20) NULL,
  full_name         VARCHAR(160) NOT NULL,
  -- NULL for portal users: members have no password at all, which is also
  -- what makes the legacy import tractable (no reset campaign, no temporary
  -- credentials in email).
  password_hash     VARCHAR(255) NULL,
  -- AES-256-GCM ciphertext. The master key is in the environment.
  totp_secret_enc   VARBINARY(255) NULL,
  mfa_mode          ENUM('none','otp_email','otp_sms','totp') NOT NULL DEFAULT 'otp_email',
  status            ENUM('invited','active','suspended','disabled') NOT NULL DEFAULT 'invited',
  -- Bumped on any change to roles, permissions, status, password, 2FA or
  -- email. Sessions carry the version they were minted with, so every session
  -- of this user dies the instant this changes.
  role_version      INT UNSIGNED NOT NULL DEFAULT 1,
  email_verified_at DATETIME(3) NULL,
  last_login_at     DATETIME(3) NULL,
  failed_logins     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until      DATETIME(3) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_type_status (user_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE roles (
  code      VARCHAR(40) NOT NULL,
  label_en  VARCHAR(80) NOT NULL,
  -- A system role cannot be deleted through the admin, only re-granted.
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The permission vocabulary also exists as a closed union in TypeScript, so a
-- misspelled permission is a compile error. Grants are data the chamber can
-- adjust; the codes are referenced by name in handlers and are therefore code.
CREATE TABLE permissions (
  code     VARCHAR(60) NOT NULL,
  label_en VARCHAR(120) NOT NULL,
  domain   ENUM('content','membership','finance','admin') NOT NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE role_permissions (
  role_code       VARCHAR(40) NOT NULL,
  permission_code VARCHAR(60) NOT NULL,
  PRIMARY KEY (role_code, permission_code),
  KEY idx_rp_permission (permission_code),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_code) REFERENCES roles (code) ON DELETE CASCADE,
  CONSTRAINT fk_rp_permission FOREIGN KEY (permission_code) REFERENCES permissions (code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_roles (
  user_id     BIGINT UNSIGNED NOT NULL,
  role_code   VARCHAR(40) NOT NULL,
  scope_kind  ENUM('global','department','content_type') NOT NULL DEFAULT 'global',
  -- NOT NULL with an empty default rather than nullable: MySQL treats NULLs as
  -- distinct in a unique key, so a nullable scope would let the same grant be
  -- inserted twice and the primary key would not prevent it.
  scope_value VARCHAR(80) NOT NULL DEFAULT '',
  granted_by  BIGINT UNSIGNED NULL,
  granted_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, role_code, scope_kind, scope_value),
  KEY idx_ur_role (role_code),
  CONSTRAINT fk_ur_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ur_role FOREIGN KEY (role_code) REFERENCES roles (code) ON DELETE CASCADE,
  CONSTRAINT fk_ur_granted_by FOREIGN KEY (granted_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sessions live here rather than in a signed cookie because spec section 9
-- requires invalidation on role change, and a stateless token cannot be
-- revoked. MySQL is a local socket on this host, so the lookup is cheap.
CREATE TABLE sessions (
  -- sha256(token), NOT the token. A leaked backup or a mis-logged query then
  -- yields nothing usable, and there is no timing channel because the hash is
  -- the primary key.
  id                  CHAR(64) NOT NULL,
  user_id             BIGINT UNSIGNED NOT NULL,
  user_type           ENUM('staff','portal') NOT NULL,
  role_version        INT UNSIGNED NOT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at          DATETIME(3) NOT NULL,
  -- Never extended by activity. Sliding expiry moves `expires_at` only.
  absolute_expires_at DATETIME(3) NOT NULL,
  mfa_satisfied_at    DATETIME(3) NULL,
  ip_hash             CHAR(64) NULL,
  user_agent_hash     CHAR(64) NULL,
  revoked_at          DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_sessions_user (user_id, revoked_at),
  KEY idx_sessions_sweep (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time codes. Consumption is a single conditional UPDATE checked by
-- affected-row count: a SELECT then UPDATE is a live race across Passenger's
-- worker processes, and the race is "the same code used twice".
CREATE TABLE otp_challenges (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id            BIGINT UNSIGNED NULL,
  purpose            ENUM('login','endorse','email_verify') NOT NULL,
  -- Hashed, so this table is not a list of who is signing in and when.
  identifier_hash    CHAR(64) NOT NULL,
  destination        VARCHAR(190) NOT NULL,
  -- sha256(code + salt). Never the code: an OTP table inside a nightly backup
  -- would otherwise be a live set of credentials.
  code_hash          CHAR(64) NOT NULL,
  salt               CHAR(32) NOT NULL,
  -- Binds the code to the browser that requested it, so possession of the
  -- inbox alone is not enough.
  browser_nonce_hash CHAR(64) NULL,
  attempts           TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts       TINYINT UNSIGNED NOT NULL DEFAULT 5,
  expires_at         DATETIME(3) NOT NULL,
  consumed_at        DATETIME(3) NULL,
  created_ip_hash    CHAR(64) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- Covers both "the live challenge for this identifier" and the invalidation
  -- of prior unconsumed codes when a new one is issued.
  KEY idx_otp_live (identifier_hash, purpose, consumed_at, expires_at),
  KEY idx_otp_sweep (expires_at),
  CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Throttling on two axes. Locking only by IP lets one NAT'd office lock itself
-- out; locking only by identifier lets an attacker spray across accounts.
CREATE TABLE login_throttle (
  bucket           VARCHAR(80) NOT NULL,
  axis             ENUM('identifier','ip') NOT NULL,
  failures         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- Escalates 15m, 1h, 4h, 24h. Deliberately never permanent: a permanent
  -- lock is a denial of service anyone can trigger against a member they can
  -- name, and membership numbers are public.
  locked_until     DATETIME(3) NULL,
  escalation       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  first_failure_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_failure_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (bucket),
  KEY idx_throttle_sweep (last_failure_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Spent TOTP time steps. In the database rather than in memory because
-- Passenger runs several worker processes: an in-process set would let the
-- same code be replayed against a different worker inside its own window.
CREATE TABLE staff_totp_used (
  user_id BIGINT UNSIGNED NOT NULL,
  step    BIGINT UNSIGNED NOT NULL,
  used_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, step),
  KEY idx_totp_sweep (used_at),
  CONSTRAINT fk_totp_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Modelled now rather than later: spec section 8.2 allows several users per
-- company, and retrofitting a user-to-company join after importing roughly
-- twenty thousand member records is the expensive version of this decision.
CREATE TABLE companies (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_companies_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE company_users (
  company_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  relation   ENUM('owner','staff','authorised_agent') NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  added_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (company_id, user_id),
  KEY idx_cu_user (user_id),
  CONSTRAINT fk_cu_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_cu_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_cu_added_by FOREIGN KEY (added_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
