/**
 * One tick of the merge queue: read check results, land what passed, evict
 * what failed, and start the candidates that should be under test.
 *
 * The trunk only moves by fast-forward to a candidate whose checks passed,
 * so the commit that lands is the commit that was tested. A candidate is
 * only usable while it still descends, link by link, from the trunk head:
 * if the trunk moved under it, it is rebuilt and tested again.
 *
 * A tick may be interrupted anywhere, so it writes nothing about a decision
 * before the state that holds the decision is saved. Its only direct effect
 * is the fast-forward, which the next tick can read back from the trunk.
 * Everything else (ledger entries, ticket labels) goes to an outbox saved
 * with the state and delivered by the next tick; delivery is idempotent.
 * A change is therefore landed, evicted and recorded exactly once.
 */
import { acknowledgeLanded, dequeue, enqueue, forget, plan, recordResult, settle } from '../domain/merge-queue.js';

/**
 * @param {{queue: object,
 *   candidates: Record<string, {sha: string, parent: string, count: number, reported: boolean}>,
 *   changes: Record<string, {branch: string, sha: string, ticketId: string, admission?: number, likelyFiles?: string[]}>,
 *   admissions?: number, outbox?: object[], awaiting?: object}} store persisted queue state
 * @param {{project: {trunk: string}}} config
 * @param {{vcs: import('./ports.js').Vcs, checks: import('./ports.js').Checks,
 *   forge: import('./ports.js').Forge, ledger: import('./ports.js').Ledger,
 *   halted?: () => Promise<boolean>}} ports
 * @returns {Promise<typeof store>} the next store
 */
export async function queueTick(store, config, ports) {
  const { vcs, checks } = ports;
  const trunk = config.project.trunk;
  let queue = store.queue;
  let candidates = { ...store.candidates };
  const changes = { ...store.changes };

  // Records of what the previous tick decided: its state was saved, so they are due.
  await deliver(store.outbox ?? [], ports);
  const outbox = [];

  // One stay of a commit in the queue: the admission number tells two stays apart, and a replayed tick sees the same one.
  const stay = (id) => `${id}@${changes[id].sha}#${changes[id].admission ?? 0}`;
  const sendBack = (id, reason) => {
    outbox.push({ type: 'evict', stay: stay(id), change: id, ticket: changes[id].ticketId, reason });
    delete changes[id];
  };
  const recordLanding = (ids, sha) => {
    for (const id of ids) {
      outbox.push({ type: 'merge', stay: stay(id), change: id, ticket: changes[id].ticketId, sha });
      delete changes[id];
    }
  };
  const byCount = () => Object.entries(candidates).sort((a, b) => a[1].count - b[1].count);

  // 0. A candidate the trunk already contains was landed by a tick that did
  //    not finish (or pushed by hand). Its changes are on the trunk whatever
  //    the plan says now: complete their bookkeeping, never land them again,
  //    and plan everything else afresh.
  const start = await vcs.head(trunk);
  const acknowledged = [];
  let settledCount = queue.landed.length;
  for (const [key, candidate] of byCount()) {
    if (!(await vcs.isAncestor(candidate.sha, start))) continue;
    if (candidate.count > settledCount) {
      const ids = queue.pending.slice(settledCount - queue.landed.length, candidate.count - queue.landed.length);
      recordLanding(ids, candidate.sha);
      acknowledged.push(...ids);
      settledCount = candidate.count;
    }
    delete candidates[key]; // otherwise a shorter prefix of what already landed
  }
  if (acknowledged.length > 0) {
    const noted = acknowledgeLanded(queue, acknowledged);
    queue = noted.state;
    candidates = {};
    if (noted.evicted) sendBack(noted.evicted, 'Isolated by bisection.');
  }

  //    Then drop every candidate that no longer chains from the trunk head
  //    (the trunk moved outside the queue, or its parent was rebuilt).
  let link = start;
  for (const [key, candidate] of byCount()) {
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

  // 2. Apply every decision the results allow, unless the owner halted the factory.
  if (await ports.halted?.()) return { ...store, queue, candidates, changes, outbox };
  const epoch = queue.epoch;
  const settled = settle(queue);
  queue = settled.state;
  for (const action of settled.actions) {
    if (action.type === 'merge') {
      const { sha } = candidates[action.key];
      if (!(await vcs.isAncestor(sha, await vcs.head(trunk)))) await vcs.fastForward(trunk, sha);
      recordLanding(action.changes, sha);
      delete candidates[action.key];
    } else if (action.type === 'evict') {
      sendBack(action.change, action.reason);
    } else {
      outbox.push({ type: 'flaky', key: action.key, sha: candidates[action.key].sha });
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
      sendBack(built.conflict, 'Conflicts with the future trunk.');
      queue = dequeue(queue, built.conflict);
      candidates = {};
      break;
    }
    candidates[planned.key] = { sha: built.sha, parent, count, reported: false };
  }
  return { ...store, queue, candidates, changes, outbox };
}

/** Write down and label what a saved tick decided. Every step can be repeated without a second trace. */
async function deliver(outbox, { ledger, forge }) {
  for (const effect of outbox) {
    if (effect.type === 'merge') {
      await ledger.appendOnce('merge', effect.stay, { change: effect.change, ticket: effect.ticket, sha: effect.sha });
      await forge.setTicketState(effect.ticket, 'done', `Landed in ${effect.sha}.`);
    } else if (effect.type === 'evict') {
      await ledger.appendOnce('evict', effect.stay, { change: effect.change, ticket: effect.ticket, reason: effect.reason });
      await ledger.appendOnce('ticket_outcome', `evict:${effect.stay}`, { ticket: effect.ticket, outcome: 'rework', reason: effect.reason });
      await forge.setTicketState(effect.ticket, 'rework', effect.reason);
    } else {
      await ledger.appendOnce('flaky_candidate', `${effect.key}@${effect.sha}`, { key: effect.key });
    }
  }
}

/** Planned candidates, including the ones that already passed, in build order. */
function planAll(queue) {
  const cleared = { ...queue, results: Object.fromEntries(Object.entries(queue.results).filter(([, r]) => r.outcome !== 'pass')) };
  return plan(cleared);
}

/** Add an approved change to the queue, pinned to the commit that passed its gates. */
export function admitChange(store, change) {
  const admission = (store.admissions ?? 0) + 1;
  return {
    ...store,
    admissions: admission,
    queue: enqueue(store.queue, change.id),
    changes: { ...store.changes, [change.id]: { branch: change.branch, sha: change.sha, ticketId: change.ticketId, admission, likelyFiles: change.likelyFiles ?? [] } },
  };
}
