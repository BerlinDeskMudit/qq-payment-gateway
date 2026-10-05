# 0014 — Marketplace payouts (split payments)

**Phase:** 3 · **Status:** planned

## Problem

Platforms need to take a cut and pay out sellers. Every marketplace has a
slightly different model, so our job is to build the primitives and let the
platform express its own logic. This is also the highest-value segment:
platforms bring many merchants with them.

## Scope

### Accounts and onboarding

- `Account` gains a `type`: `standard`, `express`, `custom`.
- Express accounts: we own KYC and underwriting, fast onboarding.
- Custom accounts: the platform owns the merchant relationship and passes
  through its own KYC answers.
- `AccountCapability` set per account: card payments, transfers, refunds on
  behalf of, payouts.
- Requirements and restrictions (`payments_enabled`, `payouts_enabled`)
  driven by verification state.

### Split payments

- `Transfer` and `TransferGroup` on the charge. Multiple destinations,
  fixed or proportional amounts.
- Platform application fee as a first-class ledger leg, not a negative
  transfer. The fee is revenue the moment the charge clears.
- `on_behalf_of` to attribute the charge to a connected account.
- Reverse behavior: a full refund claws back transfers in reverse order;
  a partial refund does not silently change seller balances — the platform
  decides and we enforce non-negative connected balances.
- Connected account balance available immediately where the processor
  allows, otherwise held in `merchant_pending` with a visible release date.

### Payout controls

- Destination management: bank account, card, or external wallet, with
  ownership verification and a micro-deposit or instant-verification flow.
- Payout schedules: daily, weekly, monthly, manual, with a minimum threshold
  and a reserve percentage.
- Manual payouts gated on a role that is not the same role that can create
  charges.
- Hold and release on a connected account, with a full audit trail and a
  stated reason.

## Acceptance criteria

- [ ] A marketplace splits a 100.00 charge across three sellers with
      rounding that sums exactly to 100.00 and a deterministic rule for
      who absorbs the sub-cent.
- [ ] Platform fee posts to revenue on clear, not on capture.
- [ ] Full refund reverses transfers in reverse order; connected balances
      never go negative.
- [ ] Payout to an unverified destination is blocked with a typed error
      naming the missing capability.
- [ ] Reserve percentage holds funds correctly and the release date is
      visible to the platform.
- [ ] Express onboarding completes KYC and enables payouts within the SLA we
      publish.
- [ ] `on_behalf_of` charge shows up in the seller's dashboard and in the
      platform's, with the correct fee attribution on both.

## Dependencies

- `0005` ledger, `0006` accounts and roles, `0017` KYC/KYB, `0015` payouts
  rail.
