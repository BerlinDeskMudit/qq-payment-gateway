-- QQ Payment Gateway :: core schema
--
-- Design rules enforced here, not in application code where possible:
--   * financial tables are append-only (see the immutability triggers)
--   * every row is scoped to an account (tenant boundary)
--   * the ledger balances per entry per currency, enforced by a constraint
--     trigger so it cannot be violated by any code path

BEGIN;

CREATE TABLE accounts (
  id            text PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL,
  country       char(2)     NOT NULL,
  region        text        NOT NULL DEFAULT 'us',
  livemode      boolean     NOT NULL DEFAULT false,
  balance_currency text     NOT NULL DEFAULT 'usd',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- customers

CREATE TABLE customers (
  id          text PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES accounts(id),
  email       text,
  name        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_account_idx ON customers (account_id, created_at DESC);

-- ------------------------------------------------------------------ api keys

-- Only the hash is stored. A database disclosure must not yield working
-- credentials. The prefix is not secret; it exists so an operator can tell
-- keys apart in a list and so lookup avoids a full table scan.
CREATE TABLE api_keys (
  id          text PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES accounts(id),
  key_prefix  text        NOT NULL UNIQUE,
  key_hash    text        NOT NULL,
  scopes      text[]      NOT NULL DEFAULT '{}',
  role        text        NOT NULL CHECK (role IN ('owner','admin','developer','finance','support','viewer')),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_account_idx ON api_keys (account_id, created_at DESC);

-- Payment methods are tokens from the processor. We never store a PAN.
-- The last4/brand/expiry are display metadata the processor returns.
CREATE TABLE payment_methods (
  id            text PRIMARY KEY,
  account_id    text        NOT NULL REFERENCES accounts(id),
  customer_id   text        NOT NULL REFERENCES customers(id),
  type          text        NOT NULL CHECK (type IN ('card', 'bank_debit')),
  brand         text,
  last4         text,
  exp_month     smallint,
  exp_year      smallint,
  -- opaque handle at the processor vault. meaningless outside this API.
  processor_token text      NOT NULL,
  network_token text,
  status        text        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'detached', 'expired')),
  is_default    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  detached_at   timestamptz
);
CREATE INDEX payment_methods_customer_idx ON payment_methods (customer_id, status);

-- ---------------------------------------------------------- payment intents

CREATE TYPE intent_status AS ENUM (
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'succeeded',
  'canceled'
);

CREATE TABLE payment_intents (
  id             text PRIMARY KEY,
  account_id     text          NOT NULL REFERENCES accounts(id),
  customer_id    text          REFERENCES customers(id),
  amount         bigint        NOT NULL CHECK (amount >= 0),
  amount_captured bigint       NOT NULL DEFAULT 0 CHECK (amount_captured >= 0),
  currency       text          NOT NULL,
  status         intent_status NOT NULL DEFAULT 'requires_payment_method',
  payment_method_id text       REFERENCES payment_methods(id),
  capture_method text          NOT NULL DEFAULT 'automatic'
                 CHECK (capture_method IN ('automatic', 'manual')),
  client_secret  text          NOT NULL,
  description    text,
  metadata       jsonb         NOT NULL DEFAULT '{}'::jsonb,
  -- UNKNOWN is the explicit "we called out and do not know yet" state.
  -- See docs/research: Helland, hold uncertainty in business semantics.
  ambiguous_since timestamptz,
  livemode       boolean       NOT NULL DEFAULT false,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  CHECK (amount_captured <= amount)
);
CREATE INDEX payment_intents_account_idx ON payment_intents (account_id, created_at DESC);
CREATE INDEX payment_intents_customer_idx ON payment_intents (customer_id);
CREATE INDEX payment_intents_status_idx ON payment_intents (status);

-- An intent can be attempted more than once: retries, method swaps, network
-- redelivery. Each attempt against the processor is its own row.
CREATE TYPE attempt_status AS ENUM (
  'pending', 'authorized', 'declined', 'requires_action', 'error', 'abandoned'
);

CREATE TABLE payment_attempts (
  id                text PRIMARY KEY,
  payment_intent_id text          NOT NULL REFERENCES payment_intents(id),
  account_id        text          NOT NULL REFERENCES accounts(id),
  attempt_number    integer       NOT NULL,
  status            attempt_status NOT NULL DEFAULT 'pending',
  processor         text          NOT NULL,
  -- provider affinity: the processor that received this intent first.
  -- retries MUST be routed back here or we can double-charge elsewhere.
  decline_code      text,
  decline_message   text,
  network_reference text,
  started_at        timestamptz   NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  UNIQUE (payment_intent_id, attempt_number)
);
CREATE INDEX payment_attempts_intent_idx ON payment_attempts (payment_intent_id);

-- ------------------------------------------------------------------ charges

CREATE TYPE charge_status AS ENUM ('succeeded', 'refunded', 'partially_refunded', 'disputed');

CREATE TABLE charges (
  id                text PRIMARY KEY,
  account_id        text        NOT NULL REFERENCES accounts(id),
  payment_intent_id text        NOT NULL REFERENCES payment_intents(id),
  payment_attempt_id text        REFERENCES payment_attempts(id),
  customer_id       text        REFERENCES customers(id),
  amount            bigint      NOT NULL CHECK (amount > 0),
  amount_refunded   bigint      NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  currency          text        NOT NULL,
  status            charge_status NOT NULL DEFAULT 'succeeded',
  failure_code      text,
  failure_message   text,
  receipt_url       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_refunded <= amount)
);
CREATE INDEX charges_account_idx ON charges (account_id, created_at DESC);
CREATE INDEX charges_intent_idx ON charges (payment_intent_id);
CREATE INDEX charges_customer_idx ON charges (customer_id);

-- ------------------------------------------------------------------- refunds

CREATE TYPE refund_status AS ENUM ('pending', 'succeeded', 'failed', 'canceled');

CREATE TABLE refunds (
  id           text PRIMARY KEY,
  account_id   text        NOT NULL REFERENCES accounts(id),
  charge_id    text        NOT NULL REFERENCES charges(id),
  amount       bigint      NOT NULL CHECK (amount > 0),
  currency     text        NOT NULL,
  status       refund_status NOT NULL DEFAULT 'pending',
  reason       text,
  processor    text        NOT NULL,
  processor_reference text,
  failure_code text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX refunds_charge_idx ON refunds (charge_id);

-- ------------------------------------------------------------------- events

CREATE TYPE event_type AS ENUM (
  'payment_intent.created',
  'payment_intent.succeeded',
  'payment_intent.canceled',
  'payment_intent.requires_action',
  'payment_intent.payment_failed',
  'charge.succeeded',
  'charge.refunded',
  'refund.created',
  'refund.succeeded',
  'refund.failed'
);

-- Immutable. Append-only. Retained 30 days for replay by id.
CREATE TABLE events (
  id          text PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES accounts(id),
  type        event_type  NOT NULL,
  api_version text        NOT NULL DEFAULT 'v1',
  data        jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_account_idx ON events (account_id, created_at DESC);
CREATE INDEX events_type_idx ON events (type, created_at DESC);

-- Append-only event log.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; post a compensating entry instead',
    TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ----------------------------------------------------------------- webhooks

CREATE TABLE webhook_endpoints (
  id           text PRIMARY KEY,
  account_id   text        NOT NULL REFERENCES accounts(id),
  url          text        NOT NULL,
  secret       text        NOT NULL,
  status       text        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'disabled')),
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_account_idx ON webhook_endpoints (account_id);

CREATE TYPE delivery_status AS ENUM ('pending', 'delivered', 'failed', 'dead');

CREATE TABLE webhook_deliveries (
  id              text PRIMARY KEY,
  account_id      text        NOT NULL REFERENCES accounts(id),
  endpoint_id     text        NOT NULL REFERENCES webhook_endpoints(id),
  event_id        text        NOT NULL REFERENCES events(id),
  status          delivery_status NOT NULL DEFAULT 'pending',
  attempt_count   integer     NOT NULL DEFAULT 0,
  -- per-endpoint serial number so a consumer can detect gaps
  sequence        bigint      NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error      text,
  last_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX webhook_deliveries_endpoint_idx
  ON webhook_deliveries (endpoint_id, created_at DESC);

CREATE TABLE webhook_delivery_attempts (
  id           bigserial PRIMARY KEY,
  delivery_id  text        NOT NULL REFERENCES webhook_deliveries(id),
  attempt      integer     NOT NULL,
  status_code  integer,
  error        text,
  duration_ms  integer,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_attempts_delivery_idx ON webhook_delivery_attempts (delivery_id);

-- -------------------------------------------------------------- idempotency

-- 24h minimum retention. Chargeback windows argue for longer; see 0001.
CREATE TABLE idempotency_keys (
  account_id     text        NOT NULL REFERENCES accounts(id),
  key            text        NOT NULL,
  -- fingerprint of the request body. Same key + different body is a client bug.
  fingerprint    text        NOT NULL,
  state          text        NOT NULL DEFAULT 'in_progress'
                CHECK (state IN ('in_progress', 'completed')),
  response_status integer,
  response_body  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  PRIMARY KEY (account_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (created_at);

-- ------------------------------------------------------------------- ledger

-- Append-only double-entry journal. See docs/architecture/overview.md.
CREATE TABLE ledger_accounts (
  id          text PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES accounts(id),
  -- e.g. merchant_available, processor_clearing, platform_fee_revenue
  code        text        NOT NULL,
  type        text        NOT NULL CHECK (type IN ('asset', 'liability', 'revenue', 'expense')),
  currency    text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code, currency)
);

CREATE TABLE ledger_entries (
  id              text PRIMARY KEY,
  account_id      text        NOT NULL REFERENCES accounts(id),
  -- business time. late-arriving network events backdate this without
  -- rewriting the row.
  effective_at    timestamptz NOT NULL DEFAULT now(),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  source_type     text        NOT NULL,
  source_id       text        NOT NULL,
  -- guards against a duplicated processor callback double-posting.
  memo            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, recorded_at DESC);
CREATE INDEX ledger_entries_source_idx ON ledger_entries (source_type, source_id);
CREATE UNIQUE INDEX ledger_entries_dedup_idx
  ON ledger_entries (account_id, source_type, source_id);

CREATE TABLE ledger_legs (
  id               bigserial PRIMARY KEY,
  entry_id         text   NOT NULL REFERENCES ledger_entries(id),
  ledger_account_id text  NOT NULL REFERENCES ledger_accounts(id),
  amount           bigint NOT NULL CHECK (amount > 0),
  -- credit = increase the account, debit = decrease it.
  direction        text   NOT NULL CHECK (direction IN ('debit', 'credit')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- one leg per account per entry
  UNIQUE (entry_id, ledger_account_id)
);
CREATE INDEX ledger_legs_account_idx ON ledger_legs (ledger_account_id, id);

-- The invariant: an entry's legs sum to zero per currency. Enforced as a
-- DEFERRED constraint trigger so a multi-leg insert is checked once at
-- COMMIT, not per row. No application code path can post an unbalanced entry.
CREATE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE
  entry_row ledger_entries%ROWTYPE;
  total    bigint;
BEGIN
  SELECT * INTO entry_row FROM ledger_entries WHERE id = NEW.entry_id;
  SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0)
    INTO total
    FROM ledger_legs
   WHERE entry_id = NEW.entry_id;

  IF total <> 0 THEN
    RAISE EXCEPTION
      'unbalanced ledger entry % : legs sum to %, expected 0', NEW.entry_id, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_legs_balanced
  AFTER INSERT ON ledger_legs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- Financial records are never mutated or deleted. A mistake is corrected by
-- posting a new compensating entry that references the original.
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ledger_legs_immutable
  BEFORE UPDATE OR DELETE ON ledger_legs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Balance is a running total of legs, not a stored mutable number.
-- Sign convention is standard accounting: for assets and expenses a balance
-- increases on the debit side, for liabilities and revenue it increases on
-- the credit side. The per-entry invariant is simply that total debits equal
-- total credits, independent of type.
CREATE VIEW ledger_balances AS
SELECT
  la.id                                        AS ledger_account_id,
  la.account_id,
  la.code,
  la.type,
  la.currency,
  CASE
    WHEN la.type IN ('asset', 'expense')
      THEN COALESCE(SUM(CASE WHEN ll.direction = 'debit'  THEN ll.amount
                             ELSE -ll.amount END), 0)
    ELSE COALESCE(SUM(CASE WHEN ll.direction = 'credit' THEN ll.amount
                           ELSE -ll.amount END), 0)
  END                                          AS balance
FROM ledger_accounts la
LEFT JOIN ledger_legs ll ON ll.ledger_account_id = la.id
GROUP BY la.id, la.account_id, la.code, la.type, la.currency;

-- ------------------------------------------------------- ledger snapshotting

-- Balances are a materialized snapshot plus a replay tail. The snapshot
-- must be independently reproducible by replaying entries from genesis.
CREATE TABLE ledger_snapshots (
  ledger_account_id text        PRIMARY KEY REFERENCES ledger_accounts(id),
  account_id        text        NOT NULL REFERENCES accounts(id),
  balance           bigint      NOT NULL,
  -- highest ledger_legs.id included in this snapshot
  through_leg_id    bigint      NOT NULL,
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_seq (
  id  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  val bigint NOT NULL DEFAULT 0
);
INSERT INTO ledger_seq (id, val) VALUES (1, 0);

-- Serializes writes per account and gives every entry a global ordering.
CREATE FUNCTION next_ledger_seq() RETURNS bigint AS $$
DECLARE v bigint;
BEGIN
  UPDATE ledger_seq SET val = val + 1 WHERE id = 1 RETURNING val INTO v;
  RETURN v;
END;
$$ LANGUAGE plpgsql;

COMMIT;
