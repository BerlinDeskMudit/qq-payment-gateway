import type { Db } from '../db/index.js';
import {
  ApiError, crossAccount, invalidRequest, invalidStateTransition, resourceMissing,
} from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import * as payments from '../payments/service.js';
import { emitEvents } from '../webhooks/events.js';

/**
 * Hosted Checkout sessions.
 *
 * A session is a time-boxed, unguessable capability to pay one payment
 * intent. Two audiences, two authentication models:
 *
 *   * the merchant API scopes every read and write by account id and
 *     authenticates with an API key;
 *   * the cardholder arrives from a link and has no key, so the session id
 *     itself is the credential. That is only safe because ids are prefixed,
 *     unguessable and expire — which is why `expires_at` is not optional and
 *     why an expired session stops rendering a payment form at all.
 *
 * The money stays on the payment intent. A session records what the customer
 * was shown and when the capability lapses; if it also recorded an amount
 * that disagreed with the intent, "what did they pay?" would have two answers.
 */

export type CheckoutStatus = 'open' | 'complete' | 'expired' | 'canceled';

export type LineItem = {
  name: string;
  quantity: number;
  unit_amount: number;
  description?: string;
};

export type CheckoutSessionRow = {
  id: string;
  account_id: string;
  payment_intent_id: string;
  customer_id: string | null;
  status: CheckoutStatus;
  line_items: LineItem[];
  amount: number | string;
  currency: string;
  success_url: string;
  cancel_url: string | null;
  expires_at: Date;
  metadata: Record<string, string>;
  livemode: boolean;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/** Session lifetime: long enough to complete a purchase, short enough that an abandoned link stops working. */
export const DEFAULT_EXPIRES_IN_SECONDS = 3_600;
export const MIN_EXPIRES_IN_SECONDS = 300;
export const MAX_EXPIRES_IN_SECONDS = 86_400;

export type CreateSessionInput = {
  accountId: string;
  currency?: string;
  lineItems?: LineItem[];
  paymentIntentId?: string;
  customerId?: string;
  successUrl: string;
  cancelUrl?: string;
  expiresIn?: number;
  metadata?: Record<string, string>;
};

function assertRedirectUrl(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidRequest(`${field} must be an absolute http(s) URL.`, 'parameter_invalid');
  }
  // A redirect target is attacker-controlled money: sending a cardholder to
  // javascript: or data: is script execution in a page that just asked for a
  // card number.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw invalidRequest(`${field} must use http or https.`, 'parameter_invalid');
  }
}

function validateLineItems(items: LineItem[]): void {
  if (items.length === 0) {
    throw invalidRequest('line_items must contain at least one item.', 'parameter_invalid');
  }
  if (items.length > 100) {
    throw invalidRequest('line_items may contain at most 100 items.', 'parameter_invalid');
  }
  for (const item of items) {
    if (typeof item.name !== 'string' || item.name.trim().length === 0 || item.name.length > 200) {
      throw invalidRequest('Each line item needs a name between 1 and 200 characters.', 'parameter_invalid');
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1_000) {
      throw invalidRequest(`Line item '${item.name}' has an invalid quantity.`, 'parameter_invalid');
    }
    if (!Number.isInteger(item.unit_amount) || item.unit_amount < 0) {
      throw invalidRequest(`Line item '${item.name}' has an invalid unit_amount.`, 'parameter_invalid');
    }
  }
}

export async function createSession(
  db: Db,
  input: CreateSessionInput,
): Promise<{ session: CheckoutSessionRow; intent: payments.PaymentIntentRow }> {
  if (input.lineItems && input.paymentIntentId) {
    throw invalidRequest('Provide either line_items or payment_intent, not both.', 'parameter_invalid');
  }
  if (!input.lineItems && !input.paymentIntentId) {
    throw invalidRequest('Provide either line_items or payment_intent.', 'parameter_missing');
  }
  assertRedirectUrl(input.successUrl, 'success_url');
  if (input.cancelUrl) assertRedirectUrl(input.cancelUrl, 'cancel_url');

  const expiresIn = input.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS;
  if (expiresIn < MIN_EXPIRES_IN_SECONDS || expiresIn > MAX_EXPIRES_IN_SECONDS) {
    throw invalidRequest(
      `expires_in must be between ${MIN_EXPIRES_IN_SECONDS} and ${MAX_EXPIRES_IN_SECONDS} seconds.`,
      'parameter_invalid',
    );
  }

  if (input.lineItems) validateLineItems(input.lineItems);

  return db.transaction(async (tx) => {
    // Generated first so the intent it creates can name it: a charge whose
    // description carries the session id is searchable in support.
    const sessionId = newId('cs', 24);
    let intent: payments.PaymentIntentRow;

    if (input.paymentIntentId) {
      intent = await payments.retrievePaymentIntent(tx, input.accountId, input.paymentIntentId);
      if (intent.status !== 'requires_payment_method' && intent.status !== 'requires_confirmation') {
        throw invalidStateTransition(intent.status, 'start a checkout session for', intent.id);
      }
    } else {
      const currency = (input.currency ?? '').toLowerCase();
      if (currency.length !== 3) {
        throw invalidRequest('currency is required when creating a session from line_items.', 'parameter_missing');
      }
      const total = input.lineItems!.reduce((sum, item) => sum + item.quantity * item.unit_amount, 0);
      intent = await payments.createPaymentIntent(tx, {
        accountId: input.accountId,
        amount: total,
        currency,
        // Description comes from the merchant when they gave one; otherwise
        // the session id, so a support agent can tie the charge to the cart.
        description: `Checkout session ${sessionId}`,
        metadata: input.metadata,
      });
    }

    // A vaulted method must belong to somebody. A merchant who did not name a
    // customer gets one, because the alternative is a hosted page that cannot
    // record a payment method at all.
    let customerId = input.customerId ?? intent.customer_id;
    if (input.customerId) {
      const { rowCount } = await tx.query(
        `SELECT 1 FROM customers WHERE id = $1 AND account_id = $2`,
        [input.customerId, input.accountId],
      );
      if (!rowCount) throw crossAccount('customer');
    }
    if (!customerId) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO customers (id, account_id, name) VALUES ($1, $2, $3) RETURNING id`,
        [newId('cus', 24), input.accountId, 'Checkout customer'],
      );
      customerId = rows[0]!.id;
      if (input.paymentIntentId) {
        await tx.query(
          `UPDATE payment_intents SET customer_id = $1, updated_at = now() WHERE id = $2 AND account_id = $3`,
          [customerId, intent.id, input.accountId],
        );
      }
    }

    const { rows } = await tx.query<CheckoutSessionRow>(
      `INSERT INTO checkout_sessions
         (id, account_id, payment_intent_id, customer_id, line_items, amount, currency,
          success_url, cancel_url, expires_at, metadata, livemode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10 || ' seconds')::interval, $11, $12)
       RETURNING *`,
      [
        sessionId, input.accountId, intent.id, customerId,
        JSON.stringify(input.lineItems ?? []),
        intent.amount, intent.currency,
        input.successUrl, input.cancelUrl ?? null, String(expiresIn),
        JSON.stringify(input.metadata ?? {}), intent.livemode,
      ],
    );
    const session = rows[0]!;

    await emitEvents(tx, input.accountId, [
      { type: 'checkout_session.created', object: session },
    ]);
    return { session, intent };
  });
}

/**
 * Flip an open session to expired once its deadline has passed.
 *
 * Expiry is applied on read rather than by a background sweep, so a session
 * cannot stay payable because a job did not run. There is a partial index on
 * open sessions for exactly this update.
 */
async function applyExpiry(db: Db, session: CheckoutSessionRow): Promise<CheckoutSessionRow> {
  if (session.status !== 'open' || session.expires_at.getTime() > Date.now()) return session;
  const { rows } = await db.query<CheckoutSessionRow>(
    `UPDATE checkout_sessions SET status = 'expired', updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING *`,
    [session.id],
  );
  // A concurrent request may have completed or expired it first; either way
  // the row it left behind is the truth.
  return rows[0] ?? session;
}

export async function retrieveSession(db: Db, accountId: string, sessionId: string): Promise<CheckoutSessionRow> {
  const { rows } = await db.query<CheckoutSessionRow>(
    `SELECT * FROM checkout_sessions WHERE id = $1 AND account_id = $2`,
    [sessionId, accountId],
  );
  if (!rows[0]) throw crossAccount('checkout session');
  return applyExpiry(db, rows[0]);
}

/**
 * Load a session for the hosted page, where possession of the id is the
 * credential. Unknown id and other-tenant id are the same 404: confirming
 * that a session exists is itself a leak.
 */
export async function loadHostedSession(db: Db, sessionId: string): Promise<CheckoutSessionRow> {
  const { rows } = await db.query<CheckoutSessionRow>(
    `SELECT * FROM checkout_sessions WHERE id = $1`,
    [sessionId],
  );
  if (!rows[0]) throw resourceMissing('checkout session', sessionId);
  return applyExpiry(db, rows[0]);
}

export type HostedContext = {
  session: CheckoutSessionRow;
  intent: payments.PaymentIntentRow;
  merchantName: string;
};

/** Session, its intent and the trading name to show, in one scoped read. */
export async function loadHostedContext(db: Db, sessionId: string): Promise<HostedContext> {
  const session = await loadHostedSession(db, sessionId);
  const intent = await payments.retrievePaymentIntent(db, session.account_id, session.payment_intent_id);
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM accounts WHERE id = $1`, [
    session.account_id,
  ]);
  return { session, intent, merchantName: rows[0]?.name ?? 'Merchant' };
}

/**
 * Mark a session complete and emit the event, in one transaction: an event
 * claiming Checkout finished while the row still says open would be a
 * consumer acting on a state that does not exist.
 */
export async function completeSession(db: Db, session: CheckoutSessionRow): Promise<CheckoutSessionRow> {
  if (session.status === 'complete') return session;
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<CheckoutSessionRow>(
      `UPDATE checkout_sessions
          SET status = 'complete', completed_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'complete'
        RETURNING *`,
      [session.id],
    );
    const updated = rows[0] ?? session;
    if (rows[0]) {
      await emitEvents(tx, session.account_id, [
        { type: 'checkout_session.completed', object: updated },
      ]);
    }
    return updated;
  });
}

/** The intent's own client secret: the session exists to pay that intent. */
export async function intentForSession(db: Db, session: CheckoutSessionRow): Promise<payments.PaymentIntentRow> {
  return payments.retrievePaymentIntent(db, session.account_id, session.payment_intent_id);
}

/**
 * Provider idempotency key for an attempt made from the hosted page.
 *
 * Derived from the number of attempts already recorded rather than from
 * anything the browser sends: a retried form post of the same attempt gets
 * the same key and cannot become a second authorization, while a genuinely
 * new attempt (a declined card, a challenge answer) gets a fresh one.
 */
export async function attemptKey(db: Db, sessionId: string, intentId: string): Promise<string> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM payment_attempts WHERE payment_intent_id = $1`,
    [intentId],
  );
  return `chk_${sessionId}_${Number(rows[0]?.n ?? 0) + 1}`;
}

/** Raised when a session can no longer be paid. Rendered as HTML by the page routes. */
export const sessionUnavailable = (message: string, status: number) =>
  new ApiError({ status, type: 'invalid_request_error', code: 'resource_missing', message });
