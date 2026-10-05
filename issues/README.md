# Feature Backlog

Planned features for QQ Payment Gateway, grouped by phase. Each file is a
standalone spec: problem, scope, acceptance criteria, dependencies.

## Phase 1 — Accept money (MVP)

| ID | Feature | Status |
| --- | --- | --- |
| [0001](0001-core-payments-api.md) | Core payments API | planned |
| [0002](0002-payment-intents-and-checkout.md) | Payment Intents + hosted Checkout | planned |
| [0003](0003-card-vaulting-and-tokenization.md) | Card vaulting & tokenization | planned |
| [0004](0004-webhooks-and-events.md) | Webhooks & event delivery | planned |
| [0005](0005-double-entry-ledger.md) | Double-entry ledger | planned |
| [0006](0006-auth-tenancy-and-rbac.md) | Auth, multi-merchant tenancy, RBAC | planned |

## Phase 2 — Grow revenue

| ID | Feature | Status |
| --- | --- | --- |
| [0007](0007-subscriptions-and-recurring-billing.md) | Subscriptions & recurring billing | planned |
| [0008](0008-invoicing.md) | Invoicing | planned |
| [0009](0009-refunds-disputes.md) | Refunds, disputes & chargebacks | planned |
| [0010](0010-fraud-and-risk-engine.md) | Fraud & risk engine | planned |
| [0011](0011-dashboard-and-merchant-portal.md) | Dashboard & merchant portal | planned |
| [0012](0012-sdks-and-frameworks.md) | Official SDKs | planned |

## Phase 3 — Platform

| ID | Feature | Status |
| --- | --- | --- |
| [0013](0013-multi-currency-and-multi-region.md) | Multi-currency & multi-region | planned |
| [0014](0014-marketplace-payouts.md) | Marketplace payouts (split payments) | planned |
| [0015](0015-global-payouts.md) | Global payouts / payouts-as-a-service | planned |
| [0016](0016-merchant-pricing-and-revenue.md) | Our own pricing engine & revenue billing | planned |
| [0017](0017-compliance-and-risk-controls.md) | Compliance, PCI scope reduction, KYC/KYB | planned |
| [0018](0018-observability-and-sre.md) | Observability & SRE tooling | planned |
| [0019](0019-developer-experience-tooling.md) | DX tooling: CLI, test mode, local stack | planned |

## Cross-cutting requirements

Non-negotiable across every feature above:

- Idempotency keys on every mutating endpoint (`0001`).
- Double-entry accounting for all money movement (`0005`).
- Append-only audit log; no hard deletes of financial records (`0005`).
- Card data never touches our servers in plaintext (`0003`, `0017`).
- Versioned API; breaking changes require a new major path (`0001`).
- p99 latency budget on the authorization path under 400 ms (`0018`).
- 99.99% availability target for the authorization API (`0018`).

## How to claim an issue

Open a PR that references the issue number. Specs are expected to change
before implementation starts: comment on the file with what you disagree
with, and update the acceptance criteria to match.
