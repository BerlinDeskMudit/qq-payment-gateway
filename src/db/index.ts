import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';

/**
 * One query interface, two backends.
 *
 * `pglite` is real Postgres compiled to WASM, running in-process. Used for
 * tests and local development so the SQL under test is the SQL we deploy.
 * `pg` is a connection-pooled Postgres for production.
 *
 * The schema deliberately uses only portable Postgres features (deferred
 * constraint triggers, plpgsql, jsonb, partial indexes) so the two backends
 * are behaviourally identical for our purposes.
 */

export type QueryResult<T> = {
  rows: T[];
  rowCount: number;
};

export interface Db {
  readonly kind: 'pglite' | 'pg';
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  /**
   * Raw multi-statement SQL, no parameters. Only for DDL and migrations.
   * `query` goes over the extended protocol and cannot take several commands
   * in one round trip, which is why migrations use this instead.
   */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * PGlite reports `affectedRows`, which is 0 for a SELECT even when it returned
 * rows. node-postgres reports the row count for SELECT. Normalising here keeps
 * `rowCount` meaningful across both backends, so callers can use `rowCount`
 * for existence checks without silently getting "false" on PGlite.
 */
function normalizeRowCount<T>(
  res: { rows: T[]; affectedRows?: number | null },
  sql: string,
): number {
  const verb = sql.trimStart().split(/\s+/)[0]?.toUpperCase() ?? '';
  const returnsRows = verb === 'SELECT' || verb === 'WITH' || verb === 'SHOW' || verb === 'VALUES';
  if (returnsRows) return res.rows.length;
  return res.affectedRows ?? 0;
}

class PGliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(private readonly pg: PGlite) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query<T>(sql, params as unknown[]);
    return { rows: res.rows, rowCount: normalizeRowCount(res, sql) };
  }

  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // PGlite hands back a transaction handle that satisfies the same query
    // API but not the PGlite class (no waitReady, no debug, ...), so it goes
    // through `unknown` before being re-wrapped.
    return this.pg.transaction(async (tx) => {
      return fn(new PGliteTxDb(this.pg, tx as unknown as PGlite));
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

/** Wraps a PGlite transaction handle so callbacks never see the full Db. */
class PGliteTxDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(
    private readonly root: PGlite,
    private readonly tx: PGlite,
  ) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.tx.query<T>(sql, params as unknown[]);
    return { rows: res.rows, rowCount: normalizeRowCount(res, sql) };
  }

  async exec(sql: string): Promise<void> {
    await this.tx.exec(sql);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Nested transaction: Postgres has no true nesting, so reuse the handle.
    return fn(this) as Promise<T>;
  }

  async close(): Promise<void> {
    // A transaction handle cannot close the database.
    void this.root;
  }
}

class PgDb implements Db {
  readonly kind = 'pg' as const;
  constructor(private readonly pool: Pool) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    const tx = new PgTxDb(client);
    try {
      await client.query('BEGIN');
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgTxDb implements Db {
  readonly kind = 'pg' as const;
  constructor(private readonly client: PoolClient) {}

  async query<T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.client.query(sql, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return fn(this) as Promise<T>;
  }

  async close(): Promise<void> {
    // A transaction handle does not own the pool.
  }
}

export type DbOptions =
  | { backend: 'pglite'; dataDir?: string }
  | { backend: 'pg'; connectionString: string; max?: number };

export async function createDb(opts: DbOptions): Promise<Db> {
  if (opts.backend === 'pglite') {
    const pg = opts.dataDir ? new PGlite(opts.dataDir) : new PGlite();
    await pg.waitReady;
    return new PGliteDb(pg);
  }
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    // Money never silently rounds. Numeric/bigint come back as strings from
    // node-postgres by default; we parse explicitly in the ledger layer.
    options: '-c timezone=UTC',
  });
  return new PgDb(pool);
}

export function createDbFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<Db> {
  const url = env.DATABASE_URL;
  if (url && url !== '') return createDb({ backend: 'pg', connectionString: url });
  return createDb({ backend: 'pglite', dataDir: env.PGLITE_DATA_DIR });
}
