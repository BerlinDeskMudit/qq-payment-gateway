<div align="center">

<h1>QQ Payment Gateway</h1>

**Payment infrastructure as software — one API to accept cards and bank payments, run subscriptions and invoices, fight fraud, handle disputes, and pay out sellers.**

Merchants integrate a single, idempotent API and get the hard parts of payments handled for them: retries, reconciliation, PCI scope, dispute deadlines, and split-payment rounding. The gateway is built on an append-only double-entry ledger and is specified feature-by-feature in [`issues/`](issues/README.md) before it is built.

<p>
<a href="https://github.com/0xMudit/qq-payment-gateway/actions/workflows/ci.yml"><img src="https://github.com/0xMudit/qq-payment-gateway/actions/workflows/ci.yml/badge.svg" alt="CI status" /></a>
<img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933.svg?logo=nodedotjs&logoColor=white" alt="Node.js 22 or newer" />
<img src="https://img.shields.io/badge/TypeScript-5.7-3178C6.svg?logo=typescript&logoColor=white" alt="TypeScript 5.7" />
<img src="https://img.shields.io/badge/Fastify-5-000000.svg?logo=fastify&logoColor=white" alt="Fastify 5" />
<img src="https://img.shields.io/badge/PostgreSQL-16%20%2F%20PGlite-4169E1.svg?logo=postgresql&logoColor=white" alt="PostgreSQL 16 or embedded PGlite" />
<img src="https://img.shields.io/badge/OpenAPI-3.1-6BA539.svg?logo=openapiinitiative&logoColor=white" alt="OpenAPI 3.1" />
<img src="https://img.shields.io/badge/Docker-ready-2496ED.svg?logo=docker&logoColor=white" alt="Docker ready" />
</p>

</div>

---

> **Status.** Phase 1 — the core payments API, double-entry ledger, merchant auth, idempotency, the sandbox processor, and signed webhook delivery — is implemented and tested (85 tests). Later phases (subscriptions, invoicing, fraud, disputes, payouts, dashboard) are fully specified in [`issues/`](issues/README.md) and not yet built. The processor is a sandbox; no real card networks are connected.

## Why QQ Payment Gateway

Integrating payments is a months-long project for a competent team, and the parts that break are invisible until they cost money. This gateway makes those parts the vendor's problem instead of the merchant's:

- **Money is never mutated.** Balances come from an append-only double-entry ledger. Corrections are compensating entries, and every cent is reconstructable from history.
- **Retry-safe by default.** Every mutating endpoint requires an idempotency key, and at-least-once delivery is assumed everywhere — including the gateway's own webhooks.
- **The reserve pattern closes the timeout gap.** The ledger reserves funds *before* the processor call, so an authorization that succeeds upstream and times out locally is a detectable hold, not a silent loss.
- **Errors are part of the contract.** Typed error classes with stable codes, mapped to responses in exactly one place. Integrators branch on `type`, never on message text.
- **Explain every number.** Any figure a merchant sees traces to a ledger entry or a documented calculation.
- **The spec is the contract.** Each feature lives in a versioned issue file with acceptance criteria; when code and spec disagree, one of them is a bug.

## Features

| Capability | What you get |
| --- | --- |
| **Payments API** | Payment intents, charges, multi-capture, refunds — idempotent by default, with a documented state machine. |
| **Card vaulting & tokenization** | Card data never touches the servers in plaintext; a `<PAN, PAR>` mapping layer with a swappable vault. |
| **Hosted Checkout** | Session-based hosted page driven by the same intent machine, so hosted and API flows stay in sync. |
| **Ledger** | Append-only double-entry journal; legs sum to zero per currency, enforced by a deferred SQL constraint and asserted in CI. |
| **Auth & tenancy** | Hashed API keys, roles, and account scoping; tenancy is read from the authenticated principal, never the request body. |
| **Idempotency** | Fingerprinting, stored replay, and in-flight waiting, so a network retry returns the original result. |
| **Webhooks** | Durable events, HMAC-signed deliveries, exponential-backoff retries, and dead-letter capture. |
| **Sandbox processor** | Deterministic outcomes driven by the card number's last four digits — approves, declines, 3DS, insufficient funds, processor error. |
| **OpenAPI 3.1** | Spec generated from the same TypeBox schemas that validate requests, with a CI check that fails on drift. |

Subscriptions, invoicing, fraud/risk scoring, disputes, marketplaces, global payouts, multi-currency, and the merchant dashboard are specified in [`issues/`](issues/README.md) and shown on the roadmap below.

## Requirements

- **Node.js 22 or newer** (the test and build toolchain, including Vitest and `tsx`, requires it).
- **PostgreSQL 16** is optional. Without `DATABASE_URL` the app runs against **PGlite**, an in-process WASM build of Postgres — the same SQL, constraints, and deferred triggers, in milliseconds.
- **Docker** is optional, for the production image.

## Quick start

```bash
# 1. Install and build (typecheck + emit dist/)
npm install
npm run build

# 2. Create a merchant. Applies migrations and prints the API key once.
npm run cli -- onboard --name "Acme" --email ops@acme.test --country US

# 3. Serve on :8080
npm start
```

To use a real database instead of embedded PGlite:

```bash
export DATABASE_URL=postgres://user:pass@localhost:5432/qqpg
npm run migrate     # explicit migration before serving
npm start
```

`MIGRATE_ON_BOOT=true` migrates during startup. Leave it off in production — several replicas racing to alter the same table is how an outage starts.

### Charge a test card

Every mutation needs an `Idempotency-Key` header. Create a customer, attach a payment method, then create and confirm an intent:

```bash
KEY=sk_test_...   # from the onboard output

curl -X POST localhost:8080/v1/customers \
  -H "authorization: Bearer $KEY" \
  -H 'idempotency-key: cust-0001' \
  -H 'content-type: application/json' \
  -d '{"email":"buyer@example.test"}'
```

Sandbox cards are chosen by their last four digits, so behaviour is reproducible with no network call:

| Card number | Outcome |
| --- | --- |
| `4242 4242 4242 4242` | Approves |
| `4000 0000 0000 0002` | Declines |
| `4000 0000 0000 9995` | Requires 3-D Secure authentication |
| `4000 0000 0000 0119` | Declines — insufficient funds |
| `4000 0000 0000 0069` | Processor error, intent left ambiguous |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | — | PostgreSQL connection string. Unset falls back to embedded PGlite at `PGLITE_DATA_DIR`. |
| `PGLITE_DATA_DIR` | `/data/qqpg` (image) | Where PGlite persists its database when `DATABASE_URL` is unset. |
| `PORT` | `8080` | HTTP listen port. |
| `HOST` | `0.0.0.0` | HTTP listen address. |
| `LOG_LEVEL` | `info` | Logger verbosity. |
| `MIGRATE_ON_BOOT` | — | When `true`, run migrations during startup. Keep off in production. |

## API overview

The v1 surface is authenticated with `Authorization: Bearer <api_key>`; every `POST` requires an `Idempotency-Key` header. The full spec is [`openapi.json`](openapi.json) (OpenAPI 3.1).

| Method & path | Description |
| --- | --- |
| `POST /v1/customers` | Create a customer. |
| `POST /v1/payment_methods` | Attach a payment method to a customer. |
| `POST /v1/payment_intents` | Create a payment intent. |
| `POST /v1/payment_intents/{id}/confirm` | Confirm an intent (runs the authorization path). |
| `POST /v1/payment_intents/{id}/capture` | Capture a confirmed intent (supports multi-capture). |
| `POST /v1/payment_intents/{id}/cancel` | Cancel an uncaptured intent. |
| `GET /v1/payment_intents/{id}` | Retrieve an intent and its attempts. |
| `GET /v1/charges` · `GET /v1/charges/{id}` | List or retrieve charges. |
| `POST /v1/charges/{id}/refunds` | Refund a charge (full or partial). |
| `POST /v1/checkout/sessions` · `GET /v1/checkout/sessions/{id}` | Create or retrieve a hosted Checkout session. |
| `GET /v1/balance` | Account balance, derived from the ledger. |
| `GET /v1/events` · `GET /v1/events/{id}` | List or retrieve events. |
| `POST /v1/webhook_endpoints` · `POST /v1/webhook_endpoints/{id}/disable` | Register or disable a webhook endpoint. |
| `GET /v1/webhook_deliveries` | Webhook delivery log with status and attempts. |
| `GET /health` | Liveness probe (no auth, no database). |

## How it works

Six bounded contexts split by what they own rather than by table, because the ledger constraint crosses all of them. See the detailed write-up in [`docs/architecture/overview.md`](docs/architecture/overview.md).

```
Merchant
   |
   +-- SDK / API  --------------------------+
   +-- Checkout (hosted)                     |
   +-- Payment Element (embedded)            |
                                              v
                                     +----------------+
                                     |  Edge / API    |
                                     |  auth, tenancy |
                                     +-------+--------+
                                             |
                        +--------------------+--------------------+
                        |                    |                    |
                        v                    v                    v
                 +------------+      +--------------+     +--------------+
                 |  Payments  |      |   Billing    |     |    Risk      |
                 |  service   |      |   scheduler  |     |   engine     |
                 +------+-----+      +------+-------+     +------+-------+
                        |                   |                    |
                        +-------------------+--------------------+
                                            v
                                    +---------------+
                                    |    Ledger     |  append-only,
                                    | (double entry)|  balanced
                                    +-------+-------+
                                            |
                        +-------------------+-------------------+
                        v                   v                   v
                 +-------------+     +--------------+    +-------------+
                 |  Processor  |     |  Payouts     |    |   Billing   |
                 |  adapters   |     |  + rails     |    | our pricing |
                 +-------------+     +--------------+    +-------------+
```

**The authorization path** — the latency-sensitive one, targeted at p99 under 400 ms (30 ms of it risk scoring, the rest mostly the processor):

```
client
  -> edge       (auth, idempotency check)
  -> payments   (validate state machine, load intent)
  -> risk       (rules, then score)
  -> ledger     (reserve: merchant_pending -> processor_pending)
  -> processor  (network call, via an adapter)
  -> ledger     (post: settle or release the reserve)
  -> payments   (persist attempt outcome, advance state)
  -> events     (enqueue webhook deliveries, out of band)
  -> client
```

Capture, refunds, and payouts follow the same reserve → call out → post → enqueue-events shape. Consistency is strong where money is (ledger entries serialize per account) and eventual everywhere else (read models, dashboards, and the webhook stream are derived and rebuildable from the ledger and event log). No distributed transaction spans a processor call — the reserve/compensate pattern replaces two-phase commit, because a processor call is not idempotent.

## Project layout

```
issues/            Feature specifications, one file per feature, phased with acceptance criteria
docs/
  architecture/    System design documents (bounded contexts, consistency, data model)
  research/        Primary-source papers on payments, ledgers, and distributed systems
src/
  app.ts           Fastify assembly: error mapping, OpenAPI, route registration
  server.ts        Process entrypoint
  cli.ts           Merchant onboarding CLI
  db/              Connection abstraction, migration runner, SQL migrations
  ledger/          Append-only double-entry ledger and balance replay
  payments/        Payment intent state machine and orchestration
  checkout/        Hosted Checkout sessions
  processors/      Processor interface, registry, sandbox implementation
  risk/            Rule evaluation in the authorization path
  auth/            API key issuance, hashing, permissions, tenancy
  idempotency/     Idempotency key claim and replay store
  webhooks/        Event persistence, fan-out, signing and retry delivery
  routes/          v1 HTTP routes and request/response schemas
scripts/           Repository tooling (OpenAPI generation)
tests/             Contract, ledger, migration and delivery tests
openapi.json       Generated OpenAPI 3.1 spec (never hand-edited)
```

## Testing

```bash
npm test            # 85 tests across the payments, ledger, auth, idempotency,
                    # webhook, migration and contract suites
npm run typecheck   # tsc --noEmit
npm run openapi     # regenerate openapi.json from the running app
```

Postgres is not needed for development or tests: the `Db` abstraction runs against PGlite so a full charge flows through the same SQL in milliseconds. CI additionally runs the migration and ledger suites against a real `postgres:16` server, because PGlite lacks replication and real concurrency. A CI check regenerates `openapi.json` and fails if it is stale, and a test asserts every mutating route still requires an idempotency key.

## Documentation

- **[`issues/`](issues/README.md)** — the feature contract. Phase 1 (accept money), Phase 2 (grow revenue), and Phase 3 (platform), each with acceptance criteria, plus the cross-cutting requirements every feature must satisfy.
- **[`docs/architecture/overview.md`](docs/architecture/overview.md)** — system design: bounded contexts, the authorization path, the consistency model, the data model, reconciliation, and regional boundaries.
- **[`docs/research/README.md`](docs/research/README.md)** — the reading list, grouped by the design question each paper answers (idempotency and exactly-once semantics, ledger design, retry/backoff theory, fraud modelling, PCI and cardholder-data handling, regional rails), with the papers downloaded locally so specs can be argued against primary sources.
- **[`openapi.json`](openapi.json)** — the generated HTTP API contract.

## Roadmap

| Phase | Scope | State |
| --- | --- | --- |
| **1 — Accept money** | Payments API, intents + Checkout, card vaulting, webhooks, double-entry ledger, auth/tenancy/RBAC | **Implemented & tested** |
| **2 — Grow revenue** | Subscriptions, invoicing, refunds/disputes, fraud & risk engine, dashboard, SDKs | Specified |
| **3 — Platform** | Multi-currency/multi-region, marketplace & global payouts, pricing engine, compliance, observability, DX tooling | Specified |

The specifications in [`issues/`](issues/README.md) remain the source of truth for what gets built next, in what order, and what "done" means.

## Contributing

Read the relevant spec before writing code — an issue file is the contract, and if code and contract disagree, one of them is a bug. The conventions the tests assume, the ground rules a reviewer will reject a change over, and the migration and OpenAPI workflow are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Not yet decided — no license has been granted. All rights reserved until the first external release; see [`package.json`](package.json) (`"license": "UNLICENSED"`).
