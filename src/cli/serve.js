/**
 * Long-running services, one per trust zone. Each reads its settings from the
 * environment and holds only the secrets of its own zone:
 *
 *   control  forge credentials        no container daemon, no model key
 *   runner   container daemon access  no forge credential, no model key
 *   egress   model provider keys      no forge credential, no container daemon
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEgressProxy, createModelGateway } from '../adapters/egress.js';
import { CONFIG_FILE, FileLedger, JsonStore } from '../adapters/files.js';
import { cloneMirror, GitVcs } from '../adapters/git.js';
import { appTokenProvider, GitHubForge } from '../adapters/github.js';
import { NpmRegistry } from '../adapters/npm-registry.js';
import { DockerLauncher, SandboxRunner } from '../adapters/sandbox-runner.js';
import { serveSpool, SpoolClient } from '../adapters/spool.js';
import { dispatchTick } from '../application/dispatch.js';
import { queueTick } from '../application/process-queue.js';
import { defaultConfig, mergeConfig, validateConfig } from '../domain/config.js';
import { createQueue } from '../domain/merge-queue.js';

const PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(env, name) {
  if (!env[name]) throw new Error(`Environment variable ${name} is required.`);
  return env[name];
}

/** The configuration that counts is the one merged on the trunk, never a local checkout. */
async function trunkConfig(vcs, trunk) {
  const config = mergeConfig(defaultConfig(), JSON.parse(await vcs.readFile(trunk, CONFIG_FILE)));
  const problems = validateConfig(config);
  if (config.project?.trunk !== trunk) problems.push(`project.trunk is "${config.project?.trunk}" but the service follows "${trunk}" (PHEROMILL_TRUNK).`);
  if (problems.length > 0) throw new Error(`Invalid ${CONFIG_FILE} on ${trunk}:\n- ${problems.join('\n- ')}`);
  return config;
}

/** A read-only token for a private repository; public repositories need none. */
const readToken = (env) => (env.PHEROMILL_READ_TOKEN ? async () => env.PHEROMILL_READ_TOKEN : null);

async function mirror(env, credentials) {
  const repository = required(env, 'PHEROMILL_REPOSITORY');
  const directory = join(required(env, 'PHEROMILL_STATE_DIR'), 'mirror.git');
  const vcs = new GitVcs({ mirror: directory, credentials });
  if (!(await stat(directory).then(() => true, () => false))) await cloneMirror(`https://github.com/${repository}.git`, directory, { credentials });
  await vcs.fetch();
  return { vcs, repository, trunk: env.PHEROMILL_TRUNK ?? 'main' };
}

function forgeToken(env) {
  if (env.PHEROMILL_GITHUB_APP_ID) {
    return async (repository) =>
      appTokenProvider({
        appId: env.PHEROMILL_GITHUB_APP_ID,
        installationId: required(env, 'PHEROMILL_GITHUB_INSTALLATION_ID'),
        privateKey: await readFile(required(env, 'PHEROMILL_GITHUB_PRIVATE_KEY_FILE'), 'utf8'),
        repository,
        permissions: { contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read' },
      });
  }
  const token = required(env, 'PHEROMILL_FORGE_TOKEN');
  return async () => async () => token;
}

async function control(io) {
  const state = required(io.env, 'PHEROMILL_STATE_DIR');
  const token = await forgeToken(io.env)(required(io.env, 'PHEROMILL_REPOSITORY'));
  const { vcs, repository, trunk } = await mirror(io.env, token);
  const ledger = new FileLedger(join(state, 'ledger.jsonl'));
  const memory = { startedKinds: [], history: [] };
  const interval = Number(io.env.PHEROMILL_TICK_SECONDS ?? 30) * 1000;
  // One store and one spool client for the whole process: both loops must share
  // the same writer, or one would overwrite what the other just saved.
  const first = await trunkConfig(vcs, trunk);
  const store = new JsonStore(join(state, 'queue.json'), { queue: createQueue(first.queue), candidates: {}, changes: {}, awaiting: {} });
  const runner = new SpoolClient({ spool: join(state, 'spool') });
  const registry = new NpmRegistry();

  const ports = async () => {
    await vcs.fetch();
    const config = await trunkConfig(vcs, trunk);
    const forge = new GitHubForge({ repository, trunk, token, requiredChecks: config.forge.requiredChecks, checksAppId: config.forge.checksAppId });
    return { config, ports: { forge, checks: forge, vcs, ledger, store, registry, runner, clock: { now: () => new Date() } } };
  };

  // Red button: while this file exists, nothing is dispatched and nothing lands.
  const halted = () => stat(join(state, 'HALT')).then(() => true, () => false);

  const loop = async (name, tick) => {
    for (;;) {
      try {
        if (await halted()) io.err(`${name}: halted (remove ${join(state, 'HALT')} to resume)`);
        else await tick(await ports());
      } catch (error) {
        io.err(`${name}: ${error.message}`);
      }
      await sleep(interval);
    }
  };

  io.out(`control: ${repository}, trunk "${trunk}", state in ${state}`);
  await Promise.all([
    loop('dispatch', async ({ config, ports: p }) => {
      memory.history = (await ledger.entries()).filter((entry) => ['arbitration', 'ticket_outcome'].includes(entry.type)).map((entry) => ({ type: entry.type, ...entry.data }));
      const result = await dispatchTick(memory, config, p);
      if (result.started.length > 0) io.out(`dispatch: ${JSON.stringify(result.outcomes)}`);
    }),
    loop('queue', ({ config, ports: p }) => p.store.update((current) => queueTick({ ...current, queue: { ...current.queue, config: config.queue } }, config, p))),
  ]);
  return 0;
}

async function runner(io) {
  const state = required(io.env, 'PHEROMILL_STATE_DIR');
  const [uid, gid] = [process.getuid?.(), process.getgid?.()];
  const { vcs, trunk } = await mirror(io.env, readToken(io.env));
  const sandboxRunner = new SandboxRunner({
    config: await trunkConfig(vcs, trunk),
    vcs,
    launcher: new DockerLauncher(),
    workRoot: join(state, 'work'),
    grants: join(state, 'grants'),
    prompts: PROMPTS,
    clock: { now: () => new Date() },
    endpoints: { proxy: io.env.PHEROMILL_PROXY ?? 'egress:3128', gateway: io.env.PHEROMILL_GATEWAY ?? 'http://egress:3129' },
    network: io.env.PHEROMILL_SANDBOX_NETWORK ?? 'pheromill-sandbox',
  });
  if (`${uid}:${gid}` !== sandboxRunner.config.sandbox.user) {
    throw new Error(`The runner must run as sandbox.user (${sandboxRunner.config.sandbox.user}); it runs as ${uid}:${gid}.`);
  }
  io.out(`runner: serving ${join(state, 'spool')}`);
  await serveSpool({
    spool: join(state, 'spool'),
    runner: sandboxRunner,
    onError: (error) => io.err(`runner: ${error.message}`),
    prepare: async () => {
      await vcs.fetch();
      sandboxRunner.config = await trunkConfig(vcs, trunk);
    },
  });
  return 0;
}

async function egress(io) {
  const state = required(io.env, 'PHEROMILL_STATE_DIR');
  const { vcs, trunk } = await mirror(io.env, readToken(io.env));
  const config = await trunkConfig(vcs, trunk);
  const ledger = new FileLedger(join(state, 'egress.jsonl'));
  const report = (event) => ledger.append(event.type, event).catch((error) => io.err(`egress ledger: ${error.message}`));
  const grants = join(state, 'grants');
  const host = io.env.PHEROMILL_BIND ?? '0.0.0.0';
  createEgressProxy({ egress: config.egress, grants, report }).listen(Number(io.env.PHEROMILL_PROXY_PORT ?? 3128), host);
  createModelGateway({ providers: config.providers, grants, env: io.env, report }).listen(Number(io.env.PHEROMILL_GATEWAY_PORT ?? 3129), host);
  io.out(`egress: proxy and model gateway listening; configuration read from ${trunk} at start (restart to apply changes)`);
  return new Promise(() => {});
}

/** @param {string|undefined} service */
export async function serve(service, io) {
  const services = { control, runner, egress };
  if (!services[service]) throw new Error('Usage: pheromill serve control | runner | egress');
  return services[service](io);
}
