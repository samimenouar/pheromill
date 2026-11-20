/**
 * Factory configuration: defaults, merge and validation. One JSON file per
 * repository (`pheromill.config.json`); secrets never appear in it, only the
 * names of the environment variables that hold them.
 */
import { validateEgress } from './egress-policy.js';
import { LEVELS } from './risk.js';

export const STEPS = ['read', 'specify', 'implement', 'review', 'refute', 'security_review', 'test_guard_review', 'arbitrate', 'audit'];
const GRADES = ['A', 'B', 'C'];
const PINNED_IMAGE = /^(?:[a-z0-9][\w./:-]*@)?sha256:[0-9a-f]{64}$/;

export function defaultConfig() {
  return {
    version: 1,
    project: { name: '', trunk: 'main' },
    forge: { kind: 'github', repository: '', requiredChecks: ['verify'], checksAppId: null, queueActor: null },
    paths: {
      reserved: ['pheromill.config.json', 'AGENTS.md', 'CLAUDE.md', '.github/**', '.gitlab-ci.yml', 'deploy/**', 'proofs/**', 'prompts/**'],
      core: [],
      manifests: ['package.json', '**/package.json', '.npmrc', '**/.npmrc', 'requirements*.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', '.gitattributes', '**/.gitattributes', '.gitmodules', '.gitignore', '**/.gitignore'],
      tests: ['test/**', 'tests/**', '**/*.test.*', '**/*.spec.*'],
      holdout: ['holdout/**'],
      queueOwned: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
      snapshots: ['**/__snapshots__/**', '**/*.snap'],
      thresholds: [],
      production: ['src/**', 'app/**', 'public/**'],
    },
    limits: { maxChangedLines: 500, midFlightChangedLines: 400, minPoints: 1, maxPoints: 5 },
    budget: {
      commits: 15,
      comments: 25,
      fixRounds: 2,
      externalToolPasses: 1,
      ciRuns: 4,
      sandboxSecondsPerPoint: 1800,
      tokensPerPoint: null,
      alertRatio: 0.8,
    },
    scheduling: { maxParallelTickets: 4, featuresPerDebtTicket: 4, maxReworks: 2 },
    milestone: { name: '', frozen: false },
    queue: { batchSize: 4, maxParallelChecks: 2, flakyRetries: 1 },
    dependencies: {
      requestFile: 'dependency-request.json',
      minVersionAgeDays: 7,
      minPackageAgeDays: 90,
      minVersions: 5,
      licenses: ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'],
      allowedInstallScripts: [],
    },
    sandbox: { user: '10001:10001', cpus: 2, memoryMb: 4096, pids: 512, tmpMb: 512 },
    providers: {},
    harnesses: {},
    routing: [],
    egress: {},
    autonomy: { tier: 0, promotion: [{}, {}, {}] },
    architecture: { layers: [] },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Deep merge: objects merge key by key, everything else is replaced. */
export function mergeConfig(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    result[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeConfig(base[key], value) : value;
  }
  return result;
}

function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isInteger(value) && value > 0 && value <= max;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Paths every repository must reserve: the rules themselves. */
const ALWAYS_RESERVED = ['pheromill.config.json', 'AGENTS.md'];

/**
 * @param {ReturnType<typeof defaultConfig>} config merged configuration
 * @returns {string[]} problems; empty when the configuration is valid
 */
export function validateConfig(config) {
  const problems = [];
  const need = (condition, message) => {
    if (!condition) problems.push(message);
  };

  const defaults = defaultConfig();
  for (const key of Object.keys(config)) need(Object.hasOwn(defaults, key), `Unknown setting "${key}".`);
  // Sections are objects, and a misspelt key inside one is an error, not a silent default.
  for (const section of ['project', 'forge', 'paths', 'limits', 'budget', 'scheduling', 'milestone', 'queue', 'dependencies', 'sandbox', 'autonomy', 'providers', 'harnesses', 'egress', 'architecture']) {
    if (!isPlainObject(config[section])) {
      problems.push(`${section} must be an object.`);
      continue;
    }
    if (['providers', 'harnesses', 'egress'].includes(section)) continue;
    for (const key of Object.keys(config[section])) need(Object.hasOwn(defaults[section], key), `Unknown setting "${section}.${key}".`);
  }
  if (problems.length > 0) return problems;
  need(config.version === 1, 'version must be 1.');
  need(typeof config.project?.name === 'string' && config.project.name !== '', 'project.name is required.');
  need(typeof config.project?.trunk === 'string' && config.project.trunk !== '', 'project.trunk is required.');
  need(['github', 'memory'].includes(config.forge?.kind), 'forge.kind must be a supported forge.');
  need(typeof config.forge?.repository === 'string' && config.forge.repository !== '', 'forge.repository is required.');
  const checks = config.forge?.requiredChecks;
  need(Array.isArray(checks) && checks.length > 0 && checks.every((name) => typeof name === 'string' && name.trim() !== ''), 'forge.requiredChecks must name at least one check: a change is never merged unproven.');
  need(config.forge?.checksAppId === null || positiveInteger(config.forge?.checksAppId), 'forge.checksAppId must be null or the numeric id of the app that reports the checks.');
  const actor = config.forge?.queueActor;
  need(actor === null || (positiveInteger(actor?.id) && typeof actor?.type === 'string'), 'forge.queueActor must be null or {id, type}: the identity allowed to fast-forward the trunk.');

  for (const [name, globs] of Object.entries(config.paths ?? {})) {
    need(Array.isArray(globs) && globs.every((glob) => typeof glob === 'string' && glob !== '' && !glob.endsWith('/') && !glob.startsWith('/') && !glob.startsWith('./')), `paths.${name} must be a list of globs without leading "/" or "./" and without trailing "/" (use "dir/**").`);
    // More than two wildcards in one path segment make matching explode.
    need(!Array.isArray(globs) || globs.every((glob) => String(glob).length <= 200 && String(glob).split('/').every((segment) => segment === '**' || (segment.match(/[*?]/g) ?? []).length <= 2)), `paths.${name}: at most two wildcards per path segment.`);
  }
  const reserved = Array.isArray(config.paths?.reserved) ? config.paths.reserved : [];
  for (const path of ALWAYS_RESERVED) need(reserved.includes(path), `paths.reserved must protect ${path}.`);
  need(Array.isArray(config.paths?.holdout) && config.paths.holdout.length > 0, 'paths.holdout must name where hidden scenarios live.');
  need(Array.isArray(config.paths?.tests) && config.paths.tests.length > 0, 'paths.tests must name where tests live: test protection depends on it.');
  for (const name of ['reserved', 'core', 'manifests', 'tests', 'holdout', 'queueOwned', 'snapshots', 'thresholds', 'production']) {
    need(Array.isArray(config.paths?.[name]), `paths.${name} is required.`);
  }

  const { limits, queue, scheduling, budget } = config;
  need(positiveInteger(limits?.maxChangedLines) && limits.maxChangedLines <= 500, 'limits.maxChangedLines must be between 1 and 500.');
  need(positiveInteger(limits?.midFlightChangedLines) && limits.midFlightChangedLines <= limits?.maxChangedLines, 'limits.midFlightChangedLines must not exceed limits.maxChangedLines.');
  need(positiveInteger(limits?.minPoints) && positiveInteger(limits?.maxPoints, 5) && limits.minPoints <= limits.maxPoints, 'limits points must satisfy 1 <= minPoints <= maxPoints <= 5.');
  need(positiveInteger(queue?.batchSize, 32) && positiveInteger(queue?.maxParallelChecks, 32), 'queue.batchSize and queue.maxParallelChecks must be integers from 1 to 32.');
  need(Number.isInteger(queue?.flakyRetries) && queue.flakyRetries >= 0 && queue.flakyRetries <= 2, 'queue.flakyRetries must be 0, 1 or 2.');
  need(positiveInteger(scheduling?.maxParallelTickets) && positiveInteger(scheduling?.featuresPerDebtTicket) && positiveInteger(scheduling?.maxReworks, 5), 'scheduling values must be positive integers (maxReworks at most 5).');
  need(typeof config.milestone?.name === 'string' && typeof config.milestone?.frozen === 'boolean', 'milestone must have a name and a frozen flag.');
  need(!config.milestone?.frozen || config.milestone.name !== '', 'A frozen milestone needs a name.');
  for (const key of ['commits', 'comments', 'externalToolPasses', 'ciRuns']) {
    need(positiveInteger(budget?.[key], 100), `budget.${key} must be an integer from 1 to 100.`);
  }
  need(positiveInteger(budget?.fixRounds, 3), 'budget.fixRounds must be 1, 2 or 3.');
  need(positiveNumber(budget?.sandboxSecondsPerPoint) && budget.sandboxSecondsPerPoint <= 86400, 'budget.sandboxSecondsPerPoint must be a number of seconds from 1 to 86400.');
  need(budget?.tokensPerPoint === null || positiveNumber(budget?.tokensPerPoint), 'budget.tokensPerPoint must be null (not calibrated) or a positive number.');
  need(typeof budget?.alertRatio === 'number' && budget.alertRatio > 0 && budget.alertRatio <= 1, 'budget.alertRatio must be in (0, 1].');
  const sandbox = config.sandbox;
  need(/^[1-9]\d*:[1-9]\d*$/.test(sandbox?.user ?? ''), 'sandbox.user must be a non-root uid:gid.');
  need(positiveNumber(sandbox?.cpus), 'sandbox.cpus must be a positive number.');
  for (const key of ['memoryMb', 'pids', 'tmpMb']) need(positiveInteger(sandbox?.[key]), `sandbox.${key} must be a positive integer.`);
  const deps = config.dependencies;
  need(typeof deps?.requestFile === 'string' && deps.requestFile !== '', 'dependencies.requestFile is required.');
  need(positiveNumber(deps?.minVersionAgeDays) && deps.minVersionAgeDays >= 7, 'dependencies.minVersionAgeDays must be at least 7.');
  need(positiveNumber(deps?.minPackageAgeDays) && positiveInteger(deps?.minVersions), 'dependencies.minPackageAgeDays and minVersions must be positive.');
  need(Array.isArray(deps?.licenses) && deps.licenses.every((name) => typeof name === 'string'), 'dependencies.licenses must be a list of license identifiers.');
  need(Array.isArray(deps?.allowedInstallScripts), 'dependencies.allowedInstallScripts must be a list.');

  for (const [name, entry] of Object.entries(config.providers ?? {})) {
    const provider = entry ?? {};
    need(/^https:\/\/[^/]+$/.test(String(provider.baseUrl ?? '')), `providers.${name}.baseUrl must be an https origin without a path.`);
    need(typeof provider.authHeader === 'string' && provider.authHeader !== '', `providers.${name}.authHeader is required.`);
    need(/^[A-Z][A-Z0-9_]*$/.test(String(provider.keyEnv ?? '')), `providers.${name}.keyEnv must name an environment variable; the key itself never goes in this file.`);
    need(Array.isArray(provider.paths) && provider.paths.length > 0 && provider.paths.every((path) => /^\/[\w./-]*$/.test(path) && !path.includes('..')), `providers.${name}.paths must list the API paths the gateway may forward.`);
  }
  for (const [name, entry] of Object.entries(config.harnesses ?? {})) {
    const harness = entry ?? {};
    need(typeof harness.family === 'string' && harness.family !== '', `harnesses.${name}.family is required.`);
    need(PINNED_IMAGE.test(String(harness.image ?? '')), `harnesses.${name}.image must be pinned by digest.`);
    need(Array.isArray(harness.command) && harness.command.length > 0 && harness.command.every((part) => typeof part === 'string') && !String(harness.command[0]).startsWith('-'), `harnesses.${name}.command must be a list of strings starting with a program.`);
    need(isPlainObject(harness.env ?? {}) && Object.keys(harness.env ?? {}).every((key) => /^[A-Z][A-Z0-9_]*$/.test(key)), `harnesses.${name}.env must map environment variable names to templates.`);
    need(typeof harness.provider === 'string' && Object.hasOwn(config.providers, harness.provider), `harnesses.${name}.provider must name a configured provider.`);
    need(isPlainObject(harness.env ?? {}) && Object.values(harness.env ?? {}).every((value) => typeof value === 'string'), `harnesses.${name}.env values must be strings.`);
    need(harness.tokens === undefined || (typeof harness.tokens?.file === 'string' && /^[\w.-]+$/.test(harness.tokens.file) && Array.isArray(harness.tokens?.fields) && harness.tokens.fields.every((field) => typeof field === 'string')), `harnesses.${name}.tokens must be {file, fields}.`);
  }
  need(Array.isArray(config.routing), 'routing must be a list.');
  (Array.isArray(config.routing) ? config.routing : []).forEach((entry, index) => {
    const route = entry ?? {};
    need(STEPS.includes(route.step), `routing[${index}].step is unknown.`);
    need(Array.isArray(route.levels) && route.levels.length > 0 && route.levels.every((level) => LEVELS.includes(level)), `routing[${index}].levels must list risk levels.`);
    need(typeof route.harness === 'string' && Object.hasOwn(config.harnesses, route.harness), `routing[${index}].harness must name a configured harness.`);
    need(typeof route.model === 'string' && route.model !== '', `routing[${index}].model is required.`);
    need(GRADES.includes(route.grade), `routing[${index}].grade must be A, B or C.`);
  });
  problems.push(...validateEgress(config.egress ?? {}));

  const tier = config.autonomy?.tier;
  need(Number.isInteger(tier) && tier >= 0 && tier <= LEVELS.length, 'autonomy.tier must be 0, 1, 2 or 3.');
  need(Array.isArray(config.autonomy?.promotion) && config.autonomy.promotion.length === LEVELS.length, 'autonomy.promotion must define thresholds for tiers 1, 2 and 3.');
  return problems;
}

/**
 * What still prevents the factory from working tickets, beyond validity.
 * @returns {string[]}
 */
export function readiness(config) {
  const gaps = [];
  const familyCount = new Set(Object.values(config.harnesses).map((harness) => harness.family)).size;
  if (familyCount === 0) gaps.push('No harness is configured: the factory cannot run any agent step.');
  else if (familyCount === 1) gaps.push('Only one model family is configured: independent review is impossible, so nothing can merge without the owner.');
  for (const step of ['specify', 'implement', 'review', 'refute', 'security_review', 'test_guard_review']) {
    if (!config.routing.some((route) => route.step === step)) gaps.push(`No route is defined for the "${step}" step.`);
  }
  if (config.routing.length > 0 && config.routing.every((route) => route.grade === 'C')) {
    gaps.push('Every route has grade C: run the reference set to earn grade B before working real tickets.');
  }
  if (config.forge.queueActor === null) gaps.push('forge.queueActor is not set: under the trunk ruleset the merge queue cannot fast-forward the trunk.');
  if (config.autonomy.tier > 0 && Object.keys(config.autonomy.promotion[config.autonomy.tier - 1] ?? {}).length === 0) {
    gaps.push('The current autonomy tier has no promotion thresholds: it was not earned on measurements.');
  }
  return gaps;
}
