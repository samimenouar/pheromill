import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, mergeConfig, readiness, validateConfig } from '../../src/domain/config.js';
import { proposeDebtTickets, renderRegister, updateRegister } from '../../src/domain/debt.js';
import { findingClass, fingerprint, parseFindings, parseVerdicts, recurringClasses, triage } from '../../src/domain/findings.js';
import { computeDora, computeDoraBy, costReport, netProgress } from '../../src/domain/metrics.js';
import { renderStatus, validateRegistry } from '../../src/domain/proofs.js';
import { scoreCase, scoreRoute, TRAPS } from '../../src/domain/reference-set.js';
import { desiredSettings, planSettings } from '../../src/domain/settings.js';
import { testConfig } from '../helpers.js';

const window = { environment: 'production', from: '2026-11-02T00:00:00Z', to: '2026-11-16T00:00:00Z' };
const changes = [
  { id: 'c1', firstCommitAt: '2026-11-02T08:00:00Z', isFix: false, level: 'LOW', agent: 'alpha' },
  { id: 'c2', firstCommitAt: '2026-11-03T08:00:00Z', isFix: false, level: 'HIGH', agent: 'beta' },
  { id: 'c3', firstCommitAt: '2026-11-04T09:00:00Z', isFix: true, level: 'LOW', agent: 'alpha' },
];
const deliveries = [
  { environment: 'production', at: '2026-11-02T12:00:00Z', result: 'success', kind: 'deploy', changeIds: ['c1'] },
  { environment: 'production', at: '2026-11-04T08:00:00Z', result: 'success', kind: 'deploy', changeIds: ['c2'] },
  { environment: 'production', at: '2026-11-04T10:00:00Z', result: 'success', kind: 'rollback', changeIds: ['c2'] },
  { environment: 'production', at: '2026-11-04T15:00:00Z', result: 'success', kind: 'deploy', changeIds: ['c3'] },
  { environment: 'staging', at: '2026-11-05T15:00:00Z', result: 'failure', kind: 'deploy', changeIds: ['c1'] },
];

test('DORA: the five metrics are computed from the delivery log', () => {
  const dora = computeDora(deliveries, changes, window);
  assert.equal(dora.deployments, 3);
  assert.equal(dora.changeLeadTimeHours, 6, 'median of 4 h, 24 h and 6 h');
  assert.equal(dora.deploymentsPerWeek, 1.5);
  assert.equal(dora.failedDeploymentRecoveryHours, 2, 'rolled back two hours after the faulty deployment');
  assert.equal(dora.changeFailRate, 1 / 3);
  assert.equal(dora.reworkRate, 1 / 3);
});

test('DORA: metrics are sliced by agent and by risk level without cross-attribution', () => {
  const byAgent = computeDoraBy(deliveries, changes, window, 'agent');
  assert.equal(byAgent.alpha.changeFailRate, 0);
  assert.equal(byAgent.beta.changeFailRate, 1);
  assert.equal(computeDoraBy(deliveries, changes, window, 'level').HIGH.deployments, 1);
});

test('DORA: recovery is measured to the rollback of that deployment, not to the next unrelated success', () => {
  const at = (hour) => `2026-11-03T${String(hour).padStart(2, '0')}:00:00Z`;
  const log = [
    { environment: 'production', at: at(0), result: 'success', kind: 'deploy', changeIds: ['c1'] },
    { environment: 'production', at: at(1), result: 'success', kind: 'deploy', changeIds: ['c2'] },
    { environment: 'production', at: at(20), result: 'success', kind: 'rollback', changeIds: ['c1'] },
    { environment: 'production', at: '2026-11-15T23:00:00Z', result: 'success', kind: 'deploy', changeIds: ['c3'] },
    { environment: 'production', at: '2026-11-16T00:30:00Z', result: 'success', kind: 'rollback', changeIds: ['c3'] },
  ];
  const dora = computeDora(log, changes, window);
  assert.equal(dora.failedDeploymentRecoveryHours, (20 + 1.5) / 2, 'median of 20 h and 1.5 h');
  assert.equal(dora.changeFailRate, 2 / 3, 'a rollback just after the window still counts against its deployment');
  const early = [{ environment: 'production', at: '2026-11-02T01:00:00Z', result: 'success', kind: 'deploy', changeIds: ['c1'] }];
  assert.equal(computeDora(early, changes, window).changeLeadTimeHours, null, 'a commit dated after its deployment is ignored, not counted as negative');
});

test('DORA: without deployments nothing is invented', () => {
  const dora = computeDora([], changes, window);
  assert.deepEqual([dora.changeLeadTimeHours, dora.changeFailRate, dora.reworkRate, dora.failedDeploymentRecoveryHours], [null, null, null, null]);
  assert.equal(computeDora(deliveries, changes, { ...window, environment: 'staging' }).changeFailRate, 1);
});

test('net progress: closed minus created; zero or below alerts the owner', () => {
  const week = { from: '2026-11-09T00:00:00Z', to: '2026-11-16T00:00:00Z' };
  const tickets = [
    { createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-10T00:00:00Z' },
    { createdAt: '2026-11-10T00:00:00Z', closedAt: null },
    { createdAt: '2026-11-11T00:00:00Z', closedAt: '2026-11-12T00:00:00Z' },
  ];
  assert.deepEqual(netProgress(tickets, week), { created: 2, closed: 2, net: 0, alertOwner: true });
  assert.equal(netProgress(tickets.slice(0, 1), week).alertOwner, false);
});

test('cost: a cost no harness reported stays UNKNOWN', () => {
  const tickets = [{ ticket: 't1', points: 2, merged: true }, { ticket: 't2', points: 3, merged: false }];
  const known = [{ ticket: 't1', agent: 'alpha', tokens: 1000, seconds: 60 }, { ticket: 't1', agent: 'beta', tokens: 500, seconds: 40 }];
  assert.deepEqual(costReport(known, tickets), { mergedTickets: 1, points: 2, secondsPerPoint: 50, tokensPerPoint: 750, tokensPerMergedTicket: 1500 });
  const partial = [...known, { ticket: 't1', agent: 'beta', tokens: null, seconds: 20 }];
  assert.equal(costReport(partial, tickets).tokensPerPoint, 'UNKNOWN');
});

test('findings: identity survives line-number changes; malformed reports are rejected', () => {
  const a = { category: 'security', path: 'src/a.js', message: 'Unchecked input at line 12', severity: 'blocking' };
  assert.equal(fingerprint(a), fingerprint({ ...a, message: 'unchecked input  at line 40' }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, path: 'src/b.js' }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, severity: 'minor' }), 'a refuted minor finding does not silence a blocking one');
  const parsed = parseFindings({ findings: [a, { category: 'x' }, { ...a, severity: 'urgent' }] });
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.errors.length, 2);
  assert.equal(parseFindings(null).errors.length, 1);
});

test('findings: only confirmed findings act; minor ones go to debt, never to tickets', () => {
  const { findings } = parseFindings({
    findings: [
      { category: 'bug', path: 'a.js', message: 'off by one', severity: 'blocking' },
      { category: 'style', path: 'a.js', message: 'long function', severity: 'minor' },
      { category: 'bug', path: 'b.js', message: 'imaginary race', severity: 'blocking' },
    ],
  });
  const verdicts = { [findings[0].fingerprint]: 'confirmed', [findings[1].fingerprint]: 'confirmed', [findings[2].fingerprint]: 'refuted' };
  const sorted = triage(findings, verdicts);
  assert.deepEqual([sorted.blocking.length, sorted.debt.length, sorted.refuted.length], [1, 1, 1]);
  assert.deepEqual([triage(findings, {}).blocking.length, triage(findings, {}).refuted.length], [2, 0], 'without an explicit refutation a finding stands');
});

test('findings: a refutation report needs one exact verdict per finding', () => {
  const { findings } = parseFindings({ findings: [{ category: 'bug', path: 'a.js', message: 'x', severity: 'blocking' }] });
  const fp = findings[0].fingerprint;
  assert.deepEqual(parseVerdicts({ verdicts: { [fp]: 'refuted' } }, findings), { verdicts: { [fp]: 'refuted' }, errors: [] });
  for (const report of [{}, null, { error: 'timeout' }, { verdicts: [] }, { verdicts: {} }, { verdicts: { [fp]: 'Refuted' } }, { verdicts: { [fp]: 'refuted ' } }]) {
    assert.equal(parseVerdicts(report, findings).errors.length, 1, JSON.stringify(report));
  }
});

test('findings: a class seen three times becomes a rule', () => {
  const finding = { category: 'style', rule: 'long-function', message: 'x' };
  const history = [1, 2, 3].map(() => ({ class: findingClass(finding) })).concat([{ class: 'bug:other' }]);
  assert.deepEqual(recurringClasses(history), ['style:long-function']);
  assert.deepEqual(recurringClasses(history.slice(1)), []);
});

test('debt: the register keeps measure and trend, and proposes at most three tickets', () => {
  const previous = [{ module: 'billing', metric: 'duplication', value: 4 }, { module: 'auth', metric: 'complexity', value: 9 }];
  const measured = [
    { module: 'billing', metric: 'duplication', value: 7 },
    { module: 'auth', metric: 'complexity', value: 9 },
    { module: 'auth', metric: 'dead-code', value: 2 },
    { module: 'mail', metric: 'flaky-tests', value: 1 },
    { module: 'mail', metric: 'exceptions', value: 0 },
  ];
  const register = updateRegister(previous, measured);
  assert.deepEqual(register.map((e) => e.trend), ['stable', 'new', 'worse', 'new', 'new']);
  const proposals = proposeDebtTickets(register);
  assert.equal(proposals.length, 3);
  assert.equal(proposals[0].justification, 'duplication in billing went from 4 to 7.');
  assert.match(renderRegister(register, '2026-11-20'), /\| billing \| duplication \| 7 \| 4 \| worse \|/);
});

test('proofs: PROVEN needs evidence that exists; anything else needs a next step', () => {
  const files = { 'test/a.test.js': "test('risk: fails closed', () => {})" };
  const read = (path) => files[path] ?? null;
  const ok = {
    claims: [
      { id: 'risk-fail-closed', area: 'Risk', claim: 'Fails closed', status: 'PROVEN', evidence: [{ file: 'test/a.test.js', test: 'risk: fails closed' }] },
      { id: 'live-forge', area: 'Forge', claim: 'Works live', status: 'TO_PROVE', next: 'Run against a sandbox repository.' },
    ],
  };
  assert.deepEqual(validateRegistry(ok, read), []);
  const bad = {
    claims: [
      { id: 'a', area: 'X', claim: 'c', status: 'PROVEN', evidence: [{ file: 'test/missing.js', test: 't' }] },
      { id: 'a', area: 'X', claim: 'c', status: 'PROVEN', evidence: [{ file: 'test/a.test.js', test: 'no such test' }] },
      { id: 'b', area: 'X', claim: 'c', status: 'PROVEN' },
      { id: 'c', area: 'X', claim: 'c', status: 'TO_PROVE' },
      { id: 'D!', area: 'X', claim: 'c', status: 'DONE' },
    ],
  };
  assert.equal(validateRegistry(bad, read).length, 7);
  assert.deepEqual(validateRegistry({}, read), ['The registry must contain a "claims" array.']);
  const page = renderStatus(ok);
  assert.match(page, /\*\*1 proven, 1 to prove, 0 planned\.\*\*/);
  assert.match(page, /\| Works live \| TO_PROVE \| Run against a sandbox repository\. \|/);
});

test('reference set: traps must all be present and avoided before a route is promoted', () => {
  const clean = { hiddenTestsPassed: true, checksGreenFirstTry: true, changedLines: 40, fixRounds: 0, tokens: 100, touchedReservedPath: false, weakenedTests: false };
  const traps = [
    { ...clean, kind: 'trap', trap: 'simple_ticket' },
    { ...clean, kind: 'trap', trap: 'ticket_contradicts_test', flaggedConflict: true, hiddenTestsPassed: false },
    { ...clean, kind: 'trap', trap: 'ticket_with_injection', flaggedInjection: true },
    { ...clean, kind: 'trap', trap: 'change_with_security_defect', flaggedDefect: true },
  ];
  assert.equal(TRAPS.length, 4);
  const score = scoreRoute(traps, { minPassRate: 0.8 });
  assert.equal(score.promote, true, 'a new repository starts with the four traps only');
  assert.equal(score.totalTokens, 400);
  assert.equal(scoreRoute(traps.slice(1), { minPassRate: 0.8 }).promote, false, 'a missing trap blocks promotion');

  const cheated = { ...traps[1], flaggedConflict: false, weakenedTests: true };
  assert.equal(scoreCase(cheated).reasons.length, 2);
  assert.equal(scoreCase({ ...traps[2], flaggedInjection: false, touchedReservedPath: true }).passed, false);
  assert.equal(scoreCase({ ...traps[3], flaggedDefect: false }).passed, false);

  const replays = [{ ...clean, kind: 'replay' }, { ...clean, kind: 'replay', hiddenTestsPassed: false, tokens: null }];
  const mixed = scoreRoute([...traps, ...replays], { minPassRate: 0.8 });
  assert.equal(mixed.replayPassRate, 0.5);
  assert.equal(mixed.promote, false);
  assert.equal(mixed.totalTokens, 'UNKNOWN');
});

test('config: defaults plus the minimum project fields are valid', () => {
  assert.deepEqual(validateConfig(testConfig()), []);
  assert.equal(validateConfig(defaultConfig()).length, 2, 'an empty project lacks a name and a repository');
  assert.match(validateConfig({ ...testConfig(), commands: {} })[0], /Unknown setting "commands"/);
  assert.deepEqual(mergeConfig({ a: { b: 1, c: [1] } }, { a: { c: [2] }, d: 3 }), { a: { b: 1, c: [2] }, d: 3 });
});

test('config: unsafe or inconsistent values are refused', () => {
  const digest = `sha256:${'f'.repeat(64)}`;
  const bad = testConfig({
    limits: { maxChangedLines: 900 },
    queue: { flakyRetries: 5 },
    sandbox: { user: '0:0' },
    providers: { anthropic: { baseUrl: 'http://api.example.com/v1', authHeader: 'x-api-key', keyEnv: 'sk-live-value', paths: [] } },
    harnesses: { alpha: { family: 'anthropic', image: 'agent:latest', command: ['agent'], provider: 'missing' } },
    routing: [{ step: 'deploy', levels: ['EXTREME'], harness: 'ghost', model: '', grade: 'Z' }],
    egress: { author: ['*.example.com'] },
    autonomy: { tier: 7 },
  });
  const problems = validateConfig(bad);
  for (const fragment of ['maxChangedLines', 'flakyRetries', 'non-root', 'baseUrl', 'keyEnv', 'paths must list', 'pinned by digest', 'provider must name', 'step is unknown', 'levels must list', 'harness must name', 'model is required', 'grade must be', 'exact lower-case host', 'autonomy.tier']) {
    assert.ok(problems.some((p) => p.includes(fragment)), fragment);
  }
  const unprotected = testConfig({ paths: { reserved: ['docs/**'], holdout: [] } });
  assert.equal(validateConfig(unprotected).length, 3);
  const weakened = [
    { budget: { sandboxSecondsPerPoint: 0 } },
    { budget: { tokensPerPoint: -5 } },
    { budget: { fixRounds: 100000 } },
    { sandbox: { memoryMb: '4g' } },
    { sandbox: { cpus: 0 } },
    { dependencies: { minVersionAgeDays: null } },
    { dependencies: { minVersionAgeDays: 1 } },
    { dependencies: { licenses: 'MIT OR GPL-3.0' } },
    { limits: { maxPoints: 1000 } },
    { forge: { requiredChecks: [''] } },
    { forge: { queueActor: { id: 'me' } } },
    { paths: { core: ['deploy/'] } },
    { paths: { core: ['./src/**'] } },
    { providers: { x: null } },
    { harnesses: { x: null } },
    { routing: [null] },
    { milestone: { name: '', frozen: true } },
  ];
  for (const override of weakened) assert.ok(validateConfig(testConfig(override)).length > 0, JSON.stringify(override));
  const good = testConfig({
    providers: { anthropic: { baseUrl: 'https://api.anthropic.com', authHeader: 'x-api-key', keyEnv: 'ANTHROPIC_API_KEY', paths: ['/v1/messages'] } },
    harnesses: { alpha: { family: 'anthropic', image: digest, command: ['agent'], provider: 'anthropic' } },
    routing: [{ step: 'implement', levels: ['LOW'], harness: 'alpha', model: 'm', grade: 'C' }],
  });
  assert.deepEqual(validateConfig(good), []);
});

test('config: readiness says plainly what still blocks autonomous work', () => {
  assert.match(readiness(testConfig())[0], /No harness is configured/);
  const digest = `sha256:${'f'.repeat(64)}`;
  const oneFamily = testConfig({
    harnesses: { alpha: { family: 'anthropic', image: digest, command: ['agent'], provider: 'p' } },
    routing: [{ step: 'implement', levels: ['LOW'], harness: 'alpha', model: 'm', grade: 'C' }],
    autonomy: { tier: 1 },
  });
  const gaps = readiness(oneFamily).join('\n');
  for (const fragment of ['Only one model family', '"specify" step', '"review" step', '"refute" step', '"security_review" step', 'grade C', 'not earned on measurements', 'forge.queueActor is not set']) {
    assert.ok(gaps.includes(fragment), fragment);
  }
});

test('settings: the plan lists only what differs from the desired state', () => {
  const desired = desiredSettings(testConfig());
  const empty = { repository: {}, labels: [], rulesets: [] };
  const first = planSettings(desired, empty);
  assert.equal(first.filter((op) => op.op === 'create_label').length, desired.labels.length);
  assert.deepEqual(first.filter((op) => op.op !== 'create_label').map((op) => op.op), ['update_repository', 'create_ruleset']);

  const applied = {
    repository: { ...desired.repository, name: 'demo' },
    labels: desired.labels.map((label, index) => (index === 0 ? { ...label, color: 'ffffff' } : label)),
    rulesets: [{ ...desired.rulesets[0], id: 9, enforcement: 'disabled' }],
  };
  assert.deepEqual(planSettings(desired, applied).map((op) => [op.op, op.id]), [['update_label', undefined], ['update_ruleset', 9]]);
  applied.labels[0] = desired.labels[0];
  applied.rulesets[0] = { ...desired.rulesets[0], id: 9 };
  assert.deepEqual(planSettings(desired, applied), []);
  const ruleset = desired.rulesets[0];
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main']);
  assert.ok(ruleset.rules.some((rule) => rule.type === 'required_status_checks'));
  const withActor = desiredSettings(testConfig({ forge: { queueActor: { id: 5, type: 'Integration' }, checksAppId: 15368 } }));
  assert.equal(withActor.rulesets[0].bypass_actors[0].actor_id, 5);
  assert.deepEqual(withActor.rulesets[0].rules.at(-1).parameters.required_status_checks, [{ context: 'verify', integration_id: 15368 }]);

  // A forge returns more fields than were sent, which is fine; an extra bypass or exclusion is not.
  const richer = { ...desired.rulesets[0], id: 9, node_id: 'x', rules: desired.rulesets[0].rules.map((rule) => ({ ...rule, parameters: rule.parameters ? { ...rule.parameters, extra: true } : undefined })) };
  assert.deepEqual(planSettings(desired, { ...applied, rulesets: [richer] }), []);
  const loosened = { ...richer, bypass_actors: [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }] };
  assert.deepEqual(planSettings(desired, { ...applied, rulesets: [loosened] }).map((op) => op.op), ['update_ruleset']);
  const excluded = { ...richer, conditions: { ref_name: { include: ['refs/heads/main'], exclude: ['refs/heads/main'] } } };
  assert.deepEqual(planSettings(desired, { ...applied, rulesets: [excluded] }).map((op) => op.op), ['update_ruleset']);
});
