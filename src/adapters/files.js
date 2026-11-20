/**
 * File-backed adapters: configuration, the hash-chained ledger, the queue
 * store and repository file listing. Plain files, readable without tooling.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, readFile, rename, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfig, mergeConfig, validateConfig } from '../domain/config.js';
import { chainEntry } from '../domain/ledger.js';

export const CONFIG_FILE = 'pheromill.config.json';

/** Load and validate the configuration of a repository. Throws with every problem listed. */
export async function loadConfig(directory) {
  const raw = JSON.parse(await readFile(join(directory, CONFIG_FILE), 'utf8'));
  const config = mergeConfig(defaultConfig(), raw);
  const problems = validateConfig(config);
  if (problems.length > 0) throw new Error(`Invalid ${CONFIG_FILE}:\n- ${problems.join('\n- ')}`);
  return config;
}

/**
 * Read a JSON object from a file written by a less trusted party. The file is
 * opened without following a symbolic link and without blocking on a pipe or
 * a device; it must be a regular file no larger than `maxBytes`.
 * @returns {Promise<object|null>} the object, or null for anything else
 */
export async function readUntrustedJson(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    const parsed = JSON.parse(buffer.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

async function readLines(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  // A record is complete only once its newline is written: a torn last line is not an entry.
  const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  return complete.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

/** Cut a torn last record (a write interrupted by a full disk or a crash) before appending. */
async function repairTail(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return;
  }
  const end = text.lastIndexOf('\n') + 1;
  if (end !== text.length) await truncate(path, Buffer.byteLength(text.slice(0, end)));
}

/** Append-only JSON Lines ledger where each entry commits to the previous one. */
export class FileLedger {
  /** @param {string} path @param {{now: () => Date}} [clock] */
  constructor(path, clock = { now: () => new Date() }) {
    this.path = path;
    this.clock = clock;
    this.last = undefined;
    this.pending = Promise.resolve();
  }

  entries() {
    return readLines(this.path);
  }

  append(type, data) {
    return this.enqueue(() => this.write(type, data));
  }

  /**
   * Append unless an entry of this type with the same identity exists. Makes
   * a replayed operation leave one trace, not two.
   */
  appendOnce(type, identity, data) {
    return this.enqueue(async () => {
      const exists = (await this.entries()).some((entry) => entry.type === type && entry.data?.identity === identity);
      if (!exists) await this.write(type, { ...data, identity });
    });
  }

  /** One operation at a time, so that concurrent appends cannot fork the chain. */
  enqueue(operation) {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }

  async write(type, data) {
    try {
      if (this.last === undefined) {
        await repairTail(this.path);
        this.last = (await this.entries()).at(-1) ?? null;
      }
      const entry = chainEntry(this.last, type, data, this.clock.now().toISOString());
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(entry)}\n`);
      this.last = entry;
    } catch (error) {
      this.last = undefined; // read the file again next time: one failure must not poison the chain
      throw error;
    }
  }
}

/** A JSON document replaced atomically, with one writer at a time, for the queue state. */
export class JsonStore {
  constructor(path, fallback = null) {
    this.path = path;
    this.fallback = fallback;
    this.pending = Promise.resolve();
  }

  /** Apply `change(current)` and persist its result. Updates never interleave. */
  update(change) {
    const next = this.pending.then(async () => {
      const value = await change(await this.read(this.fallback));
      await this.write(value);
      return value;
    });
    this.pending = next.catch(() => {});
    return next;
  }

  async read(fallback) {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async write(value) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(`${this.path}.tmp`, JSON.stringify(value, null, 2));
    await rename(`${this.path}.tmp`, this.path);
  }
}

/** Text files tracked by git in `directory`, as `{path, content}`. Binary files are skipped. */
export async function trackedFiles(directory) {
  const listing = await new Promise((resolve, reject) => {
    execFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: directory, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
  const files = [];
  for (const path of listing.split('\0').filter(Boolean)) {
    let buffer;
    try {
      // A tracked symbolic link is not opened: its target may be outside the checkout.
      if (!(await lstat(join(directory, path))).isFile()) continue;
      buffer = await readFile(join(directory, path));
    } catch {
      continue; // deleted in the working tree
    }
    if (!buffer.includes(0)) files.push({ path, content: buffer.toString('utf8') });
  }
  return files;
}
