# System Overview

How QQ Payment Gateway is put together, and why.

## Bounded contexts

Six services, split by what they own rather than by table. The split
matters because the ledger constraint crosses all of them.

### Edge / API

Authentication, merchant tenancy, request validation, idempotency, rate
limiting, and the public API surface. Owns no financial state. A request
entering here gets an `account_id`, an authenticated principal, and either
a replayed or a fresh response — then becomes an internal command.

Terminal failure domain on purpose: it can be replaced without losing money.

### Payments

Payment intents, attempts, charges, customers, payment methods. Owns the
state machine that decides whether an intent may be confirmed, captured,
or cancelled. Talks to processors through adapters, never directly to a
processor SDK.

### Billing

Subscriptions, prices, plans, invoices, and the scheduler that materializes
due invoices. Concurrency-safe by design: multiple scheduler nodes run, and
per-subscription locking guarantees one invoice per period. Invoice totals
are computed from immutable price versions, so a pricing change cannot
retroactively alter a finalized invoice.

### Risk

Rule evaluation plus model scoring, both inside the authorization path.
Budgeted at 30 ms p99 for scoring, which is why it is a separate service
rather than a library: it must be independently scalable and independently
degradable. If risk is unavailable, the documented behavior is fail-open
for low-value charges and fail-closed for high-value ones — never a silent
default in either direction.

### Ledger

Append-only double-entry journal. Sum of legs per currency is zero, always,
enforced by a database constraint and asserted in CI. Balances are a
materialized snapshot plus a replay tail, and the snapshot must be
independently reproducible by replaying entries from genesis.

This is the only service permitted to state a balance as fact. Everything
else asks it.

### Payouts

Destinations, payouts, payout rails, and the compliance screening gate that
every payout passes through. Screening is synchronous and blocking by
design: a held payout is a good outcome, a missed screen is not.

## The authorization path

The latency-sensitive path. Target: p99 under 400 ms, of which 30 ms is risk
and the remainder is mostly the processor.

```
client
  -> edge (auth, idempotency check)
  -> payments (validate state machine, load intent)
  -> risk (rules, then score)
  -> ledger (reserve authorization: merchant_pending -> processor_pending)
  -> processor adapter (network call)
  -> ledger (post authorization: settle or release the reserve)
  -> payments (persist attempt outcome, advance state)
  -> events (enqueue webhook deliveries, out of band)
  -> client
```

The ledger reservation before the network call is what makes a partial
failure detectable. Without it, an authorization that succeeds at the
processor and times out on our side is an unrecorded hold, which is the
specific failure mode that costs real money during an incident.

Capture, refunds, and payouts follow the same shape: reserve, call out,
post, enqueue events. Only the amount of reservation logic differs.

## Consistency approach

- **Strong consistency where money is.** Ledger entries are serialized per
  account. A balance read after a write reflects the write.
- **Eventual everywhere else.** Caches, read models, dashboards, and the
  webhook stream are all derived. Every derived store is rebuildable from
  the ledger and the event log, and rebuild procedures exist for each.
- **No distributed transactions spanning a processor call.** A processor
  call is not idempotent, so it cannot participate in a two-phase commit.
  Compensating entries and the reserve pattern replace that machinery.

## Data model

```
Account ──┬── Customer ──── PaymentMethod
          ├── PaymentIntent ──┬── PaymentAttempt
          │                   └── Charge ──┬── Refund
          │                                └── Dispute ── DisputeEvidence
          ├── Subscription ──┬── SubscriptionItem ── Price
          │                   └── Invoice ──── InvoiceLineItem
          ├── Product ── Price
          ├── PayoutDestination
          ├── Payout ── PayoutItem
          ├── WebhookEndpoint ── WebhookDelivery ── Event
          └── LedgerAccount ── LedgerEntry ── LedgerLeg
```

`Event` is immutable and retained 30 days. Every state change emits exactly
one event, and every webhook delivery references the event ID — so a
delivery can always be traced back to the transition that caused it, and a
merchant complaint about a missing webhook has a definite answer.

`LedgerLeg` is where the double-entry invariant lives: legs of one entry sum
to zero per currency, with no cross-currency netting. FX movements are
posted as two entries through an `fx_reserve` account rather than as a
conversion, which keeps the invariant per-currency and truthful.

## Reconciliation

Three-way, daily, per currency:

1. Internal ledger balances
2. Processor balance report
3. Bank settlement

Break tolerance defaults to zero. A break pages on-call and opens a
merchant-visible investigation ticket. It is never auto-adjusted.

Continuous invariant monitors run outside the daily job, because a break
discovered a day late is a break discovered after the money moved. The
synthetic hourly test charge is the canary: if it does not complete, we know
before a merchant tells us.

## Regional boundaries

US, EU, and APAC, with no cross-boundary transfer of cardholder data.
Account region is immutable after the first charge; changing it is a data
migration, not a setting.

Failover between regions is deliberately broken. One ledger of record, one
writable copy. Two writable ledgers is how reconciliation bugs get created,
and reconciliation bugs are how companies run out of money.

## What we are explicitly not building

- A secondary market for payment instruments.
- Credit underwriting. We surface signals; we do not lend.
- A general-purpose identity provider. Auth here is scoped to being a
  gateway, and we should not be the place a merchant stores their password.
- Optimistic concurrency on the ledger. Serializing per account is slower
  per operation and dramatically faster to reason about during an incident.
