# 0015 — Global payouts

**Phase:** 3 · **Status:** planned

## Problem

Moving money out is a different machine from taking money in. Merchants who
sell cross-border want to pay sellers, employees, and creators in local
currency. Doing that well is a defensible product.

## Scope

### Payout rails

- Bank transfer (local rails per country: ACH, SEPA, FPS, UPI, PIX, and
  others as corridors open), plus card payout and wallet payout.
- Rail selection automatic by country and currency, overridable per payout.
- Payout lifecycle: `pending` → `in_transit` → `paid` | `failed` |
  `returned`, with the rail's own state mirrored.

### Recipient management

- `Recipient` object: name, type (individual or company), bank details or
  wallet ID, country, and verification status.
- Address verification that validates ownership rather than formatting, so
  a typo becomes a failed payout we catch early.
- Bulk payouts to a recipient list, with per-row outcome.
- Recurring payouts: fixed schedule or event-triggered.

### Controls

- Compliance screening on every payout and on every recipient creation:
  sanctions lists, PEP, adverse media, and a local rule set per corridor.
- A hold when a payout trips a threshold, with a reviewer queue and a
  documented release reason.
- Rolling limits per account and per destination, with an approval step
  above them.
- Tax form collection (W-8BEN / W-9 equivalents) and end-of-year reporting
  where required.

### Reconciliation

- Payout reconciliation against the rail's own reports, on the same
  three-way basis as charge settlement.
- Returned-payout handling with a documented retry policy per rail.

## Acceptance criteria

- [ ] A payout to a new recipient in three different corridors completes or
      fails with a rail-specific, actionable error.
- [ ] A recipient with a mistyped account number is caught by verification,
      not by a returned payout.
- [ ] A bulk payout of 5,000 recipients has per-row results with a single
      aggregate summary.
- [ ] A payout tripping sanctions screening is held, alerted, and released
      or rejected with a recorded reason.
- [ ] A returned payout posts a reversal in the ledger and re-queues per the
      documented policy.
- [ ] Daily payout reconciliation reports zero breaks over 30 days across
      live rails.

## Dependencies

- `0005` ledger, `0017` compliance screening and KYC, `0014` for
  connected-account destinations.
