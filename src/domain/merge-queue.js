/**
 * Merge queue: an always-green trunk where every change is tested on the
 * future state of the trunk before it lands.
 *
 * Model. The queue holds an ordered list of pending changes. A candidate is a
 * prefix of that list, built as a commit on top of everything already landed.
 * The trunk only ever fast-forwards to a candidate that passed, so what was
 * tested is exactly what lands.
 *
 * - Batching: the head candidate holds up to `batchSize` changes.
 * - Speculation: up to `maxParallelChecks` longer prefixes are tested at the
 *   same time, assuming the ones before them pass.
 * - Bisection: a failed batch is halved until the culprit is alone, then the
 *   culprit is evicted. Halves that pass land immediately.
 * - Flaky tolerance: a failed candidate is retried `flakyRetries` times
 *   before it counts as a failure; a pass after a failure is reported.
 *
 * The state is a plain object and every function is pure.
 */

/** @param {{batchSize: number, maxParallelChecks: number, flakyRetries: number}} config */
export function createQueue(config) {
  return {
    config,
    epoch: 0,
    landed: [],
    pending: [],
    window: config.batchSize,
    suspect: null,
    results: {},
  };
}

export function enqueue(state, id) {
  if (state.pending.includes(id) || state.landed.includes(id)) return state;
  return { ...state, pending: [...state.pending, id] };
}

/** Remove a change that left the queue on its own (closed, updated, withdrawn). */
export function dequeue(state, id) {
  if (!state.pending.includes(id)) return state;
  return resetEpoch({ ...state, pending: state.pending.filter((other) => other !== id) });
}

function keyFor(state, count) {
  // The epoch makes a late result for a discarded candidate impossible to match.
  return `e${state.epoch}:${[...state.landed, ...state.pending.slice(0, count)].join('+')}`;
}

function resetEpoch(state) {
  return { ...state, epoch: state.epoch + 1, landed: [], results: {}, suspect: null, window: state.config.batchSize };
}

/**
 * Candidates that should be under test now.
 * @returns {Array<{key: string, changes: string[], speculative: boolean}>}
 */
export function plan(state) {
  const { batchSize, maxParallelChecks } = state.config;
  const candidates = [];
  let count = Math.min(state.window, state.pending.length);
  if (count === 0) return candidates;
  candidates.push({ key: keyFor(state, count), changes: state.pending.slice(0, count), speculative: false });
  // No speculation while bisecting: later prefixes include a known failure.
  while (!state.suspect && candidates.length < maxParallelChecks && count < state.pending.length) {
    count = Math.min(count + batchSize, state.pending.length);
    candidates.push({ key: keyFor(state, count), changes: state.pending.slice(0, count), speculative: true });
  }
  return candidates.filter((candidate) => state.results[candidate.key]?.outcome !== 'pass');
}

/** @param {'pass'|'fail'} outcome */
export function recordResult(state, key, outcome) {
  if (!key.startsWith(`e${state.epoch}:`)) return state; // stale candidate from an earlier epoch
  const previous = state.results[key] ?? { outcome: null, failures: 0 };
  const failures = previous.failures + (outcome === 'fail' ? 1 : 0);
  let results = { ...state.results, [key]: { outcome, failures } };
  if (outcome === 'fail') {
    // Longer prefixes were built on this candidate: their results no longer describe a future trunk.
    results = Object.fromEntries(Object.entries(results).filter(([other]) => !other.startsWith(`${key}+`)));
  }
  return { ...state, results };
}

/** Discard the result of a candidate whose commit can no longer land (the trunk moved under it). */
export function forget(state, key) {
  if (!(key in state.results)) return state;
  const { [key]: dropped, ...results } = state.results;
  return { ...state, results: dropped.failures > 0 ? { ...results, [key]: { outcome: null, failures: dropped.failures } } : results };
}

/**
 * Apply every decision the recorded results allow.
 * @returns {{state: object, actions: Array<
 *   {type: 'merge', key: string, changes: string[]} |
 *   {type: 'evict', change: string, reason: string} |
 *   {type: 'flaky', key: string}>}}
 */
export function settle(state) {
  const actions = [];
  let current = state;

  for (;;) {
    const count = Math.min(current.window, current.pending.length);
    if (count === 0) break;
    const key = keyFor(current, count);
    const result = current.results[key];
    if (!result || result.outcome === null) break;
    const head = current.pending.slice(0, count);

    if (result.outcome === 'pass') {
      if (result.failures > 0) actions.push({ type: 'flaky', key });
      actions.push({ type: 'merge', key, changes: head });
      const remainingSuspect = current.suspect?.filter((id) => !head.includes(id)) ?? null;
      current = { ...current, landed: [...current.landed, ...head], pending: current.pending.slice(count) };
      if (!remainingSuspect || remainingSuspect.length === 0) {
        current = { ...current, suspect: null, window: current.config.batchSize };
      } else if (remainingSuspect.length === 1) {
        // The rest of a failed batch is a single change: it is the culprit.
        actions.push({ type: 'evict', change: remainingSuspect[0], reason: 'Isolated by bisection.' });
        current = resetEpoch({ ...current, pending: current.pending.filter((id) => id !== remainingSuspect[0]) });
      } else {
        current = { ...current, suspect: remainingSuspect, window: Math.ceil(remainingSuspect.length / 2) };
      }
      continue;
    }

    if (result.failures <= current.config.flakyRetries) break; // retest the same candidate
    if (count === 1) {
      actions.push({ type: 'evict', change: head[0], reason: 'Checks failed on the future trunk.' });
      current = resetEpoch({ ...current, pending: current.pending.slice(1) });
      continue;
    }
    current = { ...current, suspect: head, window: Math.ceil(count / 2) };
  }
  return { state: current, actions };
}
