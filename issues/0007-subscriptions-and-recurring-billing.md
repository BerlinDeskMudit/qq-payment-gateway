# 0007 — Subscriptions and recurring billing

**Phase:** 2 · **Status:** planned

## Problem

Recurring revenue is where merchants make their money. Charging a card on
a schedule looks simple and is not: retries, proration, mid-cycle plan
changes, and dunning all have to be right or merchants churn.

## Scope

### Products and prices

- `Product` → `Price` (recurring or one-time) → `Plan` as a bundled set.
- Prices: recurring (interval + count) or one-time; tiered and usage-based
  pricing deferred to `0026`.
- Immutable pricing versions so historical invoices stay reproducible.

### Subscription lifecycle

```
incomplete -> trialing (optional) -> active
active     -> past_due -> active | canceled
active     -> canceled -> (none)
```

- `cancel_at_period_end` vs. immediate cancel, both supported.
- Trials with or without an upfront payment.
- Pause and resume with a resume date.

### Billing engine

- A scheduler materializes due invoices. It must be horizontally scalable
  and safe to run concurrently on multiple nodes, with per-subscription
  locking.
- Billing period anchored to the subscription start or to a fixed calendar
  day for merchant preference.
- Proration on plan change: credit unused time on the old plan, charge the
  remainder on the new one. Line items are itemized so the merchant can see
  the math.
- Invoice finalized and immutable once finalized; corrections are credit
  notes.

### Dunning

- Configurable retry schedule (defaults: 3 attempts over 7 days) with
  configurable dunning emails from the merchant's domain.
- Card updater invocation on each retry, so an expiring card is refreshed
  from the network before the retry.
- Downgrade instead of cancel for merchants who opt in — better retention
  than a hard stop.

## Acceptance criteria

- [ ] A subscription bills on the exact expected schedule across a DST
      transition and a leap day.
- [ ] Mid-cycle upgrade charges the prorated delta and shows the line-item
      breakdown.
- [ ] Failed payment enters `past_due`, retries per policy, and recovers to
      `active` when a retry succeeds.
- [ ] Concurrent scheduler nodes never double-bill (verified under load).
- [ ] Cancel at period end bills correctly and does not bill after the end.
- [ ] Trial with upfront payment charges at the right moment and converts
      correctly.
- [ ] Every invoice line is traceable to the ledger entries it produced.

## Dependencies

- `0001` payments, `0003` vaulted methods, `0005` ledger.
- `0004` events for `invoice.payment_succeeded` / `_failed`.
