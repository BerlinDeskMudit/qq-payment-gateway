-- QQ Payment Gateway :: 0003 fraud and risk engine (0010, first slice)
--
-- What is enforced here rather than in application code:
--   * at most one ACTIVE rule set per account (partial unique index), so
--     "which rules applied to this authorization" always has one answer
--   * rule order is part of the data (position), because the engine is
--     first-match-wins and an unordered rule list is not evaluable
--   * decisions are append-only. A decision that can be rewritten is a
--     decision that cannot be audited after a chargeback.
--
-- Notes on scope: block lists are account-scoped in this slice. A global
-- (platform-wide) list needs a platform principal, which arrives with 0017.
-- The `challenge` action is recorded and enforced as a manual-review hold
-- until 3DS step-up ships with hosted Checkout (0002); the decision history
-- keeps the distinction so enforcement can tighten without a data migration.

BEGIN;

-- ------------------------------------------------------------ risk rule sets

-- Versioned, never edited in place. A rule change is a new version, so a
-- decision can always name the exact rules that produced it.
CREATE TABLE risk_rule_sets (
  id           text PRIMARY KEY,
  account_id   text        NOT NULL REFERENCES accounts(id),
  version      integer     NOT NULL,
  status       text        NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft', 'active', 'retired')),
  activated_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, version)
);

-- Only one active set per account. Enforced in the database because the
-- activation path is exactly where a race would leave two active sets and
-- nondeterministic decisions.
CREATE UNIQUE INDEX risk_rule_sets_one_active
  ON risk_rule_sets (account_id) WHERE status = 'active';

-- Ordered rules, evaluated first-match-wins. Conditions are a fixed set of
-- signals with a comparison and a threshold, which keeps the evaluation
-- data-driven and the simulation honest; free-form expressions are a later,
-- harder problem.
CREATE TABLE risk_rules (
  id             text PRIMARY KEY,
  rule_set_id    text    NOT NULL REFERENCES risk_rule_sets(id) ON DELETE CASCADE,
  account_id     text    NOT NULL REFERENCES accounts(id),
  position       integer NOT NULL,
  name           text    NOT NULL,
  signal         text    NOT NULL
                 CHECK (signal IN ('velocity', 'amount_threshold', 'blocklist', 'decline_rate')),
  operator       text    NOT NULL CHECK (operator IN ('gte', 'lte')),
  threshold      bigint  NOT NULL,
  window_minutes integer,
  action         text    NOT NULL CHECK (action IN ('allow', 'review', 'challenge', 'block')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, position),
  -- A window only makes sense for the signals that count over time.
  CHECK (
    (signal IN ('velocity', 'decline_rate') AND window_minutes IS NOT NULL)
    OR (signal IN ('amount_threshold', 'blocklist') AND window_minutes IS NULL)
  )
);
CREATE INDEX risk_rules_set_idx ON risk_rules (rule_set_id, position);

-- ---------------------------------------------------------------- decisions

-- One row per risk evaluation. Authorization-stage decisions exist for every
-- confirm, allow included: "why was this charge allowed" is the question with
-- the expensive answer when it cannot be produced.
CREATE TABLE risk_decisions (
  id                text PRIMARY KEY,
  account_id        text NOT NULL REFERENCES accounts(id),
  payment_intent_id text REFERENCES payment_intents(id),
  stage             text NOT NULL CHECK (stage IN ('authorization', 'capture', 'manual')),
  outcome           text NOT NULL CHECK (outcome IN ('allow', 'review', 'challenge', 'block')),
  rule_set_version  integer,
  matched_rules     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The signal values as evaluated: velocity counts, last4, token. Simulation
  -- replays these, so they must be the real inputs, not a summary.
  inputs            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_decisions_account_idx ON risk_decisions (account_id, created_at DESC);
CREATE INDEX risk_decisions_intent_idx ON risk_decisions (payment_intent_id);

-- Velocity and card-testing detection read the recent past of this table.
-- Covering the token lookup here keeps the gate inside its latency budget
-- without a cache that could disagree with the database.
CREATE INDEX risk_decisions_signal_idx
  ON risk_decisions (account_id, stage, created_at DESC)
  WHERE stage = 'authorization';

CREATE TRIGGER risk_decisions_immutable
  BEFORE UPDATE OR DELETE ON risk_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------- blocklist

CREATE TYPE blocklist_kind AS ENUM ('card', 'bin', 'ip', 'email', 'device');

CREATE TABLE risk_blocklist (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  kind       blocklist_kind NOT NULL,
  value      text NOT NULL,
  reason     text,
  -- 'auto' rows come from card-testing detection; they carry the evidence in
  -- reason and can be told apart from a merchant's manual entry.
  source     text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, value)
);

-- ---------------------------------------------------------------- review queue

CREATE TYPE review_status AS ENUM ('open', 'approved', 'declined');

CREATE TABLE risk_reviews (
  id                text PRIMARY KEY,
  account_id        text NOT NULL REFERENCES accounts(id),
  decision_id       text NOT NULL UNIQUE REFERENCES risk_decisions(id),
  payment_intent_id text REFERENCES payment_intents(id),
  status            review_status NOT NULL DEFAULT 'open',
  resolved_by       text,
  resolution_reason text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz
);
CREATE INDEX risk_reviews_account_idx
  ON risk_reviews (account_id, status, created_at DESC);

-- ------------------------------------------------------------ event types

-- Consulted by emitEvents; the enum lives here so the type and the events
-- ship in the same migration.
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'risk.review.opened';
ALTER TYPE event_type ADD VALUE IF NOT EXISTS 'risk.source.auto_blocked';

COMMIT;
