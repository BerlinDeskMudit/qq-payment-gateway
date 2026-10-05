# 0019 — Developer experience tooling

**Phase:** 3 · **Status:** planned

## Problem

Time to first successful charge is the metric that predicts whether a
developer keeps building on us. Every extra step before a test charge works
is a churn event we caused.

## Scope

### CLI

- `qqpay login`, `qqpay listen --forward-to`, `qqpay logs tail`,
  `qqpay resources create/get`, `qqpay fixtures`.
- Mirrors the API resource tree so the CLI is discoverable by analogy with
  the API reference.
- Scriptable output (`--format json`) and a `--dry-run` on every mutating
  command.
- Machine-readable and stable exit codes for CI use.

### Sandbox

- A fully functional test mode with a dedicated processor account and
  synthetic money. No test data ever touches the real ledger.
- Deterministic scenario triggers so a developer can force any outcome:
  approve, decline with any code, 3DS challenge, network timeout, async
  settlement, dispute.
- Test clocks: advance time to fire an invoice, an expiry, or a dispute
  deadline without waiting.

### Local development

- One command to run the whole stack locally: API, worker, Postgres, Redis.
- Seeded fixture data so a new contributor has a populated database on first
  run.
- Contract tests runnable offline against recorded responses.
- Seed script for the SDK repos that stands up an equivalent sandbox
  environment.

### Documentation as a product

- API reference generated from the spec, with a runnable example per
  endpoint in every language.
- Quickstart that reaches a successful charge in under five minutes, with
  no account prerequisites.
- Migration guides for common framework integrations.
- A public status page and a changelog that merchants can subscribe to.
- Cookbook for the flows that are not obvious: partial capture, dunning
  tuning, split payments, dispute evidence.

## Acceptance criteria

- [ ] Quickstart reaches a successful test charge in under five minutes
      from a clean machine, verified by ten people who did not build it.
- [ ] Every endpoint in the reference has a runnable example, executed in
      CI so a stale example fails the build.
- [ ] `qqpay listen` receives and verifies a webhook signature with no
      manual setup.
- [ ] The full stack starts with one command on a clean checkout.
- [ ] Test clock can advance a subscription through a full billing cycle
      in seconds.
- [ ] Every error class in the API has a docs page with cause and remedy.

## Dependencies

- `0001` (reference generated from the spec), `0011` (dashboard sandbox
  toggle), `0012` (SDK fixtures).
