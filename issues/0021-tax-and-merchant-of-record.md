# 0021 — Tax and merchant-of-record

**Phase:** 4 · **Status:** planned

## Problem

Selling across borders means someone owes VAT, GST, or sales tax. Today
merchants handle that themselves, inconsistently, usually in the wrong
jurisdiction. Becoming merchant of record is the highest-value thing we
could sell and also the most operationally heavy.

## Scope

### Tax determination

- Jurisdiction determination from customer location, verified billing
  address, and IP, with a documented precedence order.
- Product tax categories: physical goods, digital goods, services,
  subscriptions, with per-category treatment per jurisdiction.
- Rate lookup via a maintained rules engine plus a tax provider for
  authoritative rates, with the provider as the system of record and the
  rules engine as the cache.
- Tax-inclusive and tax-exclusive display, and inclusive-pricing amount
  breakdown.

### Merchant of record (MoR)

- We contract with the buyer, we take the risk, we remit the tax.
- Tax-inclusive pricing by default in MoR jurisdictions, with net proceeds
  remitted to the seller.
- Tax registration and filing per jurisdiction, with a filing calendar and
  a reconciliation between filed amounts and collected ledger amounts.
- Documentation for sellers: certificates, statements, jurisdiction-specific
  invoicing requirements.

### Merchant-side tax

- Tax and shipping fields on the payment element and Checkout.
- Tax ID collection and validation (VAT, GST, ABN, EIN) with reverse-charge
  handling.
- Exemption certificates on file, validated and applied automatically.

## Acceptance criteria

- [ ] Jurisdiction determination follows the documented precedence order
      and its decision is exposed in the API response for audit.
- [ ] A tax-inclusive price is decomposed into net and tax correctly, with
      rounding to the jurisdiction's currency rule.
- [ ] Reverse charge applies only when the validated tax ID qualifies, and
      the validation result is stored.
- [ ] Filed tax amounts reconcile to collected ledger amounts per
      jurisdiction with zero unexplained difference.
- [ ] A price change in the tax provider does not retroactively alter a
      finalized invoice.

## Dependencies

- `0005` ledger (tax as its own account), `0008` invoicing (tax fields),
  `0013` multi-region.
