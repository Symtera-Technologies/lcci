-- The `enquiry.read` permission, for databases that already ran 0005.
--
-- 0005 is a generated seed and its canonical form now carries this row, which
-- is what a fresh database gets. A database that ran 0005 before today does
-- not, and re-running 0005 is not an option: it is checksummed, and the
-- runner refuses a file whose contents have changed since it was applied —
-- correctly, because that refusal is the only thing standing between a
-- rewritten migration and a database nobody can describe.
--
-- So the row arrives twice, by two routes, and both are idempotent. The seed
-- is the definition; this is the delivery.
--
-- The super administrator's grant is a `SELECT` over `permissions` rather than
-- an enumerated list, in 0005 and again here, for exactly this situation: a
-- permission added after the seed ran would otherwise leave the one account
-- that is supposed to be able to do everything unable to use the newest
-- screen.
INSERT INTO permissions (code, label_en, domain) VALUES
  ('enquiry.read', 'Read website enquiries', 'admin')
ON DUPLICATE KEY UPDATE label_en = VALUES(label_en), domain = VALUES(domain);

-- No seeded role is granted it. Which desk owns the chamber's public inbox is
-- LCCI's decision, nobody has made it, and a default of "the Information
-- Department, probably" would arrive as a fact and never be revisited. The
-- super administrator holds it below by virtue of holding everything, and
-- assigning it to anyone else is one grant in the staff panel.
INSERT IGNORE INTO role_permissions (role_code, permission_code)
  SELECT 'super_admin', code FROM permissions;
