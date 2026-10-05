# 0003 — Card vaulting and tokenization

**Phase:** 1 · **Status:** planned

## Problem

Charging a card twice is the easy part. Storing it so we can charge it again
later is what puts us in PCI DSS scope and creates breach liability. The
goal is for our servers to hold only an opaque token.

## Scope

### Network tokenization

- Route card entry through our processor's hosted fields or tokenization
  service. Raw PAN never transits or rests on our infrastructure.
- Store only: `tok_...` handle, last 4, brand, expiry, and a
  processor-issued network token where the region supports it.
- Stripe-style `src_` / `tok_` distinction abstracted behind one internal
  `PaymentMethod` type so merchants do not care which they were given.

### Lifecycle

- `PaymentMethod` attaches to a `Customer`.
- `Customer.default_payment_method` for one-click repeat charges.
- Detach instead of delete: detached methods stay tombstoned for dispute
  evidence and are purged after the retention window.
- Expiry sweep: warn at 30 days, mark unusable at expiry, notify the
  merchant on the next invoice attempt.

### Network tokens and account updater

- Provision network tokens via the account updater where available, so a
 card whose underlying PAN is re-issued keeps working.
- Fall back to the processor token when provisioning fails; surface the
  degradation to the merchant rather than silently failing at charge time.

### Token lifecycle and portability

- Tokens are merchant-scoped and non-transferable by default.
- Document clearly that a token is meaningless outside our API. This is a
  selling point: merchant data is not a liability they can be breached
  into losing.

## Acceptance criteria

- [ ] No code path stores a full PAN, CVV, or track data. Enforced by a CI
      secret-scanning rule plus a review checklist item.
- [ ] A vaulted method charges successfully 90 days later.
- [ ] Detaching then attempting a charge returns a typed, documented error.
- [ ] Expired method produces a distinct error class from a processor
      decline so merchants can prompt for a new card.
- [ ] Token IDs are unguessable and never sequential.
- [ ] Breach simulation: database dump contains no reversible card data.
- [ ] PCI DSS SAQ A eligibility documented and signed off before launch.

## Dependencies

- `0006` Auth for merchant-scoped token access.
- `0017` Compliance for PCI scope statement.

## Open questions

- Do we offer our own long-lived vault token independent of the
  processor, so a processor switch does not strand merchants' customers?
  Argument for: portability, negotiating leverage. Argument against: it
  puts in-scope data handling back on us. Recommend deferring until
  processor diversification is actually on the roadmap.
