import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffStats, isSafePath, parseUnifiedDiff, reconcile } from '../../src/domain/diff.js';
import { anyOverlap, globToRegExp, globsMayOverlap, matchesAny, mayFallUnder, normalizePath } from '../../src/domain/glob.js';
import { checkPatch } from '../../src/domain/patch-policy.js';
import { fileDiff, testConfig } from '../helpers.js';

test('glob: ** crosses directories, * and ? do not', () => {
  assert.ok(globToRegExp('src/**/x.js').test('src/x.js'));
  assert.ok(globToRegExp('src/**/x.js').test('src/a/b/x.js'));
  assert.ok(globToRegExp('src/*.js').test('src/a.js'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('a?.md').test('ab.md'));
  assert.ok(!globToRegExp('a?.md').test('a/.md'));
  assert.ok(matchesAny('.github/workflows/ci.yml', ['.github/**']));
  assert.ok(!matchesAny('agithub/x', ['.github/**']));
});

test('glob: overlap test is conservative and never misses a real overlap', () => {
  assert.ok(globsMayOverlap('src/a/**', 'src/a/b.js'));
  assert.ok(globsMayOverlap('**/*.md', 'docs/x.md'));
  assert.ok(!globsMayOverlap('src/a/**', 'src/b/**'));
  assert.ok(anyOverlap(['docs/a.md', 'src/x/**'], ['src/x/y.js']));
  assert.ok(!anyOverlap(['docs/a.md'], ['src/x/y.js']));
  assert.ok(globsMayOverlap('./src/auth/login.js', 'src/auth/**'), 'spelling does not hide an overlap');
  assert.equal(normalizePath('/./src/a.js'), 'src/a.js');
  assert.equal(mayFallUnder('./pheromill.config.json', ['pheromill.config.json']), true);
  assert.equal(mayFallUnder('src/app/a.js', ['**/package.json', '.github/**']), false, 'a plain path is matched exactly');
  assert.equal(mayFallUnder('src/app/**', ['**/package.json']), true, 'a glob is matched conservatively');
});

test('glob: repeated ** segments stay fast', () => {
  const started = Date.now();
  assert.equal(globToRegExp('**/**/**/**/**/**/**/**/x').test(`${'a/'.repeat(60)}y`), false);
  assert.ok(Date.now() - started < 200);
});

test('diff: parses added, removed and modified files with line counts', () => {
  const text =
    fileDiff('src/a.js', { removed: ['old'], added: ['new', 'more'] }) +
    fileDiff('src/b.js', { added: ['x'], status: 'added' }) +
    fileDiff('src/c.js', { removed: ['y'], status: 'deleted' });
  const files = parseUnifiedDiff(text);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.additions, f.deletions]), [
    ['src/a.js', 'modified', 2, 1],
    ['src/b.js', 'added', 1, 0],
    ['src/c.js', 'deleted', 0, 1],
  ]);
  assert.deepEqual(diffStats(files), { files: 3, additions: 3, deletions: 2, changedLines: 5 });
});

test('diff: file content that imitates a diff header cannot forge a file entry', () => {
  const forged = ['diff --git a/.github/x.yml b/.github/x.yml', '--- a/.github/x.yml', '+++ b/.github/x.yml'];
  const files = parseUnifiedDiff(fileDiff('notes.txt', { added: forged }));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'notes.txt');
  assert.equal(files[0].additions, 3);
});

test('diff: symlinks, submodules, binaries and mode changes are flagged; renames and copies are not accepted', () => {
  const symlink = 'diff --git a/link b/link\nnew file mode 120000\nindex 000..111\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n';
  const submodule = 'diff --git a/vendor b/vendor\nnew file mode 160000\n';
  const binary = 'diff --git a/a.png b/a.png\nindex 1..2 100644\nBinary files a/a.png and b/a.png differ\n';
  const literal = 'diff --git a/b.png b/b.png\nindex 1..2 100644\nGIT binary patch\nliteral 3\nKcmZQzU\n\nliteral 0\nHcmV?d00001\n';
  const mode = 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n';
  const [s, m, b, l, x] = parseUnifiedDiff(symlink + submodule + binary + literal + mode);
  assert.ok(s.symlink && m.submodule && b.binary && l.binary && x.modeChanged);
  assert.ok([s, m, b, l, x].every((file) => !file.unsafePath));
  const rename = 'diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\n';
  const copy = 'diff --git a/x.js b/x.js\ncopy from x.js\ncopy to y.js\n';
  assert.deepEqual(parseUnifiedDiff(rename + copy).map((file) => file.unsafePath), [true, true]);
});

test('diff: anything git would read differently from this parser is refused', () => {
  const hunk = '@@ -1 +1 @@\n-a\n+b\n';
  const cases = {
    'names in ---/+++ differ from the header': `diff --git a/README.md b/README.md\n--- a/pheromill.config.json\n+++ b/pheromill.config.json\n${hunk}`,
    'a second patch without its own header': `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n${hunk}--- a/pheromill.config.json\n+++ b/pheromill.config.json\n${hunk}`,
    'header lines after a hunk': `diff --git a/x b/x\n--- a/x\n+++ b/x\n${hunk}rename from docs/old.md\nrename to docs/new.md\n`,
    'a patch without any header': `--- a/x\n+++ b/x\n${hunk}`,
    'an unknown header line': `diff --git a/x b/x\nsomething else\n--- a/x\n+++ b/x\n${hunk}`,
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.ok(parseUnifiedDiff(text).every((file) => file.unsafePath), name);
    assert.equal(checkPatch(parseUnifiedDiff(text), testConfig()).ok, false, name);
  }
  const fine = `diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n`;
  assert.deepEqual(parseUnifiedDiff(fine).map((file) => [file.unsafePath, file.additions, file.deletions]), [[false, 1, 1]]);
});

test('diff: reconciling with what git reports fails closed on any disagreement', () => {
  const parsed = () => parseUnifiedDiff(fileDiff('src/a.js', { removed: ['a'], added: ['b'] }));
  const entry = { path: 'src/a.js', status: 'M', oldMode: '100644', newMode: '100644' };
  assert.equal(reconcile(parsed(), [entry])[0].unsafePath, false);
  assert.equal(reconcile(parsed(), [{ ...entry, oldMode: '120000', newMode: '120000' }])[0].symlink, true, 'modes come from the tree, not from the text');
  assert.equal(reconcile(parsed(), [{ ...entry, status: 'T' }])[0].modeChanged, true);
  assert.equal(reconcile(parsed(), [{ ...entry, path: 'pheromill.config.json' }])[0].unsafePath, true);
  assert.equal(reconcile(parsed(), [{ ...entry, status: 'D' }])[0].unsafePath, true);
  assert.equal(reconcile(parsed(), [entry, { ...entry, path: 'src/b.js' }])[0].unsafePath, true);
  assert.equal(reconcile([], [entry])[0].unsafePath, true, 'a change git sees and the parser does not');
  assert.deepEqual(reconcile([], []), []);
});

test('diff: unsafe paths are rejected', () => {
  for (const path of ['../x', '/etc/passwd', 'a/../b', '.git/config', 'a/.GIT/hooks/x', 'a\\b', '-rf', 'a//b', '"quoted"', '']) {
    assert.equal(isSafePath(path), false, path);
  }
  assert.ok(isSafePath('.github/workflows/ci.yml'));
  const [file] = parseUnifiedDiff('diff --git "a/caf\\303\\251" "b/caf\\303\\251"\n');
  assert.equal(file.unsafePath, true);
  const [escape] = parseUnifiedDiff('diff --git a/../x b/../x\n');
  assert.equal(escape.unsafePath, true);
});

test('patch policy: accepts an ordinary change', () => {
  const files = parseUnifiedDiff(fileDiff('src/app/a.js', { removed: ['a'], added: ['b'] }));
  assert.deepEqual(checkPatch(files, testConfig()), { ok: true, violations: [] });
});

test('patch policy: rejects structural tricks, queue-owned files and holdout edits', () => {
  const text =
    'diff --git a/link b/link\nnew file mode 120000\n' +
    'diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\n' +
    'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n' +
    'diff --git a/../x b/../x\n' +
    fileDiff('package-lock.json', { added: ['{}'] }) +
    fileDiff('holdout/login.test.js', { added: ['x'], status: 'added' });
  const rules = checkPatch(parseUnifiedDiff(text), testConfig()).violations.map((v) => v.rule);
  assert.deepEqual(rules.sort(), ['binary', 'holdout', 'mode_change', 'queue_owned', 'symlink', 'unsafe_path']);
});

test('patch policy: holdout scenarios are writable by the specify step only', () => {
  const files = parseUnifiedDiff(fileDiff('holdout/login.test.js', { added: ['x'], status: 'added' }));
  assert.equal(checkPatch(files, testConfig(), { allowHoldout: true }).ok, true);
  assert.equal(checkPatch(files, testConfig()).ok, false);
});

test('patch policy: a change above 500 lines or an empty patch is rejected', () => {
  const big = parseUnifiedDiff(fileDiff('src/a.js', { added: Array.from({ length: 501 }, (_, i) => `l${i}`) }));
  assert.deepEqual(checkPatch(big, testConfig()).violations.map((v) => v.rule), ['too_large']);
  assert.deepEqual(checkPatch([], testConfig()).violations.map((v) => v.rule), ['empty_patch']);
});

test('diff: a path that contains a space is read as git writes it, with a tab after the name', () => {
  const patch = ['diff --git a/docs/user guide.md b/docs/user guide.md', 'index 1111111..2222222 100644', '--- a/docs/user guide.md\t', '+++ b/docs/user guide.md\t', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
  const [file] = parseUnifiedDiff(patch);
  assert.deepEqual([file.path, file.unsafePath, file.added, file.removed], ['docs/user guide.md', false, ['new'], ['old']]);
});

test('patch policy: lines that ship in the same change count towards its size', () => {
  const files = parseUnifiedDiff(fileDiff('src/a.js', { added: Array.from({ length: 300 }, (_, i) => `line ${i}`), status: 'added' }));
  assert.equal(checkPatch(files, testConfig()).ok, true);
  const { ok, violations } = checkPatch(files, testConfig(), { carriedLines: 201 });
  assert.equal(ok, false);
  assert.deepEqual(violations.map((v) => [v.rule, v.detail]), [['too_large', '501 changed lines (201 of them in hidden scenarios) exceed the limit of 500.']]);
});
