import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cloneMirror, GitVcs } from '../../src/adapters/git.js';
import { DockerLauncher, roleOf, SandboxRunner } from '../../src/adapters/sandbox-runner.js';
import { parseUnifiedDiff } from '../../src/domain/diff.js';
import { testConfig } from '../helpers.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;
let root;
let vcs;
let base;
let launched;

const config = testConfig({
  providers: { anthropic: { baseUrl: 'https://api.anthropic.com', authHeader: 'x-api-key', keyEnv: 'ANTHROPIC_API_KEY', paths: ['/v1/messages'] } },
  harnesses: {
    alpha: {
      family: 'anthropic',
      image: DIGEST,
      provider: 'anthropic',
      command: ['agent', '/in/prompt.md'],
      env: { ANTHROPIC_BASE_URL: '{{gateway}}', ANTHROPIC_API_KEY: '{{token}}' },
      tokens: { file: 'usage.json', fields: ['usage.input_tokens', 'usage.output_tokens'] },
    },
  },
  egress: { author: ['registry.npmjs.org'] },
});

/** Stands in for Docker: plays the agent directly on the mounted directories. */
function fakeLauncher(agent) {
  return {
    launch: async (spec) => {
      const mount = (target) => /source=([^,]+),target=/.exec(spec.args.find((arg) => arg.includes(`target=${target}`)))[1];
      launched = { spec, grantsDuringRun: readdirSync(join(root, 'grants')).length };
      return agent({ workspace: mount('/workspace'), input: mount('/in'), output: mount('/out') }) ?? { exitCode: 0, timedOut: false, seconds: 2 };
    },
  };
}

function runner(agent) {
  return new SandboxRunner({
    config,
    vcs,
    launcher: fakeLauncher(agent),
    workRoot: join(root, 'work'),
    grants: join(root, 'grants'),
    prompts: join(root, 'prompts'),
    clock: { now: () => new Date('2026-11-20T00:00:00Z') },
    endpoints: { proxy: 'egress:3128', gateway: 'http://egress:3129' },
    network: 'pheromill-sandbox',
  });
}

const job = (overrides = {}) => ({
  runId: 't7-1',
  step: 'implement',
  route: { harness: 'alpha', model: 'model-x', family: 'anthropic' },
  base,
  patches: [],
  hidePaths: ['holdout/**'],
  readOnly: false,
  input: { ticket: { id: '7' } },
  ...overrides,
});

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pheromill-runner-'));
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const seed = join(root, 'seed');
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  mkdirSync(join(seed, 'holdout'));
  writeFileSync(join(seed, 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(seed, 'holdout/a.test.js'), 'hidden\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  await cloneMirror(seed, join(root, 'mirror.git'));
  vcs = new GitVcs({ mirror: join(root, 'mirror.git') });
  base = await vcs.head('main');
  mkdirSync(join(root, 'prompts'));
  mkdirSync(join(root, 'grants'));
  for (const step of ['implement', 'review']) writeFileSync(join(root, 'prompts', `${step}.md`), `# ${step} instructions`);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('runner: an author step gets a hidden-free workspace, a prompt, and returns patch, report and tokens', async () => {
  const result = await runner(({ workspace, input, output }) => {
    assert.equal(existsSync(join(workspace, 'holdout')), false);
    assert.match(readFileSync(join(input, 'prompt.md'), 'utf8'), /# implement instructions[\s\S]*"id": "7"/);
    writeFileSync(join(workspace, 'a.js'), 'export const a = 2;\n');
    writeFileSync(join(output, 'report.json'), JSON.stringify({ summary: 'done' }));
    writeFileSync(join(output, 'usage.json'), JSON.stringify({ usage: { input_tokens: 120, output_tokens: 30 } }));
  }).run(job());
  assert.deepEqual(parseUnifiedDiff(result.patch).map((file) => file.path), ['a.js']);
  assert.deepEqual([result.report, result.tokens, result.seconds], [{ summary: 'done' }, 150, 2]);
  assert.equal(existsSync(join(root, 'work', 't7-1')), false, 'the workspace is destroyed after the step');
});

test('runner: the sandbox only receives a step token, valid for the step and revoked after it', async () => {
  await runner(() => {}).run(job());
  const { spec, grantsDuringRun } = launched;
  assert.equal(grantsDuringRun, 1);
  assert.equal(readdirSync(join(root, 'grants')).length, 0);
  assert.match(spec.env.ANTHROPIC_API_KEY, /^[0-9a-f]{64}$/);
  assert.equal(spec.env.ANTHROPIC_BASE_URL, 'http://egress:3129/anthropic');
  assert.equal(spec.env.HTTPS_PROXY, `http://step:${spec.env.ANTHROPIC_API_KEY}@egress:3128`);
  assert.equal(spec.args.join(' ').includes(spec.env.ANTHROPIC_API_KEY), false);
  assert.ok(spec.args.includes(DIGEST));
});

test('runner: a reviewing step reads the change, cannot write it, and has no proxy', async () => {
  const change = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 3;\n';
  const result = await runner(({ workspace, input, output }) => {
    assert.equal(readFileSync(join(input, 'change.patch'), 'utf8'), change, 'a reviewer reads the change as a diff too');
    assert.equal(readFileSync(join(workspace, 'a.js'), 'utf8'), 'export const a = 3;\n');
    assert.equal(readFileSync(join(workspace, 'holdout/a.test.js'), 'utf8'), 'hidden\n');
    writeFileSync(join(workspace, 'a.js'), 'tampered\n');
    writeFileSync(join(output, 'report.json'), JSON.stringify({ findings: [] }));
  }).run(job({ step: 'review', readOnly: true, hidePaths: [], patches: [change] }));
  assert.equal(result.patch, '', 'whatever a reviewer writes is discarded');
  assert.deepEqual(result.report, { findings: [] });
  assert.equal(result.tokens, null, 'unreported usage stays unknown');
  assert.equal(launched.spec.env.HTTPS_PROXY, undefined);
  assert.ok(launched.spec.args.some((arg) => arg.includes('target=/workspace,readonly')));
  assert.deepEqual(['read', 'specify', 'implement', 'review', 'refute'].map(roleOf), ['reader', 'author', 'author', 'reviewer', 'reviewer']);
});

test('runner: timeouts, crashes and malformed reports are reported, never trusted', async () => {
  const timeout = await runner(() => ({ exitCode: 137, timedOut: true, seconds: 9 })).run(job());
  assert.equal(timeout.report.error, 'timeout');
  const crash = await runner(({ output }) => {
    writeFileSync(join(output, 'report.json'), '[1, 2');
    return { exitCode: 3, timedOut: false, seconds: 1 };
  }).run(job());
  assert.deepEqual(crash.report, { error: 'exit_3' });
  const huge = await runner(({ output }) => writeFileSync(join(output, 'report.json'), JSON.stringify({ x: 'y'.repeat(2 * 1024 * 1024) }))).run(job());
  assert.deepEqual(huge.report, {});
});

test('runner: a correction round starts from the previous attempt, and its patch is still relative to the trunk', async () => {
  const previous = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n';
  const result = await runner(({ workspace, input }) => {
    assert.equal(readFileSync(join(workspace, 'a.js'), 'utf8'), 'export const a = 2;\n');
    assert.equal(existsSync(join(input, 'change.patch')), false);
    writeFileSync(join(workspace, 'b.js'), 'export const b = 1;\n');
  }).run(job({ patches: [previous] }));
  assert.deepEqual(parseUnifiedDiff(result.patch).map((file) => file.path), ['a.js', 'b.js']);
});

test('runner: a report that is a link to a host file, or a job with a crafted identifier, is not followed', async () => {
  writeFileSync(join(root, 'host-secret.json'), JSON.stringify({ secret: 'from the runner host' }));
  const linked = await runner(({ output }) => symlinkSync(join(root, 'host-secret.json'), join(output, 'report.json'))).run(job());
  assert.deepEqual(linked.report, {});
  for (const bad of [{ runId: '../../etc' }, { runId: 'T7' }, { step: '../x' }, { step: 'implement.md' }]) {
    await assert.rejects(() => runner(() => {}).run(job(bad)), /Invalid run or step identifier/);
  }
});

test('runner: a job is only launched on the harness family it was routed to', async () => {
  const agent = () => assert.fail('nothing may be launched');
  await assert.rejects(() => runner(agent).run(job({ route: { harness: 'alpha', model: 'model-x', family: 'openai' } })), /is not the openai harness this job was routed to/);
  await assert.rejects(() => runner(agent).run(job({ route: { harness: 'ghost', model: 'model-x', family: 'anthropic' } })), /routed to/);
});

test('runner: whatever happens to a step, its workspace is removed and its token revoked', async () => {
  const failing = runner(({ workspace }) => {
    mkdirSync(join(workspace, 'locked/inner'), { recursive: true });
    writeFileSync(join(workspace, 'locked/inner/file'), 'x');
    chmodSync(join(workspace, 'locked'), 0o000);
    throw new Error('container runtime unreachable');
  });
  await assert.rejects(() => failing.run(job({ runId: 't7-fail' })), /container runtime unreachable/);
  assert.deepEqual(readdirSync(join(root, 'work')), [], 'a directory the step made unreadable is removed all the same');
  assert.deepEqual(readdirSync(join(root, 'grants')), []);
});

test('docker launcher: a step that passes its time limit is killed, and sandboxes left by a dead runner are swept', async () => {
  const bin = join(root, 'fake-docker');
  writeFileSync(
    bin,
    ['#!/bin/sh', 'state="$(dirname "$0")"', 'case "$1" in', '  ps) if [ -e "$state/broken" ]; then exit 1; fi; cat "$state/containers" 2>/dev/null; exit 0 ;;', '  rm) shift; shift; echo "$@" > "$state/removed" ;;', '  kill) touch "$state/killed-$2" ;;', '  *) while [ ! -e "$state/killed-box" ]; do sleep 0.05; done; exit 137 ;;', 'esac', ''].join('\n'),
    { mode: 0o755 },
  );
  const launcher = new DockerLauncher(bin);
  const result = await launcher.launch({ name: 'box', args: ['run', '--name', 'box'], env: {}, timeoutMs: 100 });
  assert.deepEqual([result.exitCode, result.timedOut], [137, true]);
  const quick = await new DockerLauncher('/bin/true').launch({ name: 'ok', args: [], env: {}, timeoutMs: 5000 });
  assert.deepEqual([quick.exitCode, quick.timedOut], [0, false]);
  await assert.rejects(() => new DockerLauncher(join(root, 'no-such-binary')).launch({ name: 'x', args: [], env: {}, timeoutMs: 100 }));

  assert.equal(await launcher.sweep(), 0);
  writeFileSync(join(root, 'containers'), 'abc123\ndef456\n');
  assert.equal(await launcher.sweep(), 2);
  assert.equal(readFileSync(join(root, 'removed'), 'utf8').trim(), 'abc123 def456');
  writeFileSync(join(root, 'broken'), '');
  await assert.rejects(() => launcher.sweep(), /Could not list leftover sandboxes/, 'a runtime that does not answer is an error at start, not an empty list');
});
