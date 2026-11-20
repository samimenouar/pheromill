import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryForge, MemoryLedger, MemoryVcs, ScriptedChecks, ScriptedRunner, StaticRegistry } from '../../src/adapters/memory.js';
import { serveSpool, SpoolClient } from '../../src/adapters/spool.js';
import { dispatchTick } from '../../src/application/dispatch.js';
import { createQueue } from '../../src/domain/merge-queue.js';
import { renderTicketBody } from '../../src/domain/ticket.js';
import { fileDiff, testConfig } from '../helpers.js';

const DIGEST = `sha256:${'c'.repeat(64)}`;
const config = testConfig({
  providers: { p: { baseUrl: 'https://p.example', authHeader: 'x', keyEnv: 'P_KEY', paths: ['/v1'] } },
  harnesses: { alpha: { family: 'anthropic', image: DIGEST, command: ['a'], provider: 'p' }, beta: { family: 'openai', image: DIGEST, command: ['b'], provider: 'p' } },
  routing: ['specify', 'implement', 'review', 'security_review', 'test_guard_review', 'refute', 'arbitrate'].flatMap((step) => ['alpha', 'beta'].map((harness) => ({ step, levels: ['LOW', 'HIGH', 'CRITICAL'], harness, model: 'm', grade: 'A' }))),
  autonomy: { tier: 1 },
});

const criterion = 'It works';
const issue = (id, files, extra = {}) => ({
  id,
  title: `Ticket ${id}`,
  labels: ['factory:ready'],
  milestone: null,
  body: renderTicketBody({ title: `Ticket ${id}`, description: 'd', acceptanceCriteria: [criterion], likelyFiles: files, points: 2 }),
  ...extra,
});

function world(script, issues) {
  const forge = new MemoryForge();
  for (const entry of issues) forge.tickets.set(entry.id, entry);
  let saved = { queue: createQueue(config.queue), candidates: {}, changes: {}, awaiting: {} };
  const specify = (job) => ({ patch: fileDiff(`holdout/t${job.input.ticket.id}.test.js`, { added: ['assert.ok(works)'], status: 'added' }) });
  const ports = {
    forge,
    runner: new ScriptedRunner({ specify, ...script }),
    vcs: new MemoryVcs(),
    checks: new ScriptedChecks(),
    registry: new StaticRegistry(),
    ledger: new MemoryLedger(),
    clock: { now: () => new Date('2026-11-20T00:00:00Z') },
    store: new SerialStore(() => saved, (value) => { saved = value; }),
  };
  return { ports, forge, queue: () => saved };
}

/** A store double that yields between read and write, as a real file store does. */
class SerialStore {
  constructor(read, write) {
    Object.assign(this, { read, write, pending: Promise.resolve() });
  }

  update(change) {
    const next = this.pending.then(async () => {
      const current = this.read();
      await new Promise((resolve) => setImmediate(resolve));
      const value = await change(current);
      this.write(value);
      return value;
    });
    this.pending = next.catch(() => {});
    return next;
  }
}

const approve = { report: { findings: [], criteria: { [criterion]: true } } };
const patchFor = (job) => fileDiff(job.input.ticket.likelyFiles[0], { added: ['x'], status: 'added' });

test('dispatcher: non-overlapping tickets run, overlapping ones wait, approved changes enter the queue', async () => {
  const { ports, forge, queue } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [
    issue('1', ['src/app/a.js']),
    issue('2', ['src/app/a.js']),
    issue('3', ['src/app/b.js']),
  ]);
  const result = await dispatchTick({ startedKinds: [], history: [] }, config, ports);
  assert.deepEqual(result.started, ['1', '3']);
  assert.deepEqual(result.held, [{ id: '2', reason: 'overlaps 1' }]);
  assert.deepEqual(result.outcomes, { 1: 'queued', 3: 'queued' });
  assert.deepEqual(queue().queue.pending.length, 2);
  assert.deepEqual(Object.values(queue().changes).map((change) => [change.branch, typeof change.sha]).sort(), [['factory/t1', 'string'], ['factory/t3', 'string']], 'a change is queued with the commit that passed its gates');

  forge.tickets.set('1', { ...forge.tickets.get('1'), labels: [] });
  forge.tickets.set('3', { ...forge.tickets.get('3'), labels: [] });
  const next = await dispatchTick({ startedKinds: [], history: [] }, config, ports);
  assert.deepEqual(next.held, [{ id: '2', reason: 'overlaps ticket 1' }], 'a change still in the queue keeps its files occupied');
  assert.equal(forge.tickets.get('1').state, 'queued');
  assert.equal(forge.tickets.get('2').state, undefined, 'a held ticket is left untouched');
});

test('dispatcher: a rerouted ticket keeps its number, gets its risk label, and is capped', async () => {
  const core = fileDiff('src/domain/x.js', { added: ['x'], status: 'added' });
  const { ports, forge } = world({ implement: () => ({ patch: core }), review: () => approve }, [issue('5', ['src/app/x.js'])]);
  const first = await dispatchTick({ startedKinds: [], history: [] }, config, ports);
  assert.deepEqual(first.outcomes, { 5: 'rework' });
  assert.equal(forge.tickets.get('5').state, 'rework');
  assert.deepEqual(forge.changes.get('5').labels, ['risk:high']);

  const history = [1, 2].map(() => ({ ticket: '5', type: 'ticket_outcome', outcome: 'rework' }));
  forge.tickets.set('5', issue('5', ['src/app/x.js'], { labels: ['factory:rework'] }));
  const capped = await dispatchTick({ startedKinds: [], history }, config, ports);
  assert.deepEqual(capped.outcomes, { 5: 'needs_owner' });
  assert.deepEqual(capped.started, []);
});

test('dispatcher: a frozen milestone defers every ticket that does not block one of its exit criteria', async () => {
  const frozen = { ...config, milestone: { name: 'M1', frozen: true } };
  const { ports, forge } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [
    issue('1', ['src/app/a.js'], { milestone: 'M1' }),
    issue('2', ['src/app/b.js'], { milestone: 'M1', labels: ['factory:ready', 'blocks-exit-criterion'] }),
    issue('3', ['src/app/c.js']),
  ]);
  const result = await dispatchTick({ startedKinds: [], history: [] }, frozen, ports);
  assert.deepEqual(result.outcomes, { 1: 'later', 3: 'later', 2: 'queued' });
  assert.equal(forge.tickets.get('1').state, 'later');
  assert.deepEqual(result.started, ['2']);
});

test('dispatcher: a split closes the original and creates tickets that parse like any other', async () => {
  const huge = fileDiff('src/app/big.js', { added: Array.from({ length: 450 }, (_, i) => `l${i}`), status: 'added' });
  const child = (title) => ({ title, description: title, acceptanceCriteria: [criterion], likelyFiles: ['src/app/big.js'], points: 1, kind: 'feature' });
  const { ports, forge } = world(
    { implement: () => ({ patch: huge }), arbitrate: () => ({ report: { action: 'split', tickets: [child('Part one'), child('Part two')] } }) },
    [issue('9', ['src/app/big.js'])],
  );
  const result = await dispatchTick({ startedKinds: [], history: [] }, config, ports);
  assert.deepEqual(result.outcomes, { 9: 'split' });
  assert.match(forge.tickets.get('9').note, /Proposed replacements: #1001, #1002/);
  const children = [...forge.tickets.values()].filter((t) => t.title.startsWith('Part'));
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => !child.labels.includes('factory:ready')), 'a ticket proposed by an agent is not dispatched until a person labels it');
});

test('dispatcher: an unexpected pipeline error stops that ticket only and is recorded', async () => {
  const { ports, forge } = world(
    { implement: (job) => { if (job.input.ticket.id === '1') throw new Error('sandbox host unreachable'); return { patch: patchFor(job) }; }, review: () => approve },
    [issue('1', ['src/app/a.js']), issue('2', ['src/app/b.js'])],
  );
  const result = await dispatchTick({ startedKinds: [], history: [] }, config, ports);
  assert.deepEqual(result.outcomes, { 1: 'needs_owner', 2: 'queued' });
  assert.match(forge.tickets.get('1').note, /sandbox host unreachable/);
});

test('dispatcher: at tier 0 a change that passed every gate enters the queue when a person approves it', async () => {
  const tierZero = { ...config, autonomy: { ...config.autonomy, tier: 0 } };
  const { ports, forge, queue } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('1', ['src/app/a.js'])]);
  const first = await dispatchTick({ startedKinds: [], history: [] }, tierZero, ports);
  assert.deepEqual(first.outcomes, { 1: 'needs_owner' });
  assert.match(forge.tickets.get('1').note, /add the label "factory:approved"/);
  assert.deepEqual(queue().queue.pending, []);
  const waiting = Object.keys(queue().awaiting);
  assert.equal(waiting.length, 1);

  forge.tickets.set('1', { ...forge.tickets.get('1'), labels: [] });
  forge.approved.add('unknown-change');
  await dispatchTick({ startedKinds: [], history: [] }, tierZero, ports);
  assert.deepEqual(queue().queue.pending, [], 'approving something that did not pass the gates does nothing');
  forge.approved.add(waiting[0]);
  const second = await dispatchTick({ startedKinds: [], history: [] }, tierZero, ports);
  assert.deepEqual(second.outcomes, { 1: 'queued' });
  assert.deepEqual(queue().queue.pending, waiting);
  assert.deepEqual(queue().awaiting, {});
  assert.equal(queue().changes[waiting[0]].sha, ports.vcs.published[0].sha, 'the approved commit is the reviewed one');
});

test('dispatcher: after a restart, a ticket left in progress with nobody working on it starts again', async () => {
  const { ports, forge } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('7', ['src/app/a.js'], { labels: ['factory:in-progress'] })]);
  const memory = { startedKinds: [], history: [] };
  await dispatchTick(memory, config, ports);
  assert.equal(forge.tickets.get('7').state, 'rework');
  forge.tickets.set('8', issue('8', ['src/app/b.js'], { labels: ['factory:in-progress'] }));
  await dispatchTick(memory, config, ports);
  assert.equal(forge.tickets.get('8').state, undefined, 'recovery happens once, at start-up');
});

test('dispatcher: a failure while recording an outcome never leaves a ticket in progress', async () => {
  const { ports, forge } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('1', ['src/app/a.js'])]);
  const original = ports.store.update.bind(ports.store);
  let calls = 0;
  ports.store.update = (change) => ((calls += 1) === 2 ? Promise.reject(new Error('disk full')) : original(change));
  const result = await dispatchTick({ startedKinds: [], history: [] }, config, ports);
  assert.deepEqual(result.outcomes, { 1: 'needs_owner' });
  assert.match(forge.tickets.get('1').note, /disk full/);
});

test('spool: a job crosses the zone boundary as a file and its answer is sanitised', async () => {
  const spool = mkdtempSync(join(tmpdir(), 'pheromill-spool-'));
  const controller = new AbortController();
  const seen = [];
  const serving = serveSpool({
    spool,
    pollMs: 5,
    signal: controller.signal,
    runner: { run: async (job) => {
      seen.push(job.step);
      if (job.step === 'explode') throw new Error('container failed to start');
      return { patch: 42, report: 'not an object', seconds: 3, tokens: 'many', extra: 'ignored' };
    } },
  });
  const client = new SpoolClient({ spool, pollMs: 5, timeoutMs: 2000 });
  assert.deepEqual(await client.run({ runId: 't1-1', step: 'implement' }), { patch: '', report: {}, seconds: 3, tokens: null });
  assert.deepEqual(readdirSync(join(spool, 'jobs')), [], 'served jobs and temporary files are gone');
  await assert.rejects(() => client.run({ runId: 't1-2', step: 'explode' }), /container failed to start/);
  await assert.rejects(() => client.run({ runId: '../escape', step: 'implement' }), /Invalid run identifier/);
  await assert.rejects(() => new SpoolClient({ spool: join(spool, 'nobody-serves'), pollMs: 5, timeoutMs: 20 }).run({ runId: 't1-3', step: 'x' }), /no answer/);
  controller.abort();
  await serving;
  assert.deepEqual(seen, ['implement', 'explode']);
  rmSync(spool, { recursive: true, force: true });
});

test('spool: an answer to an earlier job with the same identifier is never taken for the new one', async () => {
  const spool = mkdtempSync(join(tmpdir(), 'pheromill-spool-'));
  mkdirSync(join(spool, 'results'), { recursive: true });
  const client = new SpoolClient({ spool, pollMs: 5, timeoutMs: 400 });
  const pending = client.run({ runId: 't7-1', step: 'implement' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // What a runner would write if it finished a job submitted before a restart of the control zone.
  writeFileSync(join(spool, 'results', 't7-1.json'), JSON.stringify({ patch: 'patch for the old job', nonce: 'stale' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const job = JSON.parse(readFileSync(join(spool, 'jobs', 't7-1.json'), 'utf8'));
  writeFileSync(join(spool, 'results', 't7-1.json'), JSON.stringify({ patch: 'patch for the new job', nonce: job.nonce }));
  assert.equal((await pending).patch, 'patch for the new job');
  rmSync(spool, { recursive: true, force: true });
});
