# 0010 — Fraud and risk engine

**Phase:** 2 · **Status:** planned

## Problem

Card testing and enumeration attack merchant accounts and eat our margin.
Every authorization is a bet; a rules-only engine either blocks good
customers or lets fraud through. We need fast, explainable scoring in the
request path, plus merchant-tunable rules on top.

## Scope

### Rules engine

- Ordered rule list evaluated per authorization: conditions on amount,
  velocity, geography, device, BIN, cardholder distance, hour of day.
- Actions: `allow`, `review` (hold in a manual queue), `challenge` (3DS
  step-up), `block`.
- Merchant-editable through the dashboard with a simulation mode: run a
  candidate rule set against historical traffic and see approve/block
  deltas before enabling.
- Versioned and auditable — a rule change records who, when, and the
  resulting approve rate.

### Scoring service

- A model (gradient-boosted trees, retrained on a rolling window) scoring
  every authorization, returning a score plus top contributing features.
- Must be fast enough for the synchronous path: budget 30 ms p99.
- Model registry with shadow deployment, offline evaluation on a fixed
  holdout, and automatic rollback on error-rate regression.

### Signals

- Device fingerprint: IP reputation, velocity, emulator and automation
  detection.
- Card testing detection: many small authorizations from one source across
  many cards, sequential BINs, high decline rate.
- Account takeover signals: impossible travel, new device plus high-value
  charge, password reset followed immediately by a card add.

### Blocks and reports

- Block lists: card, BIN, IP, email, device — account-scoped and global.
- Merchant report queue with accept/decline, reason capture, and reviewer
  notes feeding the model training set.
- Fraud and chargeback-rate dashboards with a threshold that flags accounts
  approaching network monitoring programs.

## Acceptance criteria

- [ ] A rule added in the dashboard takes effect within one revision cycle
      with no deploy.
- [ ] Simulation on 30 days of history shows approve-rate impact before
      enabling, for both block and review actions.
- [ ] Scoring stays inside the 30 ms p99 budget at production request
      volume.
- [ ] Card-testing pattern (N small auths across M distinct cards within a
      window) is detected and the source auto-blocked within 60 s.
- [ ] Every `review` outcome is reviewable in the queue and the resolution
      is fed back into training.
- [ ] A model regression triggers rollback automatically and pages on-call.

## Dependencies

- `0001` for the authorization path hook, `0011` for the rules and queue
  UI, `0018` for feature-level latency monitoring.
