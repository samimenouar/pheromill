import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/adapters/files.js';
import { main } from '../src/cli/main.js';
import { readiness } from '../src/domain/config.js';
import { chainEntry } from '../src/domain/ledger.js';
import { desiredSettings } from '../src/domain/settings.js';
import { fileDiff } from './helpers.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'pheromill-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function run(args, { cwd = scratch, env = {}, stdin = '', fetch } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, { out: (line) => out.push(line), err: (line) => err.push(line), env, cwd, stdin: async () => stdin, fetch });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function newRepository(name) {
  const directory = join(scratch, name);
  mkdirSync(directory);
  execFileSync('git', ['init', '--quiet', directory]);
  return directory;
}

test('cli: unknown commands print usage; help succeeds', async () => {
  assert.equal((await run(['frobnicate'])).code, 2);
  const help = await run(['help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /pheromill <command>/);
});

test('cli: init starts a repository from the template and never overwrites', async () => {
  const directory = newRepository('product');
  writeFileSync(join(directory, 'AGENTS.md'), 'mine\n');
  const first = await run(['init', directory, '--name', 'product', '--repository', 'acme/product']);
  assert.equal(first.code, 0);
  assert.match(first.out, /kept {5}AGENTS\.md/);
  assert.match(first.out, /created {2}pheromill\.config\.json/);
  assert.equal(readFileSync(join(directory, 'AGENTS.md'), 'utf8'), 'mine\n');
  const config = await loadConfig(directory);
  assert.deepEqual([config.project.name, config.forge.repository], ['product', 'acme/product']);

  const doctor = await run(['doctor', directory]);
  assert.equal(doctor.code, 0);
  assert.match(doctor.out, /Not ready yet:\n- No harness is configured/);
  assert.equal((await run(['doctor', directory, '--strict'])).code, 1);
  assert.equal((await run(['check', directory, '--production'])).code, 0);
});

test('cli: a template without project name is refused by doctor with the reasons', async () => {
  const directory = newRepository('unnamed');
  await run(['init', directory]);
  const doctor = await run(['doctor', directory]);
  assert.equal(doctor.code, 1);
  assert.match(doctor.err, /project\.name is required[\s\S]*forge\.repository is required/);
});

test('cli: check reports non-English text, secrets, outward imports and shipped provisional data', async () => {
  const directory = newRepository('dirty');
  await run(['init', directory, '--name', 'dirty', '--repository', 'acme/dirty']);
  const config = JSON.parse(readFileSync(join(directory, 'pheromill.config.json'), 'utf8'));
  config.architecture = { layers: [{ name: 'domain', paths: ['src/domain/**'], mayImport: [] }, { name: 'adapters', paths: ['src/adapters/**'], mayImport: ['domain'] }] };
  writeFileSync(join(directory, 'pheromill.config.json'), JSON.stringify(config));
  mkdirSync(join(directory, 'src/domain'), { recursive: true });
  mkdirSync(join(directory, 'src/adapters'), { recursive: true });
  writeFileSync(join(directory, 'src/adapters/db.js'), 'export const db = 1;\n');
  const marker = ['PROVISIONAL', '(price): to confirm with the owner'].join('');
  writeFileSync(join(directory, 'src/domain/price.js'), `import { db } from '../adapters/db.js';\n// ${marker}\n// r${String.fromCharCode(233)}duction\n`);
  writeFileSync(join(directory, 'notes.txt'), `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\n`);

  const strict = await run(['check', directory, '--production']);
  assert.equal(strict.code, 1);
  for (const fragment of ['non-English text', 'possible secret (private_key)', 'domain must not import adapters', 'provisional information in a production path (price)']) {
    assert.ok(strict.err.includes(fragment), fragment);
  }
  const lenient = await run(['check', directory]);
  assert.match(lenient.out, /provisional {2}price {2}src\/domain\/price\.js:2/);
  assert.ok(!lenient.err.includes('provisional information'));
});

test('cli: risk classifies a patch and gates it', async () => {
  const directory = newRepository('risky');
  await run(['init', directory, '--name', 'risky', '--repository', 'acme/risky']);
  const patch = fileDiff('.github/workflows/verify.yml', { added: ['x'] }) + fileDiff('package-lock.json', { added: ['{}'] });
  const piped = await run(['risk', '-', '--gate'], { cwd: directory, stdin: patch });
  const report = JSON.parse(piped.out);
  assert.equal(piped.code, 1);
  assert.equal(report.level, 'CRITICAL');
  assert.deepEqual(report.gate.violations.map((v) => v.rule), ['queue_owned']);
  writeFileSync(join(directory, 'ok.patch'), fileDiff('src/a.js', { added: ['x'], status: 'added' }));
  const file = await run(['risk', 'ok.patch', '--gate'], { cwd: directory });
  assert.deepEqual([file.code, JSON.parse(file.out).level], [0, 'LOW']);
});

test('cli: ledger verify detects tampering', async () => {
  const first = chainEntry(null, 'a', {}, '2026-11-20T00:00:00Z');
  const second = chainEntry(first, 'b', {}, '2026-11-20T00:00:01Z');
  writeFileSync(join(scratch, 'good.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  writeFileSync(join(scratch, 'bad.jsonl'), `${JSON.stringify(first)}\n${JSON.stringify({ ...second, type: 'c' })}\n`);
  const good = await run(['ledger', 'verify', 'good.jsonl']);
  assert.equal(good.code, 0);
  assert.ok(good.out.includes(`Head: entry 2, hash ${second.hash}`), 'the head is printed so that it can be anchored elsewhere');
  assert.equal((await run(['ledger', 'verify'])).code, 1);
  const bad = await run(['ledger', 'verify', 'bad.jsonl']);
  assert.deepEqual([bad.code, bad.out], [1, 'Ledger chain is broken at entry 2.']);
});

test('cli: metrics dora reads the delivery log and slices by agent and level', async () => {
  const lines = (items) => items.map((item) => JSON.stringify(item)).join('\n');
  writeFileSync(join(scratch, 'deliveries.jsonl'), lines([{ environment: 'production', at: '2026-11-03T12:00:00Z', result: 'success', kind: 'deploy', changeIds: ['c1'] }]));
  writeFileSync(join(scratch, 'changes.jsonl'), lines([{ id: 'c1', firstCommitAt: '2026-11-03T10:00:00Z', isFix: false, level: 'LOW', agent: 'alpha' }]));
  const result = await run(['metrics', 'dora', '--deliveries', 'deliveries.jsonl', '--changes', 'changes.jsonl', '--from', '2026-11-02T00:00:00Z', '--to', '2026-11-09T00:00:00Z']);
  const report = JSON.parse(result.out);
  assert.equal(report.overall.changeLeadTimeHours, 2);
  assert.deepEqual([Object.keys(report.byAgent), Object.keys(report.byLevel)], [['alpha'], ['LOW']]);
  assert.equal((await run(['metrics', 'dora', '--deliveries', 'deliveries.jsonl', '--changes', 'changes.jsonl'])).code, 1, 'a window is required');
  assert.equal((await run(['metrics', 'dora', '--deliveries', 'deliveries.jsonl', '--changes', 'changes.jsonl', '--from', 'yesterday', '--to', 'tomorrow'])).code, 1);
  mkdirSync(join(scratch, 'plain'));
  writeFileSync(join(scratch, 'plain', 'pheromill.config.json'), JSON.stringify({ project: { name: 'p' }, forge: { repository: 'a/p' } }));
  assert.match((await run(['check', join(scratch, 'plain')])).err, /is not a git repository/);
});

test('cli: settings prints the desired state offline, plans and applies with a token', async () => {
  const offline = await run(['settings', 'plan', '--offline'], { cwd: repository });
  assert.equal(JSON.parse(offline.out).rulesets[0].name, 'pheromill-trunk');
  assert.equal((await run(['settings', 'plan'], { cwd: repository })).code, 1, 'no token, no call');

  const desired = desiredSettings(await loadConfig(repository));
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace('https://api.github.com/repos/samimenouar/pheromill', '') || '/'}`);
    const body = url.endsWith('/labels?per_page=100') ? desired.labels.slice(1) : url.endsWith('/rulesets?per_page=100') ? [] : { delete_branch_on_merge: true, allow_auto_merge: false };
    return { ok: true, status: 200, json: async () => body };
  };
  const plan = await run(['settings', 'plan'], { cwd: repository, env: { PHEROMILL_FORGE_TOKEN: 't' }, fetch });
  assert.match(plan.out, /plan {3}create_label {2}factory:ready\nplan {3}create_ruleset {2}pheromill-trunk/);
  assert.ok(calls.every((call) => call.startsWith('GET')));
  const apply = await run(['settings', 'apply'], { cwd: repository, env: { PHEROMILL_FORGE_TOKEN: 't' }, fetch });
  assert.equal(apply.code, 0);
  assert.deepEqual(calls.slice(-2), ['POST /labels', 'POST /rulesets']);
});

test('cli: demo shows an honest change queued and a cheating one caught', async () => {
  const result = await run(['demo']);
  assert.equal(result.code, 0);
  assert.match(result.out, /outcome {3}queued/);
  assert.match(result.out, /test weakening signal assertion_removed/);
  const serve = await run(['serve', 'nothing']);
  assert.deepEqual([serve.code, serve.err], [1, 'pheromill serve: Usage: pheromill serve control | runner | egress']);
});

test('this repository: its own configuration is valid, honest about readiness, and matches the template', async () => {
  const config = await loadConfig(repository);
  assert.equal(config.autonomy.tier, 0);
  assert.ok(readiness(config).length > 0, 'no harness is configured yet, and the factory says so');
  const read = (path) => readFileSync(join(repository, path), 'utf8');
  assert.equal(read('.github/ISSUE_TEMPLATE/ticket.yml'), read('template/.github/ISSUE_TEMPLATE/ticket.yml'));
  assert.ok(read('AGENTS.md').startsWith(read('template/AGENTS.md')));
  const proofs = await run(['proofs', 'render', '--check'], { cwd: repository });
  assert.equal(proofs.code, 0, proofs.err);
});
