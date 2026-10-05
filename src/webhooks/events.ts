import type { Db } from '../db/index.js';
import { crossAccount } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

/**
 * Event emission and webhook fan-out.
 *
 * Events are the durable record; webhooks are a delivery attempt against it.
 * The separation matters: an endpoint that was down for an hour must not lose
 * the event, and a consumer must be able to replay by event id after it has
 * already acknowledged.
 *
 * Events are written inside the caller's transaction, so a rolled-back
 * payment leaves no event claiming it happened.
 */

export type EventType =
  | 'payment_intent.created'
  | 'payment_intent.succeeded'
  | 'payment_intent.canceled'
  | 'payment_intent.requires_action'
  | 'payment_intent.payment_failed'
  | 'charge.succeeded'
  | 'charge.refunded'
  | 'refund.created'
  | 'refund.succeeded'
  | 'refund.failed';

export type EventInput = { type: EventType; object: unknown };

export type EventRow = {
  id: string;
  account_id: string;
  type: EventType;
  api_version: string;
  data: { object: Record<string, unknown> };
  created_at: Date;
};

export const EVENT_RETENTION_DAYS = 30;

/**
 * Write events and queue a delivery per active endpoint. Must run inside the
 * transaction that made the change, so the event and its delivery cannot
 * disagree about whether the thing happened.
 */
export async function emitEvents(tx: Db, accountId: string, inputs: EventInput[]): Promise<EventRow[]> {
  const { rows: endpoints } = await tx.query<{ id: string }>(
    `SELECT id FROM webhook_endpoints WHERE account_id = $1 AND status = 'active'`, [accountId],
  );

  const written: EventRow[] = [];
  for (const input of inputs) {
    const id = newId('evt', 24);
    const { rows } = await tx.query<EventRow>(
      `INSERT INTO events (id, account_id, type, data)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, accountId, input.type, JSON.stringify({ object: normalize(input.object) })],
    );
    const event = rows[0]!;
    written.push(event);

    for (const endpoint of endpoints) {
      // Sequence is per endpoint, so a consumer can detect a gap even when
      // deliveries arrive out of order.
      const { rows: seqRows } = await tx.query<{ n: string }>(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM webhook_deliveries WHERE endpoint_id = $1`,
        [endpoint.id],
      );
      await tx.query(
        `INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event_id, status, sequence)
         VALUES ($1, $2, $3, $4, 'pending', $5)`,
        [newId('whd', 22), accountId, endpoint.id, event.id, seqRows[0]?.n ?? '1'],
      );
    }
  }
  return written;
}

/**
 * bigint columns arrive as strings, and a JSON body must carry numbers or
 * integrators' parsers quietly lose precision on large amounts.
 */
function normalize(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { value: value as never };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === null) {
      out[k] = v ?? null;
      continue;
    }
    out[k] = typeof v === 'bigint' || (typeof v === 'string' && /^-?\d{16,}$/.test(v))
      ? Number(v)
      : v instanceof Date
        ? v.toISOString()
        : v;
  }
  return out;
}

export async function listEvents(
  db: Db,
  accountId: string,
  opts: { limit?: number; type?: string; after?: string } = {},
): Promise<EventRow[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const { rows } = await db.query<EventRow>(
    `SELECT * FROM events
      WHERE account_id = $1
        AND ($2::text IS NULL OR type = $2::event_type)
        AND ($3::text IS NULL OR (created_at, id) > (
              SELECT created_at, id FROM events WHERE id = $3))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [accountId, opts.type ?? null, opts.after ?? null, limit],
  );
  return rows;
}

export async function retrieveEvent(db: Db, accountId: string, eventId: string): Promise<EventRow> {
  const { rows } = await db.query<EventRow>('SELECT * FROM events WHERE id = $1 AND account_id = $2', [
    eventId, accountId,
  ]);
  if (!rows[0]) throw crossAccount('event');
  return rows[0];
}

export async function purgeOldEvents(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM events WHERE created_at < now() - ($1 || ' days')::interval`, [String(EVENT_RETENTION_DAYS)],
  );
  return rowCount ?? 0;
}