-- 0013 — what cashier receipting needs that 0009 did not provide.
--
-- 0009 modelled the money. This adds the two things the act of receipting
-- needs on top of it: a receipt number series, and the index behind the
-- near-duplicate warning.

-- The receipt number the cashier writes in the page-2 block.
--
-- A separate series from `application_ref` and from the membership number,
-- because it counts a different thing and because finance will be asked to
-- reconcile against it. Yearly, like the application reference, so a receipt
-- number carries the year it was issued in — which is what makes a bank
-- statement reconcilable against this table by eye.
--
-- Allocated under the sequence row's own `FOR UPDATE` lock inside the
-- receipting transaction, so two cashiers receipting at the same moment
-- serialise rather than both taking the same number. `UNIQUE KEY
-- uq_pay_receipt_no` on `payments.receipt_no` is the backstop that turns a
-- bug here into a failed receipt rather than a duplicate.
INSERT INTO number_sequences (name, pattern, next_value, pad_width, resets, period_key, updated_at) VALUES
  ('fee_receipt', 'LCCI-RCPT-{yyyy}-{seq}', 1, 5, 'yearly', NULL, UTC_TIMESTAMP(3));

-- The near-duplicate lookup.
--
-- `uq_payorder_fingerprint` catches the same pay order presented twice
-- *exactly*: same bank spelling, same number, same date. It cannot catch the
-- same instrument entered as "HBL" on one application and "Habib Bank Ltd" on
-- another, because the fingerprint deliberately does not run the bank name
-- through the alias list — an editable list inside a hash means the hash stops
-- meaning the same thing across the release that edits it.
--
-- So the number and the date, which are the discriminating half, get an index
-- of their own, and receipting warns when they already exist under a
-- different fingerprint. Advisory by construction: two banks can legitimately
-- issue instrument 000412 on the same day, which is exactly why this is a
-- warning the cashier reads and not a constraint that refuses them.
ALTER TABLE pay_orders
  ADD KEY idx_payorder_instrument (instrument_no, instrument_date);

-- Who recorded the dishonour, and when it was reconciled.
--
-- 0009 stored `dishonoured_at` and `dishonour_reason` but not the actor. A
-- dishonour suspends a membership and is the one payment event that takes
-- something away from a member, so "who said so" is not optional — it is the
-- first question asked when a member telephones to say their pay order
-- cleared.
ALTER TABLE payments
  ADD COLUMN dishonoured_by BIGINT UNSIGNED NULL AFTER dishonour_reason,
  ADD CONSTRAINT fk_pay_dishonoured_by FOREIGN KEY (dishonoured_by) REFERENCES users (id) ON DELETE SET NULL;

-- What the cashier accepted a short or over-drawn instrument for.
--
-- Class is self-declared on the printed form, so an applicant who files as
-- Corporate on Associate turnover has already drawn a pay order for one of the
-- wrong six published amounts by the time anyone looks at it. The cashier can
-- receipt it anyway — bouncing them at the counter is not kinder — but then
-- the shortfall is a fact somebody has to answer for later, so it is recorded
-- here rather than left in a note.
ALTER TABLE payments
  ADD COLUMN amount_received DECIMAL(14,2) NULL AFTER amount,
  ADD COLUMN variance_reason VARCHAR(300) NULL AFTER amount_received;
