import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { cloneMirror, GitVcs } from '../../src/adapters/git.js';
import { parseUnifiedDiff, reconcile } from '../../src/domain/diff.js';
import { classifyRisk } from '../../src/domain/risk.js';
import { checkPatch } from '../../src/domain/patch-policy.js';
import { testConfig } from '../helpers.js';

let root;
let vcs;
let base;
const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pheromill-test-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--quiet', '--initial-branch=main', seed);
  mkdirSync(join(seed, 'src'));
  mkdirSync(join(seed, 'holdout'));
  writeFileSync(join(seed, 'src/a.js'), 'export const a = 1;\n');
  writeFileSync(join(seed, 'holdout/a.test.js'), 'secret scenario\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'seed');
  git(seed, 'push', '--quiet', remote, 'main');
  await cloneMirror(remote, join(root, 'mirror.git'));
  vcs = new GitVcs({ mirror: join(root, 'mirror.git') });
  base = await vcs.head('main');
});

after(() => rmSync(root, { recursive: true, force: true }));

async function workspace(name, hide = ['holdout/**']) {
  const directory = join(root, name);
  await vcs.exportTree(base, directory, hide);
  return directory;
}

test('git: a step workspace has no repository metadata and no hidden path', async () => {
  const directory = await workspace('ws-export');
  assert.equal(readFileSync(join(directory, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
  assert.equal(existsSync(join(directory, 'holdout')), false);
  assert.equal(existsSync(join(directory, '.git')), false);
});

test('git: the collected patch contains the edits and ignores hidden paths', async () => {
  const directory = await workspace('ws-patch');
  writeFileSync(join(directory, 'src/a.js'), 'export const a = 2;\n');
  writeFileSync(join(directory, 'src/b.js'), 'export const b = 1;\n');
  const patch = await vcs.collectPatch(base, directory, ['holdout/**']);
  const files = parseUnifiedDiff(patch);
  assert.deepEqual(files.map((file) => [file.path, file.status]), [['src/a.js', 'modified'], ['src/b.js', 'added']]);
});

test('git: symlinks and nested repositories planted by a step are caught by the patch gate', async () => {
  const directory = await workspace('ws-tricks');
  symlinkSync('/etc/passwd', join(directory, 'src/link'));
  git(root, 'init', '--quiet', join(directory, 'vendor'));
  writeFileSync(join(directory, 'vendor/x.txt'), 'x\n');
  git(join(directory, 'vendor'), 'add', '-A');
  git(join(directory, 'vendor'), 'commit', '--quiet', '-m', 'nested');
  const rules = checkPatch(parseUnifiedDiff(await vcs.collectPatch(base, directory, ['holdout/**'])), testConfig()).violations.map((v) => v.rule);
  assert.ok(rules.includes('symlink'));
  assert.ok(rules.includes('submodule'));
});

test('git: publish, build a candidate on the future trunk, and fast-forward to it', async () => {
  const one = await workspace('ws-one');
  writeFileSync(join(one, 'src/one.js'), 'one\n');
  const two = await workspace('ws-two');
  writeFileSync(join(two, 'src/two.js'), 'two\n');
  const shaOne = await vcs.publish({ base, branch: 'factory/t1', patches: [await vcs.collectPatch(base, one, ['holdout/**'])], message: 'one' });
  await vcs.publish({ base, branch: 'factory/t2', patches: [await vcs.collectPatch(base, two, ['holdout/**'])], message: 'two' });
  assert.equal(git(join(root, 'remote.git'), 'rev-parse', 'refs/heads/factory/t1'), shaOne);

  const shaTwo = await vcs.head('factory/t2');
  const candidate = await vcs.buildCandidate({ parent: base, changes: [{ id: '1', sha: shaOne }, { id: '2', sha: shaTwo }], ref: 'queue/e0-n2-a0' });
  assert.equal(await vcs.isAncestor(base, candidate.sha), true);
  assert.equal(await vcs.isAncestor(candidate.sha, base), false);
  const files = git(join(root, 'remote.git'), 'ls-tree', '-r', '--name-only', candidate.sha).split('\n');
  assert.deepEqual(files, ['holdout/a.test.js', 'src/a.js', 'src/one.js', 'src/two.js']);
  await vcs.fastForward('main', candidate.sha);
  assert.equal(git(join(root, 'remote.git'), 'rev-parse', 'refs/heads/main'), candidate.sha);
  await assert.rejects(() => vcs.fastForward('main', shaOne), /Not a fast-forward/);
  base = candidate.sha;
});

test('git: a conflicting branch is reported instead of producing a candidate', async () => {
  const left = await workspace('ws-left');
  writeFileSync(join(left, 'src/a.js'), 'export const a = "left";\n');
  const right = await workspace('ws-right');
  writeFileSync(join(right, 'src/a.js'), 'export const a = "right";\n');
  const leftSha = await vcs.publish({ base, branch: 'factory/left', patches: [await vcs.collectPatch(base, left)], message: 'left' });
  const rightSha = await vcs.publish({ base, branch: 'factory/right', patches: [await vcs.collectPatch(base, right)], message: 'right' });
  const result = await vcs.buildCandidate({ parent: base, changes: [{ id: 'L', sha: leftSha }, { id: 'R', sha: rightSha }], ref: 'queue/conflict' });
  assert.deepEqual(result, { conflict: 'R' });
  await assert.rejects(() => vcs.buildCandidate({ parent: base, changes: [{ id: 'X', sha: 'factory/left' }], ref: 'queue/x' }), /no reviewed commit/);
});

test('git: a patch that does not apply is refused', async () => {
  const bogus = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-not the real content\n+x\n';
  await assert.rejects(() => vcs.publish({ base, branch: 'factory/bogus', patches: [bogus], message: 'bogus' }), /git apply failed/);
});

test('git: a candidate is built from the reviewed commit, not from what the branch points to later', async () => {
  const reviewed = await workspace('ws-reviewed');
  writeFileSync(join(reviewed, 'src/reviewed.js'), 'reviewed\n');
  const sha = await vcs.publish({ base, branch: 'factory/t9', patches: [await vcs.collectPatch(base, reviewed, ['holdout/**'])], message: 'reviewed' });
  writeFileSync(join(reviewed, 'src/unreviewed.js'), 'slipped in after review\n');
  await vcs.publish({ base, branch: 'factory/t9', patches: [await vcs.collectPatch(base, reviewed, ['holdout/**'])], message: 'later push' });
  const candidate = await vcs.buildCandidate({ parent: base, changes: [{ id: '9', sha }], ref: 'queue/pinned' });
  const files = git(join(root, 'remote.git'), 'ls-tree', '-r', '--name-only', candidate.sha).split('\n');
  assert.ok(files.includes('src/reviewed.js'));
  assert.ok(!files.includes('src/unreviewed.js'));
});

test('git: the gates see what git applies, whatever the patch text claims', async () => {
  const config = testConfig({ paths: { reserved: ['pheromill.config.json', 'AGENTS.md', 'src/a.js'] } });
  const inspect = async (patch) => {
    const canonical = await vcs.canonicalize({ base, patches: [patch] });
    return reconcile(parseUnifiedDiff(canonical.patch), canonical.entries);
  };
  const current = readFileSync(join(await workspace('ws-current', []), 'src/a.js'), 'utf8').trimEnd();
  // The header names an innocent file; the ---/+++ lines, which git follows, name a reserved one.
  const disguised = `diff --git a/src/one.js b/src/one.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-${current}\n+export const a = "owned";\n`;
  assert.equal(parseUnifiedDiff(disguised)[0].unsafePath, true, 'the strict parser already refuses the text');
  const files = await inspect(disguised);
  assert.deepEqual(files.map((file) => file.path), ['src/a.js'], 'and git reports the path it really changes');
  assert.equal(classifyRisk(files, config).level, 'CRITICAL');
  assert.equal(checkPatch(await inspect(''.concat('diff --git a/src/z.js b/src/z.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/z.js\n@@ -0,0 +1 @@\n+z\n')), config).ok, true);
  await assert.rejects(() => vcs.canonicalize({ base, patches: ['not a patch'] }), /git apply failed/);
});

test('git: a symbolic link already on the trunk cannot be retargeted by a patch without a mode line', async () => {
  const linked = await workspace('ws-link');
  symlinkSync('a.js', join(linked, 'src/link.js'));
  const withLink = await vcs.publish({ base, branch: 'factory/link', patches: [await vcs.collectPatch(base, linked, ['holdout/**'])], message: 'link' });
  const retarget = 'diff --git a/src/link.js b/src/link.js\n--- a/src/link.js\n+++ b/src/link.js\n@@ -1 +1 @@\n-a.js\n\\ No newline at end of file\n+/etc/passwd\n\\ No newline at end of file\n';
  assert.equal(parseUnifiedDiff(retarget)[0].symlink, false, 'the text alone does not reveal the link');
  const canonical = await vcs.canonicalize({ base: withLink, patches: [retarget] });
  const files = reconcile(parseUnifiedDiff(canonical.patch), canonical.entries);
  assert.equal(files[0].symlink, true);
  assert.deepEqual(checkPatch(files, testConfig()).violations.map((v) => v.rule), ['symlink']);
});

test('git: attributes in the tree cannot hide files from a workspace', async () => {
  const sneaky = await workspace('ws-attributes');
  writeFileSync(join(sneaky, '.gitattributes'), 'src/a.js export-ignore\n');
  const sha = await vcs.publish({ base, branch: 'factory/attributes', patches: [await vcs.collectPatch(base, sneaky, ['holdout/**'])], message: 'attributes' });
  const directory = join(root, 'ws-after-attributes');
  await vcs.exportTree(sha, directory, []);
  assert.equal(existsSync(join(directory, 'src/a.js')), true);
});

test('git: file names are data, never patterns: spaces, brackets and pathspec magic change nothing', async () => {
  const directory = await workspace('ws-names');
  mkdirSync(join(directory, 'holdout'), { recursive: true });
  writeFileSync(join(directory, 'holdout/planted.test.js'), 'the author recreated a hidden directory\n');
  const names = ['docs/user guide.md', 'src/[draft].js', 'src/*.js', ':(top)src', ':!holdout'];
  for (const name of names) {
    mkdirSync(join(directory, name, '..'), { recursive: true });
    writeFileSync(join(directory, name), 'content\n');
  }
  const patch = await vcs.collectPatch(base, directory, ['holdout/**']);
  const { entries } = await vcs.canonicalize({ base, patches: [patch] });
  const files = reconcile(parseUnifiedDiff(patch), entries);
  assert.deepEqual(files.map((file) => file.path).sort(), [...names].sort(), 'every file is reported under its own name, and the hidden path is left out');
  assert.equal(files.some((file) => file.unsafePath), false);

  const onlyHidden = await workspace('ws-only-hidden');
  mkdirSync(join(onlyHidden, 'holdout'), { recursive: true });
  writeFileSync(join(onlyHidden, 'holdout/planted.test.js'), 'x\n');
  assert.equal(await vcs.collectPatch(base, onlyHidden, ['holdout/**']), '', 'a step that only wrote to hidden paths changed nothing');
});

test('git: a mirror whose first fetch failed is not taken for a mirror', async () => {
  const directory = join(root, 'broken-mirror.git');
  await assert.rejects(() => cloneMirror(join(root, 'no-such-remote.git'), directory));
  assert.equal(existsSync(directory), false, 'the service starts again from nothing instead of serving an empty mirror');
  await cloneMirror(join(root, 'remote.git'), directory);
  assert.equal(await new GitVcs({ mirror: directory }).head('main'), base);
});
