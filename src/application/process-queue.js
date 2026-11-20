/**
 * One tick of the merge queue: read check results, land what passed, evict
 * what failed, and start the candidates that should be under test.
 *
 * The trunk only moves by fast-forward to a candidate whose checks passed,
 * so the commit that lands is the commit that was tested. A candidate is
 * only usable while it still descends, link by link, from the trunk head:
 * if the trunk moved under it, it is rebuilt and tested again.
 */
import { dequeue, enqueue, forget, plan, recordResult, settle } from '../domain/merge-queue.js';

/**
 * @param {{queue: object,
 *   candidates: Record<string, {sha: string, parent: string, count: number, reported: boolean}>,
 *   changes: Record<string, {branch: string, sha: string, ticketId: string, likelyFiles?: string[]}>,
 *   awaiting?: object}} store persisted queue state
 * @param {{project: {trunk: string}}} config
 * @param {{vcs: import('./ports.js').Vcs, checks: import('./ports.js').Checks,
 *   forge: import('./ports.js').Forge, ledger: import('./ports.js').Ledger}} ports
 * @returns {Promise<typeof store>} the next store
 */
export async function queueTick(store, config, ports) {
  const { vcs, checks, forge, ledger } = ports;
  const trunk = config.project.trunk;
  let queue = store.queue;
  let candidates = { ...store.candidates };
  const changes = { ...store.changes };

  const sendBack = async (id, reason) => {
    await ledger.append('evict', { change: id, ticket: changes[id].ticketId, reason });
    await ledger.append('ticket_outcome', { ticket: changes[id].ticketId, outcome: 'rework', reason });
    await forge.setTicketState(changes[id].ticketId, 'rework', reason);
    delete changes[id];
  };
  const byCount = () => Object.entries(candidates).sort((a, b) => a[1].count - b[1].count);

  // 0. Drop every candidate that no longer chains from the trunk head (the
  //    trunk moved outside the queue, or its parent was rebuilt).
  let link = await vcs.head(trunk);
  for (const [key, candidate] of byCount()) {
    if (candidate.sha === link) continue; // already landed by an interrupted tick
    if (candidate.parent === link) {
      link = candidate.sha;
    } else {
      delete candidates[key];
      queue = forget(queue, key);
    }
  }

  // 1. Read the results of candidates under test.
  for (const key of Object.keys(candidates)) {
    const candidate = candidates[key];
    if (!candidate || candidate.reported) continue; // dropped earlier in this loop, or already read
    const status = await checks.status(candidate.sha);
    if (status === 'pending') continue;
    queue = recordResult(queue, key, status);
    candidates[key] = { ...candidate, reported: true };
    if (status === 'fail') {
      // A failed commit is never built upon: drop it and everything stacked on it.
      for (const [other, entry] of Object.entries(candidates)) {
        if (other === key || entry.parent === candidate.sha || other.startsWith(`${key}+`)) delete candidates[other];
      }
    }
  }

  // 2. Apply every decision the results allow.
  const epoch = queue.epoch;
  const settled = settle(queue);
  queue = settled.state;
  for (const action of settled.actions) {
    if (action.type === 'merge') {
      const { sha } = candidates[action.key];
      if ((await vcs.head(trunk)) !== sha) {
        await vcs.fastForward(trunk, sha);
        await ledger.append('merge', { changes: action.changes, sha });
      }
      for (const id of action.changes) {
        await forge.setTicketState(changes[id].ticketId, 'done', `Landed in ${sha}.`);
        delete changes[id];
      }
      delete candidates[action.key];
    } else if (action.type === 'evict') {
      await sendBack(action.change, action.reason);
    } else {
      await ledger.append('flaky_candidate', { key: action.key });
    }
  }
  if (queue.epoch !== epoch) candidates = {};

  // 3. Start the candidates that should be under test, each built on the
  //    longest usable candidate before it.
  const head = await vcs.head(trunk);
  for (const planned of planAll(queue)) {
    const count = queue.landed.length + planned.changes.length;
    const failed = queue.results[planned.key]?.failures ?? 0;
    if (candidates[planned.key]) continue; // under test, or passed and waiting for its turn
    const before = byCount().filter(([, candidate]) => candidate.count < count).at(-1);
    const parent = before ? before[1].sha : head;
    const covered = before ? before[1].count - queue.landed.length : 0;
    const built = await vcs.buildCandidate({
      parent,
      changes: planned.changes.slice(covered).map((id) => ({ id, sha: changes[id].sha })),
      ref: `queue/e${queue.epoch}-n${count}-a${failed}`,
    });
    if ('conflict' in built) {
      await sendBack(built.conflict, 'Conflicts with the future trunk.');
      queue = dequeue(queue, built.conflict);
      candidates = {};
      break;
    }
    candidates[planned.key] = { sha: built.sha, parent, count, reported: false };
  }
  return { ...store, queue, candidates, changes };
}

/** Planned candidates, including the ones that already passed, in build order. */
function planAll(queue) {
  const cleared = { ...queue, results: Object.fromEntries(Object.entries(queue.results).filter(([, r]) => r.outcome !== 'pass')) };
  return plan(cleared);
}

/** Add an approved change to the queue, pinned to the commit that passed its gates. */
export function admitChange(store, change) {
  return {
    ...store,
    queue: enqueue(store.queue, change.id),
    changes: { ...store.changes, [change.id]: { branch: change.branch, sha: change.sha, ticketId: change.ticketId, likelyFiles: change.likelyFiles ?? [] } },
  };
}
