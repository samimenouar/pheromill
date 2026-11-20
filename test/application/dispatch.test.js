import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('dispatcher: a rerouted ticket keeps its number, gets its risk label, and is capped until the owner restarts it', async () => {
  const core = fileDiff('src/domain/x.js', { added: ['x'], status: 'added' });
  const { ports, forge } = world({ implement: () => ({ patch: core }), review: () => approve }, [issue('5', ['src/app/x.js'])]);
  const memory = { startedKinds: [], history: [] };
  const first = await dispatchTick(memory, config, ports);
  assert.deepEqual(first.outcomes, { 5: 'rework' });
  assert.deepEqual(forge.tickets.get('5').labels, ['risk:high', 'factory:rework']);

  memory.history = ports.ledger.entries.filter((entry) => entry.type === 'ticket_outcome').map((entry) => ({ type: entry.type, ...entry.data }));
  for (let sent = memory.history.length; sent < config.scheduling.maxReworks; sent += 1) memory.history.push({ ticket: '5', type: 'ticket_outcome', outcome: 'rework' });
  const capped = await dispatchTick(memory, config, ports);
  assert.deepEqual([capped.outcomes, capped.started], [{ 5: 'needs_owner' }, []]);
  assert.match(forge.tickets.get('5').note, /fresh allowance/);
  assert.equal(ports.ledger.ofType('ticket_outcome').at(-1).outcome, 'needs_owner', 'the hand-over to the owner is recorded');

  forge.tickets.set('5', { ...forge.tickets.get('5'), labels: ['risk:high', 'factory:ready'] });
  const restarted = await dispatchTick(memory, config, ports);
  assert.deepEqual(restarted.started, ['5'], 'the owner relabels the ticket and it runs again, with a fresh allowance');
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

test('dispatcher: at tier 0 a change that passed every gate enters the queue when a person approves that commit', async () => {
  const tierZero = { ...config, autonomy: { ...config.autonomy, tier: 0 } };
  const { ports, forge, queue } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('1', ['src/app/a.js'])]);
  const tick = () => dispatchTick({ startedKinds: [], history: [] }, tierZero, ports);
  forge.approved.add('change-1'); // a label left on the change request by an earlier round
  const first = await tick();
  assert.deepEqual(first.outcomes, { 1: 'needs_owner' });
  assert.match(forge.tickets.get('1').note, /add the label "factory:approved"/);
  assert.deepEqual([queue().queue.pending, Object.keys(queue().awaiting)], [[], ['change-1']]);
  assert.equal(forge.approved.has('change-1'), false, 'an approval given before the gates passed approves nothing');
  const reviewed = ports.vcs.published[0].sha;

  forge.approved.add('unknown-change');
  await tick();
  assert.deepEqual(queue().queue.pending, [], 'approving something that did not pass the gates does nothing');
  assert.match(forge.comments.at(-1).body, /not waiting for an approval/);

  forge.heads.set('change-1', 'pushed-after-review');
  forge.approved.add('change-1');
  await tick();
  assert.deepEqual([queue().queue.pending, forge.approved.size], [[], 0], 'an approval of another commit is refused and removed');
  assert.match(forge.comments.at(-1).body, new RegExp(`points to pushed-after-review, and the commit that passed the gates is ${reviewed}`));

  forge.heads.set('change-1', reviewed);
  forge.approved.add('change-1');
  const second = await tick();
  assert.deepEqual(second.outcomes, { 1: 'queued' });
  assert.deepEqual([queue().queue.pending, queue().awaiting, forge.approved.size], [['change-1'], {}, 0], 'the approval is spent');
  assert.equal(queue().changes['change-1'].sha, reviewed, 'the approved commit is the reviewed one');
});

test('dispatcher: a change stops waiting for approval when the owner sends its ticket back to work', async () => {
  const tierZero = { ...config, autonomy: { ...config.autonomy, tier: 0 } };
  const { ports, forge, queue } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('1', ['src/app/a.js'])]);
  const tick = () => dispatchTick({ startedKinds: [], history: [] }, tierZero, ports);
  await tick();
  assert.deepEqual(Object.keys(queue().awaiting), ['change-1']);
  assert.deepEqual((await tick()).started, [], 'while it waits, its files stay taken');
  assert.deepEqual(Object.keys(queue().awaiting), ['change-1']);

  forge.tickets.set('1', { ...forge.tickets.get('1'), labels: ['factory:ready'] });
  const again = await tick();
  assert.deepEqual(again.started, ['1'], 'a ticket is never blocked by its own abandoned change');
  assert.equal(ports.vcs.published.length, 2);
  assert.equal(queue().awaiting['change-1'].sha, ports.vcs.published[1].sha, 'what waits now is the new commit');
});

test('dispatcher: a ticket left in progress with nobody working on it starts again, a bounded number of times', async () => {
  const { ports, forge } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('7', ['src/app/a.js'], { labels: ['factory:in-progress'] })]);
  const memory = { startedKinds: [], history: [] };
  const first = await dispatchTick(memory, config, ports);
  assert.deepEqual(first.outcomes, { 7: 'queued' }, 'recovered and worked in the same tick');
  assert.deepEqual(ports.ledger.ofType('ticket_outcome').map((entry) => entry.outcome), ['rework', 'queued']);

  forge.tickets.set('8', issue('8', ['src/app/b.js'], { labels: ['factory:in-progress'] }));
  for (let sent = 0; sent < config.scheduling.maxReworks; sent += 1) memory.history.push({ ticket: '8', type: 'ticket_outcome', outcome: 'rework' });
  const later = await dispatchTick(memory, config, ports);
  assert.deepEqual(later.outcomes, { 8: 'needs_owner' }, 'recovery happens on every tick, and a ticket that keeps being interrupted goes to the owner');
});

test('dispatcher: a ticket stopped by a halt goes back to the pile without using its allowance', async () => {
  const { ports, forge } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('1', ['src/app/a.js'])]);
  const result = await dispatchTick({ startedKinds: [], history: [] }, config, { ...ports, halted: async () => true });
  assert.deepEqual(result.outcomes, { 1: 'halted' });
  assert.deepEqual(forge.tickets.get('1').labels, ['factory:rework']);
  assert.deepEqual(ports.ledger.ofType('ticket_outcome').map((entry) => entry.outcome), ['halted']);
  assert.equal(ports.runner.jobs.length, 0);
});

test('dispatcher: a failure while recording an outcome never leaves a ticket in progress', async () => {
  const { ports, forge } = world({ implement: (job) => ({ patch: patchFor(job) }), review: () => approve }, [issue('1', ['src/app/a.js'])]);
  const original = ports.store.update.bind(ports.store);
  let calls = 0;
  ports.store.update = (change) => ((calls += 1) === 2 ? Promise.reject(new Error('disk full')) : original(change));
  const result = await dispatchTick({ startedKinds: [], history: [] }, config, ports);
  assert.deepEqual(result.outcomes, { 1: 'needs_owner' });
  assert.match(forge.tickets.get('1').note, /disk full/);
  assert.deepEqual(ports.ledger.ofType('ticket_outcome').map((entry) => entry.outcome), ['queued', 'needs_owner']);

  const refusing = world({ implement: () => { throw new Error('sandbox host unreachable'); } }, [issue('2', ['src/app/b.js'])]);
  const label = refusing.forge.setTicketState.bind(refusing.forge);
  refusing.forge.setTicketState = (id, state, note) => (state === 'needs_owner' ? Promise.reject(new Error('forge unreachable')) : label(id, state, note));
  await dispatchTick({ startedKinds: [], history: [] }, config, refusing.ports);
  assert.deepEqual(refusing.ports.ledger.ofType('ticket_outcome'), [], 'the hand-over is recorded only once the owner really has the ticket');
  assert.deepEqual(refusing.forge.tickets.get('2').labels, ['factory:in-progress'], 'found in progress at the next tick, it starts again within the cap');
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
  mkdirSync(join(spool, 'jobs'), { recursive: true });
  const stale = `t7-1.${'0'.repeat(32)}.json`;
  writeFileSync(join(spool, 'jobs', stale), JSON.stringify({ runId: 't7-1' }));
  const client = new SpoolClient({ spool, pollMs: 5, timeoutMs: 400 });
  const pending = client.run({ runId: 't7-1', step: 'implement' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const [name] = readdirSync(join(spool, 'jobs'));
  assert.notEqual(name, stale, 'the earlier submission was withdrawn');
  // What a runner would write if it finished the job submitted before a restart of the control zone.
  writeFileSync(join(spool, 'results', stale), JSON.stringify({ patch: 'patch for the old job' }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  writeFileSync(join(spool, 'results', name), JSON.stringify({ patch: 'patch for the new job' }));
  assert.equal((await pending).patch, 'patch for the new job');
  rmSync(spool, { recursive: true, force: true });
});

test('spool: oversized submissions and a spool directory replaced by a link are refused', async () => {
  const spool = mkdtempSync(join(tmpdir(), 'pheromill-spool-'));
  const client = new SpoolClient({ spool, pollMs: 5, timeoutMs: 50 });
  await assert.rejects(() => client.run({ runId: 't1-1', step: 'review', patches: ['x'.repeat(17 * 1024 * 1024)] }), /too large to submit/);
  const victim = mkdtempSync(join(tmpdir(), 'pheromill-victim-'));
  writeFileSync(join(victim, `t9-1.${'a'.repeat(32)}.json`), '{}');
  rmSync(join(spool, 'results'), { recursive: true, force: true });
  symlinkSync(victim, join(spool, 'results'));
  await assert.rejects(() => client.run({ runId: 't9-1', step: 'review' }), /not a directory/);
  assert.deepEqual(readdirSync(victim).length, 1, 'nothing outside the spool was touched');
  rmSync(spool, { recursive: true, force: true });
  rmSync(victim, { recursive: true, force: true });
});

test('spool: a runner that lost control of a sandbox answers the job, then stops serving', async () => {
  const spool = mkdtempSync(join(tmpdir(), 'pheromill-spool-'));
  const lost = Object.assign(new Error('Sandbox pheromill-t1 could not be stopped'), { fatal: true });
  let runs = 0;
  const serving = serveSpool({ spool, pollMs: 5, runner: { run: async () => { runs += 1; throw lost; } } }).then(() => null, (error) => error);
  const client = new SpoolClient({ spool, pollMs: 5, timeoutMs: 2000 });
  const answer = await client.run({ runId: 't1-1', step: 'implement' });
  assert.match(answer.report.error, /could not be stopped/);
  assert.equal(await serving, lost, 'the service ends; started again, it sweeps what it left behind');
  assert.equal(runs, 1);
  rmSync(spool, { recursive: true, force: true });
});
