/**
 * `pheromill demo`: the whole pipeline on in-memory adapters, with scripted
 * agents. It needs no key, no forge and no container, and shows what the
 * factory decides at each step for one honest change and one that cheats.
 */
import { MemoryForge, MemoryLedger, MemoryVcs, ScriptedChecks, ScriptedRunner, StaticRegistry } from '../adapters/memory.js';
import { runTicket } from '../application/run-ticket.js';
import { defaultConfig, mergeConfig } from '../domain/config.js';

const IMAGE = `sha256:${'0'.repeat(64)}`;
const STEPS = ['specify', 'implement', 'review', 'security_review', 'test_guard_review', 'refute'];

function demoConfig() {
  const harnesses = {
    'agent-a': { family: 'family-a', image: IMAGE, command: ['agent'], provider: 'demo' },
    'agent-b': { family: 'family-b', image: IMAGE, command: ['agent'], provider: 'demo' },
  };
  return mergeConfig(defaultConfig(), {
    project: { name: 'demo' },
    forge: { kind: 'memory', repository: 'demo/demo' },
    providers: { demo: { baseUrl: 'https://models.invalid', authHeader: 'x-api-key', keyEnv: 'DEMO_KEY', paths: ['/v1'] } },
    harnesses,
    routing: STEPS.flatMap((step) => Object.keys(harnesses).map((harness) => ({ step, levels: ['LOW', 'HIGH', 'CRITICAL'], harness, model: 'demo-model', grade: 'A' }))),
    autonomy: { tier: 1 },
  });
}

const added = (path, lines) => [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`), ''].join('\n');
const edited = (path, removed, line) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,1 @@', `-${removed}`, `+${line}`, ''].join('\n');

const criterion = 'The page greets the visitor by name';
const ticket = { id: '1', title: 'Greet the visitor', description: 'Show a greeting.', acceptanceCriteria: [criterion], likelyFiles: ['src/greeting.js'], points: 2, kind: 'feature', milestone: null, blocksExitCriterion: false };
const honest = added('src/greeting.js', ['export const greet = (name) => `Hello, ${name}!`;']);
const cheating = honest + edited('test/greeting.test.js', "assert.equal(greet('Ada'), 'Hello, Ada!');", '// assertion removed to make the suite pass');

async function scenario(title, patch, io) {
  const ledger = new MemoryLedger();
  const runner = new ScriptedRunner({
    specify: () => ({ patch: added('holdout/greeting.test.js', ["assert.equal(greet('Ada'), 'Hello, Ada!');"]) }),
    implement: () => ({ patch }),
    review: () => ({ report: { findings: [], criteria: { [criterion]: true } } }),
    refute: () => ({ report: { verdicts: {} } }),
  });
  const ports = { runner, vcs: new MemoryVcs(), forge: new MemoryForge(), checks: new ScriptedChecks(), registry: new StaticRegistry(), ledger, clock: { now: () => new Date() } };
  const result = await runTicket(ticket, demoConfig(), ports);
  io.out(`\n${title}`);
  for (const entry of ledger.entries) {
    const d = entry.data;
    if (entry.type === 'step') io.out(`  step      ${d.step.padEnd(10)} by ${d.family}`);
    if (entry.type === 'risk') io.out(`  risk      ${d.reasons.join('; ')}`);
    if (entry.type === 'gates_passed') io.out(`  gates     ${d.gates.join(', ')}`);
  }
  io.out(`  outcome   ${result.outcome}: ${result.reason}`);
  return result.outcome;
}

export async function demo(io) {
  io.out('Pheromill demo: scripted agents, in-memory forge. Nothing leaves this process.');
  const first = await scenario('1. An honest LOW change at autonomy tier 1', honest, io);
  const second = await scenario('2. The same change, but the author also removes an assertion from an existing test', cheating, io);
  io.out('\nThe first change is queued without a human. The second is caught by the deterministic');
  io.out('test guard, raised to HIGH, and sent back to be routed and reviewed at that level.');
  return first === 'queued' && second === 'rework' ? 0 : 1;
}
