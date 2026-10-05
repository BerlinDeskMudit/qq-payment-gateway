# 0011 — Dashboard and merchant portal

**Phase:** 2 · **Status:** planned

## Problem

The API serves developers. The dashboard serves everyone else: founders
checking yesterday's revenue, finance reconciling a payout, support tracing
a customer complaint. If the dashboard is weak, we get support tickets
instead of self-service.

## Scope

### Core surfaces

- **Home:** today/7d/30d volume, success rate, net fees, a volume chart
  broken down by product and currency.
- **Payments:** searchable, filterable list with status, customer, method,
  and amount. Row expands to the full timeline: attempts, events, ledger
  entries, webhook deliveries.
- **Balances and payouts:** available vs. pending with a reserve
  breakdown, payout schedule, destination management.
- **Refunds and disputes:** initiate refunds, submit evidence, deadline
  countdowns.
- **Customers:** profiles, saved methods, payment history.
- **Products and prices:** plan and price management for subscriptions.
- **Invoices:** create, customize, send, track.
- **Developers:** API keys, webhook endpoints with delivery log and replay,
  API logs with `request_id` search, test-mode sandbox credentials, API
  reference with runnable examples.

### Design requirements

- Single-page app, fast on a bad connection. Server-rendered fallback for
  the top-level pages so they work without client JS.
- Every number that appears is traceable to the ledger or to a documented
  calculation. No approximated aggregates.
- Fully keyboard operable; WCAG 2.1 AA.
- Dark mode; light mode is not optional, most developers will want both.
- Role-aware: the finance role sees balances and statements, the developer
  role sees keys and logs.

### Self-service

- Onboarding wizard: create account, verify business, get first test
  charge working in under ten minutes.
- Sandbox toggle that switches every surface into test mode, with an
  unmistakable visual indicator.
- Every table gets CSV export. Finance teams will ask anyway.

## Acceptance criteria

- [ ] New merchant goes from signup to a successful test charge without
      support contact.
- [ ] A payment's full lifecycle is reachable from one row, including the
      ledger entries and the webhook deliveries that reference it.
- [ ] Dashboard numbers match a direct ledger query for a sampled day, with
      zero discrepancy.
- [ ] Sandbox mode cannot be confused with live mode anywhere in the UI.
- [ ] Keyboard-only pass through checkout setup, refund, and evidence
      submission.
- [ ] First contentful paint under 1.5 s on a throttled 4G profile.

## Dependencies

- `0006` for roles and key management, `0005` for balance accuracy,
  `0019` for the sandbox and CLI story.
