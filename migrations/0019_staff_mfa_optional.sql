-- Two-factor sign-in becomes each staff member's own setting, off by default.
--
-- Nothing structural changes: `users.mfa_mode` has carried a 'none' value
-- since 0001 and `totp_secret_enc` has always been nullable. What changes is
-- which combination the application treats as "on" — `mfa_mode = 'totp'` AND
-- a secret present, both, or two-factor is off.
--
-- This migration only makes the column honest about the rows that already
-- exist. A staff account created before this change got the table default of
-- 'otp_email', which was never true of staff: they have no emailed-code path
-- at all, and the enrolment gate meant the value was simply never read. Under
-- the new rule those rows behave correctly (not 'totp' means off), but a
-- column that says 'otp_email' about an account that cannot receive an emailed
-- code is a trap for the next person to read it.
--
-- Accounts that genuinely enrolled are left exactly as they are. Turning
-- two-factor off for somebody who chose it is not a migration's decision to
-- make, and the whole point of the new design is that the holder owns it.
UPDATE users
   SET mfa_mode = 'none'
 WHERE user_type = 'staff'
   AND totp_secret_enc IS NULL
   AND mfa_mode <> 'none';

-- Portal members are untouched: 'otp_email' is exactly right for them, since
-- an emailed code is their only credential and they have no password.
