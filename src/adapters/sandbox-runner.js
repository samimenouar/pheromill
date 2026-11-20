/**
 * Step runner for the execution zone. One job, one fresh workspace, one fresh
 * container, one short-lived grant. The runner itself holds no forge
 * credential and no model key.
 *
 * The runner process must run under the same uid:gid as `sandbox.user`, so
 * that the sandbox can write its workspace and the runner can destroy it.
 */
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSandboxSpec } from '../domain/sandbox-spec.js';
import { issueGrant, revokeGrant } from './egress.js';
import { readUntrustedJson } from './files.js';

const ROLE_OF_STEP = { read: 'reader', specify: 'author', implement: 'author' };
const MAX_REPORT_BYTES = 1024 * 1024;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const STEP = /^[a-z][a-z_]{0,30}$/;
const MAX_KILL_ATTEMPTS = 120;

/** Remove a directory even if a step left entries the runner cannot traverse. */
async function forceRemove(directory) {
  const open = async (path) => {
    await chmod(path, 0o700).catch(() => {});
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isDirectory()) await open(join(path, entry.name));
  };
  await rm(directory, { recursive: true, force: true }).catch(async () => {
    await open(directory);
    await rm(directory, { recursive: true, force: true });
  });
}

/** The role decides network access; every reviewing step shares one. */
export function roleOf(step) {
  return ROLE_OF_STEP[step] ?? 'reviewer';
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name) => (name in values ? values[name] : whole));
}

function pick(object, path) {
  return path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

/** Launches a sandbox specification with Docker and enforces its time limit. */
export class DockerLauncher {
  constructor(binary = 'docker') {
    this.binary = binary;
  }

  /** @param {ReturnType<typeof buildSandboxSpec>} spec */
  launch(spec) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(this.binary, spec.args, { env: { PATH: process.env.PATH, ...spec.env }, stdio: 'ignore' });
      let timedOut = false;
      let killer = null;
      let attempts = 0;
      let killing = false;
      // Kill again every second until the container is gone: the first kill can
      // arrive before the container exists. One attempt at a time, and a bounded
      // number of them: a daemon that stopped answering is reported, not waited for.
      const kill = () => {
        if (killing) return;
        if ((attempts += 1) > MAX_KILL_ATTEMPTS) {
          stop();
          reject(new Error(`Sandbox ${spec.name} could not be stopped: the container runtime does not answer.`));
          return;
        }
        killing = true;
        const done = () => {
          killing = false;
        };
        spawn(this.binary, ['kill', spec.name], { stdio: 'ignore' }).on('error', done).on('close', done);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
        killer = setInterval(kill, 1000);
      }, spec.timeoutMs);
      const stop = () => {
        clearTimeout(timer);
        clearInterval(killer);
      };
      child.on('error', (error) => {
        stop();
        reject(error);
      });
      child.on('close', (exitCode) => {
        stop();
        resolve({ exitCode, timedOut, seconds: (Date.now() - started) / 1000 });
      });
    });
  }

  /** Remove every sandbox a previous runner process left behind. */
  sweep() {
    return new Promise((resolve) => {
      execFile(this.binary, ['ps', '--all', '--quiet', '--filter', 'label=pheromill.sandbox=true'], (error, stdout) => {
        const ids = error ? [] : stdout.split('\n').filter(Boolean);
        if (ids.length === 0) resolve(0);
        else execFile(this.binary, ['rm', '--force', ...ids], () => resolve(ids.length));
      });
    });
  }
}

export class SandboxRunner {
  /**
   * @param {{config: object, vcs: import('./git.js').GitVcs, launcher: {launch: Function},
   *   workRoot: string, grants: string, prompts: string, clock: {now: () => Date},
   *   endpoints: {proxy: string, gateway: string}, network: string|null}} options
   *   `endpoints.proxy` is host:port of the egress proxy, `endpoints.gateway` the gateway URL,
   *   both as seen from inside the sandbox network.
   */
  constructor(options) {
    Object.assign(this, options);
  }

  async run(job) {
    if (!SAFE_ID.test(String(job.runId)) || !STEP.test(String(job.step))) throw new Error('Invalid run or step identifier.');
    const { config } = this;
    const harness = Object.hasOwn(config.harnesses, job.route?.harness) ? config.harnesses[job.route.harness] : null;
    // The control zone checked independence on this family: refuse to launch anything else under that name.
    if (!harness || harness.family !== job.route.family) throw new Error(`Harness "${job.route?.harness}" is not the ${job.route?.family} harness this job was routed to.`);
    const role = roleOf(job.step);
    const root = join(this.workRoot, job.runId);
    const [workspace, input, output] = ['workspace', 'in', 'out'].map((name) => join(root, name));
    await forceRemove(root);
    let token = null;
    try {
      await Promise.all([input, output].map((directory) => mkdir(directory, { recursive: true })));

      // Workspace: the base tree, minus hidden paths, plus the change under review or the previous attempt.
      await this.vcs.exportTree(job.base, workspace, job.hidePaths);
      for (const patch of job.patches) await this.vcs.applyInDirectory(workspace, patch);
      // Reviewing steps also get the change as a diff; author steps get it applied only.
      if (job.readOnly) await writeFile(join(input, 'change.patch'), job.patches.join('\n'));

      const prompt = await readFile(join(this.prompts, `${job.step}.md`), 'utf8');
      await writeFile(join(input, 'prompt.md'), `${prompt}\n\n## Input\n\n\`\`\`json\n${JSON.stringify(job.input, null, 2)}\n\`\`\`\n`);

      const seconds = config.budget.sandboxSecondsPerPoint;
      token = await issueGrant(this.grants, { role, runId: job.runId, provider: harness.provider, ttlSeconds: seconds + 60 }, this.clock.now());
      const values = { token, model: job.route.model, gateway: `${this.endpoints.gateway}/${harness.provider}` };
      const env = { HOME: '/tmp', PHEROMILL_STEP: job.step, PHEROMILL_MODEL: job.route.model };
      for (const [key, template] of Object.entries(harness.env ?? {})) env[key] = fill(template, values);
      if (config.egress[role]) env.HTTPS_PROXY = `http://step:${token}@${this.endpoints.proxy}`;

      const spec = buildSandboxSpec({
        runId: job.runId,
        step: job.step.replaceAll('_', '-'),
        image: harness.image,
        command: harness.command,
        env,
        allowedEnv: ['HOME', 'HTTPS_PROXY', 'PHEROMILL_STEP', 'PHEROMILL_MODEL', ...Object.keys(harness.env ?? {})],
        mounts: [
          { source: workspace, target: '/workspace', readOnly: job.readOnly },
          { source: input, target: '/in', readOnly: true },
          { source: output, target: '/out', readOnly: false },
        ],
        network: this.network,
        limits: { cpus: config.sandbox.cpus, memoryMb: config.sandbox.memoryMb, pids: config.sandbox.pids, tmpMb: config.sandbox.tmpMb, seconds },
        user: config.sandbox.user,
      });
      const result = await this.launcher.launch(spec);
      await revokeGrant(this.grants, token);
      token = null;

      const report = (await readUntrustedJson(join(output, 'report.json'), MAX_REPORT_BYTES)) ?? {};
      const usage = harness.tokens ? await readUntrustedJson(join(output, harness.tokens.file), MAX_REPORT_BYTES) : null;
      const counts = usage ? harness.tokens.fields.map((field) => pick(usage, field)) : [];
      const tokens = counts.length > 0 && counts.every((count) => typeof count === 'number') ? counts.reduce((x, y) => x + y, 0) : null;
      const patch = job.readOnly ? '' : await this.vcs.collectPatch(job.base, workspace, job.hidePaths);
      const failure = result.timedOut ? 'timeout' : result.exitCode !== 0 ? `exit_${result.exitCode}` : null;
      return { patch, report: failure ? { ...report, error: failure } : report, seconds: result.seconds, tokens };
    } finally {
      // Whatever happened, the step's token and workspace do not outlive it.
      if (token) await revokeGrant(this.grants, token).catch(() => {});
      await forceRemove(root).catch(() => {});
    }
  }
}
