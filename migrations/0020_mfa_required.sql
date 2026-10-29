-- An administrator can require two-factor sign-in on a staff account.
--
-- A separate column from `mfa_mode`, deliberately. `mfa_mode` is a fact about
-- the account — what it currently has — and `mfa_required` is a policy about
-- it: what somebody has decided it must have. Folding the policy into the fact
-- loses the state that matters most, which is "required and not yet done", and
-- that is precisely the state the sign-in gate exists to act on.
--
-- Default 0, matching the default for the setting itself. A requirement nobody
-- asked for is not a requirement, and turning it on for every existing account
-- in a migration would lock the whole secretariat out of the backend at the
-- next sign-in until each of them found their phone.
ALTER TABLE users
  ADD COLUMN mfa_required TINYINT(1) NOT NULL DEFAULT 0 AFTER mfa_mode,
  -- Who decided, and when. Without these the account holder sees a demand
  -- with no author: the only honest answer to "who turned this on for me?"
  -- would be to read the audit log, which they cannot. The audit log is still
  -- the record of the change; this is the record of the current state, which
  -- is what a screen can render.
  ADD COLUMN mfa_required_by BIGINT UNSIGNED NULL AFTER mfa_required,
  ADD COLUMN mfa_required_at DATETIME(3) NULL AFTER mfa_required_by,
  -- ON DELETE SET NULL, not CASCADE: an administrator's account being removed
  -- must not quietly lift a requirement they imposed on somebody else.
  ADD CONSTRAINT fk_users_mfa_required_by
    FOREIGN KEY (mfa_required_by) REFERENCES users (id) ON DELETE SET NULL;

-- The accounts that already chose two-factor are left alone: they have it on,
-- and recording it as *required* would be putting words in their mouth. An
-- administrator who wants it pinned there does so on the user's screen, which
-- writes who and when.
