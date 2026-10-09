import type { Db } from '../db/index.js';
import type {
  RiskOutcome,
  RiskRule,
  RiskRuleSet,
  RiskSignals,
  RiskStage,
  MatchedRule,
} from './types.js';
import { compare, OUTCOME_ORDER } from './types.js';

/**
 * The rules engine. Pure, synchronous, allocation-light: it runs in the
 * authorization path, where every millisecond is budgeted (0018 puts the
 * whole request at 400 ms p99).
 *
 * Rules are ordered by position and evaluated first-match-wins. No match is
 * an implicit allow.
 */

export function evaluateRules(
  rules: RiskRule[],
  signals: RiskSignals,
): { outcome: RiskOutcome; matched: MatchedRule[] } {
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    const hit = ruleMatches(rule, signals);
    if (hit !== null) {
      return { outcome: rule.action, matched: [hit] };
    }
  }
  return { outcome: 'allow', matched: [] };
}

/**
 * True when the rule's condition holds, null when it does not. Returning the
 * matched detail rather than a boolean keeps the audit record free of a
 * second evaluation pass, which could disagree with the first.
 */
function ruleMatches(rule: RiskRule, s: RiskSignals): MatchedRule | null {
  switch (rule.signal) {
    case 'velocity': {
      const hit = compare(rule.operator, s.velocity, rule.threshold);
      return hit ? matched(rule, s.velocity) : null;
    }
    case 'amount_threshold': {
      const hit = compare(rule.operator, s.amount, rule.threshold);
      return hit ? matched(rule, s.amount) : null;
    }
    case 'blocklist': {
      // gte is "is blocked", lte is "is not blocked". The lte form lets a
      // merchant express an explicit allow rule ahead of their block rules,
      // which the first-match-wins ordering makes meaningful.
      const hit = rule.operator === 'gte' ? s.blocklisted : !s.blocklisted;
      return hit ? matched(rule, s.blocklisted ? 1 : 0) : null;
    }
    case 'decline_rate': {
      const hit = compare(rule.operator, s.declineRate, rule.threshold);
      return hit ? matched(rule, s.declineRate) : null;
    }
  }
}

function matched(rule: RiskRule, observed: number): MatchedRule {
  return {
    ruleId: rule.id,
    name: rule.name,
    signal: rule.signal,
    observed,
    threshold: rule.threshold,
    action: rule.action,
  };
}

/**
 * Card-testing detection: N authorization attempts on M distinct tokens in
 * the window is the enumeration pattern, regardless of how many approved.
 * Declines are the cheap thing for an attacker to vary; counting attempts
 * rather than declines is what makes the detector hard to evade.
 */
export const CARD_TESTING_QUERY = `
  SELECT COUNT(*)::int AS attempts,
         COUNT(DISTINCT token)::int AS distinct_tokens
    FROM (
      SELECT inputs->>'token' AS token
        FROM risk_decisions
       WHERE account_id = $1
         AND stage = 'authorization'
         AND inputs ? 'token'
         AND created_at > now() - ($2 || ' minutes')::interval
    ) t`;

export type CardTestingStats = { attempts: number; distinctTokens: number };

export async function cardTestingStats(
  db: Db,
  accountId: string,
  windowMinutes: number,
): Promise<CardTestingStats> {
  const { rows } = await db.query<{ attempts: number; distinct_tokens: number }>(
    CARD_TESTING_QUERY,
    [accountId, String(windowMinutes)],
  );
  const row = rows[0];
  return { attempts: row?.attempts ?? 0, distinctTokens: row?.distinct_tokens ?? 0 };
}

/**
 * True when the source crosses the card-testing line: at least
 * `threshold` attempts across at least 3 distinct tokens inside the window.
 * The distinct-token floor keeps one customer retrying a declining card from
 * looking like an enumeration attack.
 */
export function isCardTesting(stats: CardTestingStats, threshold: number): boolean {
  return stats.attempts >= threshold && stats.distinctTokens >= 3;
}

/** Re-export so callers do not import from two modules for one check. */
export { OUTCOME_ORDER };
export type { RiskStage };
