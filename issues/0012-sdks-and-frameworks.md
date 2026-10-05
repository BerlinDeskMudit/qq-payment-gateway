# 0012 — SDKs and frameworks

**Phase:** 2 · **Status:** planned

## Problem

Every untyped integration is a support ticket. SDKs are also our strongest
retention lever: a merchant with our library in their codebase is not
shopping us again in six months.

## Scope

### Official libraries

- **Server:** Node.js/TypeScript, Python, Go, Ruby, PHP, Java, .NET,
  Kotlin.
- **Web:** React, Vue, Svelte, Angular, plus a framework-agnostic bundle.
- **Mobile:** React Native, Flutter, iOS (SwiftUI), Android (Compose) for
  the Payment Sheet.
- **E-commerce plugins:** Shopify, WooCommerce, Magento, BigCommerce,
  Wix.

### Design requirements

- Types are the contract. Generated from the same OpenAPI source as the API,
  published to a package per language on every spec change.
- Thin by default: a request maps to one function call, no hidden state.
- Automatic retries with exponential backoff on connection errors and 5xx,
  jittered, never on non-idempotent calls without a key.
- Typed error hierarchy mirroring the API error classes.
- Built-in request/response logging with redaction of anything sensitive,
  off by default in production.
- Every SDK pinned to a supported API version and tested against the
  contract suite.

### Distribution

- Semantic versioning with a documented support policy per major.
- Dependabot-style update PRs for our own SDKs.
- A published compatibility matrix in the docs.

## Acceptance criteria

- [ ] A merchant creates a customer, charges a card, and handles a typed
      decline in under 15 lines in every supported language.
- [ ] Types in every SDK are generated from the API spec; CI fails if they
      drift.
- [ ] Retry behavior is covered by tests that simulate 5xx and connection
      reset, and verified not to double-charge.
- [ ] Logs redact card data, tokens, and API keys in all SDKs, verified by
      test.
- [ ] Each e-commerce plugin completes a real sandbox purchase end to end in
      its platform's test mode.
- [ ] SDK install-to-first-call is a single documented snippet per language.

## Dependencies

- `0001` (the spec is generated from the API), `0002` (client-side
  components), `0003` (token handling in SDKs).
