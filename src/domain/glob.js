/**
 * Minimal POSIX glob support: `**`, `*`, `?`. No dependency, no I/O.
 * Paths always use forward slashes.
 */

const SPECIAL = /[.+^${}()|[\]\\]/g;

/** @param {string} glob @returns {RegExp} */
export function globToRegExp(input) {
  // Repeated "**/" means the same as one and would make the expression explode.
  const glob = input.replace(/(?:\*\*\/)+/g, '**/');
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:[^/]+/)*';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(SPECIAL, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** @param {string} path @param {string[]} globs */
export function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/** Paths and globs are compared in one spelling: no leading "./" or "/". */
export function normalizePath(path) {
  return path.replace(/^(?:\.?\/)+/, '');
}

/** The literal part of a glob before its first wildcard. */
export function staticPrefix(glob) {
  const normal = normalizePath(glob);
  const index = normal.search(/[*?]/);
  return index === -1 ? normal : normal.slice(0, index);
}

/**
 * Conservative overlap test between two globs: it may report an overlap that
 * does not exist, but never misses one. Used to keep two tickets that could
 * touch the same files from running at the same time.
 */
export function globsMayOverlap(a, b) {
  const prefixA = staticPrefix(a);
  const prefixB = staticPrefix(b);
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

/** @param {string[]} listA @param {string[]} listB */
export function anyOverlap(listA, listB) {
  return listA.some((a) => listB.some((b) => globsMayOverlap(a, b)));
}

/**
 * Could a ticket's likely file fall under one of these globs? Exact for a
 * plain path, conservative for a glob.
 * @param {string} likely a path or a glob
 * @param {string[]} globs
 */
export function mayFallUnder(likely, globs) {
  const normal = normalizePath(likely);
  if (!/[*?]/.test(normal)) return matchesAny(normal, globs);
  return globs.some((glob) => globsMayOverlap(normal, glob));
}
