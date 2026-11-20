/**
 * Command line. Every command is a thin layer over the domain: it reads
 * files, calls pure functions, prints the result and returns an exit code.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, loadConfig, trackedFiles } from '../adapters/files.js';
import { GitHubForge } from '../adapters/github.js';
import { readiness } from '../domain/config.js';
import { diffStats, parseUnifiedDiff } from '../domain/diff.js';
import { findLayerViolations, findNonEnglish, findProvisional, findSecrets } from '../domain/hygiene.js';
import { head, verifyChain } from '../domain/ledger.js';
import { computeDora, computeDoraBy } from '../domain/metrics.js';
import { checkPatch } from '../domain/patch-policy.js';
import { renderStatus, validateRegistry } from '../domain/proofs.js';
import { classifyRisk } from '../domain/risk.js';
import { desiredSettings, planSettings } from '../domain/settings.js';
import { detectWeakening } from '../domain/test-guard.js';
import { demo } from './demo.js';
import { serve } from './serve.js';

const HOME = fileURLToPath(new URL('../../', import.meta.url));

const USAGE = `pheromill <command>

  init [dir] [--name N] [--repository owner/repo]   start a repository from the template
  doctor [dir] [--strict]                           is the configuration valid, and what is still missing
  check [dir] [--production]                        English-only, secrets, provisional data, layers
  risk <patch|-> [--gate]                           risk level and patch gate for a diff
  proofs check | render [--check]                   validate the proof registry / write docs/status.md
  ledger verify <file>                              verify a hash-chained ledger
  metrics dora --deliveries F --changes F --from D --to D [--environment E]
  settings plan [--offline] | apply                 repository settings as code
  demo                                              run the pipeline on in-memory adapters
  serve control | runner | egress                   long-running services (see docs/operations.md)
`;

/** Flags that never take a value: the word after them is an operand. */
const SWITCHES = ['strict', 'production', 'gate', 'check', 'offline'];

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i].slice(2);
    if (!args[i].startsWith('--')) positional.push(args[i]);
    else if (SWITCHES.includes(name) || args[i + 1] === undefined || args[i + 1].startsWith('--')) flags[name] = true;
    else flags[name] = args[(i += 1)];
  }
  return { flags, positional };
}

const jsonLines = async (path) => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const exists = (path) => stat(path).then(() => true, () => false);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)])));
  return nested.flat();
}

const commands = {
  async init({ positional, flags }, io) {
    const target = resolve(io.cwd, positional[0] ?? '.');
    const template = join(HOME, 'template');
    for (const source of await walk(template)) {
      const path = relative(template, source);
      const destination = join(target, path);
      if (await exists(destination)) {
        io.out(`kept     ${path}`);
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      if (path === CONFIG_FILE) {
        const config = JSON.parse(await readFile(source, 'utf8'));
        if (typeof flags.name === 'string') config.project.name = flags.name;
        if (typeof flags.repository === 'string') config.forge.repository = flags.repository;
        await writeFile(destination, `${JSON.stringify(config, null, 2)}\n`);
      } else {
        await cp(source, destination);
      }
      io.out(`created  ${path}`);
    }
    io.out('\nNext: run "pheromill doctor" to see what is still missing.');
    return 0;
  },

  async doctor({ positional, flags }, io) {
    const directory = resolve(io.cwd, positional[0] ?? '.');
    let config;
    try {
      config = await loadConfig(directory);
    } catch (error) {
      io.err(error.message);
      return 1;
    }
    io.out(`Configuration: valid (${config.project.name}, trunk "${config.project.trunk}", autonomy tier ${config.autonomy.tier}).`);
    const gaps = readiness(config);
    for (const [name, provider] of Object.entries(config.providers)) {
      if (!io.env[provider.keyEnv]) gaps.push(`Environment variable ${provider.keyEnv} (provider "${name}") is not set here. It belongs to the egress service only.`);
    }
    try {
      const [major, minor] = /(\d+)\.(\d+)/.exec(execFileSync('git', ['--version'], { encoding: 'utf8' })).slice(1).map(Number);
      if (major < 2 || (major === 2 && minor < 38)) gaps.push('git 2.38 or newer is required (merge-tree --write-tree).');
    } catch {
      gaps.push('git is not installed.');
    }
    if (gaps.length === 0) io.out('Ready: nothing is missing.');
    else io.out(`Not ready yet:\n${gaps.map((gap) => `- ${gap}`).join('\n')}`);
    return flags.strict && gaps.length > 0 ? 1 : 0;
  },

  async check({ positional, flags }, io) {
    const directory = resolve(io.cwd, positional[0] ?? '.');
    const config = await loadConfig(directory);
    const files = await trackedFiles(directory).catch(() => {
      throw new Error(`${directory} is not a git repository: only tracked files are checked.`);
    });
    const provisional = findProvisional(files, config.paths.production);
    const problems = [
      ...findNonEnglish(files).map((hit) => `${hit.path}:${hit.line} non-English text: ${hit.excerpt}`),
      ...findSecrets(files).map((hit) => `${hit.path}:${hit.line} possible secret (${hit.kind})`),
      ...findLayerViolations(files, config.architecture.layers).map((v) => `${v.path} imports ${v.imports}: ${v.rule}`),
      ...provisional.filter((item) => flags.production && item.blocksProduction).map((item) => `${item.path}:${item.line} provisional information in a production path (${item.id})`),
    ];
    for (const item of provisional) io.out(`provisional  ${item.id}  ${item.path}:${item.line}  ${item.note}`);
    if (problems.length > 0) {
      io.err(problems.join('\n'));
      return 1;
    }
    io.out(`Checked ${files.length} files: English only, no secret, layers respected, ${provisional.length} provisional item(s).`);
    return 0;
  },

  async risk({ positional, flags }, io) {
    const text = positional[0] === '-' ? await io.stdin() : await readFile(resolve(io.cwd, positional[0] ?? ''), 'utf8');
    const config = await loadConfig(io.cwd);
    const files = parseUnifiedDiff(text);
    const weakening = detectWeakening(files, config);
    const dependencyRequest = files.some((file) => file.path === config.dependencies.requestFile);
    const gate = checkPatch(files, config);
    io.out(JSON.stringify({ ...classifyRisk(files, config, { weakeningSignals: weakening, dependencyRequest }), stats: diffStats(files), weakening, gate }, null, 2));
    return flags.gate && !gate.ok ? 1 : 0;
  },

  async proofs({ positional, flags }, io) {
    const registry = JSON.parse(await readFile(join(io.cwd, 'proofs/registry.json'), 'utf8'));
    const contents = new Map();
    for (const claim of registry.claims ?? []) {
      for (const item of claim.evidence ?? []) {
        if (!contents.has(item.file)) contents.set(item.file, await readFile(join(io.cwd, item.file), 'utf8').catch(() => null));
      }
    }
    const problems = validateRegistry(registry, (path) => contents.get(path) ?? null);
    if (problems.length > 0) {
      io.err(problems.join('\n'));
      return 1;
    }
    if (positional[0] === 'render') {
      const page = renderStatus(registry);
      const path = join(io.cwd, 'docs/status.md');
      if (flags.check) {
        if ((await readFile(path, 'utf8').catch(() => '')) !== page) {
          io.err('docs/status.md is out of date: run "pheromill proofs render".');
          return 1;
        }
      } else {
        await writeFile(path, page);
      }
    }
    io.out(`Proof registry: ${registry.claims.length} claims, consistent.`);
    return 0;
  },

  async ledger({ positional }, io) {
    if (positional[0] !== 'verify' || !positional[1]) throw new Error('Usage: pheromill ledger verify <file>');
    const entries = await jsonLines(resolve(io.cwd, positional[1]));
    const result = verifyChain(entries);
    const { seq, hash } = head(entries);
    io.out(result.valid ? `Ledger chain is intact. Head: entry ${seq}, hash ${hash}.` : `Ledger chain is broken at entry ${result.brokenAt}.`);
    if (result.valid) io.out('Compare the head with a copy kept outside this host: a cut or rebuilt file cannot be detected from the file alone.');
    return result.valid ? 0 : 1;
  },

  async metrics({ flags }, io) {
    for (const name of ['deliveries', 'changes', 'from', 'to']) {
      if (typeof flags[name] !== 'string') throw new Error(`--${name} is required.`);
    }
    if (Number.isNaN(Date.parse(flags.from)) || Number.isNaN(Date.parse(flags.to))) throw new Error('--from and --to must be dates.');
    const deliveries = await jsonLines(resolve(io.cwd, flags.deliveries));
    const changes = await jsonLines(resolve(io.cwd, flags.changes));
    const window = { environment: flags.environment ?? 'production', from: flags.from, to: flags.to };
    io.out(JSON.stringify({
      window,
      overall: computeDora(deliveries, changes, window),
      byAgent: computeDoraBy(deliveries, changes, window, 'agent'),
      byLevel: computeDoraBy(deliveries, changes, window, 'level'),
    }, null, 2));
    return 0;
  },

  async settings({ positional, flags }, io) {
    const config = await loadConfig(io.cwd);
    const desired = desiredSettings(config);
    if (flags.offline) {
      io.out(JSON.stringify(desired, null, 2));
      return 0;
    }
    const token = io.env.PHEROMILL_FORGE_TOKEN;
    if (!token) {
      io.err('PHEROMILL_FORGE_TOKEN is required (or use --offline to print the desired state).');
      return 1;
    }
    const forge = new GitHubForge({ repository: config.forge.repository, trunk: config.project.trunk, token: async () => token, requiredChecks: config.forge.requiredChecks, checksAppId: config.forge.checksAppId, fetch: io.fetch });
    const operations = planSettings(desired, await forge.readSettings());
    for (const operation of operations) {
      io.out(`${positional[0] === 'apply' ? 'apply' : 'plan '}  ${operation.op}  ${operation.target}`);
      if (positional[0] === 'apply') await forge.applySetting(operation);
    }
    if (operations.length === 0) io.out('Settings already match the desired state.');
    return 0;
  },

  demo: (_, io) => demo(io),
  serve: ({ positional }, io) => serve(positional[0], io),
};

/**
 * @param {string[]} argv arguments after the program name
 * @param {{out: (line: string) => void, err: (line: string) => void, env: Record<string, string|undefined>,
 *   cwd: string, stdin?: () => Promise<string>, fetch?: typeof fetch}} io
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io) {
  const [name, ...rest] = argv;
  const command = commands[name];
  if (!command) {
    io.out(USAGE);
    return name === undefined || name === 'help' || name === '--help' ? 0 : 2;
  }
  try {
    return await command(parseArgs(rest), io);
  } catch (error) {
    io.err(`pheromill ${name}: ${error.message}`);
    return 1;
  }
}
