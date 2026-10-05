import { describe, it, expect } from 'vitest';
import { createDb, type Db } from '../../src/db/index.js';
import { migrate } from '../../src/db/migrate.js';

async function freshDb(): Promise<Db> {
  const db = await createDb({ backend: 'pglite' });
  await migrate(db);
  return db;
}

describe('schema', () => {
  it('applies cleanly', async () => {
    const db = await freshDb();
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const expected of [
      'accounts', 'customers', 'api_keys', 'payment_methods', 'payment_intents',
      'payment_attempts', 'charges', 'refunds', 'events',
      'webhook_endpoints', 'webhook_deliveries', 'webhook_delivery_attempts',
      'idempotency_keys', 'ledger_accounts', 'ledger_entries',
      'ledger_legs', 'ledger_snapshots',
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected);
    }
    await db.close();
  });

  it('is idempotent', async () => {
    const db = await freshDb();
    const second = await migrate(db);
    expect(second).toEqual([]);
    await db.close();
  });
});
