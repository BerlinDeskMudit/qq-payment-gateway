/**
 * Risk signal types, shared by the evaluation engine, the service layer and
 * the simulation. Kept free of database types so a signal provider can be
 * faked in tests without a database.
 */

/** Where in the flow a decision was made. Drives which signals are available. */
export type RiskStage = 'authorization' | 'capture' | 'manual';

export type RiskOutcome = 'allow' | 'review' | 'challenge' | 'block';

/**
 * First-match-wins evaluation order. `block` outranks `challenge` outranks
 * `review`: the most expensive-to-be-wrong outcome wins a conflict, and a
 * rule set that wants the opposite has to say so explicitly.
 */
export const OUTCOME_ORDER: Record<RiskOutcome, number> = {
  allow: 0,
  review: 1,
  challenge: 2,
  block: 3,
};

/** Signals the rules engine can condition on in this slice. */
export type RiskSignal =
  | 'velocity'
  | 'amount_threshold'
  | 'blocklist'
  | 'decline_rate';

export type RiskAction = RiskOutcome;

export type RiskRule = {
  id: string;
  name: string;
  position: number;
  signal: RiskSignal;
  operator: 'gte' | 'lte';
  /** Minor units for amounts, a count for velocity, a percentage for decline_rate. */
  threshold: number;
  /** Minutes, for signals that count over time. */
  windowMinutes?: number | null;
  action: RiskAction;
};

export type RiskRuleSet = {
  id: string;
  version: number;
  rules: RiskRule[];
};

/**
 * The live inputs a decision was made on. Persisted verbatim on the decision
 * row, because simulation replays must see the same numbers the gate saw, not
 * a post-hoc reconstruction of them.
 */
export type RiskSignals = {
  /** Authorization attempts on this token in the window. */
  velocity: number;
  /** Intent amount in minor units. */
  amount: number;
  /** True when token, card fingerprint, BIN, email, IP or device is blocked. */
  blocklisted: boolean;
  /** Declines / attempts over the window, in percent. */
  declineRate: number;
  /** Card last4, when known. Part of the record, not a rule signal yet. */
  cardLast4?: string | null;
};

export const SIGNAL_EMPTY: RiskSignals = {
  velocity: 0,
  amount: 0,
  blocklisted: false,
  declineRate: 0,
};

export type MatchedRule = {
  ruleId: string;
  name: string;
  signal: RiskSignal;
  observed: number | boolean;
  threshold: number;
  action: RiskAction;
};

/** Comparison shared by the live gate and the simulation. */
export function compare(
  operator: 'gte' | 'lte',
  observed: number,
  threshold: number,
): boolean {
  return operator === 'gte' ? observed >= threshold : observed <= threshold;
}

export const VELOCITY_WINDOW_MINUTES_DEFAULT = 60;

export const CARD_TESTING_THRESHOLD = 10;

export const CARD_TESTING_WINDOW_MINUTES = 10;

export const AUTO_BLOCK_SOURCE = 'auto';
