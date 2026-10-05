# 0005 — Double-entry ledger

**Phase:** 1 · **Status:** planned

## Problem

Money movement is the one domain where "close enough" is a legal problem.
Balances must be reconstructable from history, every cent accounted for,
and every correction traceable to a cause. This is the core of the product
and the hardest thing to retrofit.

## Scope

### Model

- Every account is a node; every movement is a balanced journal entry with
  two or more legs that sum to zero per currency.
- Accounts: `processor_clearing`, `processor_pending`, `merchant_available`,
  `merchant_pending`, `platform_fee_revenue`, `fx_reserve`,
  `chargeback_reserve`, `refunds_payable`.
- Entries carry: `effective_at` (business time) and `recorded_at` (system
  time). Late-arriving network events correct `effective_at` without
  rewriting the record.
- Balances are derived from a materialized snapshot plus a replay tail.
  The snapshot must be independently verifiable by replaying entries.

### Write path

- Append-only. Corrections are new compensating entries, never updates.
- Every entry carries `source_type` and `source_id` (the charge, refund, or
  payout that caused it) plus `idempotency_key`.
- Uniqueness enforced on `(source_type, source_id, leg_index)` so a
  duplicated network callback cannot double-post.
- Serialization per account with optimistic concurrency; conflicts retry
  against the current snapshot.

### Reconciliation

- Daily three-way reconciliation: internal ledger vs. processor balance
  report vs. bank settlement.
- Break tolerance configurable per account, defaulting to zero.
- A reconciliation break pages the on-call and opens a merchant-visible
  investigation ticket rather than being auto-adjusted.

### Reporting

- Merchant-facing balance: available, pending, and in-flight, with the
  breakdown by reserve and reserve release date.
- Statement export (CSV, and a machine-readable variant) for merchant
  finance teams.

## Acceptance criteria

- [ ] Sum of all legs per currency is zero at all times, asserted in CI on
      every migration.
- [ ] Replaying the full entry log from genesis reproduces every stored
      balance exactly.
- [ ] A duplicated processor callback produces no duplicate entry.
- [ ] A late-arriving event backdates `effective_at` correctly and does not
      mutate the original entry.
- [ ] A compensating entry fully reverses a bad entry, with the linkage
      recorded in both directions.
- [ ] Reconciliation runs daily against a real processor report and reports
      zero breaks over a 30-day window before launch.
- [ ] No `UPDATE` or `DELETE` against the entries table anywhere in the
      codebase, enforced by a database permission that grants `INSERT` and
      `SELECT` only.

## Dependencies

None. This is a foundation piece; `0001`, `0007`, `0009`, and `0014` all
depend on it.

## Open questions

- Ledger storage: Postgres with a strict permission model, or a dedicated
  append-only store? Start with Postgres — the permission model plus
  partitioning gets us most of the way, and one fewer distributed system to
  operate before we have revenue.
