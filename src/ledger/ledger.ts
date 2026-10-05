import type { Db } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { internal } from '../lib/errors.js';

/**
 * Append-only double-entry journal.
 *
 * Invariant, enforced by a deferred constraint trigger in Postgres and
 * re-checked here: total debits equal total credits within an entry.
 * No code path can post an unbalanced entry.
 *
 * Correction is never an UPDATE. A mistake is fixed by posting a new entry
 * that reverses the original, and both rows stay in history forever.
 */

export type LedgerAccountType = 'asset' | 'liability' | 'revenue' | 'expense';

/** Canonical account codes. Anything not here is a bug, not a new account. */
export const LedgerCode = {
  /** Claim we hold against the card network for an authorized-but-unsettled charge. */
  AUTHORIZATION_HOLDS: 'authorization_holds',
  /** Money sitting at the processor that we can draw down. */
  PROCESSOR_CLEARING: 'processor_clearing',
  /** Money at the processor not yet available to settle. */
  PROCESSOR_PENDING: 'processor_pending',
  /** Owed to the merchant but on hold (authorization, dispute, reserve). */
  MERCHANT_PENDING: 'merchant_pending',
  /** Owed to the merchant and drawable. */
  MERCHANT_AVAILABLE: 'merchant_available',
  /** Owed back to a cardholder for a refund we have not yet settled. */
  REFUNDS_PAYABLE: 'refunds_payable',
  /** Held against disputes until representment resolves. */
  CHARGEBACK_RESERVE: 'chargeback_reserve',
  PLATFORM_FEE_REVENUE: 'platform_fee_revenue',
  PAYMENT_FEE_REVENUE: 'payment_fee_revenue',
  PAYOUT_FEE_REVENUE: 'payout_fee_revenue',
  FX_FEE_REVENUE: 'fx_fee_revenue',
  INTERNATIONAL_FEE_REVENUE: 'international_fee_revenue',
  /** Buffer for FX movements so the per-currency invariant stays truthful. */
  FX_RESERVE: 'fx_reserve',
  /** Cost side: what the processor charges us. Accrued as incurred. */
  PROCESSOR_COST: 'processor_cost',
} as const;

export type LedgerCodeValue = (typeof LedgerCode)[keyof typeof LedgerCode];

const ACCOUNT_TYPES: Record<LedgerCodeValue, LedgerAccountType> = {
  authorization_holds: 'asset',
  processor_clearing: 'asset',
  processor_pending: 'asset',
  merchant_pending: 'liability',
  merchant_available: 'liability',
  refunds_payable: 'liability',
  chargeback_reserve: 'asset',
  platform_fee_revenue: 'revenue',
  payment_fee_revenue: 'revenue',
  payout_fee_revenue: 'revenue',
  fx_fee_revenue: 'revenue',
  international_fee_revenue: 'revenue',
  fx_reserve: 'asset',
  processor_cost: 'expense',
};

export type Direction = 'debit' | 'credit';

export type Posting = {
  code: LedgerCodeValue;
  direction: Direction;
  amount: number;
};

export type PostEntryInput = {
  /** Merchant account the entry belongs to. */
  accountId: string;
  currency: string;
  /** Business time. Late-arriving network events backdate this. */
  effectiveAt?: Date;
  /** What caused this: charge, refund, payout, fee. */
  sourceType: string;
  sourceId: string;
  memo?: string;
  postings: Posting[];
};

export type LedgerEntryRow = {
  id: string;
  account_id: string;
  currency: string;
  effective_at: Date;
  recorded_at: Date;
  source_type: string;
  source_id: string;
  memo: string | null;
};

/** Postgres returns bigint/int8 as a string. Never trust the JS type. */
export function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  if (typeof value === 'bigint') return Number(value);
  throw internal(`Expected a numeric value, got ${typeof value}.`);
}

async function ensureLedgerAccount(
  tx: Db,
  accountId: string,
  code: LedgerCodeValue,
  currency: string,
): Promise<string> {
  const type = ACCOUNT_TYPES[code];
  if (!type) throw internal(`Unknown ledger code '${code}'.`);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ledger_accounts (id, account_id, code, type, currency)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, code, currency) DO UPDATE SET code = EXCLUDED.code
     RETURNING id`,
    [newId('la', 20), accountId, code, type, currency],
  );
  const row = rows[0];
  if (!row) throw internal('Failed to create ledger account.');
  return row.id;
}

/**
 * Post a balanced journal entry. Must run inside a transaction; the caller
 * owns the commit so that ledger writes commit atomically with the business
 * rows that caused them.
 *
 * Rejects an unbalanced entry rather than trusting the caller. The database
 * trigger would catch it too, but catching it here produces a useful message
 * instead of a constraint-violation string.
 */
export async function postEntry(tx: Db, input: PostEntryInput): Promise<LedgerEntryRow> {
  const { accountId, currency, sourceType, sourceId, memo, postings } = input;

  if (postings.length < 2) {
    throw internal(`Ledger entry for ${sourceType}:${sourceId} needs at least two legs.`);
  }

  let debits = 0;
  let credits = 0;
  for (const p of postings) {
    if (!Number.isInteger(p.amount) || p.amount <= 0) {
      throw internal(`Ledger leg amount must be a positive integer, got ${p.amount}.`);
    }
    if (p.direction === 'debit') debits += p.amount;
    else credits += p.amount;
  }
  if (debits !== credits) {
    throw internal(
      `Unbalanced ledger entry for ${sourceType}:${sourceId}: debits ${debits} != credits ${credits}.`,
    );
  }

  const entryId = newId('le', 22);
  const effectiveAt = input.effectiveAt ?? new Date();

  const inserted = await tx.query<LedgerEntryRow>(
    `INSERT INTO ledger_entries (id, account_id, effective_at, source_type, source_id, memo)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_id, source_type, source_id) DO NOTHING
     RETURNING id, account_id, effective_at, recorded_at, source_type, source_id, memo`,
    [entryId, accountId, effectiveAt, sourceType, sourceId, memo ?? null],
  );

  // A duplicated source already posted its entry. Returning the original is
  // what makes a replayed processor callback safe.
  const row = inserted.rows[0];
  if (!row) {
    const existing = await tx.query<LedgerEntryRow>(
      `SELECT id, account_id, effective_at, recorded_at, source_type, source_id, memo
         FROM ledger_entries WHERE account_id = $1 AND source_type = $2 AND source_id = $3`,
      [accountId, sourceType, sourceId],
    );
    const found = existing.rows[0];
    if (!found) throw internal('Ledger entry disappeared during deduplication.');
    return found;
  }

  // Resolve accounts first, then insert legs. UNIQUE(entry_id, ledger_account_id)
  // means one leg per account per entry, so merge duplicates by code.
  const byAccount = new Map<string, { id: string; debit: number; credit: number }>();
  for (const p of postings) {
    const id = await ensureLedgerAccount(tx, accountId, p.code, currency);
    const acc = byAccount.get(id) ?? { id, debit: 0, credit: 0 };
    if (p.direction === 'debit') acc.debit += p.amount;
    else acc.credit += p.amount;
    byAccount.set(id, acc);
  }

  for (const acc of byAccount.values()) {
    // The same account can appear on both sides of an entry. UNIQUE(entry_id,
    // ledger_account_id) permits one leg per account, so net the two sides
    // into whichever direction is larger. Totals are unchanged, so the
    // zero-sum invariant still holds.
    if (acc.debit > 0 && acc.credit > 0) {
      const net = acc.debit - acc.credit;
      if (net > 0) {
        await tx.query(
          `INSERT INTO ledger_legs (entry_id, ledger_account_id, amount, direction)
           VALUES ($1, $2, $3, 'debit')`,
          [entryId, acc.id, net],
        );
      } else if (net < 0) {
        await tx.query(
          `INSERT INTO ledger_legs (entry_id, ledger_account_id, amount, direction)
           VALUES ($1, $2, $3, 'credit')`,
          [entryId, acc.id, -net],
        );
      }
      // net === 0 means the entry does not touch this account at all.
      continue;
    }

    if (acc.debit > 0) {
      await tx.query(
        `INSERT INTO ledger_legs (entry_id, ledger_account_id, amount, direction)
         VALUES ($1, $2, $3, 'debit')`,
        [entryId, acc.id, acc.debit],
      );
    }
    if (acc.credit > 0) {
      await tx.query(
        `INSERT INTO ledger_legs (entry_id, ledger_account_id, amount, direction)
         VALUES ($1, $2, $3, 'credit')`,
        [entryId, acc.id, acc.credit],
      );
    }
  }

  return row;
}

export type Balance = {
  code: LedgerCodeValue;
  type: LedgerAccountType;
  currency: string;
  balance: number;
};

/** All balances for an account. Derived, never a stored mutable number. */
export async function getBalances(db: Db, accountId: string): Promise<Balance[]> {
  const { rows } = await db.query<{ code: string; type: LedgerAccountType; currency: string; balance: string | number }>(
    `SELECT code, type, currency, balance
       FROM ledger_balances
      WHERE account_id = $1 AND balance <> 0
      ORDER BY currency, code`,
    [accountId],
  );
  return rows.map((r) => ({ code: r.code as LedgerCodeValue, type: r.type, currency: r.currency, balance: asNumber(r.balance) }));
}

export async function getBalance(
  db: Db,
  accountId: string,
  code: LedgerCodeValue,
  currency: string,
): Promise<number> {
  const { rows } = await db.query<{ balance: string | number }>(
    `SELECT balance FROM ledger_balances WHERE account_id = $1 AND code = $2 AND currency = $3`,
    [accountId, code, currency],
  );
  return rows[0] ? asNumber(rows[0].balance) : 0;
}

/** Amount the merchant can withdraw right now. */
export async function availableBalance(db: Db, accountId: string, currency: string): Promise<number> {
  return getBalance(db, accountId, LedgerCode.MERCHANT_AVAILABLE, currency);
}

/**
 * Sum of all legs must be zero, everywhere, always. Runs in CI on every
 * migration and continuously in production.
 */
export async function assertLedgerBalanced(db: Db): Promise<void> {
  const { rows } = await db.query<{ offenders: string | number }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0) AS offenders
       FROM ledger_legs`,
  );
  const total = asNumber(rows[0]?.offenders ?? 0);
  if (total !== 0) throw internal(`Ledger is out of balance by ${total}.`);
}

export async function getEntryBySource(
  db: Db,
  accountId: string,
  sourceType: string,
  sourceId: string,
): Promise<LedgerEntryRow | null> {
  const { rows } = await db.query<LedgerEntryRow>(
    `SELECT id, account_id, effective_at, recorded_at, source_type, source_id, memo
       FROM ledger_entries WHERE account_id = $1 AND source_type = $2 AND source_id = $3`,
    [accountId, sourceType, sourceId],
  );
  return rows[0] ?? null;
}
