/**
 * Job spool between the zones. The control zone drops a job file; the
 * execution zone answers with a result file. Files are the whole protocol
 * for work, so the zones share no credential, no socket and no code path.
 *
 * Every submission has its own random nonce, and its two files are named
 * after it: reading, answering or cleaning up one submission can never touch
 * another, even one with the same run identifier.
 *
 * Whatever comes back is data. The control zone reads it defensively and runs
 * it through the same gates, so a compromised execution zone gains no right
 * to write.
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readUntrustedJson } from './files.js';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FILE = /^([a-z0-9][a-z0-9-]{0,62})\.([0-9a-f]{32})\.json$/;
const MAX_BYTES = 16 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write through a temporary file with an unpredictable name that must not exist yet. */
async function writeAtomic(path, text) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

/** The two spool directories, which must be real directories: a link planted by the other side is refused. */
async function directories(spool) {
  const paths = { jobs: join(spool, 'jobs'), results: join(spool, 'results') };
  for (const path of Object.values(paths)) {
    await mkdir(path, { recursive: true });
    if (!(await lstat(path)).isDirectory()) throw new Error(`Spool path is not a directory: ${path}`);
  }
  return paths;
}

/** StepRunner port for the control zone. */
export class SpoolClient {
  /** @param {{spool: string, pollMs?: number, timeoutMs?: number}} options */
  constructor(options) {
    this.spool = options.spool;
    this.pollMs = options.pollMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 2 * 60 * 60 * 1000;
  }

  async run(job) {
    if (!SAFE_ID.test(job.runId)) throw new Error(`Invalid run identifier: ${job.runId}`);
    const nonce = randomBytes(16).toString('hex');
    const text = JSON.stringify({ ...job, nonce });
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`Step ${job.runId} is too large to submit.`);
    const { jobs, results } = await directories(this.spool);
    // Earlier submissions under this identifier (before a restart) are withdrawn.
    for (const directory of [jobs, results]) {
      for (const name of await readdir(directory)) {
        if (FILE.exec(name)?.[1] === job.runId) await rm(join(directory, name), { force: true });
      }
    }
    const name = `${job.runId}.${nonce}.json`;
    await writeAtomic(join(jobs, name), text);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const result = await readUntrustedJson(join(results, name), MAX_BYTES);
      if (result) {
        await rm(join(results, name), { force: true });
        if (typeof result.error === 'string') throw new Error(`Step ${job.runId} failed in the execution zone: ${result.error.slice(0, 500)}`);
        return {
          patch: typeof result.patch === 'string' ? result.patch : '',
          report: result.report !== null && typeof result.report === 'object' && !Array.isArray(result.report) ? result.report : {},
          seconds: typeof result.seconds === 'number' && result.seconds >= 0 ? result.seconds : 0,
          tokens: typeof result.tokens === 'number' && result.tokens >= 0 ? result.tokens : null,
        };
      }
      if (Date.now() >= deadline) {
        await rm(join(jobs, name), { force: true });
        throw new Error(`Step ${job.runId} got no answer from the execution zone.`);
      }
      await sleep(this.pollMs);
    }
  }
}

/**
 * Serve jobs in the execution zone.
 * @param {{spool: string, runner: {run: (job: object) => Promise<object>}, pollMs?: number,
 *   signal?: AbortSignal, prepare?: (job: object) => Promise<void>, onError?: (error: Error) => void}} options
 */
export async function serveSpool(options) {
  const { jobs, results } = await directories(options.spool);
  const inFlight = new Set();
  const abandoned = new Set();
  let fatal = null;

  const serve = async (name, runId) => {
    let result;
    try {
      const job = await readUntrustedJson(join(jobs, name), MAX_BYTES);
      if (!job || job.runId !== runId) throw new Error('Job file is unreadable, too large, or does not match its name.');
      await options.prepare?.(job);
      result = await options.runner.run(job);
    } catch (error) {
      result = { error: error.message };
      if (error.fatal) fatal = error; // answer this job, then stop serving
    }
    let text = JSON.stringify(result);
    if (Buffer.byteLength(text) > MAX_BYTES) text = JSON.stringify({ error: 'The step produced more output than the spool carries.' });
    await writeAtomic(join(results, name), text);
    await rm(join(jobs, name), { force: true });
  };

  while (!options.signal?.aborted) {
    // An execution zone that lost control of a sandbox takes no new job: it stops, and is swept when it starts again.
    if (fatal && inFlight.size === 0) throw fatal;
    for (const name of fatal ? [] : await readdir(jobs)) {
      const match = FILE.exec(name);
      if (!match || inFlight.has(name) || abandoned.has(name)) continue;
      inFlight.add(name);
      serve(name, match[1])
        .catch((error) => {
          abandoned.add(name); // could not even answer: do not spin on it
          options.onError?.(error);
        })
        .finally(() => inFlight.delete(name));
    }
    await sleep(options.pollMs ?? 1000);
  }
}
