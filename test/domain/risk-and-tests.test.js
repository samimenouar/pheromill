import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePromotion, mayMergeAlone, requiredGates } from '../../src/domain/autonomy.js';
import { parseUnifiedDiff } from '../../src/domain/diff.js';
import { classifyRisk, maxLevel } from '../../src/domain/risk.js';
import { detectWeakening, touchesExistingTests } from '../../src/domain/test-guard.js';
import { fileDiff, testConfig } from '../helpers.js';

const config = testConfig();
const parse = (text) => parseUnifiedDiff(text);

test('risk: an ordinary change is LOW', () => {
  const result = classifyRisk(parse(fileDiff('src/app/view.js', { added: ['x'] })), config);
  assert.equal(result.level, 'LOW');
});

test('risk: a core module, an existing test or a dependency request is HIGH', () => {
  assert.equal(classifyRisk(parse(fileDiff('src/domain/a.js', { added: ['x'] })), config).level, 'HIGH');
  assert.equal(classifyRisk(parse(fileDiff('test/a.test.js', { removed: ['x'], added: ['y'] })), config).level, 'HIGH');
  assert.equal(classifyRisk(parse(fileDiff('src/app/a.js', { added: ['x'] })), config, { dependencyRequest: true }).level, 'HIGH');
});

test('risk: adding a new test file does not raise the level', () => {
  const files = parse(fileDiff('test/new.test.js', { added: ['assert.ok(true)'], status: 'added' }));
  assert.equal(classifyRisk(files, config).level, 'LOW');
});

test('risk: a reserved path is CRITICAL, including by rename and for the factory configuration', () => {
  assert.equal(classifyRisk(parse(fileDiff('.github/workflows/ci.yml', { added: ['x'] })), config).level, 'CRITICAL');
  assert.equal(classifyRisk(parse(fileDiff('pheromill.config.json', { added: ['x'] })), config).level, 'CRITICAL');
  const rename = 'diff --git a/AGENTS.md b/x.md\nrename from AGENTS.md\nrename to x.md\n';
  assert.equal(classifyRisk(parse(rename), config).level, 'CRITICAL');
  assert.equal(classifyRisk(parse(fileDiff('package.json', { added: ['"x": "1.0.0"'] })), config).level, 'HIGH', 'a dependency manifest edited directly');
});

test('risk: fails closed on a path it cannot parse', () => {
  const result = classifyRisk(parse('diff --git "a/x\\ty" "b/x\\ty"\n'), config);
  assert.equal(result.level, 'CRITICAL');
});

test('risk: the highest level wins and every reason is kept', () => {
  const text = fileDiff('src/domain/a.js', { added: ['x'] }) + fileDiff('deploy/compose.yaml', { added: ['y'] });
  const result = classifyRisk(parse(text), config);
  assert.equal(result.level, 'CRITICAL');
  assert.equal(result.reasons.length, 2);
  assert.equal(maxLevel('HIGH', 'LOW'), 'HIGH');
});

test('test guard: detects a deleted test, removed assertions and skipped tests', () => {
  const text =
    fileDiff('test/gone.test.js', { removed: ['assert.ok(x)'], status: 'deleted' }) +
    fileDiff('test/a.test.js', { removed: ['assert.equal(total, 3);', 'expect(x).toBe(1)'], added: ['assert.ok(true);'] }) +
    fileDiff('test/b.test.js', { added: ["it.skip('pays', () => {})"] }) +
    fileDiff('tests/test_c.py', { added: ['@pytest.mark.skip'] });
  const kinds = detectWeakening(parse(text), config).map((s) => `${s.kind}:${s.path}`);
  assert.deepEqual(kinds, [
    'test_deleted:test/gone.test.js',
    'assertion_removed:test/a.test.js',
    'test_skipped:test/b.test.js',
    'test_skipped:tests/test_c.py',
  ]);
});

test('test guard: detects a relaxed threshold, a replaced snapshot and a coverage drop', () => {
  const text =
    fileDiff('package.json', { removed: ['  "lines": 90,'], added: ['  "lines": 60,'] }) +
    fileDiff('src/ui/__snapshots__/a.snap', { removed: ['old'], added: ['new'] });
  const signals = detectWeakening(parse(text), config, { coverageDrops: [{ path: 'src/a.js', before: 92, after: 80 }] });
  assert.deepEqual(signals.map((s) => s.kind), ['threshold_relaxed', 'snapshot_replaced', 'coverage_dropped']);
  assert.equal(signals[0].evidence, 'lines: 90 -> 60');
});

test('test guard: stronger tests raise no signal', () => {
  const text =
    fileDiff('test/a.test.js', { removed: ['assert.ok(x)'], added: ['assert.equal(x, 1)', 'assert.equal(y, 2)'] }) +
    fileDiff('package.json', { removed: ['  "lines": 80,'], added: ['  "lines": 90,'] });
  assert.deepEqual(detectWeakening(parse(text), config), []);
  assert.equal(touchesExistingTests(parse(text), config), true);
});

test('risk: any weakening signal raises the change to HIGH', () => {
  const files = parse(fileDiff('package.json', { removed: ['"lines": 90'], added: ['"lines": 10'] }));
  const signals = detectWeakening(files, config);
  assert.equal(classifyRisk(files, config, { weakeningSignals: signals }).level, 'HIGH');
});

test('autonomy: each tier unlocks exactly one more risk level', () => {
  const table = [0, 1, 2, 3].map((tier) => ['LOW', 'HIGH', 'CRITICAL'].map((level) => mayMergeAlone(tier, level)));
  assert.deepEqual(table, [
    [false, false, false],
    [true, false, false],
    [true, true, false],
    [true, true, true],
  ]);
  assert.throws(() => mayMergeAlone(1, 'UNKNOWN'));
});

test('autonomy: promotion needs every threshold met on measured values', () => {
  const promotion = [{ referencePassRate: { min: 0.9 }, changeFailRate: { max: 0.15 } }, {}, {}];
  assert.deepEqual(evaluatePromotion(0, { referencePassRate: 0.95, changeFailRate: 0.1 }, promotion), { eligible: true, nextTier: 1, unmet: [] });
  const unmet = evaluatePromotion(0, { referencePassRate: 0.8, changeFailRate: null }, promotion);
  assert.equal(unmet.eligible, false);
  assert.equal(unmet.unmet.length, 2);
  assert.equal(evaluatePromotion(1, {}, promotion).eligible, false, 'no thresholds defined means no promotion');
  assert.equal(evaluatePromotion(3, {}, promotion).nextTier, null);
  assert.equal(evaluatePromotion(0, { referencePassRate: Number.NaN, changeFailRate: 0.1 }, promotion).eligible, false);
  assert.equal(evaluatePromotion(0, { x: 1 }, [{ x: {} }, {}, {}]).eligible, false, 'a threshold without a bound grants nothing');
});

test('autonomy: gates grow with the risk level', () => {
  assert.deepEqual(requiredGates('LOW', { weakeningSignals: 0 }), ['checks_green', 'independent_review', 'no_confirmed_blocking_finding']);
  assert.ok(requiredGates('HIGH', { weakeningSignals: 1 }).includes('test_guard_review'));
  assert.ok(requiredGates('HIGH', { weakeningSignals: 0, testsTouched: true }).includes('test_guard_review'));
  assert.ok(!requiredGates('HIGH', { weakeningSignals: 0 }).includes('external_tool_pass'));
  assert.ok(requiredGates('HIGH', { weakeningSignals: 0, externalTool: true }).includes('external_tool_pass'));
  assert.ok(requiredGates('HIGH', { weakeningSignals: 0 }).includes('security_review'));
  assert.ok(requiredGates('CRITICAL', { weakeningSignals: 0 }).includes('second_independent_review'));
});
