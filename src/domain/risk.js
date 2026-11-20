/**
 * Risk classification. Deterministic: the level of a change is decided by
 * what it touches, never by the agent that wrote it and never by a model.
 */
import { matchesAny } from './glob.js';
import { touchesExistingTests } from './test-guard.js';

export const LEVELS = ['LOW', 'HIGH', 'CRITICAL'];

/** @param {string} a @param {string} b */
export function maxLevel(a, b) {
  return LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b;
}

/**
 * @param {ReturnType<import('./diff.js').parseUnifiedDiff>} files
 * @param {{paths: {reserved: string[], core: string[], manifests: string[], tests: string[], holdout: string[]}}} config
 * @param {{weakeningSignals?: Array<{kind: string, path: string}>, dependencyRequest?: boolean}} [facts]
 * @returns {{level: 'LOW'|'HIGH'|'CRITICAL', reasons: string[]}}
 */
export function classifyRisk(files, config, facts = {}) {
  let level = 'LOW';
  const reasons = [];
  const raise = (to, reason) => {
    level = maxLevel(level, to);
    reasons.push(`${to}: ${reason}`);
  };

  for (const file of files) {
    const paths = [...new Set([file.path, file.oldPath])].filter(Boolean);
    if (file.unsafePath) {
      raise('CRITICAL', `unparseable or unsafe path (${paths.join(', ') || 'unknown'})`);
      continue;
    }
    for (const path of paths) {
      if (matchesAny(path, config.paths.reserved)) raise('CRITICAL', `reserved path ${path}`);
      else if (matchesAny(path, config.paths.core)) raise('HIGH', `core module ${path}`);
      else if (matchesAny(path, config.paths.manifests)) raise('HIGH', `dependency manifest ${path}`);
    }
  }
  if (touchesExistingTests(files, config)) raise('HIGH', 'modifies or removes an existing test');
  for (const signal of facts.weakeningSignals ?? []) {
    raise('HIGH', `test weakening signal ${signal.kind} in ${signal.path}`);
  }
  if (facts.dependencyRequest) raise('HIGH', 'requests a new or updated dependency');

  if (reasons.length === 0) reasons.push('LOW: no reserved path, core module, manifest, existing test, or dependency touched');
  return { level, reasons };
}
