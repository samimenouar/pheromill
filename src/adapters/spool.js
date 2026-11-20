/**
 * Job spool between the zones. The control zone drops a job file; the
 * execution zone answers with a result file. Files are the whole protocol
 * for work, so the zones share no credential, no socket and no code path.
 *
 * Whatever comes back is data. The control zone reads it defensively and runs
 * it through the same gates, so a compromised execution zone gains no right
 * to write.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readUntrustedJson } from './files.js';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_BYTES = 16 * 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write through a temporary file with an unpredictable name that must not exist yet. */
async function writeAtomic(path, value) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

async function directories(spool) {
  const paths = { jobs: join(spool, 'jobs'), results: join(spool, 'results') };
  await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));
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
    const { jobs, results } = await directories(this.spool);
    const answer = join(results, `${job.runId}.json`);
    // The nonce ties an answer to this submission: an answer to an earlier job
    // with the same identifier (before a restart) is discarded.
    const nonce = randomBytes(16).toString('hex');
    await rm(answer, { force: true });
    await rm(join(jobs, `${job.runId}.json`), { force: true });
    await writeAtomic(join(jobs, `${job.runId}.json`), { ...job, nonce });
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const result = await readUntrustedJson(answer, MAX_BYTES);
      if (result) {
        await rm(answer, { force: true });
        if (result.nonce === nonce) {
          if (typeof result.error === 'string') throw new Error(`Step ${job.runId} failed in the execution zone: ${result.error.slice(0, 500)}`);
          return {
            patch: typeof result.patch === 'string' ? result.patch : '',
            report: result.report !== null && typeof result.report === 'object' && !Array.isArray(result.report) ? result.report : {},
            seconds: typeof result.seconds === 'number' && result.seconds >= 0 ? result.seconds : 0,
            tokens: typeof result.tokens === 'number' && result.tokens >= 0 ? result.tokens : null,
          };
        }
      }
      if (Date.now() >= deadline) throw new Error(`Step ${job.runId} got no answer from the execution zone.`);
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

  const serve = async (name, runId) => {
    let result;
    let nonce = null;
    try {
      const job = await readUntrustedJson(join(jobs, name), MAX_BYTES);
      if (!job || job.runId !== runId) throw new Error('Job file is unreadable or does not match its name.');
      nonce = typeof job.nonce === 'string' ? job.nonce : null;
      await options.prepare?.(job);
      result = await options.runner.run(job);
    } catch (error) {
      result = { error: error.message };
    }
    await rm(join(results, name), { force: true });
    await writeAtomic(join(results, name), { ...result, nonce });
    // Remove the job only if it is still the one that was served: the control
    // zone may have submitted the same identifier again in the meantime.
    const current = await readUntrustedJson(join(jobs, name), MAX_BYTES);
    if (!current || current.nonce === nonce) await rm(join(jobs, name), { force: true });
  };

  while (!options.signal?.aborted) {
    for (const name of (await readdir(jobs)).filter((entry) => entry.endsWith('.json'))) {
      const runId = name.slice(0, -5);
      if (inFlight.has(runId) || !SAFE_ID.test(runId)) continue;
      inFlight.add(runId);
      serve(name, runId)
        .catch((error) => options.onError?.(error))
        .finally(() => inFlight.delete(runId));
    }
    await sleep(options.pollMs ?? 1000);
  }
}
