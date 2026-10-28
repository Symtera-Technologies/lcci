-- 0004 — email outbox, job runner state, rate limiting, CSP reports.
--
-- Every table here exists because of one host constraint: there is no daemon
-- and no Redis, so MySQL is the only state shared between Passenger's worker
-- processes. Anything held in a process is per-worker and lost the moment
-- `tmp/restart.txt` is touched.

-- A queue built from a table and a cron tick. after() writes the row and tries
-- to send immediately, so the happy path is instant; the cron sweep retries
-- what failed. Email is never sent inline on a request path — a slow SMTP or
-- API handshake inside a Passenger worker is a request timeout and a lost
-- state transition. The one exception is the login OTP, which is awaited,
-- because claiming "code sent" when the provider rejected it is worse.
CREATE TABLE email_outbox (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  to_address      VARCHAR(190) NOT NULL,
  template        VARCHAR(60) NOT NULL,
  payload_json    JSON NOT NULL,
  -- WhatsApp and SMS are [TBC] in spec section 8.1. The column exists now so
  -- adding a channel later is an adapter, not a migration on a live table.
  channel         VARCHAR(20) NOT NULL DEFAULT 'email',
  entity_type     VARCHAR(40) NULL,
  entity_id       VARCHAR(64) NULL,
  state           ENUM('pending','sending','sent','failed','dead') NOT NULL DEFAULT 'pending',
  attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error      VARCHAR(500) NULL,
  -- Claimed by a conditional UPDATE, then selected by locked_by. Never a
  -- SELECT followed by an UPDATE: two overlapping cron ticks would both drain
  -- the same rows and every recipient would get the message twice.
  locked_at       DATETIME(3) NULL,
  locked_by       CHAR(26) NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at         DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_outbox_claim (state, next_attempt_at),
  KEY idx_outbox_locked (locked_by),
  KEY idx_outbox_entity (entity_type, entity_id),
  -- The retention sweep drops payloads after 30 days but keeps send metadata.
  KEY idx_outbox_retention (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per job, not one per run: this is the lock plus the last outcome.
-- GET_LOCK provides the crash-safe half of mutual exclusion (it releases when
-- the connection drops); this table provides observability and the
-- heartbeat-staleness escape.
CREATE TABLE job_runs (
  job          VARCHAR(40) NOT NULL,
  state        ENUM('idle','running','failed') NOT NULL DEFAULT 'idle',
  run_id       CHAR(26) NULL,
  started_at   DATETIME(3) NULL,
  finished_at  DATETIME(3) NULL,
  -- Refreshed inside long jobs. The claim condition treats a stale heartbeat
  -- as unlocked, because a worker killed mid-run by the shared plan's CPU
  -- limiter would otherwise hold this job forever and the symptom would be
  -- "cron silently stopped working" with nothing in any log.
  heartbeat_at DATETIME(3) NULL,
  -- What the last run did. On a host with no monitoring stack, the admin panel
  -- reading this column is the monitoring.
  last_summary JSON NULL,
  PRIMARY KEY (job)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fixed-window counters for high-volume, low-value buckets. One atomic
-- statement per check: INSERT ... ON DUPLICATE KEY UPDATE hits = hits + 1.
CREATE TABLE rate_limit_counters (
  -- scope:subject:windowStart. The subject is always a hashed IP or a hashed
  -- identifier, so this table is not an IP log.
  bucket            VARCHAR(190) NOT NULL,
  hits              INT UNSIGNED NOT NULL DEFAULT 0,
  window_started_at DATETIME(3) NOT NULL,
  expires_at        DATETIME(3) NOT NULL,
  PRIMARY KEY (bucket),
  KEY idx_rlc_sweep (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A sliding window for the few small, high-value buckets: login, OTP request,
-- OTP verify. A fixed window permits a 2x burst across the boundary, and the
-- login form is precisely where that matters. Rows are counted, then swept.
CREATE TABLE rate_limit_events (
  id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bucket VARCHAR(190) NOT NULL,
  at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_rle_window (bucket, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Violations reported while the policy ships as Report-Only. An enforcing CSP
-- shipped blind to a site with embeds and a CMS breaks something on day one,
-- so the header name is flipped only after this table has been quiet.
CREATE TABLE csp_reports (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_uri       VARCHAR(500) NULL,
  violated_directive VARCHAR(190) NULL,
  blocked_uri        VARCHAR(500) NULL,
  disposition        VARCHAR(20) NULL,
  raw_json           JSON NOT NULL,
  received_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_csp_directive (violated_directive, received_at),
  KEY idx_csp_sweep (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
