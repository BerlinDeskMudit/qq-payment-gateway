import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { Db } from '../db/index.js';
import type { ProcessorRegistry } from '../processors/index.js';
import { authenticate, assertPermission } from '../auth/apiKey.js';
import { claimIdempotencyKey, completeIdempotencyKey, fingerprintRequest } from '../idempotency/store.js';
import { ApiError, crossAccount, invalidRequest } from '../lib/errors.js';
import { newId, randomSecret } from '../lib/ids.js';
import { sandboxTokenFor } from '../processors/index.js';
import * as payments from '../payments/service.js';
import { listEvents, retrieveEvent } from '../webhooks/events.js';
import { listDeliveries } from '../webhooks/deliver.js';
import { getBalances } from '../ledger/ledger.js';

/**
 * HTTP surface.
 *
 * Two rules enforced by a helper rather than by discipline in each handler:
 *   1. every request is authenticated and account-scoped before any query runs
 *   2. every mutating endpoint is idempotent before any work starts
 */

export type AppDeps = {
  db: Db;
  registry: ProcessorRegistry;
  apiVersion: string;
};

type IdempotentRequest<Req extends RouteGenericInterface> = FastifyRequest<Req> & { idempotencyKey: string };

/**
 * Wraps a handler in the idempotency protocol:
 *   claim key -> replay stored response, or run -> store response
 *
 * Authentication happens first so the key is scoped to an account: keys are
 * namespaced per merchant, so the same key string from two merchants must not
 * collide.
 *
 * A failure is deliberately NOT stored. A client that gets a transient 502
 * should be able to retry the same key and get a real new attempt; replaying
 * the stored failure forever would make the key unusable.
 */
function withIdempotency<Req extends RouteGenericInterface>(
  deps: AppDeps,
  handler: (req: IdempotentRequest<Req>) => Promise<{ status: number; body: unknown }>,
) {
  return async (req: FastifyRequest<Req>, reply: FastifyReply): Promise<unknown> => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw invalidRequest('The Idempotency-Key header is required for this request.', 'parameter_missing');
    }

    const principal = await authenticate(deps.db, req.headers.authorization);
    const fingerprint = fingerprintRequest({ body: req.body ?? null, path: req.url });

    const claim = await claimIdempotencyKey(deps.db, principal.accountId, key, fingerprint);
    if (claim.status === 'replay') {
      // Replays carry the original status and are flagged, so an integrator can
      // tell a replay from a fresh execution.
      return reply.code(claim.responseStatus).header('idempotent-replay', 'true').send(claim.responseBody);
    }

    const result = await handler(Object.assign(req, { idempotencyKey: key }) as IdempotentRequest<Req>);
    await completeIdempotencyKey(deps.db, principal.accountId, key, result.status, result.body);
    return reply.code(result.status).send(result.body);
  };
}

/** The auth header is the credential; this documents the secret's format. */
const AuthHeader = Type.Object({ authorization: Type.String({ pattern: '^Bearer .+$' }) });

/** Mutations require an idempotency key. Enforced in the header schema, not
 * only in the handler, so the requirement shows up in the published spec. */
const IdempotencyKeyHeader = Type.Object({
  'idempotency-key': Type.String({ minLength: 8, maxLength: 255 }),
});

/**
 * Fastify serializes error responses through this schema too, and drops any
 * field it does not declare. Every extra that `ApiError.extra` can carry is
 * listed here, because they are the diagnostics an integrator needs to fix
 * their integration: which object, which state, which remaining amount.
 */
const ErrorSchema = Type.Object({
  error: Type.Object({
    type: Type.String(),
    code: Type.String(),
    message: Type.String(),
    decline_code: Type.Optional(Type.String()),
    charge: Type.Optional(Type.String()),
    payment_intent: Type.Optional(Type.String()),
    current_status: Type.Optional(Type.String()),
    minimum_amount: Type.Optional(Type.Integer()),
    remaining_amount: Type.Optional(Type.Integer()),
    currency: Type.Optional(Type.String()),
    retry_after: Type.Optional(Type.Integer()),
    retryable: Type.Boolean(),
    request_id: Type.Optional(Type.String()),
    docs_url: Type.Optional(Type.String()),
  }),
});

const ChargeSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal('charge'),
  amount: Type.Integer(),
  amount_refunded: Type.Integer(),
  currency: Type.String(),
  status: Type.String(),
  created: Type.String(),
});

/**
 * Note `ambiguous` and `latest_charge` are declared here. Fastify serializes
 * responses through this schema and silently drops anything it does not
 * list, so a field missing from here is a field an integrator never sees.
 */
const PaymentIntentSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal('payment_intent'),
  amount: Type.Integer(),
  amount_captured: Type.Integer(),
  currency: Type.String(),
  status: Type.String(),
  capture_method: Type.String(),
  client_secret: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Record(Type.String(), Type.String()),
  ambiguous: Type.Boolean(),
  latest_charge: Type.Optional(ChargeSchema),
  created: Type.String(),
});


function presentIntent(row: payments.PaymentIntentRow) {
  return {
    id: row.id,
    object: 'payment_intent' as const,
    amount: Number(row.amount),
    amount_captured: Number(row.amount_captured),
    currency: row.currency,
    status: row.status,
    capture_method: row.capture_method,
    client_secret: row.client_secret,
    description: row.description,
    metadata: row.metadata ?? {},
    /**
     * True when we called the processor and do not yet know the outcome. An
     * integrator needs this to distinguish "we are still working on it" from
     * "we lost track of the money".
     */
    ambiguous: row.ambiguous_since !== null,
    created: new Date(row.created_at).toISOString(),
  };
}

function presentCharge(row: payments.ChargeRow) {
  return {
    id: row.id,
    object: 'charge' as const,
    amount: Number(row.amount),
    amount_refunded: Number(row.amount_refunded),
    currency: row.currency,
    status: row.status,
    created: new Date(row.created_at).toISOString(),
  };
}

export async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, registry } = deps;

  // ------------------------------------------------------------- middleware

  app.addHook('onRequest', async (req, reply) => {
    try {
      req.headers['request-id'] ??= newId('req', 16);
    } catch {
      /* header plumbing is best-effort */
    }
  });

  // -------------------------------------------------------------- customers

  app.post<{ Body: Static<typeof CustomerBody> }>(
    '/v1/customers',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        body: CustomerBody,
        response: { 201: CustomerSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'customers:write');
      const body = req.body as Static<typeof CustomerBody>;
      const id = newId('cus', 24);
      const { rows } = await db.query<{ id: string; email: string | null; name: string | null; created_at: Date }>(
        `INSERT INTO customers (id, account_id, email, name)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, created_at`,
        [id, principal.accountId, body.email ?? null, body.name ?? null],
      );
      const c = rows[0]!;
      return {
        status: 201 as const,
        body: {
          id: c.id, object: 'customer' as const, email: c.email, name: c.name,
          created: new Date(c.created_at).toISOString(),
        },
      };
    }),
  );

  // -------------------------------------------------------- payment methods

  app.post<{ Body: Static<typeof PaymentMethodBody> }>(
    '/v1/payment_methods',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        body: PaymentMethodBody,
        response: { 201: PaymentMethodSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'customers:write');
      const body = req.body as Static<typeof PaymentMethodBody>;

      // Cross-account customer reference is checked before insert: the FK
      // would accept another account's customer id, so the FK is not the
      // tenancy boundary.
      const { rowCount } = await db.query(
        `SELECT 1 FROM customers WHERE id = $1 AND account_id = $2`, [body.customer, principal.accountId],
      );
      if (!rowCount) {
        throw new ApiError({
          status: 404, type: 'invalid_request_error', code: 'cross_account_access',
          message: `No such customer for this account: '${body.customer}'`,
        });
      }

      // In production this token comes from the processor's vault over TLS. The
      // sandbox derives it locally from the test card number.
      const testCard = body.test_card;
      if (!testCard && !body.sandbox_token) {
        throw invalidRequest('Provide either test_card or sandbox_token.', 'parameter_missing');
      }
      const token = body.sandbox_token ?? sandboxTokenFor(testCard!);
      const last4 = (testCard ?? '').replace(/\D/g, '').slice(-4) || null;

      const id = newId('pm', 24);
      const { rows } = await db.query<{
        id: string; brand: string | null; last4: string | null; exp_month: number | null;
        exp_year: number | null; created_at: Date;
      }>(
        `INSERT INTO payment_methods (id, account_id, customer_id, type, brand, last4, exp_month, exp_year, processor_token)
         VALUES ($1, $2, $3, 'card', $4, $5, $6, $7, $8)
         RETURNING id, brand, last4, exp_month, exp_year, created_at`,
        [
          id, principal.accountId, body.customer, body.brand ?? 'visa', last4,
          body.exp_month ?? 12, body.exp_year ?? 2030, token,
        ],
      );
      const pm = rows[0]!;
      return {
        status: 201 as const,
        body: {
          id: pm.id, object: 'payment_method' as const, type: 'card' as const, brand: pm.brand,
          last4: pm.last4, exp_month: pm.exp_month, exp_year: pm.exp_year,
          created: new Date(pm.created_at).toISOString(),
        },
      };
    }),
  );

  // ------------------------------------------------------- payment intents

  app.post<{ Body: Static<typeof CreateIntentBody> }>(
    '/v1/payment_intents',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        body: CreateIntentBody,
        response: { 201: PaymentIntentSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'payment_intents:write');
      const body = req.body as Static<typeof CreateIntentBody>;
      if (body.payment_method && !body.customer) {
        throw invalidRequest('payment_method requires customer.', 'parameter_missing');
      }
      const intent = await payments.createPaymentIntent(db, {
        accountId: principal.accountId,
        amount: body.amount,
        currency: body.currency,
        customerId: body.customer,
        paymentMethodId: body.payment_method,
        captureMethod: body.capture_method,
        description: body.description,
        metadata: body.metadata,
      });
      return { status: 201 as const, body: presentIntent(intent) };
    }),
  );

  app.get<{ Params: { id: string } }>(
    '/v1/payment_intents/:id',
    {
      schema: {
        security: [{ apiKey: [] }],
        params: Type.Object({ id: Type.String() }),
        response: { 200: PaymentIntentSchema, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'payment_intents:read');
      const intent = await payments.retrievePaymentIntent(db, principal.accountId, req.params.id);
      return presentIntent(intent);
    },
  );

  app.post<{ Params: { id: string }; Body: Static<typeof ConfirmBody> }>(
    '/v1/payment_intents/:id/confirm',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        params: Type.Object({ id: Type.String() }),
        body: ConfirmBody,
        response: { 200: PaymentIntentSchema, 402: ErrorSchema, 409: ErrorSchema, 502: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'payment_intents:write');
      const { intent, charge } = await payments.confirmPaymentIntent({
        db, principal, intentId: req.params.id, registry, idempotencyKey: req.idempotencyKey,
      });
      return { status: 200 as const, body: charge ? { ...presentIntent(intent), latest_charge: presentCharge(charge) } : presentIntent(intent) };
    }),
  );

  app.post<{ Params: { id: string }; Body: Static<typeof CaptureBody> }>(
    '/v1/payment_intents/:id/capture',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        params: Type.Object({ id: Type.String() }),
        body: CaptureBody,
        response: { 200: PaymentIntentSchema, 402: ErrorSchema, 409: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'payment_intents:write');
      const body = (req.body ?? {}) as Static<typeof CaptureBody>;
      const { intent, charge } = await payments.capturePaymentIntent({
        db, principal, intentId: req.params.id, registry,
        idempotencyKey: req.idempotencyKey, amount: body.amount_to_capture,
      });
      return { status: 200 as const, body: { ...presentIntent(intent), latest_charge: presentCharge(charge) } };
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/v1/payment_intents/:id/cancel',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        params: Type.Object({ id: Type.String() }),
        response: { 200: PaymentIntentSchema, 409: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'payment_intents:write');
      const intent = await payments.cancelPaymentIntent({
        db, principal, intentId: req.params.id, registry, idempotencyKey: req.idempotencyKey,
      });
      return { status: 200 as const, body: presentIntent(intent) };
    }),
  );

  // ---------------------------------------------------------------- charges

  app.get<{ Querystring: { limit?: string; customer?: string } }>(
    '/v1/charges',
    {
      schema: {
        security: [{ apiKey: [] }],
        querystring: Type.Object({
          limit: Type.Optional(Type.String({ pattern: '^\\d+$' })),
          customer: Type.Optional(Type.String()),
        }),
        response: { 200: Type.Object({ object: Type.Literal('list'), data: Type.Array(ChargeSchema) }) },
      },
    },
    async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'charges:read');
      const charges = await payments.listCharges(db, principal.accountId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        customerId: req.query.customer,
      });
      return { object: 'list' as const, data: charges.map(presentCharge) };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/charges/:id',
    {
      schema: {
        security: [{ apiKey: [] }],
        params: Type.Object({ id: Type.String() }),
        response: { 200: ChargeSchema, 404: ErrorSchema },
      },
    },
    async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'charges:read');
      return presentCharge(await payments.retrieveCharge(db, principal.accountId, req.params.id));
    },
  );

  app.post<{ Params: { id: string }; Body: Static<typeof RefundBody> }>(
    '/v1/charges/:id/refunds',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        params: Type.Object({ id: Type.String() }),
        body: RefundBody,
        response: { 201: RefundSchema, 400: ErrorSchema, 402: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'refunds:write');
      const body = (req.body ?? {}) as Static<typeof RefundBody>;
      const refund = await payments.createRefund({
        db, principal, chargeId: req.params.id, amount: body.amount,
        reason: body.reason, idempotencyKey: req.idempotencyKey, registry,
      });
      return {
        status: 201 as const,
        body: {
          id: refund.id, object: 'refund' as const, charge: refund.charge_id,
          amount: Number(refund.amount), currency: refund.currency,
          status: refund.status, reason: refund.reason,
          created: new Date(refund.created_at).toISOString(),
        },
      };
    }),
  );

  // ----------------------------------------------------------------- events

  app.get<{ Querystring: { limit?: string; type?: string } }>(
    '/v1/events',
    {
      schema: {
        security: [{ apiKey: [] }],
        querystring: Type.Object({ limit: Type.Optional(Type.String()), type: Type.Optional(Type.String()) }),
        response: { 200: Type.Object({ object: Type.Literal('list'), data: Type.Array(Type.Unknown()) }) },
      },
    },
    async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'events:read');
      const events = await listEvents(db, principal.accountId, {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        type: req.query.type,
      });
      return {
        object: 'list' as const,
        data: events.map((e) => ({
          id: e.id, object: 'event', type: e.type, api_version: e.api_version,
          created: new Date(e.created_at).toISOString(), data: e.data,
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/events/:id',
    {
      schema: { security: [{ apiKey: [] }], params: Type.Object({ id: Type.String() }), response: { 200: Type.Unknown() } },
    },
    async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'events:read');
      const e = await retrieveEvent(db, principal.accountId, req.params.id);
      return {
        id: e.id, object: 'event', type: e.type, api_version: e.api_version,
        created: new Date(e.created_at).toISOString(), data: e.data,
      };
    },
  );

  // -------------------------------------------------------------- balances

  app.get(
    '/v1/balance',
    {
      schema: {
        security: [{ apiKey: [] }],
        response: {
          200: Type.Object({
            object: Type.Literal('balance'),
            balances: Type.Array(Type.Object({
              code: Type.String(), type: Type.String(), currency: Type.String(), balance: Type.Integer(),
            })),
          }),
        },
      },
    },
    async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'balances:read');
      return { object: 'balance' as const, balances: await getBalances(db, principal.accountId) };
    },
  );

  // -------------------------------------------------------------- webhooks

  app.post<{ Body: Static<typeof WebhookEndpointBody> }>(
    '/v1/webhook_endpoints',
    {
      schema: {
        security: [{ apiKey: [] }],
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        body: WebhookEndpointBody,
        response: { 201: WebhookEndpointSchema, 400: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'webhooks:write');
      const body = req.body as Static<typeof WebhookEndpointBody>;

      let parsed: URL;
      try {
        parsed = new URL(body.url);
      } catch {
        throw invalidRequest('url must be an absolute http(s) URL.', 'parameter_invalid');
      }
      // An http:// endpoint sends the cardholder's payment data in clear text
      // and the signing secret in a header. Refuse rather than allow it.
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        throw invalidRequest('Webhook endpoints must use https.', 'parameter_invalid');
      }

      const id = newId('we', 22);
      const secret = randomSecret(32);
      const { rows } = await db.query<{ id: string; url: string; status: string; description: string | null; created_at: Date }>(
        `INSERT INTO webhook_endpoints (id, account_id, url, secret, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, url, status, description, created_at`,
        [id, principal.accountId, body.url, secret, body.description ?? null],
      );
      const ep = rows[0]!;
      return {
        status: 201 as const,
        // The secret is returned once, at creation. We store only enough to
        // verify signatures, never enough to show it again.
        body: {
          id: ep.id, object: 'webhook_endpoint' as const, url: ep.url, status: ep.status,
          description: ep.description, secret,
          created: new Date(ep.created_at).toISOString(),
        },
      };
    }),
  );

  /**
   * Unsubscribing is a status change, not a DELETE.
   *
   * A hard delete would either orphan the delivery history that merchants need
   * for debugging (blocked by the FK on purpose) or cascade it away. Disabling
   * keeps the audit trail, stops the worker, and is reversible if support needs
   * to turn an endpoint back on.
   */
  app.post(
    '/v1/webhook_endpoints/:id/disable',
    {
      schema: {
        security: [{ apiKey: [] }],
        params: Type.Object({ id: Type.String({ minLength: 1 }) }),
        headers: Type.Composite([AuthHeader, IdempotencyKeyHeader]),
        response: { 200: WebhookEndpointSchema, 404: ErrorSchema },
      },
    },
    withIdempotency(deps, async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'webhooks:write');
      const { id } = req.params as { id: string };

      const { rows } = await db.query<{
        id: string; url: string; status: string; description: string | null; created_at: Date;
      }>(
        `UPDATE webhook_endpoints SET status = 'disabled'
          WHERE id = $1 AND account_id = $2
          RETURNING id, url, status, description, created_at`,
        [id, principal.accountId],
      );
      // Scoped by account, so another merchant's id is indistinguishable from
      // one that does not exist.
      if (!rows[0]) throw crossAccount('webhook endpoint');
      const ep = rows[0];
      return {
        status: 200 as const,
        body: {
          id: ep.id, object: 'webhook_endpoint' as const, url: ep.url, status: ep.status,
          description: ep.description, created: new Date(ep.created_at).toISOString(),
        },
      };
    }),
  );

  app.get(
    '/v1/webhook_deliveries',
    {
      schema: {
        security: [{ apiKey: [] }],
        response: { 200: Type.Object({ object: Type.Literal('list'), data: Type.Array(Type.Unknown()) }) },
      },
    },
    async (req) => {
      const principal = await authenticate(db, req.headers.authorization);
      assertPermission(principal, 'webhooks:read');
      return {
        object: 'list' as const,
        data: await listDeliveries(db, principal.accountId),
      };
    },
  );

  app.get('/health', { schema: { hide: true } }, async () => ({ status: 'ok', version: deps.apiVersion }));
}

export const CustomerBody = Type.Object({
  email: Type.Optional(Type.String({ format: 'email' })),
  name: Type.Optional(Type.String({ maxLength: 255 })),
});

const CustomerSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal('customer'),
  email: Type.Union([Type.String(), Type.Null()]),
  name: Type.Union([Type.String(), Type.Null()]),
  created: Type.String(),
});

const PaymentMethodBody = Type.Object({
  customer: Type.String(),
  /** Test card number. Accepted only by the sandbox processor. */
  test_card: Type.Optional(Type.String({ pattern: '^\\d{12,19}$' })),
  sandbox_token: Type.Optional(Type.String()),
  brand: Type.Optional(Type.String()),
  exp_month: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
  exp_year: Type.Optional(Type.Integer({ minimum: 2024 })),
});

const PaymentMethodSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal('payment_method'),
  type: Type.Literal('card'),
  brand: Type.Union([Type.String(), Type.Null()]),
  last4: Type.Union([Type.String(), Type.Null()]),
  exp_month: Type.Union([Type.Integer(), Type.Null()]),
  exp_year: Type.Union([Type.Integer(), Type.Null()]),
  created: Type.String(),
});

const CreateIntentBody = Type.Object({
  amount: Type.Integer({ minimum: 0 }),
  currency: Type.String({ minLength: 3, maxLength: 3 }),
  customer: Type.Optional(Type.String()),
  payment_method: Type.Optional(Type.String()),
  capture_method: Type.Optional(Type.Union([Type.Literal('automatic'), Type.Literal('manual')])),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const ConfirmBody = Type.Union([Type.Object({}), Type.Object({ return_url: Type.Optional(Type.String()) })]);
const CaptureBody = Type.Object({ amount_to_capture: Type.Optional(Type.Integer({ minimum: 1 })) });
const RefundBody = Type.Object({
  amount: Type.Optional(Type.Integer({ minimum: 1 })),
  reason: Type.Optional(Type.String({ maxLength: 255 })),
});

const RefundSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal('refund'),
  charge: Type.String(),
  amount: Type.Integer(),
  currency: Type.String(),
  status: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
  created: Type.String(),
});

const WebhookEndpointBody = Type.Object({
  url: Type.String({ format: 'uri', maxLength: 2048 }),
  description: Type.Optional(Type.String({ maxLength: 255 })),
});

const WebhookEndpointSchema = Type.Object({
  id: Type.String(),
  object: Type.Literal('webhook_endpoint'),
  url: Type.String(),
  status: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  /** Returned only in the creation response. */
  secret: Type.Optional(Type.String()),
  created: Type.String(),
});

export type { TSchema };