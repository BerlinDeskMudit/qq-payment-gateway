import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, post, get, customerWithCard, type Harness, type Merchant } from '../helpers/harness.js';

/**
 * Hosted Checkout, end to end.
 *
 * The claim being tested is "a merchant can take a payment with no frontend
 * of their own": create a session, hand the customer the URL, and money moves
 * without a single line of merchant JavaScript. Everything else here is the
 * failure modes of that claim — an abandoned cart, a declined card, an
 * expired link, a customer who belongs to somebody else.
 */

let h: Harness;
beforeAll(async () => { h = await makeHarness(); }, 60_000);
afterAll(async () => { await h.close(); });

let m: Merchant;
beforeAll(async () => { m = await h.createMerchant({ name: 'Acme Shop' }); }, 60_000);

type SessionBody = {
  id: string;
  url: string;
  status: string;
  amount: number;
  currency: string;
  payment_intent: string;
  client_secret: string;
  success_url: string;
  expires_at: string;
};

/** Browser form POST: no API key, no JSON, exactly what a page submits. */
function submitForm(url: string, fields: Record<string, string>) {
  return h.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });
}

function payFields(card = '4242424242424242'): Record<string, string> {
  return { card_number: card, expiry: '12/34', cvc: '123' };
}

async function createSession(merchant: Merchant, overrides: Record<string, unknown> = {}) {
  const res = await post(h.app, merchant.auth, '/v1/checkout/sessions', {
    line_items: [{ name: 'Pro plan', quantity: 2, unit_amount: 1_500 }],
    currency: 'usd',
    success_url: 'https://shop.example/orders/1',
    cancel_url: 'https://shop.example/cart',
    ...overrides,
  });
  return { res, session: res.json<SessionBody>() };
}

const path = (url: string) => new URL(url).pathname;

describe('checkout sessions', () => {
  it('prices a cart into a payment intent and hands back a hosted URL', async () => {
    const { res, session } = await createSession(m);

    expect(res.statusCode).toBe(201);
    expect(session.id).toMatch(/^cs_/);
    expect(session.status).toBe('open');
    expect(session.amount).toBe(3_000);
    expect(session.currency).toBe('usd');
    expect(session.url).toContain(`/checkout/${session.id}`);
    expect(new Date(session.expires_at).getTime()).toBeGreaterThan(Date.now());

    const intent = await get(h.app, m.auth, `/v1/payment_intents/${session.payment_intent}`);
    const body = intent.json<{ amount: number; status: string; description: string }>();
    expect(body.amount).toBe(3_000);
    expect(body.status).toBe('requires_payment_method');
    expect(body.description).toContain(session.id);
  }, 60_000);

  it('refuses a session that is not a cart or a payment intent', async () => {
    const neither = await post(h.app, m.auth, '/v1/checkout/sessions', {
      success_url: 'https://shop.example/ok',
    });
    expect(neither.statusCode).toBe(400);

    const both = await post(h.app, m.auth, '/v1/checkout/sessions', {
      line_items: [{ name: 'Pro plan', quantity: 1, unit_amount: 1_500 }],
      currency: 'usd',
      payment_intent: 'pi_whatever',
      success_url: 'https://shop.example/ok',
    });
    expect(both.statusCode).toBe(400);

    const noCurrency = await post(h.app, m.auth, '/v1/checkout/sessions', {
      line_items: [{ name: 'Pro plan', quantity: 1, unit_amount: 1_500 }],
      success_url: 'https://shop.example/ok',
    });
    expect(noCurrency.statusCode).toBe(400);
  }, 60_000);

  it('rejects a redirect target that is not http(s)', async () => {
    const res = await post(h.app, m.auth, '/v1/checkout/sessions', {
      line_items: [{ name: 'Pro plan', quantity: 1, unit_amount: 1_500 }],
      currency: 'usd',
      success_url: 'javascript:alert(1)',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('parameter_invalid');
  }, 60_000);

  it('will not open a session against an intent that is already paid', async () => {
    const { customerId, paymentMethodId } = await customerWithCard(h.app, m);
    const intent = await post(h.app, m.auth, '/v1/payment_intents', {
      amount: 1_000, currency: 'usd', customer: customerId, payment_method: paymentMethodId,
    });
    const id = intent.json<{ id: string }>().id;
    await post(h.app, m.auth, `/v1/payment_intents/${id}/confirm`);

    const res = await post(h.app, m.auth, '/v1/checkout/sessions', {
      payment_intent: id,
      success_url: 'https://shop.example/orders/2',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('state_transition_invalid');
  }, 60_000);
});

describe('the hosted page', () => {
  it('takes a payment end to end with no merchant frontend', async () => {
    const { session } = await createSession(m);

    const page = await h.app.inject({ method: 'GET', url: path(session.url) });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('Pro plan × 2');
    expect(page.body).toContain('$30.00');
    expect(page.body).toContain('name="card_number"');
    expect(page.body).toContain('for="card_number"');
    expect(page.body).toContain('autocomplete="cc-number"');

    const paid = await submitForm(path(session.url) + '/pay', payFields());
    expect(paid.statusCode).toBe(303);

    const location = new URL(paid.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://shop.example/orders/1');
    expect(location.searchParams.get('session_id')).toBe(session.id);
    expect(location.searchParams.get('payment_intent')).toBe(session.payment_intent);
    expect(location.searchParams.get('payment_status')).toBe('succeeded');

    const intent = await get(h.app, m.auth, `/v1/payment_intents/${session.payment_intent}`);
    expect(intent.json<{ status: string; amount_captured: number }>()).toMatchObject({
      status: 'succeeded', amount_captured: 3_000,
    });

    const after = await get(h.app, m.auth, `/v1/checkout/sessions/${session.id}`);
    expect(after.json<{ status: string }>().status).toBe('complete');
  }, 60_000);

  it('sends no referrer and loads nothing from a third party', async () => {
    const { session } = await createSession(m);
    const res = await h.app.inject({ method: 'GET', url: path(session.url) });

    expect(res.body).toContain('<meta name="referrer" content="no-referrer">');
    // No script, no stylesheet link, no image, no iframe: there is no origin
    // on this page that could receive a referrer header at all.
    expect(res.body).not.toMatch(/<(script|link|img|iframe|object|embed)\b/i);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  }, 60_000);

  it('is a single fluid column down to a 320px viewport', async () => {
    const { session } = await createSession(m);
    const res = await h.app.inject({ method: 'GET', url: path(session.url) });

    expect(res.body).toContain('name="viewport"');
    expect(res.body).toContain('width=device-width');
    // No fixed pixel width anywhere: a min-width larger than 320 is what
    // produces horizontal scrolling on a small phone.
    expect(res.body).not.toMatch(/min-width:\s*\d{3,}px/);
    expect(res.body).not.toMatch(/width:\s*\d{3,}px/);
  }, 60_000);
});

describe('failure and recovery', () => {
  it('declines a card, keeps the session open, and lets the customer retry', async () => {
    const { session } = await createSession(m);

    const declined = await submitForm(path(session.url) + '/pay', payFields('4000000000000002'));
    expect(declined.statusCode).toBe(402);
    expect(declined.headers['content-type']).toContain('text/html');
    expect(declined.body).toContain('declined');
    // The form comes back so the customer can use another card.
    expect(declined.body).toContain('name="card_number"');

    const intent = await get(h.app, m.auth, `/v1/payment_intents/${session.payment_intent}`);
    expect(intent.json<{ status: string }>().status).toBe('requires_payment_method');

    const open = await get(h.app, m.auth, `/v1/checkout/sessions/${session.id}`);
    expect(open.json<{ status: string }>().status).toBe('open');

    const recovered = await submitForm(path(session.url) + '/pay', payFields());
    expect(recovered.statusCode).toBe(303);
  }, 60_000);

  it('stops charging when the same form post is replayed', async () => {
    const merchant = await h.createMerchant({ name: 'Replay Shop' });
    const { session } = await createSession(merchant);

    const first = await submitForm(path(session.url) + '/pay', payFields());
    expect(first.statusCode).toBe(303);

    const second = await submitForm(path(session.url) + '/pay', payFields());
    expect(second.statusCode).toBe(303);
    expect(new URL(second.headers.location as string).searchParams.get('session_id')).toBe(session.id);

    const charges = await get(h.app, merchant.auth, '/v1/charges');
    expect(charges.json<{ data: unknown[] }>().data).toHaveLength(1);
  }, 60_000);

  it('expires an abandoned session and refuses to render a form for it', async () => {
    const { session } = await createSession(m, { expires_in: 300 });
    await h.db.query(
      `UPDATE checkout_sessions SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [session.id],
    );

    const merchantView = await get(h.app, m.auth, `/v1/checkout/sessions/${session.id}`);
    expect(merchantView.json<{ status: string }>().status).toBe('expired');

    const page = await h.app.inject({ method: 'GET', url: path(session.url) });
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain('expired');
    // An expired session must not show card fields at all.
    expect(page.body).not.toContain('name="card_number"');

    const attempt = await submitForm(path(session.url) + '/pay', payFields());
    expect(attempt.statusCode).toBe(410);
  }, 60_000);

  it('completes a 3DS challenge inside Checkout instead of redirecting away', async () => {
    const { session } = await createSession(m);

    const challenged = await submitForm(path(session.url) + '/pay', payFields('4000000000009995'));
    expect(challenged.statusCode).toBe(200);
    expect(challenged.body).toContain('Complete verification');
    expect(challenged.body).not.toContain('name="card_number"');

    const mid = await get(h.app, m.auth, `/v1/payment_intents/${session.payment_intent}`);
    expect(mid.json<{ status: string }>().status).toBe('requires_action');

    const verified = await submitForm(path(session.url) + '/pay', { challenge: 'passed' });
    expect(verified.statusCode).toBe(303);
    expect(new URL(verified.headers.location as string).searchParams.get('payment_status')).toBe('succeeded');

    const intent = await get(h.app, m.auth, `/v1/payment_intents/${session.payment_intent}`);
    expect(intent.json<{ status: string }>().status).toBe('succeeded');

    // The whole challenge happened on our own page: no hop to the issuer.
    const page = await h.app.inject({ method: 'GET', url: path(session.url) });
    expect(page.statusCode).toBe(303);
  }, 60_000);

  it('reports an unknown session as not found rather than as forbidden', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/checkout/cs_doesnotexist' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
  }, 60_000);
});

describe('tenancy and reuse', () => {
  it('hides one merchant session from another', async () => {
    const { session } = await createSession(m);
    const other = await h.createMerchant({ name: 'Rival' });

    const res = await get(h.app, other.auth, `/v1/checkout/sessions/${session.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('cross_account_access');
  }, 60_000);

  it('pays a pre-created payment intent instead of a cart', async () => {
    const merchant = await h.createMerchant({ name: 'Intent Shop' });
    const { customerId } = await customerWithCard(h.app, merchant);
    const intent = await post(h.app, merchant.auth, '/v1/payment_intents', {
      amount: 2_500, currency: 'usd', customer: customerId,
    });
    const intentId = intent.json<{ id: string }>().id;

    const { res, session } = await createSession(merchant, {
      line_items: undefined,
      payment_intent: intentId,
    });
    expect(res.statusCode).toBe(201);
    expect(session.payment_intent).toBe(intentId);
    expect(session.amount).toBe(2_500);

    const paid = await submitForm(path(session.url) + '/pay', payFields());
    expect(paid.statusCode).toBe(303);

    const after = await get(h.app, merchant.auth, `/v1/payment_intents/${intentId}`);
    expect(after.json<{ status: string; amount_captured: number }>()).toMatchObject({
      status: 'succeeded', amount_captured: 2_500,
    });
  }, 60_000);

  it('emits checkout lifecycle events for a merchant who cannot poll', async () => {
    const merchant = await h.createMerchant({ name: 'Event Shop' });
    const { session } = await createSession(merchant);
    await submitForm(path(session.url) + '/pay', payFields());

    const created = await get(h.app, merchant.auth, '/v1/events?type=checkout_session.created');
    const completed = await get(h.app, merchant.auth, '/v1/events?type=checkout_session.completed');
    expect(created.json<{ data: unknown[] }>().data).toHaveLength(1);
    expect(completed.json<{ data: unknown[] }>().data).toHaveLength(1);
  }, 60_000);
});
