import { timingSafeEqual, createHash } from 'node:crypto';
import type { Db } from '../db/index.js';
import {
  authenticationInvalid, authenticationRequired, crossAccount, permissionDenied,
} from '../lib/errors.js';
import { newId, randomKeyString } from '../lib/ids.js';

/**
 * API key authentication and account tenancy.
 *
 * Keys are stored as a SHA-256 hash, never in plaintext, so a database
 * disclosure does not hand an attacker working credentials. Lookup is by
 * prefix (which is not secret); verification compares hashes in constant time.
 */

export type Role = 'owner' | 'admin' | 'developer' | 'finance' | 'support' | 'viewer';

export type ApiKeyRow = {
  id: string;
  account_id: string;
  key_prefix: string;
  key_hash: string;
  scopes: string[];
  role: Role;
  status: 'active' | 'revoked';
  expires_at: Date | null;
  created_at: Date;
};

export type Principal = {
  apiKeyId: string;
  accountId: string;
  role: Role;
  scopes: string[];
};

/** Resource-level permissions per role. Fixed role set, deliberately. */
const ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner: ['*'],
  admin: ['*'],
  developer: [
    'charges:write', 'charges:read', 'customers:write', 'customers:read',
    'payment_intents:write', 'payment_intents:read', 'events:read',
    'webhooks:write', 'webhooks:read', 'balances:read',
  ],
  finance: [
    'charges:read', 'customers:read', 'payment_intents:read',
    'balances:read', 'refunds:write', 'refunds:read', 'payouts:write', 'payouts:read',
  ],
  support: ['charges:read', 'customers:read', 'payment_intents:read', 'events:read', 'webhooks:read'],
  viewer: ['charges:read', 'payment_intents:read', 'customers:read', 'balances:read'],
};

export function permissionsForRole(role: Role): string[] {
  return ROLE_PERMISSIONS[role];
}

export function roleCan(role: Role, permission: string): boolean {
  const perms = ROLE_PERMISSIONS[role];
  return perms.includes('*') || perms.includes(permission);
}

export function hashKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Keys carry a readable prefix so an operator can tell them apart in a list,
 * and the secret part is what actually authenticates.
 */
export function generateApiKey(livemode: boolean): { rawKey: string; keyPrefix: string } {
  const prefix = `${livemode ? 'sk_live' : 'sk_test'}_${randomKeyString(8)}`;
  const rawKey = `${prefix}_${randomKeyString(32)}`;
  return { rawKey, keyPrefix: prefix };
}

const KEY_PATTERN = /^(sk_(?:live|test)_[A-Za-z0-9]{8}_[A-Za-z0-9]{32})$/;

export async function createApiKey(
  db: Db,
  opts: { accountId: string; role: Role; livemode: boolean; expiresAt?: Date },
): Promise<{ id: string; rawKey: string; keyPrefix: string }> {
  const { rawKey, keyPrefix } = generateApiKey(opts.livemode);
  const id = newId('key', 20);
  await db.query(
    `INSERT INTO api_keys (id, account_id, key_prefix, key_hash, scopes, role, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, opts.accountId, keyPrefix, hashKey(rawKey), ROLE_PERMISSIONS[opts.role], opts.role, opts.expiresAt ?? null],
  );
  return { id, rawKey, keyPrefix };
}

export function extractKey(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) throw authenticationRequired();
  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) throw authenticationRequired();
  return rest.join(' ');
}

/**
 * Authenticate a raw key and return the principal. Rejects unknown, revoked
 * and expired keys with the same error, so the response does not tell an
 * attacker which half they got right.
 */
export async function authenticate(db: Db, authorizationHeader: string | undefined): Promise<Principal> {
  const rawKey = extractKey(authorizationHeader);
  if (!KEY_PATTERN.test(rawKey)) throw authenticationInvalid();

  const keyPrefix = rawKey.slice(0, rawKey.indexOf('_', 3) + 1 + 8);
  const { rows } = await db.query<ApiKeyRow>(
    `SELECT id, account_id, key_prefix, key_hash, scopes, role, status, expires_at, created_at
       FROM api_keys WHERE key_prefix = $1`,
    [keyPrefix],
  );

  const row = rows[0];
  if (!row) throw authenticationInvalid();

  // Constant-time comparison so response timing cannot be used to guess a hash.
  const provided = Buffer.from(hashKey(rawKey), 'hex');
  const stored = Buffer.from(row.key_hash, 'hex');
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) throw authenticationInvalid();

  if (row.status !== 'active') throw authenticationInvalid();
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) throw authenticationInvalid();

  return {
    apiKeyId: row.id,
    accountId: row.account_id,
    role: row.role,
    scopes: row.scopes ?? [],
  };
}

export function assertPermission(principal: Principal, permission: string): void {
  const allowed =
    principal.scopes.includes('*') ||
    principal.scopes.includes(permission) ||
    roleCan(principal.role, permission);
  if (!allowed) throw permissionDenied(`This API key lacks the '${permission}' scope.`);
}

/**
 * Scoped fetch: the account filter is part of the WHERE clause on every read,
 * so a missing tenancy check is not something a new endpoint can forget.
 * A row that belongs to another account is reported as missing, never as
 * forbidden, because confirming its existence is itself a leak.
 */
export async function scopedFetch<T>(
  db: Db,
  table: string,
  id: string,
  accountId: string,
  type: string,
): Promise<T> {
  const { rows } = await db.query<T>(
    `SELECT * FROM ${table} WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  if (!rows[0]) throw crossAccount(type);
  return rows[0];
}
