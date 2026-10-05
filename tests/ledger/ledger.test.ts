import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb, type Db } from '../../src/db/index.js';
import { migrate } from '../../src/db/migrate.js';
import {
  postEntry, getBalance, getBalances, assertLedgerBalanced, asNumber,
  LedgerCode, type Posting,
} from '../../src/ledger/ledger.js';
import { newId } from '../../src/lib/ids.js';

let db: Db;
let accountId: string;

beforeEach(async () => {
  db = await createDb({ backend: 'pglite' });
  await migrate(db);
  accountId = newId('acct');
  await db.query(`INSERT INTO accounts (id, name, email, country) VALUES ($1, 'Test', 't@example.com', 'US')`, [
    accountId,
  ]);
});

afterEach(async () => {
  await db.close();
});

async function post(postings: Posting[], sourceType = 'test', sourceId?: string) {
  return db.transaction((tx) =>
    postEntry(tx, {
      accountId,
      currency: 'usd',
      sourceType,
      sourceId: sourceId ?? newId('src', 12),
      postings,
    }),
  );
}

async function legCount(target: Db, entryId: string): Promise<number> {
  const { rows } = await target.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ledger_legs WHERE entry_id = $1`, [entryId],
  );
  return asNumber(rows[0]!.n);
}

describe('ledger', () => {
  it('posts a balanced multi-leg entry and sums debits to credits', async () => {
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

  it('rejects an unbalanced entry in application code', async () => {
    await expect(
      post([
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 100 },
        { code: LedgerCode.PLATFORM_FEE_REVENUE, direction: 'credit', amount: 30 },
      ]),
    ).rejects.toThrow(/Unbalanced ledger entry/);

    // Nothing was written.
    expect(await getBalances(db, accountId)).toEqual([]);
  });

  it('rejects a non-positive or fractional leg amount', async () => {
    await expect(
      post([
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: 0 },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 0 },
      ]),
    ).rejects.toThrow(/positive integer/);

    await expect(
      post([
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: 10.5 },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 10.5 },
      ]),
    ).rejects.toThrow(/positive integer/);
  });

  it('refuses a single-leg entry', async () => {
    await expect(
      post([{ code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: 100 }]),
    ).rejects.toThrow(/at least two legs/);
  });

  it('nets the same account appearing on both sides into one leg', async () => {
    // Same account on both sides is legal. UNIQUE(entry_id, ledger_account_id)
    // allows one leg, so the two sides net to whichever direction is larger.
    const selfCancelling = await post([
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: 300 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: 200 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 500 },
    ]);

    // 500 debit against 500 credit nets to nothing, so no leg is written and
    // the account is untouched.
    expect(await legCount(db, selfCancelling.id)).toBe(0);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(0);

    // A non-zero net on a repeated account still yields exactly one leg.
    const partial = await post([
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: 100 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: 50 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 40 },
      { code: LedgerCode.PLATFORM_FEE_REVENUE, direction: 'credit', amount: 110 },
    ]);
    expect(await legCount(db, partial.id)).toBe(2);
    // 150 debit - 40 credit = 110 debit, which decreases a liability.
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(-110);
    await assertLedgerBalanced(db);
  });

  it('deduplicates by (account, source_type, source_id) so a replayed callback cannot double-post', async () => {
    const sourceId = newId('ch', 12);
    const first = await post([
      { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 500 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 500 },
    ], 'charge.captured', sourceId);

    // Same processor callback delivered twice.
    const second = await post([
      { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 500 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 500 },
    ], 'charge.captured', sourceId);

    expect(second.id).toBe(first.id);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(500);
    await assertLedgerBalanced(db);
  });

  it('keeps entries per-account even with an identical source_id', async () => {
    const otherAccount = newId('acct');
    await db.query(`INSERT INTO accounts (id, name, email, country) VALUES ($1, 'B', 'b@example.com', 'US')`, [
      otherAccount,
    ]);
    const sourceId = newId('ch', 12);
    const postings: Posting[] = [
      { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 100 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 100 },
    ];

    const a = await db.transaction((tx) => postEntry(tx, { accountId, currency: 'usd', sourceType: 'charge.captured', sourceId, postings }));
    const b = await db.transaction((tx) => postEntry(tx, { accountId: otherAccount, currency: 'usd', sourceType: 'charge.captured', sourceId, postings }));

    expect(a.id).not.toBe(b.id);
    expect(await getBalance(db, otherAccount, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(100);
  });

  it('keeps currencies separate so there is no cross-currency netting', async () => {
    await db.transaction((tx) => postEntry(tx, {
      accountId, currency: 'usd', sourceType: 'charge.captured', sourceId: newId('ch'),
      postings: [
        { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 100 },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 100 },
      ],
    }));
    await db.transaction((tx) => postEntry(tx, {
      accountId, currency: 'jpy', sourceType: 'charge.captured', sourceId: newId('ch'),
      postings: [
        { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 5000 },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 5000 },
      ],
    }));

    const balances = await getBalances(db, accountId);
    expect(balances).toHaveLength(4);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(100);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'jpy')).toBe(5000);
    await assertLedgerBalanced(db);
  });

  it('holds the zero-sum invariant at the database level, not just in app code', async () => {
    // Go around postEntry entirely and try to write an unbalanced entry.
    const entryId = newId('le', 22);
    await db.query(
      `INSERT INTO ledger_entries (id, account_id, source_type, source_id) VALUES ($1, $2, 'raw', 'raw-src')`,
      [entryId, accountId],
    );
    const accs = await db.query<{ id: string }>(
      `INSERT INTO ledger_accounts (id, account_id, code, type, currency)
       VALUES ($1, $2, 'raw_a', 'asset', 'usd'), ($3, $2, 'raw_b', 'liability', 'usd')
       RETURNING id`,
      [newId('la'), accountId, newId('la')],
    );

    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ledger_legs (entry_id, ledger_account_id, amount, direction) VALUES ($1, $2, 100, 'debit')`,
          [entryId, accs.rows[0]!.id],
        );
        await tx.query(
          `INSERT INTO ledger_legs (entry_id, ledger_account_id, amount, direction) VALUES ($1, $2, 40, 'credit')`,
          [entryId, accs.rows[1]!.id],
        );
      }),
    ).rejects.toThrow(/unbalanced ledger entry/i);
  });

  it('refuses UPDATE and DELETE on entries and legs', async () => {
    const entry = await post([
      { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 100 },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 100 },
    ]);

    await expect(db.query(`UPDATE ledger_entries SET memo = 'tampered' WHERE id = $1`, [entry.id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM ledger_entries WHERE id = $1`, [entry.id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE ledger_legs SET amount = 999 WHERE entry_id = $1`, [entry.id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM ledger_legs WHERE entry_id = $1`, [entry.id]))
      .rejects.toThrow(/append-only/);
  });

  it('reproduces a balance by replaying every entry from genesis', async () => {
    // A short ledger history, then reconstruct the balance from legs alone.
    for (const amount of [100, 250, 75]) {
      await post([
        { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: amount - 3 },
        { code: LedgerCode.PLATFORM_FEE_REVENUE, direction: 'credit', amount: 3 },
      ]);
    }

    const { rows } = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0)::text AS balance
         FROM ledger_legs
         JOIN ledger_accounts la ON la.id = ledger_legs.ledger_account_id
        WHERE la.account_id = $1 AND la.code = 'merchant_available'`,
      [accountId],
    );
    // 97 + 247 + 72 = 416 net to the merchant; 3 fees x 3 charges = 9 revenue.
    expect(asNumber(rows[0]!.balance)).toBe(416);
    expect(await getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(416);
    expect(await getBalance(db, accountId, LedgerCode.PLATFORM_FEE_REVENUE, 'usd')).toBe(9);
    await assertLedgerBalanced(db);
  });

  it('records business time separately from system time', async () => {
    // A late-arriving processor event backdates effective_at but recorded_at
    // is when we actually learned about it.
    const effectiveAt = new Date('2026-01-15T00:00:00Z');
    const entry = await db.transaction((tx) => postEntry(tx, {
      accountId, currency: 'usd', sourceType: 'charge.captured', sourceId: newId('ch'),
      effectiveAt, memo: 'late settlement',
      postings: [
        { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount: 100 },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: 100 },
      ],
    }));

    const { rows } = await db.query<{ effective_at: Date; recorded_at: Date }>(
      `SELECT effective_at, recorded_at FROM ledger_entries WHERE id = $1`, [entry.id],
    );
    expect(rows[0]!.effective_at.toISOString()).toBe(effectiveAt.toISOString());
    expect(rows[0]!.recorded_at.getTime()).toBeGreaterThan(effectiveAt.getTime());
  });
});
