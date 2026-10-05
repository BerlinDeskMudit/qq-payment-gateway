# Architecture

Design documents for QQ Payment Gateway. Each document covers one bounded
area and states the constraints it inherits from the others.

| Document | Covers |
| --- | --- |
| [overview.md](overview.md) | System boundaries, the request path, and the data model |

## Constraints that hold everywhere

These come from the product principles in the root README and are not
re-decided per service.

- **One ledger of record.** Every balance traces to it. No service keeps an
  authoritative balance of its own.
- **Append-only financial records.** `INSERT` and `SELECT` permissions only
  on the entries table. Corrections are compensating entries.
- **Idempotency at the boundary.** Every mutating endpoint and every
  internal queue consumer deduplicates on a key before doing work.
- **At-least-once delivery.** Our own webhooks included. Consumers are
  expected to be idempotent.
- **Two-phase writes avoided where money is involved.** A charge is not
  "captured" until both the ledger entry and the processor record agree,
  and disagreement is a detectable state, not a silent one.
- **Tokenized or bust.** Cardholder data does not cross a service boundary
  that does not need it.

## Documentation status

`overview.md` exists. The following are written as their issue specs firm
up, and each will land as a separate document:

- Ledger and reconciliation design (from `issues/0005`)
- Processor adapter contract (from `issues/0001`, `0014`, `0015`)
- Risk engine request path and latency budget (from `issues/0010`)
- Billing scheduler concurrency model (from `issues/0007`)
- Regional data boundaries (from `issues/0013`, `0017`)
