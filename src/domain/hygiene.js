/**
 * Repository hygiene checks, all deterministic:
 * - English-only content (the repository is written as if public),
 * - no secret committed,
 * - no provisional information in what ships to production,
 * - architecture layers that only depend inward.
 */
import { matchesAny } from './glob.js';

// Any letter outside ASCII signals non-English prose; symbols, arrows and digits are fine.
const NON_ENGLISH_LETTER = /(?![a-zA-Z])\p{L}/u;

const SECRET_PATTERNS = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['generic_assignment', /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9+/_-]{24,}["']/i],
];

export const PROVISIONAL_MARKER = /\bPROVISIONAL\(([a-z0-9-]+)\):\s*(.*)/;

/**
 * @param {Array<{path: string, content: string}>} files
 * @returns {Array<{path: string, line: number, excerpt: string}>}
 */
export function findNonEnglish(files) {
  const hits = [];
  for (const file of files) {
    file.content.split('\n').forEach((text, index) => {
      if (NON_ENGLISH_LETTER.test(text)) hits.push({ path: file.path, line: index + 1, excerpt: text.trim().slice(0, 80) });
    });
  }
  return hits;
}

/** @returns {Array<{path: string, line: number, kind: string}>} never includes the secret itself */
export function findSecrets(files) {
  const hits = [];
  for (const file of files) {
    file.content.split('\n').forEach((text, index) => {
      for (const [kind, pattern] of SECRET_PATTERNS) {
        if (pattern.test(text)) hits.push({ path: file.path, line: index + 1, kind });
      }
    });
  }
  return hits;
}

/**
 * Provisional information lets the factory move without inventing facts: it
 * is marked, listed for the owner, and must never reach production paths.
 * @param {Array<{path: string, content: string}>} files
 * @param {string[]} productionPaths globs of what ships
 */
export function findProvisional(files, productionPaths) {
  const items = [];
  for (const file of files) {
    file.content.split('\n').forEach((text, index) => {
      const match = PROVISIONAL_MARKER.exec(text);
      if (match) {
        items.push({
          id: match[1],
          path: file.path,
          line: index + 1,
          note: match[2].trim(),
          blocksProduction: matchesAny(file.path, productionPaths),
        });
      }
    });
  }
  return items;
}

/**
 * Dependency rule of a layered (hexagonal) architecture.
 * @param {Array<{path: string, content: string}>} files source files
 * @param {Array<{name: string, paths: string[], mayImport: string[]}>} layers
 * @returns {Array<{path: string, imports: string, rule: string}>}
 */
export function findLayerViolations(files, layers) {
  const layerOf = (path) => layers.find((layer) => matchesAny(path, layer.paths));
  const violations = [];
  for (const file of files) {
    const from = layerOf(file.path);
    if (!from) continue;
    const specifiers = [...file.content.matchAll(/(?:from\s+|import\s+|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      const target = resolveRelative(file.path, specifier);
      const to = layerOf(target);
      if (to && to.name !== from.name && !from.mayImport.includes(to.name)) {
        violations.push({ path: file.path, imports: target, rule: `${from.name} must not import ${to.name}` });
      }
    }
  }
  return violations;
}

function resolveRelative(fromPath, specifier) {
  const parts = fromPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}
