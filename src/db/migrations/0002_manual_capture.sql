-- QQ Payment Gateway :: 0002 manual capture states
--
-- Manual capture needs two states that 0001 did not model honestly:
--   * a payment intent that is authorized and waiting for the merchant to
--     capture. Without this we had to overload 'requires_action', which
--     already means "the cardholder must do 3DS", so a merchant could not tell
--     the two apart.
--   * a charge that exists against a hold but has not moved money yet.
--     'succeeded' on an uncaptured charge is a lie that reconciliation will
--     eventually catch.

BEGIN;

ALTER TYPE intent_status ADD VALUE IF NOT EXISTS 'requires_capture';
ALTER TYPE charge_status ADD VALUE IF NOT EXISTS 'authorized';

-- Ledger entries get a global ordering from the existing sequence generator so
-- reconciliation can walk history deterministically.
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS sequence bigint NOT NULL DEFAULT next_ledger_seq();

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_sequence_idx ON ledger_entries (sequence);

-- Reconciliation queries need the attempt that produced a charge, and a
-- charge with no attempt cannot be explained.
CREATE INDEX IF NOT EXISTS charges_attempt_idx ON charges (payment_attempt_id);

COMMIT;