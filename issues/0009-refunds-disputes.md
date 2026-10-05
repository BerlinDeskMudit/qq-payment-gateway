# 0009 — Refunds, disputes, and chargebacks

**Phase:** 2 · **Status:** planned

## Problem

Money coming back is where gateway margin and merchant trust get destroyed.
Refunds must be partial, auditable, and reflected instantly in balances.
Disputes must be evidence-driven and time-boxed, because the deadline is
absolute.

## Scope

### Refunds

- Full or partial, against a charge, multiple times up to the charge amount.
- `POST /v1/refunds`, `GET /v1/refunds`, with `reason` codes.
- Refund as a new ledger movement; the original `Charge` is never mutated.
- `reverse_transfer` for platform refunds that must pull funds back from a
  connected account's balance.
- Estimated arrival shown on the refund; tracking state from
  `pending` → `succeeded` | `failed` | `canceled`.
- Asynchronous cancel for refunds still in flight.
- Refund failure is surfaced as an event, never silently dropped.

### Disputes

- Incoming disputes written to our system automatically from processor
  notifications, with the deadline as a first-class field.
- Evidence submission: text, images, PDFs, with a size and type allowlist.
  Submission is idempotent and the final state is locked.
- Auto-respond on low-value disputes below a merchant threshold, with the
  response built from shipping and customer-history data the merchant
  already stored with us.
- Dashboard countdown on the deadline, with paging to the merchant's on-call
  contact inside the final 72 hours.
- Outcome recorded on the charge and in the ledger; a lost dispute posts a
  fee movement.

### Analytics

- Dispute rate by reason, by amount band, over time, per account.
- Network-visible early warning: card testing and enumeration patterns
  detected before a formal dispute arrives.

## Acceptance criteria

- [ ] A partial refund of 30% on a 100.00 charge leaves a 70.00 balance,
      reproducible from the ledger.
- [ ] Refunding more than the remaining chargeable amount returns a typed
      error with the remaining amount in the payload.
- [ ] A dispute's deadline is stored in UTC and displayed correctly in every
      merchant timezone.
- [ ] Evidence submission after the deadline is rejected with a clear error
      rather than silently dropped.
- [ ] A lost dispute posts the network fee to the correct ledger accounts
      and shows in the merchant's statement.
- [ ] Duplicate dispute notifications from the processor create one record.

## Dependencies

- `0001` charges, `0005` ledger, `0011` dashboard for evidence upload and
  countdowns, `0010` risk signals for the analytics feed.
