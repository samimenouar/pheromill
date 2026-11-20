/**
 * Review findings. A finding becomes actionable only after it survived a
 * refutation attempt. Blocking findings go back to the author; minor ones
 * never become tickets, they go to the debt register. A class of finding
 * seen three times becomes a rule or a lint so it stops appearing.
 */
import { createHash } from 'node:crypto';

const SEVERITIES = ['blocking', 'minor'];

function normalize(text) {
  return String(text).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Stable identity of a finding on a given file. */
export function fingerprint(finding) {
  const material = [finding.category, finding.severity, finding.path, normalize(finding.message)].join('\n');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Identity of the kind of finding, independent of the file. */
export function findingClass(finding) {
  return `${finding.category}:${finding.rule ?? normalize(finding.message).slice(0, 60)}`;
}

/**
 * @param {unknown} raw parsed reviewer report
 * @returns {{findings: Array<object>, errors: string[]}}
 */
export function parseFindings(raw) {
  const errors = [];
  const findings = [];
  const list = raw && typeof raw === 'object' ? /** @type {any} */ (raw).findings : null;
  if (!Array.isArray(list)) return { findings, errors: ['Report must contain a "findings" array.'] };
  const seen = new Map();
  list.forEach((item, index) => {
    const ok =
      item && typeof item.category === 'string' && typeof item.path === 'string' &&
      typeof item.message === 'string' && SEVERITIES.includes(item.severity);
    if (!ok) {
      errors.push(`Finding ${index} is malformed.`);
      return;
    }
    // Two findings that differ only by numbers (line 12, line 40) each need their own verdict.
    const base = fingerprint(item);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    findings.push({ ...item, fingerprint: occurrence === 1 ? base : `${base}-${occurrence}` });
  });
  return { findings, errors };
}

/**
 * Check a refutation report: exactly one verdict, "confirmed" or "refuted",
 * for every finding. Anything else is an error, never a silent refutation.
 * @param {unknown} raw parsed refuter report
 * @param {Array<{fingerprint: string}>} findings
 * @returns {{verdicts: Record<string, 'confirmed'|'refuted'>, errors: string[]}}
 */
export function parseVerdicts(raw, findings) {
  const given = raw && typeof raw === 'object' ? /** @type {any} */ (raw).verdicts : null;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    return { verdicts: {}, errors: ['Report must contain a "verdicts" object.'] };
  }
  const verdicts = {};
  const errors = [];
  for (const finding of findings) {
    const verdict = Object.hasOwn(given, finding.fingerprint) ? given[finding.fingerprint] : undefined;
    if (verdict === 'confirmed' || verdict === 'refuted') verdicts[finding.fingerprint] = verdict;
    else errors.push(`Finding ${finding.fingerprint} has no valid verdict.`);
  }
  return { verdicts, errors };
}

/**
 * Sort findings after the refutation step. Only an explicit "refuted" drops a
 * finding: a missing verdict counts as confirmed.
 * @param {Array<{fingerprint: string, severity: string}>} findings
 * @param {Record<string, 'confirmed'|'refuted'>} verdicts by fingerprint
 */
export function triage(findings, verdicts) {
  const isRefuted = (finding) => verdicts[finding.fingerprint] === 'refuted';
  const confirmed = findings.filter((finding) => !isRefuted(finding));
  return {
    blocking: confirmed.filter((finding) => finding.severity === 'blocking'),
    debt: confirmed.filter((finding) => finding.severity === 'minor'),
    refuted: findings.filter(isRefuted),
  };
}

/**
 * Classes of confirmed findings that reached the recurrence threshold.
 * @param {Array<{class: string}>} history confirmed findings over time
 * @param {number} threshold
 * @returns {string[]}
 */
export function recurringClasses(history, threshold = 3) {
  const counts = new Map();
  for (const entry of history) counts.set(entry.class, (counts.get(entry.class) ?? 0) + 1);
  return [...counts].filter(([, count]) => count >= threshold).map(([name]) => name);
}
