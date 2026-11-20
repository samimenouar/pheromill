import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryForge, MemoryLedger, MemoryVcs } from '../../src/adapters/memory.js';
import { admitChange, queueTick } from '../../src/application/process-queue.js';
import { createQueue } from '../../src/domain/merge-queue.js';

const config = { project: { trunk: 'main' } };

function setup(queueConfig, ids = []) {
  const vcs = new MemoryVcs();
  const forge = new MemoryForge();
  const ledger = new MemoryLedger();
  const verdicts = new Map();
  const checks = { status: async (sha) => verdicts.get(sha) ?? 'pending', wait: async () => ({ status: 'pass', signature: null }) };
  const context = { vcs, forge, ledger, checks, verdicts, ports: { vcs, forge, ledger, checks }, store: { queue: createQueue(queueConfig), candidates: {}, changes: {} } };
  context.admit = (...changes) => {
    for (const id of changes) context.store = admitChange(context.store, { id, branch: `factory/t${id}`, sha: `reviewed-${id}`, ticketId: id });
  };
  /** Give every candidate that has no verdict yet the verdict its content deserves. */
  context.judge = (isBad = () => false) => {
    for (const [sha, changes] of vcs.contents) if (!verdicts.has(sha)) verdicts.set(sha, changes.some(isBad) ? 'fail' : 'pass');
  };
  context.tick = async () => {
    context.store = await queueTick(context.store, config, context.ports);
  };
  context.admit(...ids);
  return context;
}

async function drain(context, isBad, maxTicks = 40) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    await context.tick();
    if (context.store.queue.pending.length === 0 && Object.keys(context.store.candidates).length === 0) return;
    context.judge(isBad);
  }
  throw new Error('The queue did not drain.');
}

const landed = (context) => context.ledger.ofType('merge').flatMap((entry) => entry.changes);
const evicted = (context) => context.ledger.ofType('evict').map((entry) => entry.change);
const onTrunk = async (context) => context.vcs.contents.get(await context.vcs.head('main')) ?? [];

test('queue tick: the trunk only fast-forwards to candidates whose checks passed', async () => {
  const context = setup({ batchSize: 2, maxParallelChecks: 2, flakyRetries: 0 }, ['a', 'b', 'c']);
  await context.tick();
  assert.equal(await context.vcs.head('main'), 'base', 'nothing lands while checks are pending');
  await drain(context);
  assert.deepEqual(context.ledger.ofType('merge').map((entry) => entry.changes), [['a', 'b'], ['c']]);
  assert.equal(await context.vcs.head('main'), context.ledger.ofType('merge').at(-1).sha);
  assert.equal(context.verdicts.get(await context.vcs.head('main')), 'pass');
  assert.deepEqual(['a', 'b', 'c'].map((id) => context.forge.tickets.get(id).state), ['done', 'done', 'done']);
});

test('queue tick: a failing change is isolated and sent back to rework; the others land', async () => {
  const context = setup({ batchSize: 4, maxParallelChecks: 1, flakyRetries: 0 }, ['a', 'b', 'c', 'd']);
  await drain(context, (id) => id === 'c');
  assert.deepEqual(landed(context), ['a', 'b', 'd']);
  assert.deepEqual(evicted(context), ['c']);
  assert.equal(context.forge.tickets.get('c').state, 'rework');
  assert.deepEqual(context.ledger.ofType('ticket_outcome').map((entry) => [entry.ticket, entry.outcome]), [['c', 'rework']], 'an eviction counts as a rework');
  assert.ok(!(await onTrunk(context)).includes('c'));
});

test('queue tick: a change that conflicts with the future trunk is evicted before any check runs', async () => {
  const context = setup({ batchSize: 2, maxParallelChecks: 1, flakyRetries: 0 }, ['a', 'b']);
  context.vcs.conflicts.add('b');
  await drain(context);
  assert.deepEqual(context.ledger.ofType('evict'), [{ change: 'b', ticket: 'b', reason: 'Conflicts with the future trunk.' }]);
  assert.deepEqual(landed(context), ['a']);
  assert.deepEqual(context.store.changes, {});
});

test('queue tick: a flaky candidate is rebuilt, retested and recorded', async () => {
  const context = setup({ batchSize: 1, maxParallelChecks: 1, flakyRetries: 1 }, ['a']);
  await context.tick();
  context.judge(() => true);
  await drain(context);
  assert.equal(context.ledger.ofType('flaky_candidate').length, 1);
  assert.deepEqual(landed(context), ['a']);
});

test('queue tick: changes admitted while candidates are under test never wedge the queue', async () => {
  const context = setup({ batchSize: 4, maxParallelChecks: 1, flakyRetries: 0 }, ['a', 'b']);
  await context.tick();
  context.admit('c');
  context.judge();
  await context.tick();
  context.admit('d');
  context.judge();
  await context.tick();
  await drain(context, (id) => id === 'd');
  assert.deepEqual(landed(context).sort(), ['a', 'b', 'c']);
  assert.deepEqual(evicted(context), ['d']);
});

test('queue tick: a head that fails while its speculative child passes, in the same tick, stays consistent', async () => {
  const context = setup({ batchSize: 1, maxParallelChecks: 2, flakyRetries: 1 }, ['a', 'b']);
  await context.tick();
  const [head, child] = Object.values(context.store.candidates).sort((x, y) => x.count - y.count);
  context.verdicts.set(head.sha, 'fail');
  context.verdicts.set(child.sha, 'pass');
  await drain(context);
  assert.deepEqual(landed(context), ['a', 'b']);
  assert.equal(context.ledger.ofType('flaky_candidate').length, 1);
});

test('queue tick: when the trunk moves outside the queue, candidates are rebuilt on the new head', async () => {
  const context = setup({ batchSize: 2, maxParallelChecks: 2, flakyRetries: 0 }, ['a', 'b', 'c']);
  await context.tick();
  const outside = context.vcs.commit('base');
  context.vcs.refs.set('main', outside); // a person merged something by hand
  context.judge();
  await drain(context);
  assert.deepEqual(landed(context).sort(), ['a', 'b', 'c']);
  assert.equal(await context.vcs.isAncestor(outside, await context.vcs.head('main')), true, 'the hand-made commit is kept');
});

test('queue tick: a tick interrupted after the fast-forward is replayed without a second landing', async () => {
  const context = setup({ batchSize: 1, maxParallelChecks: 1, flakyRetries: 0 }, ['a']);
  await context.tick();
  context.judge();
  const before = context.store;
  context.forge.setTicketState = async () => {
    throw new Error('forge unreachable');
  };
  await assert.rejects(() => queueTick(before, config, context.ports), /forge unreachable/);
  context.forge.setTicketState = MemoryForge.prototype.setTicketState;
  context.store = await queueTick(before, config, context.ports);
  assert.equal(context.ledger.ofType('merge').length, 1);
  assert.equal(context.forge.tickets.get('a').state, 'done');
  assert.deepEqual(context.store.queue.pending, []);
});

test('queue tick: random admissions, failures and timings always converge on the right trunk', async () => {
  let seed = 20261120;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 300; round += 1) {
    const queueConfig = { batchSize: 1 + Math.floor(random() * 4), maxParallelChecks: 1 + Math.floor(random() * 3), flakyRetries: Math.floor(random() * 2) };
    const context = setup(queueConfig);
    const ids = Array.from({ length: 2 + Math.floor(random() * 6) }, (_, index) => `p${index}`);
    const bad = new Set(ids.filter(() => random() < 0.25));
    const waiting = [...ids];
    for (let tick = 0; tick < 200; tick += 1) {
      while (waiting.length > 0 && random() < 0.5) context.admit(waiting.shift());
      await context.tick();
      // Verdicts arrive in a random order and at random times.
      for (const [sha, changes] of context.vcs.contents) {
        if (!context.verdicts.has(sha) && random() < 0.6) context.verdicts.set(sha, changes.some((id) => bad.has(id)) ? 'fail' : 'pass');
      }
      if (waiting.length === 0 && context.store.queue.pending.length === 0 && Object.keys(context.store.candidates).length === 0) break;
    }
    const label = `round ${round} ${JSON.stringify(queueConfig)} bad=${[...bad]}`;
    assert.deepEqual(landed(context).sort(), ids.filter((id) => !bad.has(id)).sort(), label);
    assert.deepEqual(evicted(context).sort(), [...bad].sort(), label);
    assert.deepEqual([...new Set(await onTrunk(context))].sort(), ids.filter((id) => !bad.has(id)).sort(), label);
  }
});
