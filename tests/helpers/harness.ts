import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createDb } from '../../src/db/index.js';
import { migrate } from '../../src/db/migrate.js';
import { ProcessorRegistry, SandboxProcessor } from '../../src/processors/index.js';
import { createApiKey } from '../../src/auth/apiKey.js';
import { newId } from '../../src/lib/ids.js';

/**
 * Test harness.
 *
 * Real Postgres via PGlite, the real app, the real SQL. The only thing faked
 * is the outbound network, because a test that talks to a payment network is
 * not a test.
 */

export type Merchant = {
  accountId: string;
  apiKey: string;
  auth: string;
};

export type Harness = {
  db: Awaited<ReturnType<typeof createDb>>;
  app: FastifyInstance;
  registry: ProcessorRegistry;
  /** Creates a merchant with an owner key, ready to make requests. */
  createMerchant(opts?: { name?: string; livemode?: boolean }): Promise<Merchant>;
  close(): Promise<void>;
};

export async function makeHarness(): Promise<Harness> {
  const db = await createDb({ backend: 'pglite' });
  await migrate(db);

  const registry = new ProcessorRegistry();
  registry.register(new SandboxProcessor());

  const app = await buildApp({ db, registry, apiVersion: 'test' });

  const createMerchant = async (opts: { name?: string; livemode?: boolean } = {}): Promise<Merchant> => {
    const accountId = newId('acct', 22);
    await db.query(
      `INSERT INTO accounts (id, name, email, country, region, livemode)
       VALUES ($1, $2, $3, 'US', 'us', $4)`,
      [accountId, opts.name ?? 'Test Merchant', `${accountId}@test.local`, opts.livemode ?? false],
    );
    const key = await createApiKey(db, { accountId, role: 'owner', livemode: opts.livemode ?? false });
    return { accountId, apiKey: key.rawKey, auth: `Bearer ${key.rawKey}` };
  };

  return {
    db,
    app,
    registry,
    createMerchant,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

let keyCounter = 0;

/** Unique per call, because idempotency keys are per account and per test. */
export function idemKey(label = 'test'): string {
  keyCounter += 1;
  return `${label}_${Date.now().toString(36)}_${keyCounter}`;
}

export type Json = Record<string, unknown>;

/** Convenience: POST with auth and an idempotency key. */
export function post(
  app: FastifyInstance,
  auth: string,
  url: string,
  payload: Json = {},
  key = idemKey(),
) {
  return app.inject({
    method: 'POST',
    url,
    headers: { authorization: auth, 'idempotency-key': key, 'content-type': 'application/json' },
    payload,
  });
}

export function get(app: FastifyInstance, auth: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: auth } });
}

/** Creates a customer plus a sandbox payment method, returning both ids. */
export async function customerWithCard(
  app: FastifyInstance,
  merchant: Merchant,
  card = '4242424242424242',
): Promise<{ customerId: string; paymentMethodId: string }> {
  const customer = await post(app, merchant.auth, '/v1/customers', { email: 'buyer@test.local' });
  const customerId = customer.json<{ id: string }>().id;

  const pm = await post(app, merchant.auth, '/v1/payment_methods', {
    customer: customerId,
    test_card: card,
  });
  return { customerId, paymentMethodId: pm.json<{ id: string }>().id };
}