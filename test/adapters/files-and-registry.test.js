import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FileLedger, JsonStore, loadConfig, readUntrustedJson, trackedFiles } from '../../src/adapters/files.js';
import { NpmRegistry } from '../../src/adapters/npm-registry.js';
import { verifyChain } from '../../src/domain/ledger.js';

const root = mkdtempSync(join(tmpdir(), 'pheromill-files-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('files: the ledger survives restarts and concurrent appends as one valid chain', async () => {
  const path = join(root, 'ledger.jsonl');
  const first = new FileLedger(path);
  await Promise.all([first.append('a', { n: 1 }), first.append('b', { n: 2 }), first.append('c', { n: 3 })]);
  await new FileLedger(path).append('d', { n: 4 });
  const entries = await new FileLedger(path).entries();
  assert.deepEqual(entries.map((entry) => [entry.seq, entry.type]), [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
  assert.equal(verifyChain(entries).valid, true);

  const lines = readFileSync(path, 'utf8').trim().split('\n');
  writeFileSync(path, [lines[0], lines[2], lines[3]].join('\n') + '\n');
  assert.deepEqual(verifyChain(await new FileLedger(path).entries()), { valid: false, brokenAt: 2 });
});

test('files: one failed append does not poison the ledger', async () => {
  const directory = join(root, 'blocked');
  mkdirSync(join(directory, 'ledger.jsonl'), { recursive: true });
  const ledger = new FileLedger(join(directory, 'ledger.jsonl'));
  await assert.rejects(() => ledger.append('a', {}));
  rmSync(join(directory, 'ledger.jsonl'), { recursive: true });
  await ledger.append('b', {});
  assert.deepEqual((await ledger.entries()).map((entry) => [entry.seq, entry.type]), [[1, 'b']]);
});

test('files: a file from a less trusted party is read without following links and within a size limit', async () => {
  const path = (name) => join(root, name);
  writeFileSync(path('ok.json'), '{"a":1}');
  writeFileSync(path('list.json'), '[1]');
  writeFileSync(path('broken.json'), '{');
  writeFileSync(path('big.json'), JSON.stringify({ a: 'x'.repeat(100) }));
  symlinkSync(path('ok.json'), path('link.json'));
  assert.deepEqual(await readUntrustedJson(path('ok.json'), 50), { a: 1 });
  for (const name of ['list.json', 'broken.json', 'big.json', 'link.json', 'missing.json', '.']) {
    assert.equal(await readUntrustedJson(path(name), 50), null, name);
  }
});

test('files: configuration is merged with defaults and refused with every problem listed', async () => {
  writeFileSync(join(root, 'pheromill.config.json'), JSON.stringify({ project: { name: 'demo' }, forge: { repository: 'acme/demo' } }));
  const config = await loadConfig(root);
  assert.equal(config.limits.maxChangedLines, 500);
  writeFileSync(join(root, 'pheromill.config.json'), JSON.stringify({ limits: { maxChangedLines: 5000 } }));
  await assert.rejects(() => loadConfig(root), /project\.name is required[\s\S]*maxChangedLines/);
});

test('files: the store returns its fallback until something is written', async () => {
  const store = new JsonStore(join(root, 'state', 'queue.json'));
  assert.deepEqual(await store.read({ empty: true }), { empty: true });
  await store.write({ pending: ['1'] });
  assert.deepEqual(await store.read(null), { pending: ['1'] });
  const counter = new JsonStore(join(root, 'state', 'counter.json'), { n: 0 });
  await Promise.all(Array.from({ length: 20 }, () => counter.update(async (value) => ({ n: value.n + 1 }))));
  assert.deepEqual(await counter.read(null), { n: 20 }, 'concurrent updates never lose a write');
  await assert.rejects(() => counter.update(() => { throw new Error('boom'); }), /boom/);
  assert.deepEqual((await counter.update((value) => value)).n, 20, 'a failed update does not block the next one');
});

test('npm registry: metadata for the dependency gate comes from the package document', async () => {
  const document = {
    time: { created: '2014-03-01T00:00:00Z', '1.3.0': '2018-04-01T00:00:00Z' },
    versions: {
      '1.2.0': { gypfile: true },
      '1.3.0': { license: 'MIT', scripts: { test: 'x', postinstall: 'node setup.js' }, deprecated: 'use String.prototype.padStart' },
    },
  };
  const seen = [];
  const doFetch = async (url) => {
    seen.push(url);
    if (url.endsWith('/missing')) return { ok: false, status: 404 };
    if (url.endsWith('/broken')) return { ok: false, status: 500 };
    return { ok: true, status: 200, json: async () => document };
  };
  const registry = new NpmRegistry({ fetch: doFetch });
  assert.deepEqual(await registry.metadata({ ecosystem: 'npm', name: '@scope/left-pad', version: '1.3.0' }), {
    versionPublishedAt: '2018-04-01T00:00:00Z',
    packageCreatedAt: '2014-03-01T00:00:00Z',
    versionCount: 2,
    license: 'MIT',
    installScripts: ['postinstall'],
    deprecated: true,
  });
  assert.equal(seen[0], 'https://registry.npmjs.org/@scope%2Fleft-pad');
  const native = await registry.metadata({ ecosystem: 'npm', name: 'left-pad', version: '1.2.0' });
  assert.deepEqual(native.installScripts, ['native-build'], 'a native build at install time runs code like any install script');
  assert.equal(await registry.metadata({ ecosystem: 'npm', name: 'left-pad', version: '9.9.9' }), null);
  assert.equal(await registry.metadata({ ecosystem: 'npm', name: 'missing', version: '1.0.0' }), null);
  assert.equal(await registry.metadata({ ecosystem: 'pypi', name: 'left-pad', version: '1.3.0' }), null);
  await assert.rejects(() => registry.metadata({ ecosystem: 'npm', name: 'broken', version: '1.0.0' }), /status 500/);
});

test('files: a record cut short by a crash is not an entry, and the next append starts on a clean line', async () => {
  const path = join(root, 'torn.jsonl');
  await new FileLedger(path).append('a', { n: 1 });
  const intact = readFileSync(path, 'utf8');
  writeFileSync(path, `${intact}{"seq":2,"type":"b","da`);
  assert.deepEqual((await new FileLedger(path).entries()).map((entry) => entry.type), ['a']);
  await new FileLedger(path).append('c', { n: 3 });
  const entries = await new FileLedger(path).entries();
  assert.deepEqual(entries.map((entry) => [entry.seq, entry.type]), [[1, 'a'], [2, 'c']]);
  assert.equal(verifyChain(entries).valid, true);
});

test('files: an operation recorded once stays recorded once when it is replayed, also after a restart', async () => {
  const path = join(root, 'once.jsonl');
  const ledger = new FileLedger(path);
  await Promise.all([ledger.appendOnce('merge', 'abc', { changes: ['1'] }), ledger.appendOnce('merge', 'abc', { changes: ['1'] })]);
  await new FileLedger(path).appendOnce('merge', 'abc', { changes: ['1'] });
  await new FileLedger(path).appendOnce('merge', 'def', { changes: ['2'] });
  await new FileLedger(path).appendOnce('evict', 'abc', { change: '1' });
  const entries = await new FileLedger(path).entries();
  assert.deepEqual(entries.map((entry) => [entry.type, entry.data.identity]), [['merge', 'abc'], ['merge', 'def'], ['evict', 'abc']]);
  assert.equal(verifyChain(entries).valid, true);
});

test('files: the repository scan reads tracked text files and never follows a tracked link', async () => {
  const directory = join(root, 'checkout');
  mkdirSync(directory);
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  execFileSync('git', ['init', '--quiet', directory], { env });
  writeFileSync(join(root, 'outside.txt'), 'a secret outside the checkout\n');
  writeFileSync(join(directory, 'a.md'), 'text\n');
  writeFileSync(join(directory, 'blob.bin'), Buffer.from([1, 0, 2]));
  symlinkSync(join(root, 'outside.txt'), join(directory, 'link.md'));
  assert.deepEqual(await trackedFiles(directory), [{ path: 'a.md', content: 'text\n' }]);
});
