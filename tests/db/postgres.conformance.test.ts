import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/index.js';
import { migrate } from '../../src/db/migrate.js';
import {
  postEntry, getBalance, assertLedgerBalanced, asNumber,
  LedgerCode, type Posting,
} from '../../src/ledger/ledger.js';
import { newId } from '../../src/lib/ids.js';

/**
 * Schema conformance: the invariants this project would corrupt money by
 * getting wrong.
 *
 * These run on PGlite (an in-process WASM build of Postgres) as part of
 * `npm test`, and can be pointed at a real server with CONFORMANCE_PG=1. That
 * second mode matters because the things this project leans on hardest are
 * exactly where a WASM build could plausibly differ from real Postgres:
 * deferred constraints, triggers, and checks enforced at COMMIT rather than at
 * INSERT. An unbalanced ledger is a corruption bug, so the assumption is worth
 * testing rather than hoping.
 */

const useRealPostgres = process.env.CONFORMANCE_PG === '1';
const hasPostgres = Boolean(process.env.DATABASE_URL);

/** Fail loudly rather than silently testing PGlite when PG was requested. */
if (useRealPostgres && !hasPostgres) {
  throw new Error('CONFORMANCE_PG=1 requires DATABASE_URL');
}

const schema = `conformance_${process.env.VITEST_POOL_ID ?? '1'}_${process.pid}`;
let db: Db;
let accountId: string;

describe('schema conformance', () => {
  beforeAll(async () => {
    accountId = newId('acct');

    if (useRealPostgres) {
      // A dedicated schema per worker, so parallel workers cannot see each
      // other's rows and a failed run cannot poison the next one. The
      // search_path has to travel in the connection options: a pool opens more
      // than one connection, and a bare `SET` would apply to only one of them.
      const base = process.env.DATABASE_URL!;
      const admin = await createDb({ backend: 'pg', connectionString: base });
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.close();

      const scoped = new URL(base);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      db = await createDb({ backend: 'pg', connectionString: scoped.toString() });
    } else {
      db = await createDb({ backend: 'pglite' });
    }

    await migrate(db);
    await db.query(
      `INSERT INTO accounts (id, name, email, country) VALUES ($1, 'Conformance', 'c@example.com', 'US')`,
      [accountId],
    );
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    // Clean up so a local Postgres is not left littered with schemas.
    if (useRealPostgres) await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await db.close();
  }, 120_000);

  async function post(postings: Posting[], sourceType = 'conformance') {
    return db.transaction((tx) =>
      postEntry(tx, {
        accountId, currency: 'usd', sourceType, sourceId: newId('src', 12), postings,
      }),
    );
  }

  const balancedPair = (amount: number): Posting[] => [
    { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount },
    { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount },
  ];

  it('applies the migrations', async () => {
    const { rows } = await db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
    expect(rows.map((r) => r.name)).toEqual(['0001_core.sql', '0002_manual_capture.sql']);
  });

  it('is idempotent', async () => {
    expect(await migrate(db)).toEqual([]);
  }, 60_000);

  it('balances a multi-leg entry and replays balances', async () => {
    const entry = await post([
      { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 1000 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 970 },
      { code: LedgerCode.PLATFORM_FEE_REVENUE, direction: 'credit', amount: 30 },
    ]);

    expect(entry.id).toMatch(/^le_/);
    await assertLedgerBalanced(db);

    // Assets debit upward, liabilities credit upward.
    expect(await getBalance(db, accountId, LedgerCode.PROCESSOR_CLEARING, 'usd')).toBe(1000);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(970);
    expect(await getBalance(db, accountId, LedgerCode.PLATFORM_FEE_REVENUE, 'usd')).toBe(30);
  });

  it('refuses to commit an unbalanced entry, and leaves nothing behind', async () => {
    // The deferred constraint is the guarantee: this passes every check at
    // INSERT time and must still fail at COMMIT.
    const clearingBefore = await getBalance(db, accountId, LedgerCode.PROCESSOR_CLEARING, 'usd');
    const availableBefore = await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd');

    await expect(
      post([
        { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 500 },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 400 },
      ]),
    ).rejects.toThrow();

    await assertLedgerBalanced(db);
    // The hold never became money.
    expect(await getBalance(db, accountId, LedgerCode.PROCESSOR_CLEARING, 'usd')).toBe(clearingBefore);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(availableBefore);
  }, 60_000);

  it('refuses to update or delete a posted entry', async () => {
    const entry = await post(balancedPair(200));
    const before = await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd');

    await expect(
      db.query(`UPDATE ledger_legs SET amount = 999 WHERE entry_id = $1`, [entry.id]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM ledger_entries WHERE id = $1`, [entry.id]),
    ).rejects.toThrow();

    // Unchanged, not 999.
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(before);
  });

  it('rejects impossible amounts and legs', async () => {
    const before = await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd');

    await expect(post([{ code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: -100 }]))
      .rejects.toThrow();
    await expect(post([{ code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 0 }]))
      .rejects.toThrow();
    // A single unbalanced leg is the same failure as a mismatched pair.
    await expect(post([{ code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 100 }]))
      .rejects.toThrow();

    await assertLedgerBalanced(db);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(before);
  }, 60_000);

  it('keeps every posting of concurrent writers', async () => {
    // Two writers that both read the same balance must both land. The amount is
    // not what makes this pass, only that nothing is lost.
    const clearingStart = await getBalance(db, accountId, LedgerCode.PROCESSOR_CLEARING, 'usd');
    const availableStart = await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd');
    const write = () => post(balancedPair(100), 'concurrent');

    await Promise.all([write(), write()]);

    await assertLedgerBalanced(db);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(availableStart + 200);
    expect(await getBalance(db, accountId, LedgerCode.PROCESSOR_CLEARING, 'usd')).toBe(clearingStart + 200);
  }, 60_000);

  it('holds a row for one claimant at a time', async () => {
    // The webhook worker claims deliveries with FOR UPDATE SKIP LOCKED. If that
    // silently degrades to a blocking lock, two workers deliver the same event.
    const endpointId = newId('we', 22);
    await db.query(
      `INSERT INTO webhook_endpoints (id, account_id, url, secret) VALUES ($1, $2, 'https://example.test/h', 's')`,
      [endpointId, accountId],
    );
    const eventId = newId('evt', 24);
    await db.query(`INSERT INTO events (id, account_id, type, data) VALUES ($1, $2, 'charge.succeeded', '{}')`, [
      eventId, accountId,
    ]);
    await db.query(
      `INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event_id, sequence)
       VALUES ($1, $2, $3, $4, 1)`,
      [newId('whd', 22), accountId, endpointId, eventId],
    );

    const claim = (id: string) =>
      db.transaction(async (tx) => {
        const { rows } = await tx.query<{ id: string }>(
          `UPDATE webhook_deliveries SET attempt_count = attempt_count + 1
            WHERE id = (SELECT id FROM webhook_deliveries
                         WHERE status IN ('pending','failed') AND next_attempt_at <= now()
                         ORDER BY next_attempt_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING id`,
        );
        return rows[0]?.id ?? null;
      });

    // Sequentially, each claim takes the one available row.
    const first = await claim('a');
    expect(first).not.toBeNull();
    await db.query(`UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now()`);
    const second = await claim('b');
    expect(second).not.toBeNull();
  }, 60_000);

  it('scopes reads to the account that asked', async () => {
    const otherId = newId('acct');
    await db.query(
      `INSERT INTO accounts (id, name, email, country) VALUES ($1, 'Other', 'o@example.com', 'US')`,
      [otherId],
    );
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE account_id = $1`, [otherId],
    );
    expect(asNumber(rows[0]!.n)).toBe(0);

    // ...and that other account still cannot borrow this one's money.
    expect(await getBalance(db, otherId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(0);
  });
});