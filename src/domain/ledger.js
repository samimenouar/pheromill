/**
 * Hash-chained ledger entries. Every choice leaves a trace, and a trace that
 * was edited or removed after the fact is detectable: each entry commits to
 * the one before it.
 */
import { createHash } from 'node:crypto';

const GENESIS = '0'.repeat(64);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function digest(entry) {
  return createHash('sha256').update(canonical(entry)).digest('hex');
}

/**
 * @param {{seq: number, hash: string}|null} previous last entry of the ledger, or null
 * @param {string} type
 * @param {object} data
 * @param {string} at ISO timestamp
 */
export function chainEntry(previous, type, data, at) {
  // Hash exactly what a reader will parse back: dates and undefined values do not survive JSON.
  const body = JSON.parse(JSON.stringify({ seq: previous ? previous.seq + 1 : 1, at, type, data, prev: previous ? previous.hash : GENESIS }));
  return { ...body, hash: digest(body) };
}

/**
 * @param {Array<{seq: number, at: string, type: string, data: object, prev: string, hash: string}>} entries
 * @returns {{valid: boolean, brokenAt: number|null}}
 *
 * The chain detects an edited, removed or reordered entry. It cannot detect
 * that the latest entries were cut off, or that the whole file was rebuilt:
 * for that, compare `head(entries)` with a copy kept outside the control zone.
 */
export function verifyChain(entries) {
  let prev = GENESIS;
  for (let index = 0; index < entries.length; index += 1) {
    const { hash, ...body } = entries[index];
    if (body.seq !== index + 1 || body.prev !== prev || digest(body) !== hash) {
      return { valid: false, brokenAt: index + 1 };
    }
    prev = hash;
  }
  return { valid: true, brokenAt: null };
}

/** Sequence number and hash of the latest entry: the value to anchor elsewhere. */
export function head(entries) {
  const last = entries.at(-1);
  return last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
}
