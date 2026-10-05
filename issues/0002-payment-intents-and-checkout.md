# 0002 — Payment Intents UX and hosted Checkout

**Phase:** 1 · **Status:** planned

## Problem

Merchants do not want to build payment forms. They also do not want us to
touch raw card numbers. We need a hosted page that collects the payment
details, handles 3DS step-up, and returns the customer to the merchant —
plus an embedded option for merchants who need their own styling.

## Scope

### Hosted Checkout

- `POST /v1/checkout/sessions` with a line-item array or a pre-created
  `PaymentIntent`. Returns a hosted URL.
- A single self-contained page: no merchant JavaScript required.
- Renders line items, tax/shipping fields, and a payment form.
- Handles 3DS challenge inline when the processor requires action.
- Localization of labels; currency formatting per locale.
- Post-checkout redirect back to the merchant with `session_id` and the
  resulting intent ID.
- Optional `ui_mode: "embedded"` for an iframe-based variant with callback
  events for the host page.

### Payment Element

A drop-in component for merchants who need the form inside their own
checkout. One bundle, no framework lock-in:

- Mounts a `<div>`, renders payment methods, emits lifecycle events.
- Mounts inside an iframe so card fields never enter the merchant's DOM.
- Supports React, Vue, Svelte, and plain JS through thin wrappers.
- Appears as a single integration line for most merchants; the raw API
  stays available for anyone who wants full control.

### Saved payment methods during checkout

- A returning customer can pick a previously vaulted method.
- Requires the customer to have an active mandate/session token; consent
  is recorded in the audit log with the surface it happened on.

## Acceptance criteria

- [ ] A merchant can go live with zero custom frontend code.
- [ ] 3DS challenge completes inside Checkout; no redirect to a third party.
- [ ] Checkout works on mobile browsers down to a 320 px viewport.
- [ ] Abandoned sessions are recoverable — the intent stays open and the
      customer can resume, with a configurable `expires_at`.
- [ ] Hosted page sends no referrer containing intent IDs to third parties.
- [ ] The Element bundle is under 60 KB gzipped and lazy-loads per payment
      method actually offered by the account.
- [ ] Accessibility: keyboard-navigable, labelled fields, WCAG 2.1 AA on
      the hosted page.
- [ ] Card data never reaches our application servers; verified by network
      capture in CI for the Element mount path.

## Dependencies

- `0001` Core payments API.
- `0003` Card vaulting (saved methods on the Checkout surface).

## Non-goals

No invoicing, no subscription schedules, no saved-card-on-file without
explicit merchant opt-in.
