/**
 * Test-weakening detector. Heuristic and language-agnostic by design: it does
 * not prove a test was weakened, it decides that a human-grade second look is
 * mandatory. Any signal raises the change to HIGH and triggers the dedicated
 * test reviewer.
 */
import { matchesAny } from './glob.js';

const ASSERTION = /\b(assert\w*|expect|should|must|verify|require)\b\s*[.(]|\.(toBe|toEqual|toThrow|rejects|resolves)\b/;
const SKIP = /\b(x(it|describe|test)|(it|describe|test)\.(skip|todo|only))\s*\(|\.skip\s*\(|@(pytest\.mark\.(skip|xfail)|Disabled|Ignore)\b|\bt\.Skip(Now|f)?\(|#\[ignore\]|\bskip:\s*true\b/;
const THRESHOLD = /^\s*["']?([\w.-]*(?:coverage|threshold|lines|branches|functions|statements|min|minimum)[\w.-]*)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i;

function thresholds(lines) {
  const found = new Map();
  for (const line of lines) {
    const match = THRESHOLD.exec(line);
    if (match) found.set(match[1].toLowerCase(), Number(match[2]));
  }
  return found;
}

function count(lines, pattern) {
  return lines.filter((line) => pattern.test(line)).length;
}

/**
 * @param {ReturnType<import('./diff.js').parseUnifiedDiff>} files
 * @param {{paths: {tests: string[], holdout: string[], snapshots: string[], thresholds: string[]}}} config
 * @param {{coverageDrops?: Array<{path: string, before: number, after: number}>}} [facts]
 * @returns {Array<{kind: string, path: string, evidence: string}>}
 */
export function detectWeakening(files, config, facts = {}) {
  const signals = [];
  const testGlobs = [...config.paths.tests, ...config.paths.holdout];

  for (const file of files) {
    const path = file.path || file.oldPath;
    const isTest = matchesAny(path, testGlobs) || matchesAny(file.oldPath || path, testGlobs);

    if (matchesAny(path, config.paths.snapshots) && file.status !== 'added') {
      signals.push({ kind: 'snapshot_replaced', path, evidence: `Reference capture ${file.status}.` });
    }
    if (matchesAny(path, config.paths.thresholds)) {
      const before = thresholds(file.removed);
      const after = thresholds(file.added);
      for (const [key, value] of before) {
        if (after.has(key) && after.get(key) < value) {
          signals.push({ kind: 'threshold_relaxed', path, evidence: `${key}: ${value} -> ${after.get(key)}` });
        }
      }
    }
    if (!isTest) continue;

    if (file.status === 'deleted') {
      signals.push({ kind: 'test_deleted', path, evidence: 'Existing test file deleted.' });
      continue;
    }
    const removedAssertions = count(file.removed, ASSERTION);
    const addedAssertions = count(file.added, ASSERTION);
    if (removedAssertions > addedAssertions) {
      signals.push({
        kind: 'assertion_removed',
        path,
        evidence: `${removedAssertions} assertion line(s) removed, ${addedAssertions} added.`,
      });
    }
    const skipped = file.added.filter((line) => SKIP.test(line));
    if (skipped.length > 0) {
      signals.push({ kind: 'test_skipped', path, evidence: skipped[0].trim().slice(0, 120) });
    }
  }

  for (const drop of facts.coverageDrops ?? []) {
    if (drop.after < drop.before) {
      signals.push({ kind: 'coverage_dropped', path: drop.path, evidence: `${drop.before}% -> ${drop.after}%` });
    }
  }
  return signals;
}

/** True when the change edits or removes a test that already existed. */
export function touchesExistingTests(files, config) {
  const testGlobs = [...config.paths.tests, ...config.paths.holdout];
  return files.some((file) => file.status !== 'added' && matchesAny(file.oldPath || file.path, testGlobs));
}
