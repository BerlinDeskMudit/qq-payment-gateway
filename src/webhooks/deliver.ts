import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import { asNumber } from '../ledger/ledger.js';
import type { EventRow } from './events.js';

/**
 * Webhook signing and delivery.
 *
 * Delivery is at-least-once, never exactly-once: the network cannot tell us
 * whether a 500 came from the handler or from a proxy after the handler ran.
 * So every event carries an id, and consumers are expected to de-duplicate.
 * Anything that promises exactly-once to a webhook consumer is lying.
 */

export const WEBHOOK_SIGNATURE_HEADER = 'qqpg-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'qqpg-timestamp';
export const WEBHOOK_ID_HEADER = 'qqpg-event-id';

/** Reject a replayed signature outside this window. */
export const TOLERANCE_SECONDS = 300;

export const MAX_ATTEMPTS = 8;

/**
 * Signed payload: `t=timestamp,v1=signature` over "{timestamp}.{body}".
 *
 * The timestamp is inside the signed string so an attacker cannot replay a
 * captured body under a fresh timestamp to slip past the tolerance check.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** Constant-time verification, for tests and for consumer examples. */
export function verifySignature(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = TOLERANCE_SECONDS,
  nowMs = Date.now(),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, ...rest] = p.trim().split('=');
      return [k ?? '', rest.join('=')] as const;
    }),
  );
  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Exponential backoff with full jitter. Jitter is not decoration: without it
 * every endpoint that failed during the same processor outage retries in
 * lockstep and re-creates the outage that caused it.
 */
export function backoffMs(attempt: number, random = Math.random): number {
  const capped = Math.min(attempt, 10);
  const ceiling = Math.min(60_000 * 2 ** (capped - 1), 24 * 60 * 60 * 1000);
  return Math.floor(random() * ceiling);
}

export type DeliveryRow = {
  id: string;
  account_id: string;
  endpoint_id: string;
  event_id: string;
  status: 'pending' | 'delivered' | 'failed' | 'dead';
  attempt_count: number;
  sequence: string | number;
  next_attempt_at: Date;
  last_status_code: number | null;
  last_error: string | null;
};

export type DeliveryTransport = (opts: {
  url: string;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
}) => Promise<{ status: number }>;

/** fetch with a hard timeout: a hung endpoint must not hold a worker forever. */
export function fetchTransport(timeoutMs = 10_000): DeliveryTransport {
  return async ({ url, body, headers, signal }) => {
    const res = await fetch(url, { method: 'POST', body, headers, signal });
    return { status: res.status };
  };
}

/** 2xx is success. A 410 means stop trying. */
function classify(status: number): 'delivered' | 'retry' | 'dead' {
  if (status >= 200 && status < 300) return 'delivered';
  if (status === 410) return 'dead';
  return 'retry';
}

export type DeliveryResult = {
  id: string;
  outcome: 'delivered' | 'retrying' | 'dead';
  statusCode: number | null;
  nextAttemptAt: Date | null;
};

/**
 * Claim a due delivery, deliver it, record the attempt. Called in a loop by
 * the worker. Claiming uses a conditional UPDATE so two workers cannot
 * deliver the same event concurrently.
 */
export async function deliverOne(
  db: Db,
  transport: DeliveryTransport,
  opts: { now?: Date; timeoutMs?: number } = {},
): Promise<DeliveryResult | null> {
  const now = opts.now ?? new Date();

  const claimed = await db.query<DeliveryRow>(
    `UPDATE webhook_deliveries
        SET last_attempt_at = now(), attempt_count = attempt_count + 1
      WHERE id = (
        SELECT id FROM webhook_deliveries
         WHERE status IN ('pending','failed') AND next_attempt_at <= $1
         ORDER BY next_attempt_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [now],
  );
  const delivery = claimed.rows[0];
  if (!delivery) return null;

  const { rows: joined } = await db.query<{ url: string; secret: string; status: string } & EventRow>(
    `SELECT ep.url, ep.secret, ep.status, e.*
       FROM webhook_endpoints ep
       JOIN events e ON e.id = $2
      WHERE ep.id = $1`,
    [delivery.endpoint_id, delivery.event_id],
  );
  const target = joined[0];
  if (!target) {
    await db.query(`UPDATE webhook_deliveries SET status = 'dead', last_error = 'endpoint deleted' WHERE id = $1`, [
      delivery.id,
    ]);
    return { id: delivery.id, outcome: 'dead', statusCode: null, nextAttemptAt: null };
  }
  if (target.status !== 'active') {
    // The merchant unsubscribed after this event was queued. Retrying anyway
    // would keep POSTing to an endpoint they asked us to stop using, so park
    // it as dead on the first look rather than burning the attempt budget.
    await db.query(
      `UPDATE webhook_deliveries SET status = 'dead', last_error = 'endpoint disabled' WHERE id = $1`,
      [delivery.id],
    );
    return { id: delivery.id, outcome: 'dead', statusCode: null, nextAttemptAt: null };
  }

  const attempt = asNumber(delivery.attempt_count);
  const payload = JSON.stringify({
    id: target.id,
    object: 'event',
    type: target.type,
    api_version: target.api_version,
    created: new Date(target.created_at).toISOString(),
    sequence: asNumber(delivery.sequence),
    data: target.data,
  });
  const timestamp = Math.floor(now.getTime() / 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const startedAt = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const res = await transport({
      url: target.url,
      body: payload,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'QQPaymentGateway-Webhooks/1.0',
        [WEBHOOK_SIGNATURE_HEADER]: signPayload(target.secret, timestamp, payload),
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        [WEBHOOK_ID_HEADER]: target.id,
      },
      signal: controller.signal,
    });
    statusCode = res.status;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;
  await db.query(
    `INSERT INTO webhook_delivery_attempts (delivery_id, attempt, status_code, error, duration_ms)
     VALUES ($1, $2, $3, $4, $5)`,
    [delivery.id, attempt, statusCode, error, durationMs],
  );

  if (!error && statusCode !== null && classify(statusCode) === 'delivered') {
    await db.query(
      `UPDATE webhook_deliveries
          SET status = 'delivered', last_status_code = $2, last_error = NULL
        WHERE id = $1`, [delivery.id, statusCode],
    );
    return { id: delivery.id, outcome: 'delivered', statusCode, nextAttemptAt: null };
  }

  if (error === null && statusCode !== null && classify(statusCode) === 'dead') {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'dead', last_status_code = $2, last_error = 'endpoint gone' WHERE id = $1`,
      [delivery.id, statusCode],
    );
    return { id: delivery.id, outcome: 'dead', statusCode, nextAttemptAt: null };
  }

  if (attempt >= MAX_ATTEMPTS) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'dead', last_status_code = $2, last_error = $3 WHERE id = $1`,
      [delivery.id, statusCode, error ?? `gave up after ${attempt} attempts`],
    );
    return { id: delivery.id, outcome: 'dead', statusCode, nextAttemptAt: null };
  }

  const delay = backoffMs(attempt);
  const nextAttemptAt = new Date(now.getTime() + delay);
  await db.query(
    `UPDATE webhook_deliveries
        SET status = 'failed', last_status_code = $2, last_error = $3, next_attempt_at = $4
      WHERE id = $1`,
    [delivery.id, statusCode, error ?? `http ${statusCode}`, nextAttemptAt],
  );
  return { id: delivery.id, outcome: 'retrying', statusCode, nextAttemptAt };
}

/** Drain the due queue. Bounded so one tick cannot run away. */
export async function deliverDueBatch(
  db: Db,
  transport: DeliveryTransport,
  max = 25,
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];
  for (let i = 0; i < max; i += 1) {
    const r = await deliverOne(db, transport);
    if (!r) break;
    results.push(r);
  }
  return results;
}

export async function listDeliveries(
  db: Db,
  accountId: string,
  endpointId?: string,
): Promise<DeliveryRow[]> {
  const { rows } = await db.query<DeliveryRow>(
    `SELECT * FROM webhook_deliveries
      WHERE account_id = $1 AND ($2::text IS NULL OR endpoint_id = $2)
      ORDER BY created_at DESC LIMIT 100`,
    [accountId, endpointId ?? null],
  );
  return rows;
}