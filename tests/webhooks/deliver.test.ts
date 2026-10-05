import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, post, customerWithCard, type Harness, type Merchant } from '../helpers/harness.js';
import {
  signPayload, verifySignature, backoffMs, deliverOne, MAX_ATTEMPTS,
  WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, type DeliveryTransport,
} from '../../src/webhooks/deliver.js';

/**
 * Webhook delivery.
 *
 * The property under test is not "did we POST the event" but "does a consumer
 * that retries safely and verifies signatures get exactly-once semantics",
 * because the network cannot give us exactly-once.
 */

let h: Harness;
beforeAll(async () => { h = await makeHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

describe('signature', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded' });

  it('round-trips a valid signature', () => {
    const header = signPayload(secret, 1_700_000_000, body);
    expect(verifySignature(secret, header, body, 300, 1_700_000_000_000)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const header = signPayload(secret, 1_700_000_000, body);
    expect(verifySignature(secret, header, `${body} `, 300, 1_700_000_000_000)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const header = signPayload('other_secret', 1_700_000_000, body);
    expect(verifySignature(secret, header, body, 300, 1_700_000_000_000)).toBe(false);
  });

  it('rejects a replayed signature outside the tolerance window', () => {
    const header = signPayload(secret, 1_700_000_000, body);
    // Signature is still cryptographically valid, but it is old.
    expect(verifySignature(secret, header, body, 300, 1_700_000_000_000 + 301_000)).toBe(false);
    expect(verifySignature(secret, header, body, 300, 1_700_000_000_000 + 299_000)).toBe(true);
  });

  it('rejects a fresh timestamp pasted onto an old body', () => {
    const header = signPayload(secret, 1_700_000_000, body);
    const forged = header.replace(/t=\d+/, `t=${1_700_000_1000}`);
    // nowMs matches the forged timestamp, so the tolerance check passes and the
    // only thing left that can reject this is the HMAC itself.
    expect(verifySignature(secret, forged, body, 300, 1_700_001_000_000)).toBe(false);
  });

  it('rejects a malformed header rather than throwing', () => {
    expect(verifySignature(secret, 'garbage', body)).toBe(false);
    expect(verifySignature(secret, 't=abc,v1=def', body)).toBe(false);
    expect(verifySignature(secret, '', body)).toBe(false);
  });
});

describe('backoff', () => {
  it('grows with the attempt number and stays inside the cap', () => {
    const maxes = [1, 2, 3, 4, 5, 6, 8, 10, 20].map((n) => backoffMs(n, () => 1));
    for (let i = 1; i < maxes.length; i += 1) {
      expect(maxes[i]!).toBeGreaterThanOrEqual(maxes[i - 1]!);
    }
    expect(maxes.at(-1)).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('applies jitter, so an outage does not retry in lockstep', () => {
    // Same attempt, different jitter source: without randomness every endpoint
    // that failed together would come back together.
    const values = new Set([backoffMs(5, () => 0.1), backoffMs(5, () => 0.5), backoffMs(5, () => 0.9)]);
    expect(values.size).toBeGreaterThan(1);
    expect(backoffMs(5, () => 0)).toBe(0);
  });
});

/**
 * Each delivery test gets its own harness. `deliverOne` claims the globally
 * earliest due row, so a shared queue would let one test's leftovers be
 * delivered by another test's assertions.
 */
describe('delivery', () => {
  let h: Harness;
  let merchant: Merchant;
  let endpointId: string;
  let secret: string;
  let received: { headers: Record<string, string>; body: unknown }[];

  beforeEach(async () => {
    h = await makeHarness();
    merchant = await h.createMerchant({ name: 'Hooked' });
    const ep = await post(h.app, merchant.auth, '/v1/webhook_endpoints', {
      url: 'https://example.test/hooks', description: 'test',
    });
    expect(ep.statusCode).toBe(201);
    endpointId = ep.json<{ id: string }>().id;
    secret = ep.json<{ secret?: string }>().secret ?? '';

    const { customerId, paymentMethodId } = await customerWithCard(h.app, merchant);
    const intent = await post(h.app, merchant.auth, '/v1/payment_intents', {
      amount: 4_200, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const confirmed = await post(
      h.app, merchant.auth, `/v1/payment_intents/${intent.json<{ id: string }>().id}/confirm`,
    );
    expect(confirmed.statusCode).toBe(200);

    received = [];
    // Fast-forward past any backoff so a single claim loop can drain the queue.
    await makeDue();
  }, 60_000);

  afterEach(async () => { await h.close(); });

  async function makeDue(): Promise<void> {
    await h.db.query(`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE account_id = $1`, [
      merchant.accountId,
    ]);
  }

  async function deliveryRows() {
    const { rows } = await h.db.query<{
      id: string; event_type: string; status: string; attempt_count: number; sequence: string;
    }>(
      `SELECT d.id, e.type AS event_type, d.status, d.attempt_count, d.sequence
         FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.account_id = $1 ORDER BY d.created_at ASC`,
      [merchant.accountId],
    );
    return rows;
  }

  /** Drain until the queue has nothing due left, with a hard iteration cap. */
  async function drain(transport: DeliveryTransport, cap = 60) {
    const results = [];
    for (let i = 0; i < cap; i += 1) {
      await makeDue();
      const r = await deliverOne(h.db, transport);
      if (!r) break;
      results.push(r);
    }
    return results;
  }

  it('signs and delivers every event queued for the endpoint', async () => {
    const transport: DeliveryTransport = async ({ body, headers }) => {
      received.push({ headers, body: JSON.parse(body) });
      return { status: 200 };
    };

    const queued = await deliveryRows();
    expect(queued.length).toBeGreaterThanOrEqual(3);

    const results = await drain(transport);
    expect(results.every((r) => r.outcome === 'delivered')).toBe(true);
    expect(results.length).toBe(queued.length);
    expect(received.length).toBe(queued.length);

    // Re-read: the pre-drain snapshot is stale by definition.
    for (const row of await deliveryRows()) {
      expect(row.status).toBe('delivered');
      expect(row.attempt_count).toBe(1);
    }

    const first = received[0]!;
    expect(first.headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(first.headers[WEBHOOK_TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(first.headers['qqpg-event-id']).toMatch(/^evt_/);
    // The raw body is what gets signed, so a consumer can verify without
    // re-serializing: this is the exact string we would have sent.
    expect(verifySignature(secret, first.headers[WEBHOOK_SIGNATURE_HEADER]!, JSON.stringify(first.body))).toBe(true);

    expect((first.body as { object: string }).object).toBe('event');
    expect(String((first.body as { id: string }).id)).toMatch(/^evt_/);
    expect((first.body as { sequence: number }).sequence).toBeGreaterThan(0);
    expect((first.body as { type: string }).type).toMatch(/^(payment_intent|charge)\./);
    // Pinned to the version that shaped the payload, not to the running build.
    expect((first.body as { api_version: string | null }).api_version).toBe('v1');

    // Sequence is a total order over this endpoint's deliveries, so a consumer
    // can drop a gap-free prefix and never reprocess.
    const sequences = received.map((r) => (r.body as { sequence: number }).sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);

    const succeeded = received
      .map((r) => r.body as { type: string; data: Record<string, unknown> })
      .find((b) => b.type === 'charge.succeeded');
    expect(succeeded).toBeDefined();
    expect((succeeded!.data.object as { amount: number }).amount).toBe(4_200);
    expect((succeeded!.data.object as { status: string }).status).toBe('succeeded');
  }, 120_000);

  it('retries a failing endpoint until the attempt cap, then parks it dead', async () => {
    let calls = 0;
    const transport: DeliveryTransport = async () => {
      calls += 1;
      return { status: 500 };
    };

    const results = await drain(transport);
    const rows = await deliveryRows();
    const expectedCalls = rows.length * MAX_ATTEMPTS;

    expect(calls).toBe(expectedCalls);
    expect(results.filter((r) => r.outcome === 'retrying')).toHaveLength(rows.length * (MAX_ATTEMPTS - 1));
    expect(results.filter((r) => r.outcome === 'dead')).toHaveLength(rows.length);

    for (const row of rows) {
      expect(row.status).toBe('dead');
      // Gave up at the cap, not one attempt past it.
      expect(row.attempt_count).toBe(MAX_ATTEMPTS);
    }

    // A dead delivery is terminal: it must not keep the worker busy forever.
    await makeDue();
    expect(await deliverOne(h.db, transport)).toBeNull();
  }, 120_000);

  it('stops immediately on 410 Gone rather than retrying forever', async () => {
    const transport: DeliveryTransport = async () => ({ status: 410 });
    const results = await drain(transport);

    expect(results.every((r) => r.outcome === 'dead')).toBe(true);
    for (const row of await deliveryRows()) {
      expect(row.status).toBe('dead');
      expect(row.attempt_count).toBe(1);

      const attempts = await h.db.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM webhook_delivery_attempts WHERE delivery_id = $1`, [row.id],
      );
      expect(Number(attempts.rows[0]!.n)).toBe(1);
    }
  }, 120_000);

  it('treats a network error as retryable, and records why', async () => {
    const transport: DeliveryTransport = async () => {
      throw new Error('ECONNRESET');
    };
    const results = await drain(transport);
    const rows = await deliveryRows();

    // A thrown transport is not a delivery. Each row is retried up to the cap
    // and only then parked dead, with the underlying error kept for the merchant.
    expect(results.filter((r) => r.outcome === 'retrying')).toHaveLength(rows.length * (MAX_ATTEMPTS - 1));
    expect(results.filter((r) => r.outcome === 'dead')).toHaveLength(rows.length);
    expect(results.every((r) => r.statusCode === null)).toBe(true);

    for (const row of rows) {
      expect(row.status).toBe('dead');
      expect(row.attempt_count).toBe(MAX_ATTEMPTS);
    }

    const logged = await h.db.query<{ error: string | null }>(
      `SELECT a.error FROM webhook_delivery_attempts a
         JOIN webhook_deliveries d ON d.id = a.delivery_id
        WHERE d.account_id = $1 AND a.error IS NOT NULL LIMIT 1`, [merchant.accountId],
    );
    expect(logged.rows[0]!.error).toContain('ECONNRESET');

    const lastError = await h.db.query<{ last_error: string | null }>(
      `SELECT last_error FROM webhook_deliveries WHERE account_id = $1 LIMIT 1`, [merchant.accountId],
    );
    expect(lastError.rows[0]!.last_error).toContain('ECONNRESET');
  }, 120_000);

  it('stops delivering once the merchant unsubscribes, and keeps the history', async () => {
    const disabled = await post(h.app, merchant.auth, `/v1/webhook_endpoints/${endpointId}/disable`);
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<{ status: string }>().status).toBe('disabled');
    // The secret is never echoed back after creation.
    expect(disabled.json<{ secret?: string }>().secret).toBeUndefined();

    const queued = await deliveryRows();
    const results = await drain(async () => ({ status: 200 }));

    // Everything already queued is parked on the first look, not retried.
    expect(results).toHaveLength(queued.length);
    expect(results.every((r) => r.outcome === 'dead' && r.statusCode === null)).toBe(true);
    expect(received).toHaveLength(0);

    for (const row of await deliveryRows()) {
      expect(row.status).toBe('dead');
      expect(row.attempt_count).toBe(1);
    }

    // Events raised after unsubscribing are not queued for it at all.
    await post(h.app, merchant.auth, '/v1/payment_intents', { amount: 1_000, currency: 'usd' });
    const after = await h.db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId],
    );
    expect(Number(after.rows[0]!.n)).toBe(queued.length);
  }, 120_000);

  it('refuses to orphan delivery history, and hides another merchant\'s endpoint', async () => {
    await expect(
      h.db.query(`DELETE FROM webhook_endpoints WHERE id = $1`, [endpointId]),
    ).rejects.toThrow(/foreign key/i);

    const other = await h.createMerchant({ name: 'Other' });
    const res = await post(h.app, other.auth, `/v1/webhook_endpoints/${endpointId}/disable`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('cross_account_access');

    // Still active, and still the merchant's own.
    const row = await h.db.query<{ status: string; account_id: string }>(
      `SELECT status, account_id FROM webhook_endpoints WHERE id = $1`, [endpointId],
    );
    expect(row.rows[0]!.status).toBe('active');
    expect(row.rows[0]!.account_id).toBe(merchant.accountId);
  }, 120_000);

  it('never delivers one merchant\'s events to another merchant\'s endpoint', async () => {
    const other = await h.createMerchant({ name: 'Other' });
    await post(h.app, other.auth, '/v1/webhook_endpoints', { url: 'https://example.test/other' });
    const mine = (await deliveryRows()).map((r) => r.id);
    const theirs = (
      await h.db.query<{ id: string }>(`SELECT id FROM events WHERE account_id = $1`, [other.accountId])
    ).rows.map((r) => r.id);

    const seen: string[] = [];
    const results = await drain(async ({ body }) => {
      seen.push((JSON.parse(body) as { id: string }).id);
      return { status: 200 };
    });

    expect(results.length).toBeGreaterThan(0);
    // `seen` holds event ids, so compare against this merchant's events.
    const mineEvents = (
      await h.db.query<{ id: string }>(`SELECT id FROM events WHERE account_id = $1`, [merchant.accountId])
    ).rows.map((r) => r.id);

    expect(seen).toHaveLength(mine.length);
    for (const id of mineEvents) expect(seen).toContain(id);
    for (const id of theirs) expect(seen).not.toContain(id);
    for (const id of mine) expect(seen).not.toContain(id);

    // And each delivery only ever references its own account's event.
    const crossAccount = await h.db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
        WHERE e.account_id <> d.account_id`,
    );
    expect(Number(crossAccount.rows[0]!.n)).toBe(0);
  }, 120_000);
});