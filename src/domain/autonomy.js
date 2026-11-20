/**
 * Autonomy tiers. The factory earns the right to merge without a human, one
 * risk level at a time, on measured results. Thresholds are written before
 * the measurements start and live in a reserved path.
 *
 * Tier 0: every merge needs the owner.   Tier 1: LOW merges alone.
 * Tier 2: LOW and HIGH merge alone.      Tier 3: every level merges alone.
 */
import { LEVELS } from './risk.js';

export const MAX_TIER = LEVELS.length;

/** @param {number} tier @param {string} level */
export function mayMergeAlone(tier, level) {
  const index = LEVELS.indexOf(level);
  if (index === -1) throw new Error(`Unknown risk level: ${level}`);
  return tier > index;
}

/**
 * @param {number} tier current tier
 * @param {Record<string, number|null>} measured metric name -> value, null when not measured
 * @param {Array<Record<string, {min?: number, max?: number}>>} promotion thresholds to enter tier 1, 2, 3
 * @returns {{eligible: boolean, nextTier: number|null, unmet: string[]}}
 */
export function evaluatePromotion(tier, measured, promotion) {
  if (tier >= MAX_TIER) return { eligible: false, nextTier: null, unmet: ['Already at the highest tier.'] };
  const thresholds = promotion[tier];
  if (!thresholds || Object.keys(thresholds).length === 0) {
    return { eligible: false, nextTier: tier + 1, unmet: ['No thresholds are defined for the next tier.'] };
  }
  const unmet = [];
  for (const [metric, bound] of Object.entries(thresholds)) {
    const value = measured[metric];
    if (typeof bound?.min !== 'number' && typeof bound?.max !== 'number') {
      unmet.push(`${metric}: threshold has neither min nor max`);
    } else if (typeof value !== 'number' || Number.isNaN(value)) {
      unmet.push(`${metric}: not measured`);
    } else if (bound.min !== undefined && value < bound.min) {
      unmet.push(`${metric}: ${value} is below ${bound.min}`);
    } else if (bound.max !== undefined && value > bound.max) {
      unmet.push(`${metric}: ${value} is above ${bound.max}`);
    }
  }
  return { eligible: unmet.length === 0, nextTier: tier + 1, unmet };
}

/**
 * Review gates a change must pass before it may enter the merge queue.
 * @param {string} level
 * @param {{weakeningSignals: number, testsTouched?: boolean, externalTool?: boolean}} facts
 *   `testsTouched`: an existing test or scenario was edited or removed; `externalTool`: one is wired in
 */
export function requiredGates(level, facts) {
  const gates = ['checks_green', 'independent_review', 'no_confirmed_blocking_finding'];
  if (level !== 'LOW') gates.push('security_review');
  if (level !== 'LOW' && facts.externalTool) gates.push('external_tool_pass');
  if (facts.weakeningSignals > 0 || facts.testsTouched) gates.push('test_guard_review');
  if (level === 'CRITICAL') gates.push('second_independent_review');
  return gates;
}
