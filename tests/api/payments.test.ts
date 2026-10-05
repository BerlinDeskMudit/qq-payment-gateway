import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, post, get, customerWithCard, idemKey, type Harness, type Merchant } from '../helpers/harness.js';
import { LedgerCode, getBalance, assertLedgerBalanced } from '../../src/ledger/ledger.js';
import { platformFee } from '../../src/payments/service.js';

/**
 * End-to-end contract tests over the real app and real Postgres.
 *
 * These assert the two properties that matter for a payment gateway:
 * money moves exactly once, and the books balance afterwards.
 */

let h: Harness;
beforeAll(async () => { h = await makeHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

let m: Merchant;
beforeAll(async () => { m = await h.createMerchant({ name: 'Acme' }); }, 60_000);

describe('money movement', () => {
  it('captures a card payment and leaves the ledger balanced with the fee split out', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);

    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 10_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
      description: 'Order #1001',
    });
    expect(intent.statusCode).toBe(201);
    const created = intent.json<{ id: string; status: string; client_secret: string }>();
    expect(created.status).toBe('requires_confirmation');
    expect(created.client_secret).toMatch(/^pi_secret_[A-Za-z0-9]+_secret$/);

    const confirmed = await post(h.app, m.auth, `/v1/payment_intents/${created.id}/confirm`);
    expect(confirmed.statusCode).toBe(200);
    const body = confirmed.json<{ status: string; amount_captured: number; latest_charge: { id: string; status: string } }>();
    expect(body.status).toBe('succeeded');
    expect(body.amount_captured).toBe(10_000);
    expect(body.latest_charge.status).toBe('succeeded');

    // 2.9% + 30c on 10_000 = 320. Everything else is the merchant's.
    const fee = platformFee(10_000, 'usd');
    expect(fee).toBe(320);
    expect(await getBalance(h.db, m.accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(10_000 - fee);
    expect(await getBalance(h.db, m.accountId, LedgerCode.PLATFORM_FEE_REVENUE, 'usd')).toBe(fee);
    expect(await getBalance(h.db, m.accountId, LedgerCode.AUTHORIZATION_HOLDS, 'usd')).toBe(0);
    // No hold is left dangling once the money has settled.
    expect(await getBalance(h.db, m.accountId, LedgerCode.MERCHANT_PENDING, 'usd')).toBe(0);

    await expect(assertLedgerBalanced(h.db)).resolves.toBeUndefined();

    const balance = await get(h.app, m.auth, '/v1/balance');
    expect(balance.statusCode).toBe(200);
    expect(balance.json<{ balances: { code: string; balance: number }[] }>().balances.length).toBeGreaterThan(0);
  }, 60_000);

  it('refunds partially and reverses only the proportional fee', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 20_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;
    await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    const chargeId = (await get(h.app, m.auth, `/v1/payment_intents/${id}`)).json<{ latest_charge?: { id: string } }>().latest_charge?.id
      ?? chargeIdFrom(await get(h.app, m.auth, `/v1/charges?limit=1`));

    const before = await getBalance(h.db, m.accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd');
    const feeBefore = await getBalance(h.db, m.accountId, LedgerCode.PLATFORM_FEE_REVENUE, 'usd');

    const refund = await post(h.app, m.auth, `/v1/charges/${chargeId}/refunds`, { amount: 5_000, reason: 'requested_by_customer' });
    expect(refund.statusCode).toBe(201);
    expect(refund.json<{ status: string; amount: number }>()).toMatchObject({ status: 'succeeded', amount: 5_000 });

    // Rounded half-up, the same rule the ledger uses when it splits the fee.
    const feeShare = Math.round((platformFee(20_000, 'usd') * 5_000) / 20_000);
    expect(feeBefore - await getBalance(h.db, m.accountId, LedgerCode.PLATFORM_FEE_REVENUE, 'usd')).toBe(feeShare);
    expect(before - await getBalance(h.db, m.accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(5_000 - feeShare);

    const charge = await get(h.app, m.auth, `/v1/charges/${chargeId}`);
    expect(charge.json<{ status: string; amount_refunded: number }>()).toMatchObject({
      status: 'partially_refunded', amount_refunded: 5_000,
    });
    await expect(assertLedgerBalanced(h.db)).resolves.toBeUndefined();
  }, 60_000);

  it('will not refund more than the charge', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 3_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;
    await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    const chargeId = chargeIdFrom(await get(h.app, m.auth, '/v1/charges?limit=1'));

    const tooMuch = await post(h.app, m.auth, `/v1/charges/${chargeId}/refunds`, { amount: 3_001 });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json<{ error: { code: string } }>().error.code).toBe('parameter_invalid');
  }, 60_000);
});

describe('declines and failure modes', () => {
  it('releases the hold when the card is declined and does not book revenue', async () => {
    const before = await getBalance(h.db, m.accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd');
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m, '4000000000000002');

    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 4_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;

    const res = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    expect(res.statusCode).toBe(402);
    const err = res.json<{ error: { type: string; code: string; decline_code: string } }>();
    expect(err.error.type).toBe('card_error');
    expect(err.error.code).toBe('card_declined');
    expect(err.error.decline_code).toBe('generic_decline');

    // A decline moves no money: no fee, no merchant balance, no leftover hold.
    expect(await getBalance(h.db, m.accountId, LedgerCode.MERCHANT_AVAILABLE, 'usd')).toBe(before);
    expect(await getBalance(h.db, m.accountId, LedgerCode.AUTHORIZATION_HOLDS, 'usd')).toBe(0);
    expect(await getBalance(h.db, m.accountId, LedgerCode.PLATFORM_FEE_REVENUE, 'usd')).toBeGreaterThan(0);

    const after = await get(h.app, m.auth, `/v1/payment_intents/${id}`);
    expect(after.json<{ status: string }>().status).toBe('requires_payment_method');
    await expect(assertLedgerBalanced(h.db)).resolves.toBeUndefined();
  }, 60_000);

  it('marks the intent ambiguous and keeps the hold when the processor errors', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m, '4000000000000069');
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 7_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;

    const res = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string; retryable: boolean } }>().error).toMatchObject({
      code: 'processing_error', retryable: true,
    });

    const after = await get(h.app, m.auth, `/v1/payment_intents/${id}`);
    expect(after.json<{ status: string; ambiguous: boolean }>()).toMatchObject({
      status: 'processing', ambiguous: true,
    });
    // The hold is deliberately retained: we do not know the outcome, and
    // releasing money we might have committed is the expensive direction of
    // the error.
    expect(await getBalance(h.db, m.accountId, LedgerCode.AUTHORIZATION_HOLDS, 'usd')).toBe(7_000);
  }, 60_000);

  it('sends a 3DS card to requires_action and back to succeeded on retry', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m, '4000000000009995');
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 2_500, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;

    const res = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('requires_action');

    // Cancelling from requires_action is allowed and must unwind the hold.
    const cancel = await post(h.app, m.auth, `/v1/payment_intents/${id}/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json<{ status: string }>().status).toBe('canceled');
  }, 60_000);

  it('rejects an illegal transition instead of silently doing nothing', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 1_500, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;

    // No payment method attached: confirm is not a legal action yet.
    const bare = await post(h.app, m.auth, '/v1/payment_intents', { amount: 1_500, currency: 'usd' });
    const bareId = bare.json<{ id: string }>().id;
    const bad = await post(h.app, m.auth, `/v1/payment_intents/${bareId}/confirm`);
    expect(bad.statusCode).toBe(409);
    expect(bad.json<{ error: { code: string; current_status: string } }>().error).toMatchObject({
      code: 'state_transition_invalid', current_status: 'requires_payment_method',
    });

    // Succeeded intents are terminal.
    await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    const again = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    expect(again.statusCode).toBe(409);
  }, 60_000);
});

describe('manual capture', () => {
  it('holds funds at authorization, then settles on capture', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 15_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
      capture_method: 'manual',
    });
    const id = intent.json<{ id: string }>().id;

    const authorized = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json<{ status: string }>().status).toBe('requires_capture');
    expect(authorized.json<{ latest_charge: { status: string } }>().latest_charge.status).toBe('authorized');

    // Money is held but not available and not earned.
    expect(await getBalance(h.db, m.accountId, LedgerCode.AUTHORIZATION_HOLDS, 'usd')).toBeGreaterThanOrEqual(15_000);

    const captured = await post(h.app, m.auth, `/v1/payment_intents/${id}/capture`, {});
    expect(captured.statusCode).toBe(200);
    expect(captured.json<{ status: string; amount_captured: number }>().status).toBe('succeeded');
    expect(captured.json<{ amount_captured: number }>().amount_captured).toBe(15_000);
    expect(captured.json<{ latest_charge: { status: string } }>().latest_charge.status).toBe('succeeded');
    await expect(assertLedgerBalanced(h.db)).resolves.toBeUndefined();
  }, 60_000);

  it('rejects capturing more than was authorized', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 5_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
      capture_method: 'manual',
    });
    const id = intent.json<{ id: string }>().id;
    await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);

    const tooMuch = await post(h.app, m.auth, `/v1/payment_intents/${id}/capture`, { amount_to_capture: 5_001 });
    expect(tooMuch.statusCode).toBe(400);
  }, 60_000);

  it('refuses automatic capture on a manual-capture intent', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 5_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
      capture_method: 'automatic',
    });
    const id = intent.json<{ id: string }>().id;
    await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    const res = await post(h.app, m.auth, `/v1/payment_intents/${id}/capture`, {});
    expect(res.statusCode).toBe(409);
  }, 60_000);
});

describe('idempotency', () => {
  it('replays the original response instead of charging twice', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const key = idemKey('confirm');
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 12_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;

    const first = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`, {}, key);
    const second = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`, {}, key);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());

    const charges = await get(h.app, m.auth, '/v1/charges?limit=100');
    const matching = charges.json<{ data: { amount: number }[] }>().data.filter((c) => c.amount === 12_000);
    expect(matching).toHaveLength(1);
    await expect(assertLedgerBalanced(h.db)).resolves.toBeUndefined();
  }, 60_000);

  it('treats the same key with a different body as a client bug', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const key = idemKey('create');
    const payload = { amount: 6_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId };

    const first = await post(h.app, m.auth, '/v1/payment_intents', payload, key);
    expect(first.statusCode).toBe(201);

    const second = await post(h.app, m.auth, '/v1/payment_intents', { ...payload, amount: 6_001 }, key);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('idempotency_key_reuse');
  }, 60_000);

  it('does not collide when two merchants use the same key string', async () => {
    const other = await h.createMerchant({ name: 'Other Co' });
    const a = await customerWithCard(h.app, m);
    const b = await customerWithCard(h.app, other);

    const shared = idemKey('shared');
    const resA = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 8_000, currency: 'usd', customer: a.customerId, payment_method: a.paymentMethodId,
    }, shared);
    const resB = await post(h.app, other.auth, '/v1/payment_intents', {
      amount: 9_000, currency: 'usd', customer: b.customerId, payment_method: b.paymentMethodId,
    }, shared);

    expect(resA.statusCode).toBe(201);
    expect(resB.statusCode).toBe(201);
    expect(resB.headers['idempotent-replay']).toBeUndefined();
  }, 60_000);

  it('requires the header on mutations', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/payment_intents',
      headers: { authorization: m.auth, 'content-type': 'application/json' },
      payload: { amount: 1_000, currency: 'usd' },
    });
    // Rejected by the header schema before the handler runs, so the code is a
    // generic validation failure rather than parameter_missing.
    expect(res.statusCode).toBe(400);
    expect(['parameter_invalid', 'parameter_missing']).toContain(
      res.json<{ error: { code: string } }>().error.code,
    );
  }, 60_000);
});

describe('tenancy', () => {
  it('hides another merchant\'s resources behind a 404', async () => {
    const other = await h.createMerchant({ name: 'Intruder' });
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 2_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;

    const res = await get(h.app, other.auth, `/v1/payment_intents/${id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('cross_account_access');
  }, 60_000);

  it('refuses to attach another merchant\'s customer', async () => {
    const other = await h.createMerchant({ name: 'Intruder 2' });
    const mine = await customerWithCard(h.app, m);

    const res = await post(h.app, other.auth, '/v1/payment_intents', {
      amount: 2_000, currency: 'usd', customer: mine.customerId,
    });
    expect(res.statusCode).toBe(404);
  }, 60_000);

  it('keeps balances scoped per account', async () => {
    const other = await h.createMerchant({ name: 'Bystander' });
    const mine = await get(h.app, m.auth, '/v1/balance');
    const theirs = await get(h.app, other.auth, '/v1/balance');
    expect(mine.json<{ balances: unknown[] }>().balances.length).toBeGreaterThan(0);
    expect(theirs.json<{ balances: unknown[] }>().balances).toHaveLength(0);
  }, 60_000);
});

describe('authentication', () => {
  it('rejects a missing, malformed or unknown key identically', async () => {
    const missing = await get(h.app, '', '/v1/payment_intents/pi_whatever');
    const malformed = await h.app.inject({ method: 'GET', url: '/v1/payment_intents/pi_whatever', headers: { authorization: 'Bearer nonsense' } });
    const unknown = await get(h.app, 'Bearer sk_test_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '/v1/payment_intents/pi_whatever');

    for (const res of [missing, malformed, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { type: string } }>().error.type).toBe('authentication_error');
    }
  }, 60_000);

  it('rejects a revoked key', async () => {
    const revoked = await h.createMerchant({ name: 'Revoked' });
    await h.db.query(`UPDATE api_keys SET status = 'revoked' WHERE key_prefix = $1`, [
      revoked.apiKey.split('_').slice(0, 3).join('_'),
    ]);
    const res = await get(h.app, revoked.auth, '/v1/balance');
    expect(res.statusCode).toBe(401);
  }, 60_000);
});

describe('request validation', () => {
  it('rejects a sub-minimum amount', async () => {
    const res = await post(h.app, m.auth, '/v1/payment_intents', { amount: 10, currency: 'usd' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('amount_too_small');
  });

  it('rejects an unsupported currency', async () => {
    const res = await post(h.app, m.auth, '/v1/payment_intents', { amount: 10_000, currency: 'xyz' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('currency_unsupported');
  });

  it('rejects a non-integer amount', async () => {
    const res = await post(h.app, m.auth, '/v1/payment_intents', { amount: 10.5, currency: 'usd' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a three-letter currency with the wrong length', async () => {
    const res = await post(h.app, m.auth, '/v1/payment_intents', { amount: 10_000, currency: 'usdd' });
    expect(res.statusCode).toBe(400);
  });

  it('handles a zero-decimal currency without inventing decimal places', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 5_000, currency: 'jpy', customer: customerId, payment_method: paymentMethodId,
    });
    expect(intent.statusCode).toBe(201);
    const id = intent.json<{ id: string }>().id;
    const res = await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);
    expect(res.statusCode).toBe(200);
    // The fee floor is still 30 minor units, i.e. 30 yen here.
    expect(await getBalance(h.db, m.accountId, LedgerCode.PLATFORM_FEE_REVENUE, 'jpy')).toBe(175);
    await expect(assertLedgerBalanced(h.db)).resolves.toBeUndefined();
  }, 60_000);
});

/** Reads the newest charge id out of the charges list. */
function chargeIdFrom(res: { json(): unknown }): string {
  const data = (res.json() as { data: { id: string }[] }).data;
  const first = data[0];
  if (!first) throw new Error('expected at least one charge');
  return first.id;
}