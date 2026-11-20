import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arbitrate, budgetFor, detectLoop, exceeded, nearLimit, returnedFinding, usage } from '../../src/domain/budget.js';
import { acknowledgeLanded, createQueue, dequeue, enqueue, forget, plan, recordResult, settle } from '../../src/domain/merge-queue.js';
import { debtIsDue, selectRunnable } from '../../src/domain/scheduler.js';
import { admit, closure, parseTicket, renderTicketBody, validateTicket } from '../../src/domain/ticket.js';
import { testConfig } from '../helpers.js';

const config = testConfig();

const formBody = [
  '### What the user will see',
  '',
  'A visitor can reset a forgotten password.',
  '',
  '### Acceptance criteria',
  '',
  '- [ ] A reset link is emailed',
  '- [ ] The link expires after one hour',
  '',
  '### Likely files',
  '',
  '- `src/auth/**`',
  '- src/mail/reset.js',
  '',
  '### Points',
  '',
  '3',
].join('\n');

test('ticket: parses the form and validates size, criteria and likely files', () => {
  const ticket = parseTicket({ id: 42, title: 'Password reset', body: formBody, labels: ['kind:fix'] });
  assert.equal(ticket.id, '42');
  assert.equal(ticket.points, 3);
  assert.equal(ticket.kind, 'fix');
  assert.deepEqual(ticket.acceptanceCriteria, ['A reset link is emailed', 'The link expires after one hour']);
  assert.deepEqual(ticket.likelyFiles, ['src/auth/**', 'src/mail/reset.js']);
  assert.deepEqual(validateTicket(ticket, config), []);
});

test('ticket: a micro-fix, an oversized ticket or a ticket without criteria is not dispatchable', () => {
  const form = (answers) => ['What the user will see', 'Acceptance criteria', 'Likely files', 'Points'].map((title, i) => `### ${title}\n\n${answers[i]}\n`).join('\n');
  const problems = (answers) => validateTicket(parseTicket({ id: 1, title: 't', body: form(answers) }), config);
  assert.equal(problems(['x', '_No response_', '_No response_', '8']).length, 3);
  assert.equal(problems(['x', '- works', '- src/a.js', '0']).length, 1);
  assert.equal(problems(['x', '- works', '- src/a.js', '3 ']).length, 0);
  assert.equal(validateTicket(parseTicket({ id: 2, title: '', body: '' }), config).length, 5);
  for (const malformed of [null, {}, { title: 't', points: 2, acceptanceCriteria: 'works', likelyFiles: 'src/a.js' }, { title: 't', points: 2, acceptanceCriteria: [1], likelyFiles: [null] }]) {
    assert.ok(validateTicket(malformed, config).length > 0, 'a malformed ticket is refused, never a crash');
  }
});

test('ticket: the form is read strictly; ambiguity is refused, not guessed', () => {
  const body = (description, criteria, files) => `### What the user will see\r\n\r\n${description}\r\n\r\n### Acceptance criteria\r\n\r\n${criteria}\r\n\r\n### Likely files\r\n\r\n${files}\r\n\r\n### Points\r\n\r\n2\r\n`;
  const parsed = parseTicket({ id: 3, title: 't', body: body('d', '3.5 seconds or less\n-1 is rejected\n1. first', '*.md\n./src/a.js\n- `docs/**`') });
  assert.deepEqual(parsed.acceptanceCriteria, ['3.5 seconds or less', '-1 is rejected', 'first'], 'only real list markers are stripped');
  assert.deepEqual(parsed.likelyFiles, ['*.md', 'src/a.js', 'docs/**']);
  assert.deepEqual(validateTicket(parsed, config), []);

  const quoted = parseTicket({ id: 4, title: 't', body: body('d\n### Points\n\n1', '- works', '- src/a.js') });
  assert.equal(quoted.wellFormed, false, 'a heading quoted inside an answer makes the form ambiguous');
  assert.match(validateTicket(quoted, config)[0], /does not follow the ticket form/);
  const odd = parseTicket({ id: 5, title: 't', body: body('d', '- works', '- a file with spaces.js') });
  assert.match(validateTicket(odd, config).join(' '), /plain paths or globs/);
});

test('ticket: done means done; unmet criteria send the same ticket back to rework', () => {
  const ticket = parseTicket({ id: 42, title: 'Password reset', body: formBody });
  const partial = closure(ticket, { 'A reset link is emailed': true });
  assert.deepEqual(partial, { done: false, unmet: ['The link expires after one hour'] });
});

test('ticket: a frozen milestone only admits tickets that block an exit criterion', () => {
  const milestone = { name: 'M1', frozen: true };
  const base = parseTicket({ id: 1, title: 't', body: formBody, milestone: 'M1' });
  assert.equal(admit(base, milestone), 'later');
  assert.equal(admit({ ...base, blocksExitCriterion: true }, milestone), 'ready');
  assert.equal(admit({ ...base, blocksExitCriterion: true, milestone: 'M2' }, milestone), 'later');
  assert.equal(admit(base, { name: 'M1', frozen: false }), 'ready');
});

test('scheduler: tickets whose likely files may overlap never run together', () => {
  const ready = [
    { id: 'a', kind: 'feature', likelyFiles: ['src/auth/**'] },
    { id: 'b', kind: 'feature', likelyFiles: ['src/auth/login.js'] },
    { id: 'c', kind: 'feature', likelyFiles: ['src/billing/**'] },
  ];
  const result = selectRunnable(ready, [], { maxParallelTickets: 4, featuresPerDebtTicket: 4, startedKinds: [] });
  assert.deepEqual(result.start.map((t) => t.id), ['a', 'c']);
  assert.deepEqual(result.held, [{ id: 'b', reason: 'overlaps a' }]);
});

test('scheduler: capacity is bounded and one debt ticket is owed per four feature tickets', () => {
  const ready = [
    { id: 'f1', kind: 'feature', likelyFiles: ['a/**'] },
    { id: 'f2', kind: 'feature', likelyFiles: ['b/**'] },
    { id: 'd1', kind: 'debt', likelyFiles: ['c/**'] },
  ];
  const options = { maxParallelTickets: 2, featuresPerDebtTicket: 4, startedKinds: ['feature', 'feature', 'feature', 'fix'] };
  const result = selectRunnable(ready, [], options);
  assert.deepEqual(result.start.map((t) => t.id), ['d1', 'f1']);
  assert.deepEqual(result.held, [{ id: 'f2', reason: 'capacity' }]);
  assert.equal(debtIsDue(['feature', 'feature', 'feature'], 4), false);
  assert.equal(debtIsDue(['feature', 'feature', 'feature', 'feature', 'debt'], 4), false);
});

test('budget: ceilings scale with points and uncalibrated ones stay UNKNOWN', () => {
  const budget = budgetFor({ points: 3 }, config);
  assert.equal(budget.sandboxSeconds, 5400);
  assert.equal(budget.tokens, null);
  const counters = { commits: 16, ciRuns: 4, tokens: 1000 };
  assert.equal(usage(counters, budget).tokens, 'UNKNOWN');
  assert.deepEqual(exceeded(counters, budget), ['commits']);
  assert.equal(nearLimit({ commits: 12 }, budget, 0.8), true);
  assert.equal(nearLimit({ commits: 11 }, budget, 0.8), false);
});

test('loop detection: each of the five deterministic triggers fires', () => {
  const budget = budgetFor({ points: 2 }, config);
  const base = { steps: [], counters: {}, changedLines: 10, points: 2, refutedFingerprints: [], raisedFingerprints: [] };
  const step = (errorSignature, changedFiles = 1) => ({ errorSignature, changedFiles });

  assert.equal(detectLoop(base, budget, config.limits), null);
  assert.equal(detectLoop({ ...base, steps: [step('E1'), step('E1'), step('E1')] }, budget, config.limits).trigger, 'same_error_three_times');
  assert.equal(detectLoop({ ...base, steps: [step('E1'), step('E2'), step('E1')] }, budget, config.limits), null);
  assert.equal(detectLoop({ ...base, counters: { ciRuns: 5 } }, budget, config.limits).trigger, 'counter_exceeded');
  assert.equal(detectLoop({ ...base, steps: [step(null, 0), step(null, 0)] }, budget, config.limits).trigger, 'no_change_twice');
  assert.equal(detectLoop({ ...base, changedLines: 401 }, budget, config.limits).trigger, 'size_exceeded');
  assert.equal(detectLoop({ ...base, points: 6 }, budget, config.limits).trigger, 'size_exceeded');
  const returned = { ...base, refutedFingerprints: ['abc'], raisedFingerprints: ['abc'] };
  assert.equal(detectLoop(returned, budget, config.limits).trigger, 'refuted_finding_returned');
});

test('arbiter: three outcomes, one escalation per ticket, then the owner decides', () => {
  const first = { escalations: 0, otherFamilyAvailable: true };
  assert.equal(arbitrate({ ...first, trigger: 'size_exceeded' }).action, 'split');
  assert.equal(arbitrate({ ...first, trigger: 'same_error_three_times' }).action, 'reassign');
  assert.equal(arbitrate({ ...first, trigger: 'counter_exceeded' }).action, 'ask_owner');
  assert.equal(arbitrate({ ...first, trigger: 'size_exceeded', proposal: 'reassign' }).action, 'reassign');
  assert.equal(arbitrate({ ...first, trigger: 'size_exceeded', proposal: 'merge_anyway' }).action, 'split');
  assert.equal(arbitrate({ ...first, trigger: 'no_change_twice', otherFamilyAvailable: false }).action, 'ask_owner');
  assert.equal(arbitrate({ trigger: 'size_exceeded', escalations: 1, otherFamilyAvailable: true, proposal: 'split' }).action, 'ask_owner');
});

const queueConfig = { batchSize: 4, maxParallelChecks: 2, flakyRetries: 0 };
const fill = (config, ids) => ids.reduce((state, id) => enqueue(state, id), createQueue(config));

test('merge queue: a batch that passes lands as one tested candidate', () => {
  let state = fill(queueConfig, ['1', '2', '3']);
  const [head] = plan(state);
  assert.deepEqual(head.changes, ['1', '2', '3']);
  state = recordResult(state, head.key, 'pass');
  const settled = settle(state);
  assert.deepEqual(settled.actions, [{ type: 'merge', key: head.key, changes: ['1', '2', '3'] }]);
  assert.deepEqual(settled.state.pending, []);
});

test('merge queue: later batches are tested on the future trunk and stay valid when the head lands', () => {
  let state = fill(queueConfig, ['1', '2', '3', '4', '5', '6']);
  const [head, speculative] = plan(state);
  assert.deepEqual(head.changes, ['1', '2', '3', '4']);
  assert.deepEqual(speculative.changes, ['1', '2', '3', '4', '5', '6']);
  assert.equal(speculative.speculative, true);
  state = recordResult(recordResult(state, speculative.key, 'pass'), head.key, 'pass');
  const settled = settle(state);
  assert.deepEqual(settled.actions.map((a) => a.changes), [['1', '2', '3', '4'], ['5', '6']]);
});

test('merge queue: a failed batch is bisected, good halves land, the culprit alone is evicted', () => {
  let state = fill({ ...queueConfig, maxParallelChecks: 1 }, ['1', '2', '3', '4']);
  const actions = [];
  const failing = '3';
  for (let guard = 0; guard < 20; guard += 1) {
    const [candidate] = plan(state);
    if (!candidate) break;
    state = recordResult(state, candidate.key, candidate.changes.includes(failing) ? 'fail' : 'pass');
    const settled = settle(state);
    state = settled.state;
    actions.push(...settled.actions.map((a) => (a.type === 'merge' ? `merge ${a.changes.join(',')}` : `${a.type} ${a.change}`)));
  }
  assert.deepEqual(actions, ['merge 1,2', 'evict 3', 'merge 4']);
});

test('merge queue: the last change of a failed batch is evicted without a wasted run', () => {
  let state = fill({ ...queueConfig, batchSize: 2, maxParallelChecks: 1 }, ['1', '2']);
  let [candidate] = plan(state);
  state = settle(recordResult(state, candidate.key, 'fail')).state;
  [candidate] = plan(state);
  assert.deepEqual(candidate.changes, ['1']);
  const settled = settle(recordResult(state, candidate.key, 'pass'));
  assert.deepEqual(settled.actions.map((a) => a.type), ['merge', 'evict']);
  assert.equal(settled.actions[1].change, '2');
  assert.deepEqual(plan(settled.state), []);
});

test('merge queue: a flaky failure is retried, reported, and does not evict', () => {
  let state = fill({ ...queueConfig, flakyRetries: 1 }, ['1']);
  const [candidate] = plan(state);
  state = recordResult(state, candidate.key, 'fail');
  assert.deepEqual(settle(state).actions, []);
  assert.equal(plan(state)[0].key, candidate.key, 'the same candidate is tested again');
  const settled = settle(recordResult(state, candidate.key, 'pass'));
  assert.deepEqual(settled.actions.map((a) => a.type), ['flaky', 'merge']);
  const evicted = settle(recordResult(state, candidate.key, 'fail'));
  assert.deepEqual(evicted.actions.map((a) => a.type), ['evict']);
});

test('merge queue: results of discarded candidates can never be matched again', () => {
  let state = fill(queueConfig, ['1', '2']);
  const [stale] = plan(state);
  state = dequeue(state, '1');
  state = recordResult(state, stale.key, 'pass');
  assert.deepEqual(settle(state).actions, []);
  assert.deepEqual(plan(state)[0].changes, ['2']);
  assert.equal(enqueue(state, '2'), state, 'enqueueing twice is a no-op');
});

test('merge queue: a failure discards the speculative results built on top of it', () => {
  let state = fill({ ...queueConfig, batchSize: 1, flakyRetries: 1 }, ['1', '2']);
  const [head, speculative] = plan(state);
  state = recordResult(state, speculative.key, 'pass');
  state = recordResult(state, head.key, 'fail');
  assert.deepEqual(Object.keys(state.results), [head.key]);
  assert.deepEqual(plan(state).map((c) => c.key), [head.key, speculative.key], 'both are tested again');
});

test('ticket: a ticket rendered by the factory parses back to the same ticket', () => {
  const original = parseTicket({ id: 42, title: 'Password reset', body: formBody, labels: ['risk:high'] });
  assert.equal(original.level, 'HIGH');
  const again = parseTicket({ id: 42, title: 'Password reset', body: renderTicketBody(original), labels: ['risk:high'] });
  assert.deepEqual(again, original);
});

test('merge queue: a result can be forgotten when its commit can no longer land', () => {
  let state = fill({ ...queueConfig, batchSize: 1, flakyRetries: 1 }, ['1']);
  const [head] = plan(state);
  state = recordResult(recordResult(state, head.key, 'fail'), head.key, 'pass');
  assert.equal(forget(state, head.key).results[head.key].outcome, null, 'forgotten, but the failure count is kept');
  const clean = recordResult(fill(queueConfig, ['1']), plan(fill(queueConfig, ['1']))[0].key, 'pass');
  assert.deepEqual(forget(clean, plan(fill(queueConfig, ['1']))[0].key).results, {});
  assert.equal(forget(clean, 'e0:unknown'), clean);
});

test('scheduler: a debt ticket that can run is not passed over because another one is blocked', () => {
  const ready = [
    { id: 'f1', kind: 'feature', likelyFiles: ['a/**'] },
    { id: 'd1', kind: 'debt', likelyFiles: ['busy/**'] },
    { id: 'd2', kind: 'debt', likelyFiles: ['c/**'] },
  ];
  const active = [{ id: 'ticket 9', likelyFiles: ['busy/x.js'] }];
  const result = selectRunnable(ready, active, { maxParallelTickets: 2, featuresPerDebtTicket: 4, startedKinds: ['feature', 'feature', 'feature', 'feature'] });
  assert.deepEqual(result.start.map((t) => t.id), ['d2']);
  assert.deepEqual(result.held, [{ id: 'f1', reason: 'capacity' }, { id: 'd1', reason: 'overlaps ticket 9' }]);
});

test('ticket: list markers of every common style are read; paths that climb or repeat a separator are refused', () => {
  const body = formBody.replace('- [ ] A reset link is emailed', '+ A reset link is emailed').replace('- [ ] The link expires after one hour', '1) The link expires after one hour');
  assert.deepEqual(parseTicket({ id: '1', title: 'Reset', body, labels: [], milestone: null }).acceptanceCriteria, ['A reset link is emailed', 'The link expires after one hour']);
  const valid = { id: '1', title: 'Reset', description: 'd', acceptanceCriteria: ['It works'], likelyFiles: ['src/auth/**'], points: 2, kind: 'feature', wellFormed: true };
  assert.deepEqual(validateTicket(valid, config), []);
  for (const file of ['src/../secrets.js', './src/a.js', 'src//a.js', '..']) assert.ok(validateTicket({ ...valid, likelyFiles: [file] }, config).length > 0, file);
  assert.ok(validateTicket({ ...valid, acceptanceCriteria: ['It works\n### Points\n\n1'] }, config).length > 0, 'a criterion cannot smuggle another section of the form');
});

test('loop detection: a finding raised again after it was refuted is named', () => {
  assert.equal(returnedFinding({ refutedFingerprints: ['aa', 'bb'], raisedFingerprints: ['cc', 'bb'] }), 'bb');
  assert.equal(returnedFinding({ refutedFingerprints: ['aa'], raisedFingerprints: ['cc'] }), null);
});

test('merge queue: changes found on the trunk leave the queue, bisection keeps its conclusion, and the rest is planned afresh', () => {
  let state = ['a', 'b', 'c'].reduce(enqueue, createQueue({ batchSize: 2, maxParallelChecks: 2, flakyRetries: 0 }));
  state = recordResult(state, plan(state)[0].key, 'pass');
  const { state: next, evicted } = acknowledgeLanded(state, ['a']);
  assert.deepEqual([next.pending, next.landed, next.epoch, next.results, evicted], [['b', 'c'], [], 1, {}, null]);
  assert.deepEqual(plan(next).map((candidate) => candidate.key), ['e1:b+c']);
  assert.deepEqual(acknowledgeLanded(next, ['a', 'z']), { state: next, evicted: null }, 'nothing to acknowledge, nothing changes');

  const bisecting = settle(recordResult(state, 'e0:a+b', 'fail')).state;
  assert.deepEqual(bisecting.suspect, ['a', 'b']);
  const concluded = acknowledgeLanded(bisecting, ['a']);
  assert.deepEqual([concluded.evicted, concluded.state.pending, concluded.state.suspect], ['b', ['c'], null], 'the half that landed clears a; b alone is the culprit');
});
