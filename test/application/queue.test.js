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

/** Nothing left to test, land or write down. */
const idle = (context) => context.store.queue.pending.length === 0 && Object.keys(context.store.candidates).length === 0 && (context.store.outbox ?? []).length === 0;

async function drain(context, isBad, maxTicks = 40) {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    await context.tick();
    if (idle(context)) return;
    context.judge(isBad);
  }
  throw new Error('The queue did not drain.');
}

const landed = (context) => context.ledger.ofType('merge').map((entry) => entry.change);
const evicted = (context) => context.ledger.ofType('evict').map((entry) => entry.change);
const onTrunk = async (context) => context.vcs.contents.get(await context.vcs.head('main')) ?? [];

/** A hand-made commit on the trunk; it carries what the trunk already had. */
function outside(context) {
  const head = context.vcs.refs.get('main');
  const commit = context.vcs.commit(head);
  context.vcs.contents.set(commit, context.vcs.contents.get(head) ?? []);
  context.vcs.refs.set('main', commit);
}

test('queue tick: the trunk only fast-forwards to candidates whose checks passed', async () => {
  const context = setup({ batchSize: 2, maxParallelChecks: 2, flakyRetries: 0 }, ['a', 'b', 'c']);
  await context.tick();
  assert.equal(await context.vcs.head('main'), 'base', 'nothing lands while checks are pending');
  await drain(context);
  const merges = context.ledger.ofType('merge');
  assert.deepEqual(landed(context), ['a', 'b', 'c']);
  assert.ok(merges[0].sha === merges[1].sha && merges[1].sha !== merges[2].sha, 'a and b landed as one tested candidate, c as the next');
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
  assert.deepEqual(context.ledger.ofType('evict'), [{ change: 'b', ticket: 'b', reason: 'Conflicts with the future trunk.', identity: 'b@reviewed-b#2' }]);
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
  await queueTick(context.store, config, context.ports); // lands a; the state it returns is never saved
  const landedAt = await context.vcs.head('main');
  assert.notEqual(landedAt, 'base');
  assert.equal(context.ledger.entries.length, 0, 'a tick writes nothing about a decision before its state is saved');
  await drain(context);
  assert.deepEqual([await context.vcs.head('main'), landed(context), context.forge.tickets.get('a').state], [landedAt, ['a'], 'done']);
  assert.deepEqual(context.store.queue.pending, []);
});

test('queue tick: records are delivered after the state is saved, and delivering them twice leaves one trace', async () => {
  const context = setup({ batchSize: 1, maxParallelChecks: 2, flakyRetries: 0 }, ['a', 'b']);
  await context.tick();
  context.judge((id) => id === 'b');
  await context.tick();
  assert.deepEqual(context.store.outbox.map((effect) => [effect.type, effect.change]), [['merge', 'a'], ['evict', 'b']]);
  assert.deepEqual([landed(context), evicted(context)], [[], []]);

  const real = context.forge.setTicketState;
  context.forge.setTicketState = async (id, ...rest) => {
    if (id === 'b') throw new Error('forge unreachable');
    return real.call(context.forge, id, ...rest);
  };
  await assert.rejects(() => context.tick(), /forge unreachable/);
  assert.deepEqual([landed(context), evicted(context), context.forge.tickets.get('b')?.state], [['a'], ['b'], undefined], 'the delivery stopped half way');
  context.forge.setTicketState = real;
  await drain(context);
  assert.deepEqual([landed(context), evicted(context)], [['a'], ['b']]);
  assert.deepEqual(context.ledger.ofType('ticket_outcome').map((entry) => [entry.ticket, entry.outcome]), [['b', 'rework']]);
  assert.deepEqual([context.forge.tickets.get('a').state, context.forge.tickets.get('b').state], ['done', 'rework']);
});

test('queue tick: a tick interrupted after several landings, or after an eviction, is replayed with each effect recorded once', async () => {
  const context = setup({ batchSize: 1, maxParallelChecks: 3, flakyRetries: 0 }, ['a', 'b', 'c']);
  await context.tick();
  context.judge((id) => id === 'c');
  const before = context.store;
  await queueTick(before, config, context.ports); // lands a and b, starts bisecting; its state is lost
  context.store = before;
  await drain(context, (id) => id === 'c');
  assert.deepEqual(landed(context), ['a', 'b'], 'nothing is landed or recorded twice');
  assert.deepEqual(evicted(context), ['c']);
  assert.deepEqual(context.ledger.ofType('ticket_outcome').map((entry) => [entry.ticket, entry.outcome]), [['c', 'rework']]);
  assert.deepEqual(context.vcs.contents.get(await context.vcs.head('main')), ['a', 'b']);

  const again = setup({ batchSize: 1, maxParallelChecks: 1, flakyRetries: 0 }, ['x']);
  await again.tick();
  again.judge(() => true);
  await queueTick(again.store, config, again.ports);
  await queueTick(again.store, config, again.ports); // two ticks decide the eviction and are lost
  await drain(again, () => true);
  assert.deepEqual(evicted(again), ['x'], 'an eviction decided several times and saved once counts once against the ticket');
  again.admit('x');
  await drain(again, () => true);
  assert.deepEqual(evicted(again), ['x', 'x'], 'a later stay of the same commit in the queue is another eviction');
});

test('queue tick: a landing that was interrupted is acknowledged even when the plan changed before the replay', async () => {
  const interrupted = async () => {
    const context = setup({ batchSize: 2, maxParallelChecks: 1, flakyRetries: 0 }, ['a']);
    await context.tick();
    context.judge();
    await queueTick(context.store, config, context.ports); // lands a; its state is lost
    context.admit('b'); // admitted before the replay: the head candidate is no longer "a" alone
    return context;
  };

  const evicting = await interrupted();
  evicting.vcs.conflicts.add('b');
  await drain(evicting);
  assert.deepEqual([landed(evicting), evicted(evicting), await onTrunk(evicting)], [['a'], ['b'], ['a']], 'a is not landed a second time when b leaves the queue');

  const moved = await interrupted();
  outside(moved);
  const built = moved.vcs.count;
  await drain(moved);
  assert.deepEqual([landed(moved), await onTrunk(moved), moved.forge.tickets.get('a').state], [['a', 'b'], ['a', 'b'], 'done']);
  assert.equal(moved.vcs.count - built, 1, 'one candidate is built for b; the queue does not spin');
});

test('queue: admitting the same commit again changes nothing; another commit under an identifier already in the queue is refused', async () => {
  const context = setup({ batchSize: 2, maxParallelChecks: 1, flakyRetries: 0 }, ['a', 'b']);
  await context.tick();
  const before = context.store;
  context.admit('a');
  assert.equal(context.store, before);
  assert.throws(() => admitChange(context.store, { id: 'a', branch: 'factory/ta', sha: 'reviewed-again', ticketId: 'a' }), /already in the merge queue with commit reviewed-a; reviewed-again was not admitted/);
  await drain(context);
  assert.deepEqual([landed(context), context.vcs.contents.get(await context.vcs.head('main'))], [['a', 'b'], ['a', 'b']]);
});

test('queue tick: while the factory is halted, results are read but nothing lands and nobody is evicted', async () => {
  const context = setup({ batchSize: 1, maxParallelChecks: 2, flakyRetries: 0 }, ['a', 'b']);
  let halted = true;
  context.ports.halted = async () => halted;
  await context.tick();
  context.judge((id) => id === 'b');
  await context.tick();
  await context.tick();
  assert.deepEqual([await context.vcs.head('main'), landed(context), evicted(context), context.store.outbox], ['base', [], [], []]);
  halted = false;
  await drain(context, (id) => id === 'b');
  assert.deepEqual([landed(context), evicted(context)], [['a'], ['b']]);
});

/** Wrap a port so that any call may fail, as a forge, a disk or a network does. */
function unreliable(port, fails) {
  return new Proxy(port, {
    get: (target, name) =>
      typeof target[name] !== 'function'
        ? target[name]
        : async (...args) => {
            if (fails()) throw new Error('injected fault');
            return target[name](...args);
          },
  });
}

test('queue tick: random admissions, failures, timings, faults on any call, lost ticks and outside commits always converge on the right trunk', async () => {
  let seed = 20261120;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 400; round += 1) {
    const queueConfig = { batchSize: 1 + Math.floor(random() * 4), maxParallelChecks: 1 + Math.floor(random() * 3), flakyRetries: Math.floor(random() * 2) };
    const context = setup(queueConfig);
    let chaos = true;
    const fails = () => chaos && random() < 0.02;
    const ports = { vcs: unreliable(context.vcs, fails), forge: unreliable(context.forge, fails), ledger: unreliable(context.ledger, fails), checks: unreliable(context.checks, fails) };
    const ids = Array.from({ length: 2 + Math.floor(random() * 6) }, (_, index) => `p${index}`);
    const bad = new Set(ids.filter(() => random() < 0.25));
    const waiting = [...ids];
    let settled = false;
    for (let tick = 0; tick < 400 && !settled; tick += 1) {
      chaos = tick < 150;
      while (waiting.length > 0 && random() < 0.5) context.admit(waiting.shift());
      if (chaos && random() < 0.15) await queueTick(context.store, config, ports).catch(() => {}); // a tick whose state is lost before it is saved
      if (waiting.length > 0 && random() < 0.3) context.admit(waiting.shift()); // the dispatcher admits a change before the replay
      if (chaos && random() < 0.03) outside(context); // a person merges something by hand
      try {
        context.store = await queueTick(context.store, config, ports);
      } catch (error) {
        assert.equal(error.message, 'injected fault'); // the tick stopped where a port failed; nothing was saved
      }
      // Verdicts arrive in a random order and at random times.
      for (const [sha, changes] of context.vcs.contents) {
        if (!context.verdicts.has(sha) && random() < 0.6) context.verdicts.set(sha, changes.some((id) => bad.has(id)) ? 'fail' : 'pass');
      }
      settled = !chaos && waiting.length === 0 && idle(context);
    }
    const label = `round ${round} ${JSON.stringify(queueConfig)} bad=${[...bad]}`;
    assert.ok(settled, `${label}: the queue did not settle`);
    assert.deepEqual(landed(context).sort(), ids.filter((id) => !bad.has(id)).sort(), label);
    assert.deepEqual(evicted(context).sort(), [...bad].sort(), label);
    assert.deepEqual(context.ledger.ofType('ticket_outcome').map((entry) => entry.ticket).sort(), [...bad].sort(), `${label}: one rework per eviction`);
    assert.deepEqual((await onTrunk(context)).sort(), ids.filter((id) => !bad.has(id)).sort(), `${label}: each good change is on the trunk exactly once`);
    for (const id of ids) assert.equal(context.forge.tickets.get(id)?.state, bad.has(id) ? 'rework' : 'done', `${label}: ticket ${id}`);
  }
});
