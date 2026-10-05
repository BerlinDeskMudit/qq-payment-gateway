# 0020 — Usage-based and tiered pricing

**Phase:** 4 · **Status:** planned

## Problem

Flat per-transaction pricing punishes high-volume, low-value merchants and
under-prices everyone else. Usage-based pricing lets us serve both, but it
requires metering that merchants will audit.

## Scope

### Metering

- `Meter` object: an event name plus optional filters (customer, product,
  region). Metered events stream in over the API.
- Event ingestion: high volume, at-least-once, with a client-side
  idempotency key so a retry cannot double-count.
- Aggregation windows: hourly buckets with a late-arrival window (72 hours)
  and a reconciliation pass before the bucket closes.
- Immutable closed buckets. A correction posts an adjustment, never an edit.

### Pricing models

- **Tiered:** graduated brackets, per meter, per billing period.
- **Volume:** all units priced at the rate of the reached bracket.
- **Package:** a committed block of units at a fixed price, overage priced
  per unit.
- **Per-category:** different rates for distinct event types.

### Transparency

- Meter usage visible to the merchant in near real time in the dashboard.
- A usage preview: projected bill at any point in the period.
- A downloadable line-by-line calculation for every usage invoice.
- Alert when a merchant crosses a tier boundary mid-period.

## Acceptance criteria

- [ ] Tier boundary values are correct at exact boundaries and one unit
      either side.
- [ ] A duplicated metering event with the same client key counts once.
- [ ] An event arriving after the late window is rejected with a typed
      error and an adjustment path.
- [ ] A merchant's usage in the dashboard matches the ingested event count
      for a sampled meter and period.
- [ ] Every usage invoice line is reproducible from the closed buckets.
- [ ] Projected bill is within a documented tolerance of the final bill
      before period close.

## Dependencies

- `0005` ledger, `0007` billing engine, `0016` pricing configuration.
