-- 0014 — the near-duplicate lookup, done properly.
--
-- 0013 added `idx_payorder_instrument (instrument_no, instrument_date)` and its
-- comment described a warning that this one actually implements. The index was
-- the wrong shape for it and the lookup was never written, which was found the
-- first time two applications were receipted by hand: "United Bank Limited"
-- instrument 000412 and "U.B.L." instrument 00-0412, same date, both accepted.
-- One physical pay order, two receipt numbers, nothing said.
--
-- Why it was not caught: `uq_payorder_fingerprint` hashes the *bank name* with
-- the number and the date, and deliberately without the alias list, so that the
-- hash means the same thing across a release that edits that list. "UBL" and
-- "United Bank Limited" therefore do not collide, by design and by test.
--
-- So the discriminating half gets its own key: SHA-256 of the normalised
-- instrument number and the instrument date, with no bank name in it at all.
-- Two banks can legitimately issue instrument 000412 on the same day, so this
-- is emphatically *not* unique — it is an indexed equality behind a refusal the
-- cashier can clear by confirming the instruments are different. A constraint
-- here would refuse honest applicants; silence lets one pay order pay twice.
--
-- NULL rather than a default of '': rows written before this column existed
-- have no key, and an empty-string default would make every one of them a
-- near-duplicate of every other.
ALTER TABLE pay_orders
  ADD COLUMN instrument_key CHAR(64) NULL AFTER instrument_fingerprint,
  ADD KEY idx_payorder_instrument_key (instrument_key);

-- Why the cashier let a near-duplicate through, where they did.
--
-- Kept beside the instrument rather than folded into `bank_match_note`, which
-- answers a different question: the note is about the account the instrument
-- was drawn on, and this is about whether the chamber has seen this piece of
-- paper before. Collapsing them would leave an auditor unable to tell which
-- judgement the sentence belongs to.
ALTER TABLE pay_orders
  ADD COLUMN duplicate_cleared_note VARCHAR(400) NULL AFTER instrument_key;
