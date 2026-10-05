# 0006 — Auth, multi-merchant tenancy, RBAC

**Phase:** 1 · **Status:** planned

## Problem

Merchants integrate with API keys in servers and OAuth in dashboards. Both
must work, and every row we store must be scoped to exactly one account.
A cross-tenant leak is the worst bug this product can ship.

## Scope

### Account model

- `Account` is the tenant boundary. All financial rows carry `account_id`.
- Accounts are either direct (we contracted with them) or connected (via
  `0014` marketplace onboarding).
- Account hierarchy: organizations can own child accounts for franchise,
  multi-store, and enterprise procurement models.

### API authentication

- Secret API keys, shown once at creation, prefix identifies the key for
  lookup and secret does the verification.
- Keys carry scopes (read/write on resources), an optional expiry, and
  rotation without downtime (two active keys during rotation).
- Per-key rate limit and per-key allowlist of IP ranges.
- Restricted keys: server-only, no client exposure.
- OAuth 2.0 authorization code with PKCE for the dashboard and for platforms
  acting on behalf of merchants.

### Authorization

- Role model on accounts: `owner`, `admin`, `developer`, `finance`,
  `support`, `viewer`.
- Resource-level policy so a `developer` can create charges but not change
  bank details.
- Every authorization decision logged with actor, action, resource, result.

### Data isolation

- Row-level scoping enforced in the data layer, not left to query authors.
  A shared helper generates the scope predicate so it cannot be forgotten.
- Automated test that attempts cross-account reads and writes for every
  endpoint; a single pass is a release blocker.

## Acceptance criteria

- [ ] A key for account A cannot read, write, or guess any resource of
      account B, across every endpoint.
- [ ] Key rotation with two live keys works with no downtime.
- [ ] OAuth flow completes PKCE challenge correctly; replayed auth codes are
      rejected.
- [ ] Role restrictions enforced: finance role cannot create charges,
      developer role cannot add a payout destination.
- [ ] A privileged support action requires explicit elevation, expires, and
      is written to the immutable audit log.
- [ ] Cross-tenant isolation suite runs in CI against the reference
      implementation and fails the build on any pass-through.

## Dependencies

- `0011` Dashboard for key and role management UI.
- `0005` for account-scoped balances.

## Open questions

- Do merchants need per-resource granular permissions (role templates
  they can edit), or is a fixed role set enough for the first 50 customers?
  Recommend fixed roles; custom permission editors are a v2 feature and a
  common source of misconfiguration support load.
