import { createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import { idempotencyInProgress, idempotencyKeyReuse } from '../lib/errors.js';

/**
 * Idempotency keys, per merchant account.
 *
 * Guarantees:
 *   - the first response for a key is stored and replayed byte-identically,
 *     including failures, for 24 hours
 *   - the same key with a different request body is a client bug (409)
 *   - concurrent requests on one key are serialized: the second caller waits
 *     briefly for the first rather than executing the operation twice
 */

export const IDEMPOTENCY_RETENTION_HOURS = 24;

/** How long a caller waits for an in-flight request holding the same key. */
const WAIT_BUDGET_MS = 2_000;
const POLL_INTERVAL_MS = 25;

/**
 * Stable fingerprint of the request. Key order must not matter, so we
 * canonicalize before hashing, otherwise a client that serializes its JSON
 * differently gets a spurious 409.
 */
export function fingerprintRequest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export type Claim =
  /** We own this key. Run the operation, then call complete(). */
  | { status: 'claimed' }
  /** Someone already ran this. Replay their stored response. */
  | { status: 'replay'; responseStatus: number; responseBody: unknown };

/**
 * Attempt to claim a key. Returns 'claimed' if this caller should do the
 * work, or 'replay' with the stored response if it has already been done.
 */
export async function claimIdempotencyKey(
  db: Db,
  accountId: string,
  key: string,
  fingerprint: string,
): Promise<Claim> {
  const deadline = Date.now() + WAIT_BUDGET_MS;

  for (;;) {
    // ON CONFLICT DO NOTHING makes the insert itself the claim: exactly one
    // caller can win the primary key, so there is no check-then-act race.
    const { rowCount } = await db.query(
      `INSERT INTO idempotency_keys (account_id, key, fingerprint, state)
       VALUES ($1, $2, $3, 'in_progress')
       ON CONFLICT (account_id, key) DO NOTHING`,
      [accountId, key, fingerprint],
    );

    if (rowCount === 1) return { status: 'claimed' };

    const existing = await db.query<{
      fingerprint: string;
      state: 'in_progress' | 'completed';
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT fingerprint, state, response_status, response_body
         FROM idempotency_keys WHERE account_id = $1 AND key = $2`,
      [accountId, key],
    );

    const row = existing.rows[0];
    // Vanished between our failed insert and the read: the holder deleted or
    // it expired. Treat as in-progress and let the caller retry.
    if (!row) {
      if (Date.now() > deadline) throw idempotencyInProgress();
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (row.fingerprint !== fingerprint) throw idempotencyKeyReuse();

    if (row.state === 'completed') {
      return {
        status: 'replay',
        responseStatus: row.response_status ?? 200,
        responseBody: row.response_body,
      };
    }

    if (Date.now() > deadline) throw idempotencyInProgress();
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Store the response so a retry replays it instead of re-executing. */
export async function completeIdempotencyKey(
  db: Db,
  accountId: string,
  key: string,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys
        SET state = 'completed', response_status = $3, response_body = $4, completed_at = now()
      WHERE account_id = $1 AND key = $2`,
    [accountId, key, responseStatus, JSON.stringify(responseBody)],
  );
}

/**
 * Release a claim without recording a response, so a failed request can be
 * retried with the same key. Used when the operation failed before producing
 * a durable result; a failure that did produce one must be replayed instead.
 */
export async function abandonIdempotencyKey(db: Db, accountId: string, key: string): Promise<void> {
  await db.query(`DELETE FROM idempotency_keys WHERE account_id = $1 AND key = $2 AND state = 'in_progress'`, [
    accountId,
    key,
  ]);
}

export async function purgeExpiredIdempotencyKeys(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval`,
    [String(IDEMPOTENCY_RETENTION_HOURS)],
  );
  return rowCount ?? 0;
}
