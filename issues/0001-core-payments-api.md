# 0001 — Core payments API

**Phase:** 1 · **Status:** planned · **Blocks:** everything

## Problem

Merchants need one stable endpoint family to create a charge, look it up,
and settle it. Everything else in the product hangs off this contract, so
getting the shape right early matters more than shipping it fast.

## Scope

### Resources

- `POST /v1/payment_intents` — create an intent with amount, currency,
  customer, payment method, capture method.
- `GET /v1/payment_intents/{id}` — retrieve full state.
- `POST /v1/payment_intents/{id}/confirm` — attempt authorization.
- `POST /v1/payment_intents/{id}/capture` — capture an authorized amount.
- `POST /v1/payment_intents/{id}/cancel` — release an uncaptured hold.
- `GET /v1/charges` — list charges, filtered by customer/intent/time window.
- `GET /v1/customers`, `POST /v1/customers` — customer records.

### Core object model

`PaymentIntent` holds the merchant's intent to collect money and owns the
state machine:

```
requires_payment_method
  -> requires_confirmation
  -> requires_action        (3DS / bank redirect)
  -> processing             (network in flight)
  -> succeeded | canceled
```

`PaymentAttempt` records each individual authorization try against a
processor. An intent with one payment method can have many attempts
(retries, method swaps). `Charge` is the money-movement record: created on
successful capture, refunded in whole or in part.

A `Charge` is never mutated to represent a refund. Refunds are separate
objects offsetting the original, so history stays reconstructable.

### Idempotency

- `Idempotency-Key` header required on all POST endpoints.
- Keys scoped per merchant account.
- First request's response (status + body) is stored for 24 hours and
  replayed byte-identically on retry, including on failure.
- Same key + different request body → `409 idempotency_key_reuse`.
- Concurrent retries on one key are serialized; the second caller waits
  for the first rather than double-charging.

### Errors

Single error envelope everywhere:

```json
{
  "error": {
    "type": "card_declined",
    "code": "insufficient_funds",
    "message": "The card does not have enough funds.",
    "decline_code": "insufficient_funds",
    "charge": "ch_...",
    "request_id": "req_...",
    "docs_url": "https://docs.qqpg.io/errors/card-declined",
    "retryable": false
  }
}
```

`type` is the stable value integrations switch on. `code` is the specific
reason. `message` is human-facing and may be reworded at any time.

Error classes to model on day one: `card_error`, `invalid_request_error`,
`authentication_error`, `api_error`, `rate_limit_error`,
`idempotency_error`.

### Versioning

`/v1/` is frozen once released. Additive fields only; new major version
for removals or semantic changes. Response objects tolerate unknown
fields so SDKs can be upgraded independently of the API.

## Acceptance criteria

- [ ] Create + confirm + capture a card payment end to end against a sandbox processor.
- [ ] Retrying a confirmed request with the same key returns the identical response, no second charge.
- [ ] Same key with a changed amount returns `409`.
- [ ] State machine rejects illegal transitions (`confirm` on a `succeeded` intent → typed error).
- [ ] Partial capture of a partially authorized amount behaves predictably and is documented.
- [ ] Every error response carries `request_id`, and the ID resolves in the request log.
- [ ] OpenAPI spec generated from the same source as the handlers; CI fails on drift.
- [ ] Rate limits return `429` with `Retry-After` and a typed error body.
- [ ] Contract test suite runs against the reference implementation on every commit.

## Dependencies

- `0005` Double-entry ledger for the balance effects of capture and refund.
- `0006` Auth and tenancy for merchant scoping.
- `0018` Structured request logging keyed on `request_id`.

## Open questions

- Do we model multi-currency amounts as integer minor units plus an
  explicit exponent map, or delegate to a `Money` type in the SDK? (Leaning
  minor units; it matches what processors send and avoids float drift.)
- How long do we retain idempotency records — 24 hours is the minimum,
  chargeback windows argue for longer. Storage cost is trivial either way.
