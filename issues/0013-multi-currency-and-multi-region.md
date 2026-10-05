# 0013 — Multi-currency and multi-region

**Phase:** 3 · **Status:** planned

## Problem

A merchant in one country selling in another needs settlement in their home
currency. FX handling is where payment companies quietly lose money, and it
is where a merchant's expectations and our arithmetic disagree.

## Scope

### Currencies

- Presentment and settlement currency configurable per account.
- A `Balance` per currency per account. No implicit conversion.
- Zero-decimal currencies (`JPY`, `KRW`) and three-decimal currencies
  (`BHD`, `KWD`, `JOD`) supported natively, with an exponent table that is
  versioned with the API.
- Rounding mode declared per currency, never applied implicitly at display
  time.

### FX

- Explicit `ExchangeRate` records with source, timestamp, and rate, so any
  historical amount can be explained.
- Two models, merchant-selectable:
  - **Merchant bears FX:** transparent single rate, no markup.
  - **Platform bears FX:** merchant receives a locked rate at a disclosed
    markup, with the markup itemized in the ledger.
- Rate quotes with a TTL; a charge that settles after the TTL is
  re-quoted and the difference is posted as a separate ledger movement.
- FX fee recognized separately from `platform_fee_revenue` so the two can be
  reported independently.

### Regions

- Regional processing for data residency: US, EU, and APAC data boundaries
  with no cross-boundary transfer of cardholder data.
- Region selection at account creation, immutable after the first charge.
  Migration is a data-migration project, not a settings toggle.
- Failover between regions is broken by design: a single ledger of record.
  Two writable ledgers is how reconciliation bugs get created.

## Acceptance criteria

- [ ] A JPY charge stores and displays without rounding drift.
- [ ] Every converted amount resolves back to the rate record that produced
      it, by ID, indefinitely.
- [ ] An expired-rate settlement posts a re-quote movement and no amount is
      lost or double-counted.
- [ ] FX margin, when platform-borne, is separately reportable from platform
      fees.
- [ ] Cardholder data for an EU account never leaves the EU boundary,
      verified in an audit and in CI.
- [ ] Account region cannot be changed after the first charge, and the
      error message names the migration path.

## Dependencies

- `0005` ledger (multi-currency entries, `fx_reserve`), `0003` (network
  tokens are region-bound), `0017` (residency compliance).
