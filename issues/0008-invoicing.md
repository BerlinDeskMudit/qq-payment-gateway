# 0008 — Invoicing

**Phase:** 2 · **Status:** planned

## Problem

B2B merchants cannot use a card-only flow. They need a PDF, a PO number,
net terms, and a payment that lands days later without losing reconciliation
between the invoice and the ledger.

## Scope

### Invoice object

- Line items: description, quantity, unit amount, tax rate, discount.
- Lifecycle: `draft` → `open` → `paid` | `void` | `uncollectible`.
  Only drafts are editable.
- Immutable once `open`. A correction is a credit note against the original.

### Customization

- Merchant logo, accent color, address, footer, custom fields.
- Line-item and total rendering rules: show tax inclusive vs. exclusive,
  hide zero-quantity lines.
- Hosted invoice page at a shareable URL, plus a print-optimized template.
- PDF generation with page numbering, and a deterministic layout that does
  not reflow when a field changes length.

### Payment options

- Pay online by card through the hosted page.
- `ACH`/bank debit with delayed settlement — model the pending state
  explicitly, since the money moves later.
- Payment terms: `due_on_receipt`, `net_15`, `net_30`, `net_45`, custom
  dates.
- Partial payments, allocated across line items in a documented order.
- PO number and vendor reference on the invoice.

### Automation

- Recurring invoice schedules with an email delivery policy the merchant
  controls (we send, or we hand them a signed PDF).
- Overdue reminders on the merchant's schedule, quiet hours respected per
  recipient locale.

## Acceptance criteria

- [ ] PDF renders identically across a full-page line item list and a
      single-line invoice, with no orphaned totals.
- [ ] A finalized invoice cannot be edited; attempting so returns a typed
      error naming the credit-note path.
- [ ] Net-30 invoice records as pending until settlement, and the ledger
      reflects the receivable from day one.
- [ ] Partial payment reduces the balance correctly and is fully
      reconstructable from ledger entries.
- [ ] Invoice numbering is gap-free and sequential per account, with a
      documented override for merchants whose auditors object.

## Dependencies

- `0005` ledger for receivables, `0007` for recurring schedules (shared
  scheduler), `0011` for the hosted page and customization UI.
