# QQ Payment Gateway

Payment infrastructure as software. Merchants integrate one API to accept
cards and bank payments, run subscriptions and invoices, fight fraud, handle
disputes, and pay out sellers in any supported currency.

The product is sold three ways:

- **Hosted** — a merchant pastes two lines of code and starts charging.
- **Embedded** — a drop-in payment element for merchants who need their own
  checkout design.
- **Platform** — marketplaces onboard sellers, split payments, and pay out
  through the same API.

## Why this exists

Integrating payments is a months-long project for a competent engineering
team, and the hard parts are invisible: idempotency, reconciliation,
PCI scope, dispute deadlines, split-payment rounding. Meanwhile a new
enterprise SaaS in a new country needs to charge in local currency before
it can sign its first large customer.

This product makes those hard parts the vendor's problem instead of the
merchant's.

## What is in the box

| Capability | Summary |
| --- | --- |
| Payments API | Payment intents, charges, multi-capture, idempotent by default |
| Tokenization | Card data never touches our servers; network tokens where available |
| Checkout | Hosted page and embedded payment element, 3DS handled inline |
| Subscriptions | Trials, proration, scheduled billing, automated dunning |
| Invoicing | Line items, tax fields, net terms, partial payments, PDF |
| Fraud | Ordered rule engine plus a real-time scoring service, both merchant-tunable |
| Disputes | Auto-ingested cases, deadline tracking, evidence submission, auto-respond |
| Marketplaces | Connected accounts, split payments, platform fees, seller payouts |
| Payouts | Bank, card, and wallet rails with compliance screening built in |
| Multi-currency | Per-currency balances, explicit FX quotes, regional data boundaries |
| Dashboard | Self-service setup, live money-in-flight view, webhook delivery log |
| SDKs | Server, web, mobile, and framework plugins, types generated from the spec |

Full specifications, phase by phase, live in [`issues/`](issues/README.md).

## Product principles

These are constraints, not aspirations. Features that violate them get
rejected in review.

1. **Money is never mutated.** Balances come from an append-only
   double-entry ledger. Corrections are compensating entries. Every cent is
   reconstructable from history.
2. **Retry-safe by default.** Every mutating endpoint takes an idempotency
   key. At-least-once delivery is assumed everywhere, including our own
   webhook delivery.
3. **Never hold what you do not need.** No raw card data on our
   infrastructure. An external assessor signs off on the PCI scope claim
   before launch.
4. **Errors are part of the contract.** Typed error classes with stable
   codes. Integrators branch on `type`, never on message text.
5. **Explain every number.** Any figure a merchant sees traces to a ledger
   entry or a documented calculation. If a charge happened and money did
   not move, the merchant can see that immediately.
6. **The dashboard is a product, not a report page.** Most merchants never
   read the API docs. They read the dashboard.
7. **Design for the incident.** Idempotency, reconciliation, and observability
   ship with the feature, not in a later phase.

## Architecture at a glance

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
                                    |  (double entry)|  balanced
                                    +-------+-------+
                                            |
                        +-------------------+-------------------+
                        v                   v                   v
                 +-------------+     +--------------+    +-------------+
                 |  Processor  |     |  Payouts     |    |   Billing   |
                 |  adapters   |     |  + rails     |    |  our pricing|
                 +-------------+     +--------------+    +-------------+
```

Read the detailed write-up in
[`docs/architecture/overview.md`](docs/architecture/overview.md).

## Repository layout

```
issues/            Feature specifications, one file per feature, phased
docs/
  architecture/    System design documents
  research/        Academic papers on payments, ledgers, and distributed systems
src/               Implementation (not started)
```

## Current status

Pre-implementation. The specifications in `issues/` are the source of truth
for what gets built, in what order, and what "done" means. The research
library in `docs/research/` is the reading list the specs are argued from.

Phase 1 is the critical path: the core payments API, the double-entry
ledger, tokenization, webhooks, and multi-tenant auth. Nothing else can be
built safely until those land.

## Research library

[`docs/research/README.md`](docs/research/README.md) holds the reading
list, grouped by the design question each paper answers: idempotency and
exactly-once semantics, ledger and accounting design, retry and backoff
theory, fraud modelling, PCI and cardholder data handling, and regional
payment rails. Papers are downloaded locally so the specs can be argued
against primary sources.

## Contributing

Read the specs before writing code. An issue file is the contract; if the
code and the contract disagree, one of them is a bug.

1. Pick an issue from [`issues/`](issues/README.md) and comment on it.
2. Open a branch, make the change, include tests.
3. Contract tests and the ledger balance invariant run on every commit.
   A failing invariant blocks the merge.

Disagreement with a spec is welcome and expected. Comment on the file with
what you think is wrong, and update the acceptance criteria as part of the
PR.

## License

To be decided before the first external release. All rights reserved until
then.
