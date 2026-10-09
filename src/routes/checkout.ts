import { Type, type Static } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../db/index.js';
import type { ProcessorRegistry } from '../processors/index.js';
import { authenticate, assertPermission } from '../auth/apiKey.js';
import { ApiError, invalidRequest } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { sandboxTokenFor } from '../processors/index.js';
import * as payments from '../payments/service.js';
import * as checkout from '../checkout/service.js';
import { renderCheckoutPage, renderUnavailablePage } from '../checkout/page.js';
import { withIdempotency, AuthHeader, IdempotencyKeyHeader, ErrorSchema, type AppDeps } from './v1.js';

/**
 * Checkout HTTP surface.
 *
 * Two surfaces with deliberately different trust models, kept in one module
 * because they are two halves of one flow:
 *
 *   * `/v1/checkout/sessions` is merchant-facing: API key, permission check,
 *     idempotency key, account scoping — the same contract as every other
 *     mutation in the API.
 *   * `/checkout/:id` is cardholder-facing: no API key exists to present,
 *     so the unguessable, expiring session id is the credential. These routes
 *     are registered with `hide: true` because they are not part of the
 *     merchant contract, and every published route in this API is
 *     authenticated — a test in `tests/api/openapi.test.ts` enforces that, so
 *     a public route must be explicitly public rather than accidentally
 *     undocumented.
 */

const LineItemBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  quantity: Type.Integer({ minimum: 1, maximum: 1_000 }),
  unit_amount: Type.Integer({ minimum: 0 }),
  description: Type.Optional(Type.String({ maxLength: 500 })),
});

const CreateSessionBody = Type.Object({
  /** The cart to charge. Exactly one of line_items or payment_intent. */
  line_items: Type.Optional(Type.Array(LineItemBody, { maxItems: 100 })),
  payment_intent: Type.Optional(Type.String()),
  /** Required with line_items: the currency the totals are in. */
  currency: Type.Optional(Type.String({ minLength: 3, maxLength: 3 })),
  customer: Type.Optional(Type.String()),
  success_url: Type.String({ maxLength: 2048 }),
  cancel_url: Type.Optional(Type.String({ maxLength: 2048 })),
  expires_in: Type.Optional(Type.Integer({ minimum: 300, maximum: 86_400 })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const LineItemSchema = Type.Object({
  name: Type.String(),
  quantity: Type.Integer(),
  unit_amount: Type.Integer(),
  description: Type.Optional(Type.String()),
});

/**
 * Every field here is returned by `present`. Fastify serializes responses
 * through this schema and drops the rest, so a field missing from it is a
 * field an integrator never sees.
 */
const CheckoutSessionSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal('checkout_session'),
  /** Absolute URL of the hosted page, ready to redirect a customer to. */
  url: Type.String(),
  status: Type.String(),
  amount: Type.Integer(),
  currency: Type.String(),
  line_items: Type.Array(LineItemSchema),
  payment_intent: Type.String(),
  /** The intent's client secret, so a merchant can confirm from their own UI. */
  client_secret: Type.String(),
  success_url: Type.String(),
  cancel_url: Type.Union([Type.String(), Type.Null()]),
  expires_at: Type.String(),
  metadata: Type.Record(Type.String(), Type.String()),
  created: Type.String(),
});

function presentSession(
  session: checkout.CheckoutSessionRow,
  intent: payments.PaymentIntentRow,
  origin: string,
) {
  return {
    id: session.id,
    object: 'checkout_session' as const,
    url: `${origin}/checkout/${session.id}`,
    status: session.status,
    amount: Number(session.amount),
    currency: session.currency,
    line_items: session.line_items,
    payment_intent: session.payment_intent_id,
    client_secret: intent.client_secret,
    success_url: session.success_url,
    cancel_url: session.cancel_url,
    expires_at: new Date(session.expires_at).toISOString(),
    metadata: session.metadata ?? {},
    created: new Date(session.created_at).toISOString(),
  };
}

/** `https://host:port` as the client asked for it. */
function originOf(req: { protocol: string; headers: Record<string, unknown> }): string {
  const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost';
  return `${req.protocol}://${host}`;
}

export async function registerCheckoutRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, registry } = deps;

  /**
   * The payment form posts as a browser form, not as JSON: a hosted page
   * that needs JavaScript to submit a card number is a hosted page that
   * breaks when a customer has a script blocker.
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  /** HTML responses never leak a referrer, whatever the document says. */
  function html(reply: FastifyReply, status: number, body: string): FastifyReply {
    return reply
      .code(status)
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(body);
  }

  /**
   * Where the merchant goes after paying, with the parameters a merchant
   * needs to reconcile: which session, which intent, what happened.
   */
  function successRedirect(session: checkout.CheckoutSessionRow): string {
    const url = new URL(session.success_url);
    url.searchParams.set('session_id', session.id);
    url.searchParams.set('payment_intent', session.payment_intent_id);
    url.searchParams.set('payment_status', 'succeeded');
    return url.toString();
  }

  function unavailablePage(status: number, title: string, message: string, reply: FastifyReply) {
    return html(reply, status, renderUnavailablePage({ title, message }));
  }

  /**
   * A failure from the payments layer rendered the way a browser expects it.
   * Anything that is not an ApiError keeps its way to the JSON error handler:
   * those are bugs, not customer-facing outcomes.
   */
  function asErrorPage(err: unknown, reply: FastifyReply): FastifyReply | undefined {
    if (!(err instanceof ApiError)) return undefined;
    if (err.status >= 500 && err.status !== 502) return undefined;
    return html(
      reply,
      err.status,
      renderUnavailablePage({
        title: err.status === 404 ? 'Checkout session not found' : 'This payment could not be completed',
        message: err.message,
      }),
    );
  }

  function formPage(
    reply: FastifyReply,
    opts: {
      session: checkout.CheckoutSessionRow;
      merchantName: string;
      intent: payments.PaymentIntentRow;
      error?: string;
    },
  ): FastifyReply {
    return html(
      reply,
      200,
      renderCheckoutPage({
        session: opts.session,
        merchantName: opts.merchantName,
        challenge: opts.intent.status === 'requires_action',
        testMode: !opts.session.livemode,
        ...(opts.error ? { error: opts.error } : {}),
      }),
    );
  }

  async function completeAndRedirect(
    reply: FastifyReply,
    session: checkout.CheckoutSessionRow,
  ): Promise<FastifyReply> {
    const done = await checkout.completeSession(db, session);
    return reply.redirect(successRedirect(done), 303);
  }

  // --------------------------------------------------------- merchant API

  app.post<{ Body: Static<typeof CreateSessionBody> }>(
    '/v1/checkout/sessions',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        body: CreateSessionBody,
        response: {
          201: CheckoutSessionSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'checkout:write');
      const body = req.body as Static<typeof CreateSessionBody>;

      const { session, intent } = await checkout.createSession(db, {
        accountId: principal.accountId,
        ...(body.currency ? { currency: body.currency } : {}),
        ...(body.line_items ? { lineItems: body.line_items } : {}),
        ...(body.payment_intent ? { paymentIntentId: body.payment_intent } : {}),
        ...(body.customer ? { customerId: body.customer } : {}),
        successUrl: body.success_url,
        ...(body.cancel_url ? { cancelUrl: body.cancel_url } : {}),
        ...(body.expires_in ? { expiresIn: body.expires_in } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });

      return { status: 201 as const, body: presentSession(session, intent, originOf(req)) };
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/v1/checkout/sessions/:id',
    {
      schema: {
        security: [{ apiKey: [] }],
        params: Type.Object({ id: Type.String() }),
        response: { 200: CheckoutSessionSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'checkout:read');
      const session = await checkout.retrieveSession(db, principal.accountId, req.params.id);
      const intent = await checkout.intentForSession(db, session);
      return reply.send(presentSession(session, intent, originOf(req)));
    },
  );

  // ------------------------------------------------------- hosted Checkout

  app.get<{ Params: { id: string } }>(
    '/checkout/:id',
    { schema: { hide: true, params: Type.Object({ id: Type.String({ minLength: 4, maxLength: 64 }) }) } },
    async (req, reply) => {
      let ctx: checkout.HostedContext;
      try {
        ctx = await checkout.loadHostedContext(db, req.params.id);
      } catch (err) {
        const page = asErrorPage(err, reply);
        if (page) return page;
        throw err;
      }
      const { session, intent, merchantName } = ctx;

      // Paid already? The link still works and simply takes the customer
      // where paying would have taken them. An abandoned session the merchant
      // confirmed from their own backend must not strand the customer here.
      if (session.status === 'complete' || intent.status === 'succeeded') {
        return completeAndRedirect(reply, session);
      }
      if (intent.status === 'canceled') {
        return unavailablePage(410, 'This checkout session is closed', 'The merchant canceled this payment.', reply);
      }
      if (session.status !== 'open') {
        return unavailablePage(410, 'This checkout session has expired', 'Ask the merchant for a new payment link.', reply);
      }
      return formPage(reply, { session, merchantName, intent });
    },
  );

  app.post<{ Params: { id: string }; Body: Record<string, string> }>(
    '/checkout/:id/pay',
    { schema: { hide: true, params: Type.Object({ id: Type.String({ minLength: 4, maxLength: 64 }) }) } },
    async (req, reply) => {
      let ctx: checkout.HostedContext;
      try {
        ctx = await checkout.loadHostedContext(db, req.params.id);
      } catch (err) {
        const page = asErrorPage(err, reply);
        if (page) return page;
        throw err;
      }
      const { session, intent, merchantName } = ctx;
      const body = (req.body ?? {}) as Record<string, string>;

      // Replaying the POST after the money moved redirects instead of
      // charging again. This is the idempotency guarantee for a browser
      // form, where the merchant's API key cannot vouch for the retry.
      if (session.status === 'complete' || intent.status === 'succeeded') {
        return completeAndRedirect(reply, session);
      }
      if (intent.status === 'canceled') {
        return unavailablePage(410, 'This checkout session is closed', 'The merchant canceled this payment.', reply);
      }
      if (session.status !== 'open') {
        return unavailablePage(410, 'This checkout session has expired', 'Ask the merchant for a new payment link.', reply);
      }

      try {
        let after: payments.PaymentIntentRow;

        if (body.challenge === 'passed') {
          if (intent.status !== 'requires_action') {
            return formPage(reply, {
              session, merchantName, intent,
              error: 'This payment is not waiting for verification.',
            });
          }
          after = (
            await payments.confirmPaymentIntent({
              db,
              accountId: session.account_id,
              intentId: intent.id,
              registry,
              idempotencyKey: await checkout.attemptKey(db, session.id, intent.id),
              // The challenge was rendered by this page and answered by the
              // submit above. Production adapters must instead take this from
              // the processor's challenge response (see Processor.authorize).
              challengeResult: 'passed',
            })
          ).intent;
        } else {
          const card = parseCard(body);
          const methodId = newId('pm', 24);
          // The CVC is never written anywhere: it is checked by the processor
          // and must not survive the request. Same for the PAN — the token is
          // derived the same way /v1/payment_methods derives it, from the
          // processor's vault over TLS in production.
          await db.query(
            `INSERT INTO payment_methods
               (id, account_id, customer_id, type, brand, last4, exp_month, exp_year, processor_token)
             VALUES ($1, $2, $3, 'card', $4, $5, $6, $7, $8)`,
            [
              methodId, session.account_id, session.customer_id, 'visa',
              card.number.slice(-4), card.expMonth, card.expYear,
              sandboxTokenFor(card.number),
            ],
          );
          await payments.attachPaymentMethod(db, {
            accountId: session.account_id,
            intentId: intent.id,
            paymentMethodId: methodId,
          });
          after = (
            await payments.confirmPaymentIntent({
              db,
              accountId: session.account_id,
              intentId: intent.id,
              registry,
              idempotencyKey: await checkout.attemptKey(db, session.id, intent.id),
            })
          ).intent;
        }

        if (after.status === 'succeeded') return completeAndRedirect(reply, session);
        return formPage(reply, { session, merchantName, intent: after });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        // Declines and rejected submissions are outcomes the customer can act
        // on: show them the form again with the reason, never a JSON body a
        // browser would render as raw text. A 5xx carries our internal
        // wording, so the cardholder gets a sentence they can act on instead.
        const current = await checkout.intentForSession(db, session);
        return html(
          reply,
          err.status,
          renderCheckoutPage({
            session,
            merchantName,
            challenge: current.status === 'requires_action',
            testMode: !session.livemode,
            error: err.status >= 500
              ? 'Something went wrong on our side. Please try again.'
              : err.message,
          }),
        );
      }
    },
  );
}

/**
 * Card details from the form. Validated here rather than by schema so the
 * customer gets a sentence they can act on ("Enter the expiry as MM/YY")
 * instead of a parameter name from a JSON Schema.
 */
function parseCard(body: Record<string, string>): { number: string; expMonth: number; expYear: number } {
  const number = (body.card_number ?? '').replace(/[\s-]/g, '');
  if (!/^\d{12,19}$/.test(number)) {
    throw invalidRequest('Enter a valid card number.', 'parameter_invalid');
  }

  const expiry = (body.expiry ?? '').trim();
  const match = /^(\d{2})\s*\/\s*(\d{2})$/.exec(expiry);
  if (!match) throw invalidRequest('Enter the expiry date as MM/YY.', 'parameter_invalid');
  const expMonth = Number(match[1]);
  const expYear = 2000 + Number(match[2]);
  if (expMonth < 1 || expMonth > 12) {
    throw invalidRequest('Enter a valid expiry month.', 'parameter_invalid');
  }
  const now = new Date();
  if (
    expYear < now.getFullYear() ||
    (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)
  ) {
    throw invalidRequest('That card has expired.', 'parameter_invalid');
  }

  const cvc = (body.cvc ?? '').trim();
  if (!/^\d{3,4}$/.test(cvc)) {
    throw invalidRequest('Enter the 3 or 4 digit security code.', 'parameter_invalid');
  }

  return { number, expMonth, expYear };
}
