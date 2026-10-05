# 0018 — Observability and SRE tooling

**Phase:** 3 · **Status:** planned

## Problem

A payment gateway's worst outage is a silent one: charges that appear to
succeed but never settle. If we cannot see money in flight, we cannot run
the business.

## Scope

### Metrics

- Golden signals per service, plus payment-specific ones: authorization
  success rate, capture success rate, settlement lag, webhook delivery lag,
  dispute rate, reconciliation break count.
- Funnel from create → confirm → capture → settle with drop-off at each
  step.
- Latency histograms on the authorization path with a 400 ms p99 budget,
  broken out by processor and by region.
- Business metrics alongside technical ones: volume, net revenue,
  contribution margin per corridor.

### Tracing and logging

- Distributed trace per request, propagated through async boundaries so a
  webhook delivery links back to the charge that caused it.
- Structured JSON logs, correlated by `request_id`, with sensitive fields
  redacted at the logger, not at the call site.
- Log retention sized so a dispute window (typically 120 days) is always
  covered.

### Alerts and on-call

- Alerts on symptoms, not causes: settle rate drop, ledger imbalance,
  reconciliation break, webhook backlog, processor error rate.
- Every alert links to a runbook that has been read by the person on call.
- On-call rotation with a defined escalation path and a blameless
  postmortem template.
- Error-budget policy tied to the 99.99% target, with planned releases
  paused when it is exhausted.

### Financial observability

- Invariant monitors: sum of ledger legs equals zero, available plus
  pending equals held, merchant balance equals the sum of its movements.
  These run continuously, not just in daily reconciliation.
- A "money in flight" dashboard: authorized but uncaptured, captured but
  unsettled, settled but unreconciled, with age buckets.
- Synthetic test charge, hourly, against a dedicated processor account,
  with an alert if it does not complete.

### Data and migrations

- Blue/green or expand-contract migrations only. Zero-downtime schema
  changes, proven by a migration rehearsal in staging before every
  production change.
- Backfill jobs with resumability, rate limiting, and a verified row count.

## Acceptance criteria

- [ ] A test charge completes hourly for 30 days with zero missed runs.
- [ ] Ledger invariant monitors have never fired outside an intentional
      test.
- [ ] A deliberately broken reconciliation raises an alert within 5
      minutes and reaches the on-call.
- [ ] Every alert in the rotation has a runbook link and a named owner.
- [ ] A queued-and-abandoned charge is visible in the money-in-flight
      dashboard with its age.
- [ ] Schema migration rehearsal runs in CI against a production-sized
      snapshot.

## Dependencies

- `0005` ledger for the invariant monitors, `0004` for delivery lag.
