# 0004 — Webhooks and event delivery

**Phase:** 1 · **Status:** planned

## Problem

Merchants cannot poll us for every state change. They need to be told when
money moves. Webhooks are the entire integration surface for a large share
of merchants, so silent failure is not acceptable.

## Scope

### Event model

- Every state transition emits an immutable event: `payment_intent.succeeded`,
  `charge.refunded`, `payout.paid`, `invoice.payment_failed`, and so on.
- Event object carries `id`, `type`, `created`, `livemode`, `data` (the full
  API object), plus `api_version` so consumers can pin behavior.
- Events are stored and replayable by ID for 30 days.

### Delivery guarantees

- At-least-once delivery, exponentially backed off from 30 s to 24 h, with
  jitter.
- Every delivery attempt signed: HMAC-SHA256 over `timestamp.body`, secret
  per endpoint. Merchants verify timestamp freshness to block replays.
- Retries on any 5xx or connection failure. 2xx means delivered. 410 disables
  the endpoint permanently; 404 disables after a threshold.
- Dead letter queue with dashboard visibility and manual replay.

### Ordering and scope

- No global ordering guarantee. Per-object ordering is best-effort.
- Provide an `event.id` based dedupe recipe in the docs, since
  at-least-once means merchants must be idempotent.
- Optional ordered stream per account via a monotonic sequence number.

### Developer experience

- `stripe`-shaped CLI command to replay and inspect: list recent deliveries
  per endpoint, view request/response pairs, re-send.
- Local listener with signature verification and a real-time UI.
- Typed event payloads generated from the same OpenAPI source.

## Acceptance criteria

- [ ] A merchant endpoint that returns 500 for three attempts then 200
      receives the payload on the fourth, in order.
- [ ] Signatures verify; a tampered body fails verification.
- [ ] A replayed old payload fails the timestamp-freshness check.
- [ ] Dedupe recipe in docs works: two deliveries of one event produce one
      merchant-side side effect.
- [ ] Dead letter entries are visible in the dashboard with full attempt
      history.
- [ ] Load test: 10k events/second enqueued without loss or backpressure on
      the authorization path.

## Dependencies

- `0001` Core payments API for event emission points.
- `0011` Dashboard for endpoint configuration and delivery inspection.
- `0018` Observability for delivery metrics.

## Open questions

- Offer a pull-based feed endpoint alongside push, for merchants who cannot
  accept inbound traffic? Recommend yes, it is a small amount of code and
  unblocks enterprise network policies.
