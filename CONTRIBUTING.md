# Contributing

The specifications in [`issues/`](issues/README.md) are the contract. Code and
contract disagreeing means one of them is a bug, and the fix is to work out
which before changing either.

## Getting set up

Requires Node 22 or newer.

```bash
npm install
npm test
```

Postgres is not needed for development or tests. The `Db` abstraction runs
against [PGlite](https://pglite.dev), an in-process build of Postgres, so a
full charge flows through the same SQL, the same constraints, and the same
deferred triggers in milliseconds.

## Ground rules

These come from the product principles in the README. They are the things a
reviewer will reject a change over.

1. **Money is never mutated.** Balances are derived from an append-only
   double-entry ledger. A correction is a compensating entry. If your change
   updates a ledger row, it is wrong.
2. **Every mutation takes an idempotency key.** Handlers are wrapped in
   `withIdempotency`; a new mutating route that is not wrapped will let a
   network retry double-charge. A test enforces this against the OpenAPI spec.
3. **Never trust a request body for tenancy.** Read the account from the
   authenticated principal and pass it into every query. A test in
   `tests/api/payments.test.ts` checks that one merchant's id 404s for another.
4. **Errors are part of the contract.** Typed errors with stable codes, mapped
   to responses in exactly one place, `src/app.ts`. Never leak an internal
   message or a SQL fragment to a client.
5. **Explain every number.** Any amount a merchant sees traces to a ledger
   entry or a documented calculation. "Where did this fee come from" must have
   an answer.

## Conventions the tests rely on

These are enforced, not stylistic preferences.

- **No test reaches for a real network.** Processors and webhook transports are
  injected; the sandbox processor decides behaviour from the test card number.
- **Tests must not share a database.** Each harness creates its own PGlite
  instance. Sharing state between files is the fastest way to a suite that
  passes alone and fails in CI.
- **Run the suite in full before pushing.** Several tests, including the webhook
  queue and the migration runner, claim from shared state and are only
  meaningful under parallel execution.
- **Assert on behaviour, not on status codes alone.** A `200` that silently did
  nothing is the failure mode this project exists to avoid.

## Migrations

Migrations are plain SQL in `src/db/migrations/`, applied in filename order and
recorded in `schema_migrations`. The runner owns the transaction, so migration
files should not contain their own `BEGIN` or `COMMIT`.

Add a new file rather than editing an applied one. Applied migrations are
history; editing one means existing databases and fresh ones disagree, and the
bug only shows up for whichever merchant upgrades.

Involve a constraint or trigger where the invariant deserves database
enforcement. The ledger's balance check is a deferred constraint precisely so
that no application bug, and no `psql` session, can commit an unbalanced entry.

## OpenAPI

`openapi.json` is generated, never hand-edited:

```bash
npm run openapi
```

It comes from the same TypeBox schemas that validate requests and serialize
responses. A field returned by a handler but missing from its schema is
silently stripped from the response, so when you add a response field, add it
to the schema in the same commit.

## Commit messages

Say what changed and why, in the past tense. A reader should be able to
understand why a refund reverses the original fee rather than recomputing one
without looking at the diff.

## Pull requests

1. Tests, including the failure mode you just fixed.
2. Acceptance criteria updated if the change altered the contract.
3. `npm test` green, and `npm run typecheck` clean.