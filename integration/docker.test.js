/**
 * Sandbox hardening against a real container runtime. Runs in CI, where the
 * workflow resolves a test image to an immutable identifier first. Without
 * PHEROMILL_TEST_IMAGE the tests are skipped, and say so.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DockerLauncher } from '../src/adapters/sandbox-runner.js';
import { buildSandboxSpec } from '../src/domain/sandbox-spec.js';

const image = process.env.PHEROMILL_TEST_IMAGE;
const skip = image ? false : 'PHEROMILL_TEST_IMAGE is not set (this proof runs in CI)';
const launcher = new DockerLauncher();
let root;
let count = 0;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'pheromill-docker-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

/** Run a shell script in a sandbox and return what it wrote to /out/result. */
async function sandbox(script, overrides = {}) {
  count += 1;
  const workspace = join(root, `workspace-${count}`);
  const output = join(root, `out-${count}`);
  for (const directory of [workspace, output]) {
    mkdirSync(directory);
    chmodSync(directory, 0o777);
  }
  writeFileSync(join(workspace, 'file.txt'), 'original\n');
  const spec = buildSandboxSpec({
    runId: `it-${count}`,
    step: 'probe',
    image,
    command: ['sh', '-c', script],
    env: { HOME: '/tmp', PHEROMILL_STEP: 'probe' },
    allowedEnv: ['HOME', 'PHEROMILL_STEP'],
    mounts: [
      { source: workspace, target: '/workspace', readOnly: overrides.readOnly ?? false },
      { source: output, target: '/out', readOnly: false },
    ],
    network: null,
    limits: { cpus: 1, memoryMb: 128, pids: 64, seconds: overrides.seconds ?? 30, tmpMb: 16 },
    user: '10001:10001',
  });
  const result = await launcher.launch(spec);
  let text = '';
  try {
    text = readFileSync(join(output, 'result'), 'utf8');
  } catch {
    // the script wrote nothing
  }
  return { ...result, text, workspace, name: spec.name };
}

test('docker: the step runs as an unprivileged user with no capability, usable or obtainable', { skip }, async () => {
  const { text, exitCode } = await sandbox('{ id -u; id -g; grep -E "^Cap(Eff|Bnd)" /proc/self/status; grep NoNewPrivs /proc/self/status; } > /out/result');
  assert.equal(exitCode, 0);
  const [uid, gid, ...status] = text.trim().split('\n');
  assert.deepEqual([uid, gid], ['10001', '10001']);
  assert.deepEqual(status.map((line) => line.replace(/\s+/g, ' ')), ['CapEff: 0000000000000000', 'CapBnd: 0000000000000000', 'NoNewPrivs: 1']);
});

test('docker: the root filesystem is mounted read-only; only the workspace, /out and /tmp accept writes', { skip }, async () => {
  const script = [
    'awk \'$2 == "/" { split($4, o, ","); print "root " o[1] }\' /proc/mounts',
    'for target in /workspace/probe /tmp/probe /out/probe; do if touch "$target" 2>/dev/null; then echo "$target writable"; else echo "$target refused"; fi; done',
  ].join('; ');
  const { text } = await sandbox(`{ ${script}; } > /out/result`);
  assert.deepEqual(text.trim().split('\n'), ['root ro', '/workspace/probe writable', '/tmp/probe writable', '/out/probe writable']);
});

test('docker: a read-only workspace cannot be modified by a reviewing step', { skip }, async () => {
  // The directory itself is world-writable, so only the read-only mount can refuse the write.
  const script = 'if touch /workspace/new 2>/dev/null; then echo written; else echo refused; fi > /out/result';
  const { text, workspace } = await sandbox(script, { readOnly: true });
  assert.equal(text.trim(), 'refused');
  assert.deepEqual(readdirSync(workspace), ['file.txt']);
});

test('docker: without a network the step only has a loopback interface', { skip }, async () => {
  const { text } = await sandbox('ls /sys/class/net > /out/result');
  assert.deepEqual(text.trim().split('\n'), ['lo']);
});

test('docker: the environment is the closed list and nothing from the host', { skip }, async () => {
  process.env.PHEROMILL_HOST_SECRET = 'must-not-leak';
  const { text } = await sandbox('env | cut -d= -f1 | sort > /out/result');
  delete process.env.PHEROMILL_HOST_SECRET;
  const names = text.trim().split('\n').filter((name) => !['HOSTNAME', 'PATH', 'PWD', 'SHLVL'].includes(name));
  assert.deepEqual(names, ['HOME', 'PHEROMILL_STEP']);
});

test('docker: a step that exceeds its time limit is killed and its container removed', { skip }, async () => {
  const { timedOut, seconds, name } = await sandbox('sleep 60', { seconds: 2 });
  assert.equal(timedOut, true);
  assert.ok(seconds < 30);
  const remaining = execFileSync('docker', ['ps', '--all', '--quiet', '--filter', `name=${name}`], { encoding: 'utf8' });
  assert.equal(remaining.trim(), '');
});
