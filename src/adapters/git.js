/**
 * Git adapter. Runs in trusted zones only and never inside a working tree an
 * agent could have prepared: every operation uses a bare mirror, a private
 * index file, and a configuration that ignores user, system and hook settings.
 * Requires git 2.38 or newer (merge-tree --write-tree).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { matchesAny } from '../domain/glob.js';

const HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.quotePath=false', '-c', 'protocol.file.allow=user', '-c', 'gc.auto=0'];
const DIFF_OPTIONS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
const SHA = /^[0-9a-f]{40,64}$/;

export class GitVcs {
  /**
   * @param {{mirror: string, remote?: string, identity?: {name: string, email: string},
   *   credentials?: (() => Promise<string>)|null, host?: string}} options
   *   `mirror` is the path of a bare mirror clone owned by the zone that uses it.
   *   `credentials` returns the forge token for network operations; it is passed
   *   to git through the environment, never on a command line or in a config file.
   */
  constructor(options) {
    this.mirror = options.mirror;
    this.credentials = options.credentials ?? null;
    this.host = options.host ?? 'github.com';
    this.remote = options.remote ?? 'origin';
    this.identity = options.identity ?? { name: 'pheromill', email: 'pheromill@localhost' };
  }

  /**
   * Run git and return its exit code and output. Only a failure to start git rejects.
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  async run(args, { index = null, workTree = null, gitDir = this.mirror, input = null, network = false } = {}) {
    const auth = {};
    if (network && this.credentials) {
      const basic = Buffer.from(`x-access-token:${await this.credentials()}`).toString('base64');
      Object.assign(auth, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.https://${this.host}/.extraheader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
    }
    const env = {
      ...auth,
      PATH: process.env.PATH,
      HOME: tmpdir(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: this.identity.name,
      GIT_AUTHOR_EMAIL: this.identity.email,
      GIT_COMMITTER_NAME: this.identity.name,
      GIT_COMMITTER_EMAIL: this.identity.email,
      GIT_DIR: gitDir,
      GIT_LITERAL_PATHSPECS: '1',
      ...(index ? { GIT_INDEX_FILE: index } : {}),
      ...(workTree ? { GIT_WORK_TREE: workTree } : {}),
    };
    return new Promise((resolve, reject) => {
      const child = execFile('git', [...HARDENING, ...args], { env, cwd: workTree ?? gitDir, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') reject(new Error(`git ${args[0]} could not run: ${error.message}`));
        else resolve({ code: error ? error.code : 0, stdout, stderr });
      });
      if (input !== null) child.stdin.end(input);
    });
  }

  /** Run git and return stdout; any non-zero exit is an error. */
  async git(args, options) {
    const result = await this.run(args, options);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    return result.stdout;
  }

  async fetch() {
    await this.git(['fetch', '--prune', this.remote, '+refs/heads/*:refs/heads/*'], { network: true });
  }

  async head(ref) {
    return (await this.git(['rev-parse', '--verify', `refs/heads/${ref}^{commit}`])).trim();
  }

  /** Content of a file at a ref, read from the mirror: what merged, not what a checkout holds. */
  async readFile(ref, path) {
    return this.git(['show', `refs/heads/${ref}:${path}`]);
  }

  /** True when `ancestor` is reachable from `descendant` (or they are the same commit). */
  async isAncestor(ancestor, descendant) {
    const result = await this.run(['merge-base', '--is-ancestor', ancestor, descendant]);
    if (result.code > 1) throw new Error(`git merge-base failed: ${result.stderr.trim()}`);
    return result.code === 0;
  }

  async withScratch(run) {
    const dir = await mkdtemp(join(tmpdir(), 'pheromill-git-'));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Write the tree of a commit into `directory`, without any `.git` and
   * without the paths the step must not see. Attributes found in the tree
   * (export-ignore, export-subst) are not honoured: the index is the source.
   */
  async exportTree(sha, directory, hidePaths = []) {
    if (!SHA.test(sha)) throw new Error('exportTree needs a full commit id.');
    await mkdir(directory, { recursive: true });
    await this.withScratch(async (scratch) => {
      const index = join(scratch, 'index');
      await this.git(['read-tree', sha], { index });
      if (hidePaths.length > 0) {
        const listing = await this.git(['ls-files', '-z'], { index });
        const hidden = listing.split('\0').filter((path) => path !== '' && matchesAny(path, hidePaths));
        if (hidden.length > 0) await this.git(['update-index', '--force-remove', '-z', '--stdin'], { index, workTree: directory, input: `${hidden.join('\0')}\0` });
      }
      await this.git(['checkout-index', '--all', `--prefix=${directory}/`], { index, workTree: directory });
    });
  }

  /**
   * The patch between a commit and what a step left in `directory`.
   * Hidden paths are excluded: they were never in the workspace.
   */
  async collectPatch(sha, directory, hidePaths = []) {
    return this.withScratch(async (scratch) => {
      const index = join(scratch, 'index');
      await this.git(['read-tree', sha], { index });
      await this.git(['add', '-A', '--', '.'], { index, workTree: directory });
      // The same matcher as exportTree decides what is hidden; git only sees literal paths.
      const changed = (await this.git(['diff', '--cached', '--name-only', '-z', '--no-renames', sha], { index, workTree: directory })).split('\0');
      const visible = changed.filter((path) => path !== '' && !matchesAny(path, hidePaths));
      if (visible.length === 0) return '';
      return this.git(['diff', '--cached', '--binary', ...DIFF_OPTIONS, sha, '--', ...visible], { index, workTree: directory });
    });
  }

  /** Apply patches to a private index on top of `base`; returns the index path and an empty work tree. */
  async stage(scratch, base, patches) {
    const index = join(scratch, 'index');
    const empty = join(scratch, 'empty');
    await mkdir(empty);
    await this.git(['read-tree', base], { index });
    for (const [number, patch] of patches.entries()) {
      const file = join(scratch, `${number}.patch`);
      await writeFile(file, patch);
      await this.git(['apply', '--cached', '--whitespace=nowarn', file], { index, workTree: empty });
    }
    return { index, empty };
  }

  /**
   * Let git decide what a patch really does. The patch text is applied on top
   * of `base`, then git itself reports the changed paths and modes and emits
   * the patch again in its own format. The gates run on that, never on text
   * an execution zone handed over.
   * @returns {Promise<{patch: string, entries: Array<{path: string, status: string, oldMode: string, newMode: string}>}>}
   */
  async canonicalize({ base, patches }) {
    return this.withScratch(async (scratch) => {
      const { index, empty } = await this.stage(scratch, base, patches);
      const raw = await this.git(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', base], { index, workTree: empty });
      const fields = raw.split('\0');
      const entries = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const [oldMode, newMode, , , status] = fields[i].replace(/^:/, '').split(' ');
        entries.push({ path: fields[i + 1], status, oldMode, newMode });
      }
      const patch = await this.git(['diff', '--cached', '--binary', ...DIFF_OPTIONS, base], { index, workTree: empty });
      return { patch, entries };
    });
  }

  /** Apply an already gated patch to a plain directory (a reviewer workspace). */
  async applyInDirectory(directory, patch) {
    await this.withScratch(async (scratch) => {
      // An empty repository of our own: git never looks for one inside the workspace.
      const gitDir = join(scratch, 'apply.git');
      await mkdir(gitDir);
      await this.git(['init', '--quiet', '--bare'], { gitDir });
      await this.git(['apply', '--whitespace=nowarn', '-'], { gitDir, workTree: directory, input: patch });
    });
  }

  /** Apply patches on top of `base` as one commit and push it as `branch`. */
  async publish({ base, branch, patches, message }) {
    return this.withScratch(async (scratch) => {
      const { index } = await this.stage(scratch, base, patches);
      const tree = (await this.git(['write-tree'], { index })).trim();
      const sha = (await this.git(['commit-tree', tree, '-p', base, '-m', message])).trim();
      await this.git(['update-ref', `refs/heads/${branch}`, sha]);
      await this.git(['push', '--force', this.remote, `${sha}:refs/heads/${branch}`], { network: true });
      return sha;
    });
  }

  /**
   * Merge reviewed commits one by one on top of `parent`, without a working
   * tree. A change is merged by the commit that passed its gates, never by
   * whatever its branch points to now.
   * @param {{parent: string, changes: Array<{id: string, sha: string}>, ref: string}} input
   * @returns {Promise<{sha: string}|{conflict: string}>}
   */
  async buildCandidate({ parent, changes, ref }) {
    let tip = parent;
    for (const change of changes) {
      if (!SHA.test(change.sha)) throw new Error(`Change ${change.id} has no reviewed commit.`);
      const merged = await this.run(['merge-tree', '--write-tree', tip, change.sha]);
      if (merged.code === 1) return { conflict: change.id };
      if (merged.code !== 0) throw new Error(`git merge-tree failed for change ${change.id}: ${merged.stderr.trim()}`);
      const tree = merged.stdout.split('\n')[0].trim();
      tip = (await this.git(['commit-tree', tree, '-p', tip, '-p', change.sha, '-m', `Merge change ${change.id}`])).trim();
    }
    await this.git(['update-ref', `refs/heads/${ref}`, tip]);
    await this.git(['push', '--force', this.remote, `${tip}:refs/heads/${ref}`], { network: true });
    return { sha: tip };
  }

  /** Move the trunk to a tested candidate. Refuses anything but a fast-forward. */
  async fastForward(trunk, sha) {
    if (!(await this.isAncestor(await this.head(trunk), sha))) throw new Error(`Not a fast-forward: ${sha} does not descend from ${trunk}.`);
    await this.git(['push', this.remote, `${sha}:refs/heads/${trunk}`], { network: true });
    await this.git(['update-ref', `refs/heads/${trunk}`, sha]);
  }
}

/**
 * Create the bare mirror a zone works from and fetch every branch into it.
 * The fetch goes through GitVcs, so credentials never touch a command line.
 * @param {string} url
 * @param {string} directory
 * @param {{credentials?: (() => Promise<string>)|null, host?: string}} [options]
 */
export async function cloneMirror(url, directory, options = {}) {
  await mkdir(dirname(directory), { recursive: true });
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile('git', args, { env }, (error, _out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve()));
    });
  // Build beside the final place and move it in only when complete: an
  // interrupted start never leaves a half-made mirror that looks ready.
  const building = `${directory}.partial`;
  await rm(building, { recursive: true, force: true });
  await run(['init', '--quiet', '--bare', building]);
  await run(['--git-dir', building, 'remote', 'add', 'origin', url]);
  await new GitVcs({ mirror: building, ...options }).fetch();
  await rename(building, directory);
}
