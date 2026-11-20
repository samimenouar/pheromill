/**
 * Parser for `git diff` output (unified format with `a/` and `b/` prefixes).
 *
 * The parser counts hunk lines from each `@@` header, so file content that
 * imitates a diff header cannot forge a file entry. It accepts only what
 * `git diff --no-renames` emits; anything else is flagged `unsafePath`, and
 * callers must fail closed on it. Because `git apply` is more lenient than
 * this parser, the pipeline never trusts agent-supplied text directly: it
 * applies the patch, lets git re-emit it, and reconciles both views.
 */

const SYMLINK_MODE = '120000';
const SUBMODULE_MODE = '160000';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** @param {string} path */
export function isSafePath(path) {
  if (!path || path.length > 1024) return false;
  if (path.startsWith('/') || path.startsWith('-')) return false;
  if (path.includes('\\') || path.includes('"') || CONTROL_CHARS.test(path)) return false;
  const segments = path.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}

function newFile(headerRest) {
  const file = {
    path: '',
    oldPath: '',
    status: 'modified',
    binary: false,
    symlink: false,
    submodule: false,
    modeChanged: false,
    unsafePath: false,
    additions: 0,
    deletions: 0,
    added: [],
    removed: [],
  };
  // "a/<path> b/<path>" with both halves equal. Renames and copies are never
  // produced by the factory (it diffs with --no-renames) and are not accepted.
  const half = (headerRest.length - 1) / 2;
  const left = headerRest.slice(0, half);
  const right = headerRest.slice(half + 1);
  if (Number.isInteger(half) && left.startsWith('a/') && right === `b/${left.slice(2)}`) {
    file.path = left.slice(2);
    file.oldPath = file.path;
  } else {
    file.unsafePath = true;
  }
  return file;
}

function applyMode(file, mode) {
  if (mode === SYMLINK_MODE) file.symlink = true;
  if (mode === SUBMODULE_MODE) file.submodule = true;
}

/** @returns {boolean} false when the line is not a header git would emit here */
function readHeader(file, line) {
  if (line.startsWith('new file mode ')) {
    file.status = 'added';
    applyMode(file, line.slice(14).trim());
  } else if (line.startsWith('deleted file mode ')) {
    file.status = 'deleted';
    applyMode(file, line.slice(18).trim());
  } else if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
    file.modeChanged = true;
    applyMode(file, line.slice(9).trim());
  } else if (line.startsWith('index ')) {
    const mode = line.split(' ')[2];
    if (mode) applyMode(file, mode);
  } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    file.binary = true;
  } else if (line.startsWith('--- ')) {
    return line === '--- /dev/null' || line === `--- a/${file.oldPath}`;
  } else if (line.startsWith('+++ ')) {
    return line === '+++ /dev/null' || line === `+++ b/${file.path}`;
  } else {
    return false;
  }
  return true;
}

/**
 * @param {string} text output of `git diff`
 * @returns {Array<ReturnType<typeof newFile>>}
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let oldLeft = 0;
  let newLeft = 0;
  let sawHunk = false;

  for (const line of text.split('\n')) {
    if (file && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('+')) {
        file.added.push(line.slice(1));
        file.additions += 1;
        newLeft -= 1;
      } else if (line.startsWith('-')) {
        file.removed.push(line.slice(1));
        file.deletions += 1;
        oldLeft -= 1;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" carries no content.
      } else {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      file = newFile(line.slice(11));
      files.push(file);
      sawHunk = false;
      continue;
    }
    if (line === '' || line.startsWith('\\')) continue;
    if (!file) {
      // Text before the first file header: git would look for a patch in it.
      file = newFile('');
      files.push(file);
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      sawHunk = true;
      continue;
    }
    // Binary payload lines are opaque; binaries are refused by the gate anyway.
    if (file.binary) continue;
    // After a hunk, git starts looking for another patch: anything here could be one.
    if (sawHunk || !readHeader(file, line)) file.unsafePath = true;
  }

  for (const entry of files) {
    if (!isSafePath(entry.path) || !isSafePath(entry.oldPath)) entry.unsafePath = true;
  }
  return files;
}

/**
 * Cross-check parsed files against what git itself reports for the applied
 * patch (`git diff --raw`). The parser reads the text; git is the authority
 * on which paths and modes really change. Any disagreement fails closed.
 * @param {ReturnType<typeof parseUnifiedDiff>} files
 * @param {Array<{path: string, status: string, oldMode: string, newMode: string}>} entries
 */
export function reconcile(files, entries) {
  const STATUS = { A: 'added', D: 'deleted', M: 'modified', T: 'modified' };
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  let agrees = files.length === entries.length;
  for (const file of files) {
    const entry = byPath.get(file.path);
    if (!entry || STATUS[entry.status] !== file.status) {
      agrees = false;
      continue;
    }
    for (const mode of [entry.oldMode, entry.newMode]) applyMode(file, mode);
    if (entry.status === 'T') file.modeChanged = true;
  }
  if (!agrees) for (const file of files) file.unsafePath = true;
  if (!agrees && files.length === 0) {
    const ghost = newFile('');
    files.push(ghost);
  }
  return files;
}

/** @param {Array<{additions: number, deletions: number}>} files */
export function diffStats(files) {
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  return { files: files.length, additions, deletions, changedLines: additions + deletions };
}
