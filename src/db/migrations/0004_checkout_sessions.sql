-- QQ Payment Gateway :: 0003 checkout sessions
--
-- A hosted Checkout session is a time-boxed capability: whoever holds the
-- session id may pay that session's intent. The merchant API authenticates
-- with an API key; the hosted page deliberately does not, because the
-- cardholder has no key and never should.
--
-- What the table therefore has to answer, without a merchant present:
--   * which intent this session pays for, and that it has not been paid yet
--   * what the customer was shown (line items, amounts) so a resumed session
--     renders the same cart rather than a possibly-different one
--   * when the capability expires, so an abandoned session stops being
--     payable instead of living forever
--   * where to send the customer back to, and with which parameters

BEGIN;

CREATE TABLE checkout_sessions (
  id                text PRIMARY KEY,
  account_id        text        NOT NULL REFERENCES accounts(id),
  -- One session pays exactly one intent. Splitting payments across intents
  -- is a cart, not a checkout session, and would make "did this succeed?"
  -- unanswerable.
  payment_intent_id text        NOT NULL REFERENCES payment_intents(id),
  customer_id       text        REFERENCES customers(id),
  status            text        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'complete', 'expired', 'canceled')),
  -- The cart as the customer saw it. jsonb rather than a line_items table:
  -- it is display history for a single session, not something we query or
  -- join. The authoritative money is on the payment intent.
  line_items        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  amount            bigint      NOT NULL CHECK (amount > 0),
  currency          text        NOT NULL,
  success_url       text        NOT NULL,
  cancel_url        text,
  -- The capability is useless after this instant. Stored per session rather
  -- than as a table default so a merchant can shorten or extend it.
  expires_at        timestamptz NOT NULL,
  metadata          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  livemode          boolean     NOT NULL DEFAULT false,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX checkout_sessions_account_idx ON checkout_sessions (account_id, created_at DESC);
CREATE INDEX checkout_sessions_intent_idx ON checkout_sessions (payment_intent_id);
-- Finding the session a hosted-page request is asking for is a primary-key
-- lookup; this index exists for the expiry sweep instead.
CREATE INDEX checkout_sessions_open_idx ON checkout_sessions (expires_at)
  WHERE status = 'open';

-- Checkout lifecycle events, so a merchant who cannot poll the session still
-- learns that a cart was paid. Added rather than reusing
-- payment_intent.succeeded: consumers filter on type, and "an intent that was
-- created by Checkout succeeded" is a different fact from "Checkout finished".
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'checkout_session.created';
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'checkout_session.completed';

COMMIT;
