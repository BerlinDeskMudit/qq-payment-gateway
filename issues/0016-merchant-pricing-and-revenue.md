# 0016 — Our own pricing engine and revenue billing

**Phase:** 3 · **Status:** planned

## Problem

We sell software that takes a cut of money. Our own pricing, invoicing, and
revenue recognition has to be as solid as what we sell, and it has to be
one system rather than three SaaS tools. It is also the first place our own
ledger gets used for non-customer money.

## Scope

### Plans and pricing

- Merchant pricing in three tiers plus a custom tier, each with a base fee,
  a percentage rate, and per-transaction caps.
- Configuration driven, not code-driven: a change to pricing should not
  require a deploy, and historical invoices must be unaffected by it.
- Volume tiers and a committed-spend discount, evaluated on a rolling
  window with the evaluation result stored on the invoice line.
- Custom pricing for strategic accounts via a signed pricing schedule
  attached to the account.

### What we charge

- `platform_fee` on captures.
- `payment_fee` per successful charge.
- `international_fee` on cross-border.
- `FX markup` on conversions.
- `Payout fee` per payout and per method.
- `Dispute handling fee` on a lost dispute, passed through at cost.
- `Refund fee` — optional, and off by default because it is the kind of
  fee that generates angry support tickets.
- Optional monthly platform fee with a trial period.

### Billing and revenue recognition

- Recurring billing for platform and payout fees, via our own subscription
  engine.
- Usage-based lines computed from the ledger, closed monthly, and immutable
  once invoiced.
- Accrual accounting for processor fees: recognize cost when incurred,
  matching the settlement period.
- Revenue recognized net of processor cost; processor cost broken out per
  corridor so unit economics are answerable.

### Reporting

- Monthly statement per merchant with every fee line itemized.
- Internal unit economics: gross volume, net revenue, processor cost by
  corridor, contribution margin per corridor.
- Churn and expansion reporting on the platform-fee subscription line.

## Acceptance criteria

- [ ] A pricing config change applies to new invoices only; a prior month's
      invoice is byte-identical afterwards.
- [ ] Every fee on a merchant statement maps to a ledger entry, and the sum
      of fees ties to revenue for the period.
- [ ] Volume tier boundaries are tested at exact boundary values.
- [ ] A dispute fee passes through at cost with the actual charge attached
      to the fee line.
- [ ] Accrued processor cost reconciles to the processor's own invoice
      within a cent per corridor over a month.
- [ ] Contribution margin is computable per corridor without manual work.

## Dependencies

- `0005` ledger, `0007` subscriptions engine, `0013` multi-currency for FX
  markup.
