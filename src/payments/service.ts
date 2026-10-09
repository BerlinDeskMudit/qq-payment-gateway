import type { Db } from '../db/index.js';
import type { Principal } from '../auth/apiKey.js';
import type { Processor, ProcessorName } from '../processors/index.js';
import {
  ApiError, cardDeclined, crossAccount, internal, invalidRequest, invalidStateTransition,
} from '../lib/errors.js';
import {
  assertValidAmount, currencyExponent, isSupportedCurrency, minChargeFor, newClientSecret, newId,
} from '../lib/ids.js';
import { LedgerCode, postEntry } from '../ledger/ledger.js';
import { emitEvents } from '../webhooks/events.js';

export type IntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'requires_capture'
  | 'processing'
  | 'succeeded'
  | 'canceled';

export type PaymentIntentRow = {
  id: string;
  account_id: string;
  customer_id: string | null;
  amount: number | string;
  amount_captured: number | string;
  currency: string;
  status: IntentStatus;
  payment_method_id: string | null;
  capture_method: 'automatic' | 'manual';
  client_secret: string;
  description: string | null;
  metadata: Record<string, string>;
  ambiguous_since: Date | null;
  livemode: boolean;
  created_at: Date;
  updated_at: Date;
};

export type ChargeRow = {
  id: string;
  account_id: string;
  payment_intent_id: string;
  payment_attempt_id: string | null;
  customer_id: string | null;
  amount: number | string;
  amount_refunded: number | string;
  currency: string;
  status: 'succeeded' | 'refunded' | 'partially_refunded' | 'disputed';
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
};

/**
 * The state machine, as data. Illegal transitions are rejected because they
 * are not in this table, not because of scattered if-statements.
 *
 *   requires_payment_method ─ confirm ─┐
 *   requires_confirmation ────────────┴─> processing ─> succeeded
 *                          ├─> requires_action (3DS) ─> processing
 *                          └─> requires_capture (manual auth) ─> succeeded
 */
const TRANSITIONS: Record<IntentStatus, IntentStatus[]> = {
  requires_payment_method: ['requires_confirmation', 'canceled'],
  requires_confirmation: ['processing', 'requires_action', 'requires_capture', 'requires_payment_method', 'canceled'],
  requires_action: ['processing', 'requires_payment_method', 'canceled'],
  requires_capture: ['succeeded', 'processing', 'canceled'],
  processing: ['succeeded', 'requires_action', 'canceled'],
  succeeded: [],
  canceled: [],
};

export function canTransition(from: IntentStatus, to: IntentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Platform fee: 2.9% + 30c, the industry default. Configurable later via 0016. */
const FEE_BASIS_POINTS = 290;
const FEE_FIXED_MINOR = 30;

export function platformFee(amount: number, currency: string): number {
  return Math.round((amount * FEE_BASIS_POINTS) / 10_000) + FEE_FIXED_MINOR;
}

export type CreateIntentInput = {
  accountId: string;
  amount: number;
  currency: string;
  customerId?: string;
  paymentMethodId?: string;
  captureMethod?: 'automatic' | 'manual';
  description?: string;
  metadata?: Record<string, string>;
};

export async function createPaymentIntent(db: Db, input: CreateIntentInput): Promise<PaymentIntentRow> {
  const currency = input.currency.toLowerCase();
  if (!isSupportedCurrency(currency)) {
    throw invalidRequest(`Unsupported currency '${input.currency}'.`, 'currency_unsupported');
  }
  assertValidAmount(input.amount, currency);

  const min = minChargeFor(currency);
  if (input.amount < min) {
    throw new ApiError({
      status: 400,
      type: 'invalid_request_error',
      code: 'amount_too_small',
      message: `Amount must be at least ${min} ${currency.toUpperCase()} minor units (${currencyExponent(currency)} decimal places).`,
      extra: { minimum_amount: min, currency },
    });
  }

  if (input.customerId) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM customers WHERE id = $1 AND account_id = $2`, [input.customerId, input.accountId],
    );
    if (!rowCount) throw crossAccount('customer');
  }

  const id = newId('pi', 24);
  const clientSecret = newClientSecret();
  const status: IntentStatus = input.paymentMethodId ? 'requires_confirmation' : 'requires_payment_method';
  const livemode = await isLivemode(db, input.accountId);

  const { rows } = await db.query<PaymentIntentRow>(
    `INSERT INTO payment_intents
       (id, account_id, customer_id, amount, currency, status, payment_method_id,
        capture_method, client_secret, description, metadata, livemode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id, input.accountId, input.customerId ?? null, input.amount, currency, status,
      input.paymentMethodId ?? null, input.captureMethod ?? 'automatic', clientSecret,
      input.description ?? null, JSON.stringify(input.metadata ?? {}), livemode,
    ],
  );

  const intent = rows[0]!;
  await emitEvents(db, input.accountId, [
    { type: 'payment_intent.created', object: intent },
  ]);
  return intent;
}

async function isLivemode(db: Db, accountId: string): Promise<boolean> {
  const { rows } = await db.query<{ livemode: boolean }>('SELECT livemode FROM accounts WHERE id = $1', [accountId]);
  return rows[0]?.livemode ?? false;
}

async function loadIntent(db: Db, intentId: string, accountId: string): Promise<PaymentIntentRow> {
  const { rows } = await db.query<PaymentIntentRow>(
    `SELECT * FROM payment_intents WHERE id = $1 AND account_id = $2`, [intentId, accountId],
  );
  const row = rows[0];
  if (!row) throw crossAccount('payment_intent');
  return row;
}

async function assertTransition(
  intent: PaymentIntentRow,
  to: IntentStatus,
  action: string,
): Promise<void> {
  if (!canTransition(intent.status, to)) {
    throw invalidStateTransition(intent.status, action, intent.id);
  }
}

/**
 * Resolve the processor for this intent.
 *
 * Provider affinity: once an attempt has gone to a processor, every retry of
 * this intent goes back to the same one. Failing over to a second gateway
 * mid-payment is how one intent becomes two charges.
 */
async function resolveProcessor(
  db: Db,
  intent: PaymentIntentRow,
  registry: { pickDefault(): Processor; get(name: ProcessorName): Processor },
): Promise<{ processor: Processor; name: ProcessorName }> {
  const { rows } = await db.query<{ processor: ProcessorName }>(
    `SELECT processor FROM payment_attempts WHERE payment_intent_id = $1 ORDER BY attempt_number ASC LIMIT 1`,
    [intent.id],
  );
  const existing = rows[0];
  if (existing) return { processor: registry.get(existing.processor), name: existing.processor };
  const processor = registry.pickDefault();
  return { processor, name: processor.name };
}

async function loadPaymentMethodToken(db: Db, intent: PaymentIntentRow): Promise<string> {
  if (!intent.payment_method_id) {
    throw invalidRequest('This payment intent has no payment method.', 'parameter_missing');
  }
  const { rows } = await db.query<{ processor_token: string; status: string }>(
    `SELECT processor_token, status FROM payment_methods WHERE id = $1 AND account_id = $2`,
    [intent.payment_method_id, intent.account_id],
  );
  const pm = rows[0];
  if (!pm) throw crossAccount('payment_method');
  if (pm.status !== 'active') {
    throw invalidRequest('This payment method is no longer usable.', 'parameter_invalid');
  }
  return pm.processor_token;
}

export type ConfirmOptions = {
  db: Db;
  /**
   * The account the intent belongs to. Deliberately an account id rather
   * than an API-key principal: the only thing these functions use it for is
   * scoping their reads, and the hosted Checkout flow reaches them with a
   * session, not a key.
   */
  accountId: string;
  intentId: string;
  registry: { pickDefault(): Processor; get(name: ProcessorName): Processor };
  /** Distinguishes attempts; also the provider idempotency key. */
  idempotencyKey: string;
  /**
   * Outcome of an issuer challenge the cardholder has already answered.
   * See `Processor.authorize`: only a flow that actually rendered the
   * challenge may set this.
   */
  challengeResult?: 'passed';
};

/**
 * Confirm an intent: reserve, call the processor, post.
 *
 * The ledger reservation happens BEFORE the network call. Without it, an
 * authorization that succeeds at the processor and times out on our side is
 * an unrecorded hold, which is the exact failure that costs real money
 * during an incident.
 */
export async function confirmPaymentIntent(opts: ConfirmOptions): Promise<{ intent: PaymentIntentRow; charge?: ChargeRow }> {
  const { db, accountId, intentId, registry, idempotencyKey, challengeResult } = opts;

  // Phase 1: reserve inside our own ledger and claim the attempt. Committed
  // separately from the network call on purpose.
  const reservation = await db.transaction(async (tx) => {
    const intent = await loadIntent(tx, intentId, accountId);
    if (intent.status === 'requires_payment_method') {
      throw invalidStateTransition(intent.status, 'confirm', intent.id);
    }
    // A succeeded or canceled intent is terminal, and confirm is not a legal
    // action on it. Returning the old success here would be more forgiving,
    // but a retried request with a *different* idempotency key is a different
    // request and deserves a real answer, not a fake one. Retries of the same
    // request are handled by replaying the stored response, upstream.
    await assertTransition(intent, 'processing', 'confirm');

    const amount = Number(intent.amount);
    const { processor, name: processorName } = await resolveProcessor(tx, intent, registry);
    const { rows: countRows } = await tx.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM payment_attempts WHERE payment_intent_id = $1`, [intent.id],
    );
    const attemptNumber = Number(countRows[0]?.n ?? 0) + 1;
    const attemptId = newId('pat', 22);
    await tx.query(
      `INSERT INTO payment_attempts (id, payment_intent_id, account_id, attempt_number, status, processor)
       VALUES ($1, $2, $3, $4, 'pending', $5)`,
      [attemptId, intent.id, intent.account_id, attemptNumber, processorName],
    );

    // The hold is keyed by attempt, not by intent: an intent can be retried
    // after a decline, and each attempt genuinely holds its own money. Keying
    // by intent would make the second hold collide with the first and
    // silently vanish.
    await postEntry(tx, {
      accountId: intent.account_id,
      currency: intent.currency,
      sourceType: 'payment_attempt.hold_placed',
      sourceId: attemptId,
      effectiveAt: new Date(),
      memo: `authorization hold for ${intent.id} attempt ${attemptNumber}`,
      postings: [
        { code: LedgerCode.AUTHORIZATION_HOLDS, direction: 'debit', amount },
        { code: LedgerCode.MERCHANT_PENDING, direction: 'credit', amount },
      ],
    });

    const { rows } = await tx.query<PaymentIntentRow>(
      `UPDATE payment_intents SET status = 'processing', updated_at = now()
        WHERE id = $1 RETURNING *`, [intent.id],
    );
    return { intent: rows[0]!, attemptId, amount, processorName };
  });

  const { intent, attemptId, amount, processorName } = reservation;
  const processor = registry.get(processorName);
  const token = await loadPaymentMethodToken(db, intent);

  // Phase 2: the network call, outside any transaction of ours.
  const result = await processor.authorize({
    idempotencyKey,
    processorToken: token,
    amount,
    currency: intent.currency,
    ...(challengeResult ? { challengeResult } : {}),
  });

  // Phase 3: post the outcome.
  //
  // Note the shape: the transaction always COMMITS its bookkeeping, and the
  // error is raised afterwards. Throwing inside the callback would roll back
  // the attempt record and the hold release, leaving a permanently stuck hold
  // for a card that was in fact declined.
  let deferredError: ApiError | null = null;

  const outcome = await db.transaction(async (tx): Promise<{ intent: PaymentIntentRow; charge?: ChargeRow } | null> => {
    const current = await loadIntent(tx, intent.id, accountId);

    if (result.outcome === 'declined') {
      await tx.query(
        `UPDATE payment_attempts SET status = 'declined', decline_code = $2, decline_message = $3, completed_at = now()
          WHERE id = $1`,
        [attemptId, result.declineCode, result.declineMessage],
      );
      // Release the hold: a declined authorization holds no money.
      await releaseHold(tx, current, attemptId, 'authorization declined');
      const { rows } = await tx.query<PaymentIntentRow>(
        `UPDATE payment_intents SET status = 'requires_payment_method', updated_at = now()
          WHERE id = $1 RETURNING *`, [current.id],
      );
      const failed = rows[0]!;
      await emitEvents(tx, current.account_id, [
        { type: 'payment_intent.payment_failed', object: { ...failed, decline_code: result.declineCode } },
      ]);
      deferredError = cardDeclined(result.declineCode, result.declineMessage);
      return null;
    }

    if (result.outcome === 'requires_action') {
      await tx.query(
        `UPDATE payment_attempts SET status = 'requires_action', network_reference = $2, completed_at = now()
          WHERE id = $1`, [attemptId, result.networkReference],
      );
      const { rows } = await tx.query<PaymentIntentRow>(
        `UPDATE payment_intents SET status = 'requires_action', updated_at = now()
          WHERE id = $1 RETURNING *`, [current.id],
      );
      const action = rows[0]!;
      await emitEvents(tx, current.account_id, [
        { type: 'payment_intent.requires_action', object: { ...action, redirect_url: result.redirectUrl } },
      ]);
      return { intent: action };
    }

    if (result.outcome === 'error') {
      await tx.query(
        `UPDATE payment_attempts SET status = 'error', decline_code = $2, completed_at = now() WHERE id = $1`,
        [attemptId, result.errorCode],
      );
      // The processor call failed. The hold stays until we know the truth:
      // an UNKNOWN state is honest, silently releasing it is not. A sweeper
      // reconciles intents whose ambiguity is older than its budget.
      await tx.query(
        `UPDATE payment_intents SET ambiguous_since = COALESCE(ambiguous_since, now()), updated_at = now()
          WHERE id = $1`, [current.id],
      );
      deferredError = new ApiError({
        status: 502,
        type: 'api_error',
        code: 'processing_error',
        message: 'The payment processor did not respond. The request is safe to retry with the same idempotency key.',
        retryable: true,
      });
      return null;
    }

    // Approved.
    await tx.query(
      `UPDATE payment_attempts SET status = 'authorized', network_reference = $2, completed_at = now()
        WHERE id = $1`, [attemptId, result.networkReference],
    );

    const chargeId = newId('ch', 22);
    const chargeStatus = current.capture_method === 'automatic' ? 'succeeded' : 'authorized';
    const { rows: chargeRows } = await tx.query<ChargeRow>(
      `INSERT INTO charges
         (id, account_id, payment_intent_id, payment_attempt_id, customer_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [chargeId, current.account_id, current.id, attemptId, current.customer_id, amount, current.currency, chargeStatus],
    );
    const charge = chargeRows[0]!;

    if (current.capture_method === 'automatic') {
      await settleCapture(tx, current, charge, amount);
      const { rows } = await tx.query<PaymentIntentRow>(
        `UPDATE payment_intents SET status = 'succeeded', amount_captured = $2, updated_at = now()
          WHERE id = $1 RETURNING *`, [current.id, amount],
      );
      const succeeded = rows[0]!;
      await emitEvents(tx, current.account_id, [
        { type: 'charge.succeeded', object: charge },
        { type: 'payment_intent.succeeded', object: succeeded },
      ]);
      return { intent: succeeded, charge };
    }

    // Manual capture: authorized, funds held, not yet ours to spend. The
    // intent waits in 'requires_capture' rather than 'requires_action',
    // because nothing is being asked of the cardholder here.
    const { rows } = await tx.query<PaymentIntentRow>(
      `UPDATE payment_intents SET status = 'requires_capture', updated_at = now()
        WHERE id = $1 RETURNING *`, [current.id],
    );
    const awaiting = rows[0]!;
    await emitEvents(tx, current.account_id, [
      { type: 'payment_intent.requires_action', object: awaiting },
    ]);
    return { intent: awaiting, charge };
  });

  if (deferredError) throw deferredError;
  if (!outcome) throw internal('Authorization outcome was neither recorded nor rejected.');
  return outcome;
}

/** Manual capture of an already-authorized amount, full or partial. */
export async function capturePaymentIntent(
  opts: ConfirmOptions & { amount?: number },
): Promise<{ intent: PaymentIntentRow; charge: ChargeRow }> {
  const { db, accountId, intentId, registry, amount: requested } = opts;
  const intent = await loadIntent(db, intentId, accountId);
  if (intent.status !== 'requires_capture' || intent.capture_method !== 'manual') {
    throw invalidStateTransition(intent.status, 'capture', intent.id);
  }

  const remaining = Number(intent.amount) - Number(intent.amount_captured);
  const amount = requested ?? remaining;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw invalidRequest('Capture amount must be a positive integer.', 'parameter_invalid');
  }
  if (amount > remaining) {
    throw invalidRequest(
      `Cannot capture ${amount}; only ${remaining} remains authorized.`, 'parameter_invalid',
    );
  }

  const processor = registry.get(await firstProcessorFor(db, intentId));
  const captureResult = await processor.capture({
    idempotencyKey: `${opts.idempotencyKey}:capture`,
    networkReference: intent.id,
    amount,
    currency: intent.currency,
  });
  if (captureResult.outcome === 'capture_failed') {
    throw new ApiError({
      status: 402,
      type: 'api_error',
      code: 'processing_error',
      message: `Capture failed: ${captureResult.errorCode}`,
      retryable: captureResult.retryable,
    });
  }

  return db.transaction(async (tx) => {
    const current = await loadIntent(tx, intentId, accountId);
    if (current.status !== 'requires_capture') {
      throw invalidStateTransition(current.status, 'capture', current.id);
    }
    const { rows: chargeRows } = await tx.query<ChargeRow>(
      `SELECT * FROM charges WHERE payment_intent_id = $1 AND status = 'authorized' ORDER BY created_at DESC LIMIT 1`,
      [intentId],
    );
    const charge = chargeRows[0];
    if (!charge) throw internal(`No authorized charge for intent ${intentId}.`);

    await settleCapture(tx, current, charge, amount);
    const { rows: updatedChargeRows } = await tx.query<ChargeRow>(
      `UPDATE charges SET status = 'succeeded' WHERE id = $1 RETURNING *`, [charge.id],
    );

    const newCaptured = Number(current.amount_captured) + amount;
    const done = newCaptured >= Number(current.amount);
    const { rows } = await tx.query<PaymentIntentRow>(
      `UPDATE payment_intents
          SET amount_captured = $2, status = $3, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [intentId, newCaptured, done ? 'succeeded' : 'requires_capture'],
    );
    const updated = rows[0]!;

    await emitEvents(tx, accountId, [{ type: 'charge.succeeded', object: updatedChargeRows[0]! }]);
    if (done) {
      await emitEvents(tx, accountId, [{ type: 'payment_intent.succeeded', object: updated }]);
    }
    return { intent: updated, charge: updatedChargeRows[0]! };
  });
}

/** The processor that received this intent first. Captures must follow it. */
async function firstProcessorFor(db: Db, intentId: string): Promise<ProcessorName> {
  const { rows } = await db.query<{ processor: ProcessorName }>(
    `SELECT processor FROM payment_attempts WHERE payment_intent_id = $1 ORDER BY attempt_number ASC LIMIT 1`,
    [intentId],
  );
  const name = rows[0]?.processor;
  if (!name) throw internal(`No processor recorded for intent ${intentId}.`);
  return name;
}

export async function cancelPaymentIntent(opts: ConfirmOptions): Promise<PaymentIntentRow> {
  const { db, accountId, intentId } = opts;
  return db.transaction(async (tx) => {
    const intent = await loadIntent(tx, intentId, accountId);
    if (intent.status === 'canceled') return intent;
    await assertTransition(intent, 'canceled', 'cancel');

    // Only an attempt that actually holds money needs the hold unwound, and
    // only once: releasing an already-released attempt would double the credit.
    const { rows: openAttempts } = await tx.query<{ id: string }>(
      `SELECT id FROM payment_attempts
        WHERE payment_intent_id = $1 AND status IN ('pending','authorized','requires_action')`,
      [intentId],
    );
    for (const attempt of openAttempts) {
      const { rowCount } = await tx.query<{ id: string }>(
        `SELECT 1 AS id FROM ledger_entries
          WHERE account_id = $1 AND source_type = 'payment_attempt.hold_released' AND source_id = $2`,
        [intent.account_id, attempt.id],
      );
      if (!rowCount) {
        await releaseHold(tx, intent, attempt.id, 'intent canceled before capture');
        await tx.query(
          `UPDATE payment_attempts SET status = 'abandoned', completed_at = now() WHERE id = $1`, [attempt.id],
        );
      }
    }

    const { rows } = await tx.query<PaymentIntentRow>(
      `UPDATE payment_intents SET status = 'canceled', updated_at = now() WHERE id = $1 RETURNING *`,
      [intentId],
    );
    const canceled = rows[0]!;
    await emitEvents(tx, accountId, [{ type: 'payment_intent.canceled', object: canceled }]);
    return canceled;
  });
}

/**
 * Turn an authorization hold into real money and split out our fee.
 *
 * Two entries rather than one, because "the processor gave us cash" and "the
 * merchant earned X net" are different facts with different reconciliation
 * requirements. One combined entry would make a fee dispute a cash dispute.
 */
async function settleCapture(
  tx: Db,
  intent: PaymentIntentRow,
  charge: ChargeRow,
  amount: number,
): Promise<void> {
  await postEntry(tx, {
    accountId: intent.account_id,
    currency: intent.currency,
    sourceType: 'charge.processor_settled',
    sourceId: charge.id,
    memo: `cash received from processor for ${charge.id}`,
    postings: [
      { code: LedgerCode.PROCESSOR_CLEARING, direction: 'debit', amount },
      { code: LedgerCode.AUTHORIZATION_HOLDS, direction: 'credit', amount },
    ],
  });

  const fee = platformFee(amount, intent.currency);
  const net = amount - fee;
  await postEntry(tx, {
    accountId: intent.account_id,
    currency: intent.currency,
    sourceType: 'charge.captured',
    sourceId: charge.id,
    memo: `net ${net} to merchant, fee ${fee}`,
    postings: [
      { code: LedgerCode.MERCHANT_PENDING, direction: 'debit', amount },
      { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'credit', amount: net },
      { code: LedgerCode.PLATFORM_FEE_REVENUE, direction: 'credit', amount: fee },
    ],
  });
}

/**
 * Release an authorization hold back to the processor.
 *
 * Keyed by attempt: an intent can be declined several times, each decline
 * releasing its own attempt's hold. Reusing the intent id here would collide
 * with the earlier release and silently drop the second one, which is exactly
 * the kind of bug that leaves a merchant's money stuck.
 */
async function releaseHold(
  tx: Db,
  intent: PaymentIntentRow,
  attemptId: string,
  memo: string,
): Promise<void> {
  const amount = Number(intent.amount);
  await postEntry(tx, {
    accountId: intent.account_id,
    currency: intent.currency,
    sourceType: 'payment_attempt.hold_released',
    sourceId: attemptId,
    memo,
    postings: [
      { code: LedgerCode.AUTHORIZATION_HOLDS, direction: 'credit', amount },
      { code: LedgerCode.MERCHANT_PENDING, direction: 'debit', amount },
    ],
  });
}

export async function retrievePaymentIntent(db: Db, accountId: string, intentId: string): Promise<PaymentIntentRow> {
  return loadIntent(db, intentId, accountId);
}

/**
 * Attach the method the customer just chose, at confirmation time.
 *
 * Checkout collects payment details after the intent exists, so this is the
 * only place an intent learns its payment method besides creation. It is
 * refused on an intent that is already awaiting a challenge or a capture:
 * swapping the method there would silently drop the state the cardholder or
 * the merchant is waiting on.
 */
export async function attachPaymentMethod(
  db: Db,
  input: { accountId: string; intentId: string; paymentMethodId: string },
): Promise<PaymentIntentRow> {
  return db.transaction(async (tx) => {
    const intent = await loadIntent(tx, input.intentId, input.accountId);
    if (intent.status !== 'requires_payment_method' && intent.status !== 'requires_confirmation') {
      throw invalidStateTransition(intent.status, 'attach a payment method to', intent.id);
    }

    // Cross-account method: the FK would accept another merchant's id, so the
    // tenancy check is here rather than in the constraint.
    const { rowCount } = await tx.query(
      `SELECT 1 FROM payment_methods WHERE id = $1 AND account_id = $2`,
      [input.paymentMethodId, input.accountId],
    );
    if (!rowCount) throw crossAccount('payment_method');

    const { rows } = await tx.query<PaymentIntentRow>(
      `UPDATE payment_intents
          SET payment_method_id = $1, status = 'requires_confirmation', updated_at = now()
        WHERE id = $2 AND account_id = $3
        RETURNING *`,
      [input.paymentMethodId, input.intentId, input.accountId],
    );
    return rows[0]!;
  });
}

export async function listCharges(
  db: Db,
  accountId: string,
  opts: { limit?: number; customerId?: string } = {},
): Promise<ChargeRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const { rows } = await db.query<ChargeRow>(
    `SELECT * FROM charges
      WHERE account_id = $1
        AND ($2::text IS NULL OR customer_id = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [accountId, opts.customerId ?? null, limit],
  );
  return rows;
}

export async function retrieveCharge(db: Db, accountId: string, chargeId: string): Promise<ChargeRow> {
  const { rows } = await db.query<ChargeRow>('SELECT * FROM charges WHERE id = $1 AND account_id = $2', [
    chargeId, accountId,
  ]);
  if (!rows[0]) throw crossAccount('charge');
  return rows[0];
}

export type RefundResultRow = {
  id: string;
  charge_id: string;
  amount: number | string;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'canceled';
  reason: string | null;
  created_at: Date;
};

export async function createRefund(
  opts: { db: Db; principal: Principal; chargeId: string; amount?: number; reason?: string; idempotencyKey: string; registry: { pickDefault(): Processor } },
): Promise<RefundResultRow> {
  const { db, principal, chargeId, amount: requested, reason, idempotencyKey, registry } = opts;
  const charge = await retrieveCharge(db, principal.accountId, chargeId);

  const refundable = Number(charge.amount) - Number(charge.amount_refunded);
  const amount = requested ?? refundable;
  if (!Number.isInteger(amount) || amount <= 0) throw invalidRequest('Refund amount must be a positive integer.', 'parameter_invalid');
  if (amount > refundable) {
    throw invalidRequest(
      `Cannot refund ${amount}; only ${refundable} remains refundable on ${chargeId}.`,
      'parameter_invalid',
    );
  }

  const processor = registry.pickDefault();
  const refundId = newId('re', 22);
  const processorResult = await processor.refund({
    idempotencyKey,
    networkReference: charge.id,
    amount,
    currency: charge.currency,
  });

  if (processorResult.outcome === 'refund_failed') {
    await db.query(
      `INSERT INTO refunds (id, account_id, charge_id, amount, currency, status, reason, processor, failure_code)
       VALUES ($1, $2, $3, $4, $5, 'failed', $6, $7, $8)`,
      [refundId, principal.accountId, chargeId, amount, charge.currency, reason ?? null, processor.name, processorResult.errorCode],
    );
    throw new ApiError({
      status: 402, type: 'api_error', code: 'processing_error',
      message: `Refund failed: ${processorResult.errorCode}`, retryable: processorResult.retryable,
    });
  }

  return db.transaction(async (tx) => {
    const { rows } = await tx.query<RefundResultRow>(
      `INSERT INTO refunds (id, account_id, charge_id, amount, currency, status, reason, processor, processor_reference, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, $7, $8, now())
       RETURNING id, charge_id, amount, currency, status, reason, created_at`,
      [refundId, principal.accountId, chargeId, amount, charge.currency, reason ?? null, processor.name, processorResult.networkReference],
    );
    const refund = rows[0]!;

    const newRefunded = Number(charge.amount_refunded) + amount;
    const fully = newRefunded >= Number(charge.amount);
    await tx.query(
      `UPDATE charges SET amount_refunded = $2, status = $3 WHERE id = $1`,
      [chargeId, newRefunded, fully ? 'refunded' : 'partially_refunded'],
    );

    // A refund is a new, balanced movement. The original capture entry is
    // never rewritten, per the Sagas principle: compensation is a semantic
    // action, not a rollback.
    //
    // The fee reversed is the ORIGINAL fee on the charge, prorated to this
    // refund. Recomputing a fee from the refund amount and then prorating that
    // reverses a fraction of a fraction, and quietly hands the merchant back
    // fee income we never took.
    const originalFee = platformFee(Number(charge.amount), charge.currency);
    const feeShare = Number(charge.amount) > 0
      ? Math.round((originalFee * amount) / Number(charge.amount))
      : 0;
    const merchantShare = amount - feeShare;
    await postEntry(tx, {
      accountId: principal.accountId,
      currency: charge.currency,
      sourceType: 'refund.settled',
      sourceId: refund.id,
      memo: `refund of ${amount} on ${chargeId}`,
      postings: [
        { code: LedgerCode.PROCESSOR_CLEARING, direction: 'credit', amount },
        { code: LedgerCode.MERCHANT_AVAILABLE, direction: 'debit', amount: merchantShare },
        { code: LedgerCode.PLATFORM_FEE_REVENUE, direction: 'debit', amount: feeShare },
      ],
    });

    await emitEvents(tx, principal.accountId, [
      { type: 'refund.succeeded', object: refund },
      { type: 'charge.refunded', object: { ...charge, amount_refunded: newRefunded } },
    ]);
    return refund;
  });
}

export async function retrieveBalanceSummary(db: Db, accountId: string) {
  const { rows } = await db.query<{ code: string; currency: string; balance: string | number }>(
    `SELECT code, currency, balance FROM ledger_balances
      WHERE account_id = $1 AND balance <> 0 ORDER BY currency, code`,
    [accountId],
  );
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const perCurrency = out.get(r.currency) ?? {};
    perCurrency[r.code] = Number(r.balance);
    out.set(r.currency, perCurrency);
  }
  return Object.fromEntries(out);
}
