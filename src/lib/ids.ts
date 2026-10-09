import { randomBytes } from 'node:crypto';
import { invalidRequest } from './errors.js';

/**
 * Prefixed, unguessable, non-sequential IDs. Sequential IDs leak volume to
 * anyone holding one, and payment object IDs get pasted into support tickets
 * and URLs.
 */
const PREFIXES = [
  'acct', 'cus', 'pm', 'pi', 'pat', 'ch', 're', 'evt', 'we', 'whd',
  'le', 'la', 'key', 'req', 'pi_secret', 'sk_live', 'sk_test', 'cs',
  'rs', 'rr', 'rj', 'rb', 'rv',
] as const;

export type IdPrefix = (typeof PREFIXES)[number];

// Ambiguous glyphs (0/O, 1/l/I) removed: these IDs get read aloud on phone
// support calls.
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export function newId(prefix: IdPrefix, length = 24): string {
  return `${prefix}_${randomString(length)}`;
}

/** Customer-visible secret, used by the client to confirm an intent. */
export function newClientSecret(): string {
  return `${newId('pi_secret', 24)}_secret`;
}

/**
 * Raw unprefixed entropy, for secrets composed by the caller (webhook signing
 * secrets). Distinct from newId: those are identifiers, and an identifier is
 * only as strong as its prefix.
 */
export function randomSecret(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * API key secrets use a plain alphanumeric alphabet instead of base64url.
 * base64url emits '-' and '_', which makes a key awkward to retype from a
 * dashboard and easy to mangle in a shell, a header or a config file.
 */
export function randomKeyString(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

const SUPPORTED = new Set(['usd', 'eur', 'gbp', 'inr', 'jpy', 'krw', 'sgd', 'aud', 'cad', 'brl']);

/**
 * Currency exponents. Zero-decimal (JPY, KRW) and three-decimal (BHD, KWD)
 * currencies exist and getting this wrong is a 1000x error, so the exponent
 * is data rather than a hardcoded 2.
 */
const EXPONENTS: Record<string, number> = {
  usd: 2, eur: 2, gbp: 2, inr: 2, sgd: 2, aud: 2, cad: 2, brl: 2,
  jpy: 0, krw: 0,
  bhd: 3, kwd: 3, jod: 3, omr: 3, tnd: 3,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency.toLowerCase()] ?? 2;
}

export function isSupportedCurrency(currency: string): boolean {
  return SUPPORTED.has(currency.toLowerCase());
}

/** Smallest charge we accept. Filters out amounts that would round to zero. */
export const MIN_CHARGE: Record<string, number> = { usd: 50, eur: 50, gbp: 30, inr: 5000 };

export function minChargeFor(currency: string): number {
  return MIN_CHARGE[currency.toLowerCase()] ?? 50;
}

/** Refuse absurd amounts early: a 9-figure charge is a bug or an attack. */
export const MAX_CHARGE_MINOR = 999_999_99_99;

export function assertValidAmount(amount: number, currency: string): void {
  if (!Number.isInteger(amount)) {
    throw invalidRequest('Amount must be an integer in the currency minor unit.', 'parameter_invalid');
  }
  if (amount < 0) {
    throw invalidRequest('Amount must not be negative.', 'parameter_invalid');
  }
  if (amount > MAX_CHARGE_MINOR) {
    throw invalidRequest('Amount exceeds the maximum allowed.', 'amount_too_large');
  }
}
