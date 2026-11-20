import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDependency, parseDependencyRequest } from '../../src/domain/dependency-gate.js';
import { decideEgress, isPrivateAddress, validateEgress } from '../../src/domain/egress-policy.js';
import { findLayerViolations, findNonEnglish, findProvisional, findSecrets } from '../../src/domain/hygiene.js';
import { chainEntry, head, verifyChain } from '../../src/domain/ledger.js';
import { assertIndependentReview, families, selectRoute } from '../../src/domain/routing.js';
import { buildSandboxSpec, SandboxSpecError } from '../../src/domain/sandbox-spec.js';

const IMAGE = `registry.example/harness@sha256:${'a'.repeat(64)}`;
const sandboxInput = (overrides = {}) => ({
  runId: 'run-1',
  step: 'implement',
  image: IMAGE,
  command: ['agent', '--go'],
  env: { HOME: '/tmp' },
  allowedEnv: ['HOME', 'HTTPS_PROXY'],
  mounts: [{ source: '/var/lib/pheromill/run-1/workspace', target: '/workspace', readOnly: false }],
  network: 'pheromill-run-1',
  limits: { cpus: 2, memoryMb: 2048, pids: 256, seconds: 600, tmpMb: 256 },
  user: '10001:10001',
  ...overrides,
});

test('sandbox: every container is disposable, unprivileged, read-only and bounded', () => {
  const spec = buildSandboxSpec(sandboxInput());
  const line = spec.args.join(' ');
  for (const flag of ['--rm', '--pull never', '--read-only', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 10001:10001', '--pids-limit 256', '--memory 2048m', '--cpus 2', '--network pheromill-run-1', '--ipc none']) {
    assert.ok(line.includes(flag), flag);
  }
  assert.ok(!line.includes('--privileged'));
  assert.equal(spec.timeoutMs, 600_000);
  assert.deepEqual(spec.args.slice(-3), [IMAGE, 'agent', '--go']);
});

test('sandbox: secret values never appear on the command line', () => {
  const spec = buildSandboxSpec(sandboxInput({ env: { HTTPS_PROXY: 'http://step:tok3n@egress:3128' } }));
  assert.ok(!spec.args.join(' ').includes('tok3n'));
  assert.ok(spec.args.join(' ').includes('--env HTTPS_PROXY'));
  assert.equal(spec.env.HTTPS_PROXY, 'http://step:tok3n@egress:3128');
});

test('sandbox: without a network the container is fully offline', () => {
  assert.ok(buildSandboxSpec(sandboxInput({ network: null })).args.join(' ').includes('--network none'));
});

test('sandbox: refuses unpinned images, root, open environments, daemon sockets and host networks', () => {
  const bad = [
    { image: 'node:22' },
    { image: 'node@sha256:abc' },
    { image: `--privileged@sha256:${'a'.repeat(64)}` },
    { user: '0:0' },
    { user: 'root' },
    { env: { GITHUB_TOKEN: 'x' } },
    { env: { HOME: 'a\nb' } },
    { network: 'host' },
    { network: 'bridge' },
    { command: [] },
    { runId: 'Run 1' },
    { limits: { cpus: 0, memoryMb: 1, pids: 1, seconds: 1, tmpMb: 1 } },
    { mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: true }] },
    { mounts: [{ source: '/etc', target: '/host-etc', readOnly: true }] },
    { mounts: [{ source: '/data/../etc', target: '/x', readOnly: true }] },
    { mounts: [{ source: '/data,readonly=false', target: '/x', readOnly: true }] },
    { mounts: [{ source: 'relative', target: '/x', readOnly: true }] },
  ];
  for (const override of bad) {
    assert.throws(() => buildSandboxSpec(sandboxInput(override)), SandboxSpecError, JSON.stringify(override));
  }
});

const egress = { author: ['registry.npmjs.org'], reader: ['docs.example.com'] };

test('egress: only exact listed hosts on port 443, per role', () => {
  assert.equal(decideEgress(egress, 'author', 'registry.npmjs.org', 443).allowed, true);
  assert.equal(decideEgress(egress, 'author', 'REGISTRY.npmjs.org.', 443).allowed, true);
  assert.equal(decideEgress(egress, 'author', 'docs.example.com', 443).reason, 'host_not_listed');
  assert.equal(decideEgress(egress, 'author', 'evil.registry.npmjs.org', 443).reason, 'host_not_listed');
  assert.equal(decideEgress(egress, 'author', 'registry.npmjs.org', 80).reason, 'port_not_443');
  assert.equal(decideEgress(egress, 'reviewer', 'registry.npmjs.org', 443).reason, 'role_has_no_network');
  assert.equal(decideEgress(egress, 'author', '93.184.216.34', 443).reason, 'not_a_host_name');
  assert.equal(decideEgress(egress, 'author', 'localhost', 443).reason, 'not_a_host_name');
});

test('egress: private, loopback, link-local and metadata addresses are recognised', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.0.8', '::1', 'fd00::1', 'fe80::1', 'fec0::1', '64:ff9b::a00:1', '2002:a00:1::', '::ffff:10.0.0.1', '::ffff:a00:1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('egress: wildcards and malformed hosts are configuration errors', () => {
  assert.deepEqual(validateEgress(egress), []);
  assert.equal(validateEgress({ author: ['*.npmjs.org', 'Registry.npmjs.org', '10.0.0.1'], reader: 'x' }).length, 4);
});

const policy = { minVersionAgeDays: 7, minPackageAgeDays: 90, minVersions: 5, licenses: ['MIT'], allowedInstallScripts: [] };
const now = new Date('2026-11-20T00:00:00Z');
const goodMetadata = {
  versionPublishedAt: '2026-10-01T00:00:00Z',
  packageCreatedAt: '2020-01-01T00:00:00Z',
  versionCount: 40,
  license: 'MIT',
  installScripts: [],
  deprecated: false,
};

test('dependency gate: an established, licensed, script-free version is approved', () => {
  assert.deepEqual(evaluateDependency({ name: 'left-pad', version: '1.3.0' }, goodMetadata, policy, now), { approved: true, reasons: [] });
});

test('dependency gate: refuses unknown, too young, unlicensed, deprecated or scripted packages', () => {
  const request = { name: 'thing', version: '1.0.0' };
  assert.equal(evaluateDependency(request, null, policy, now).approved, false);
  const young = { ...goodMetadata, versionPublishedAt: '2026-11-15T00:00:00Z' };
  assert.match(evaluateDependency(request, young, policy, now).reasons[0], /younger than 7 days/);
  const undated = { ...goodMetadata, versionPublishedAt: null };
  assert.equal(evaluateDependency(request, undated, policy, now).approved, false);
  const bad = { ...goodMetadata, packageCreatedAt: '2026-11-01T00:00:00Z', versionCount: 1, license: 'GPL-3.0', deprecated: true, installScripts: ['postinstall'] };
  assert.equal(evaluateDependency(request, bad, policy, now).reasons.length, 5);
  const named = { ...policy, allowedInstallScripts: ['thing:postinstall'] };
  assert.equal(evaluateDependency(request, { ...goodMetadata, installScripts: ['postinstall'] }, named, now).approved, true);
});

test('dependency gate: a request needs an exact version and a reason', () => {
  const parsed = parseDependencyRequest([
    { ecosystem: 'npm', name: 'left-pad', version: '1.3.0', reason: 'Needed for column alignment.' },
    { ecosystem: 'npm', name: 'x', version: '^1.0.0', reason: 'Needed for column alignment.' },
    { ecosystem: 'npm', name: '../evil', version: '1.0.0', reason: 'Needed for column alignment.' },
    { ecosystem: 'npm', name: 'y', version: '1.0.0', reason: 'why' },
    null,
  ]);
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.errors.length, 4);
  assert.equal(parseDependencyRequest({}).errors.length, 1);
});

const routingConfig = {
  harnesses: { alpha: { family: 'anthropic' }, beta: { family: 'openai' } },
  routing: [
    { step: 'implement', levels: ['LOW'], harness: 'alpha', model: 'm-fast', grade: 'B' },
    { step: 'implement', levels: ['LOW', 'HIGH', 'CRITICAL'], harness: 'alpha', model: 'm-best', grade: 'A' },
    { step: 'review', levels: ['LOW', 'HIGH'], harness: 'alpha', model: 'm-best', grade: 'A' },
    { step: 'review', levels: ['LOW', 'HIGH'], harness: 'beta', model: 'm-other', grade: 'A' },
    { step: 'refute', levels: ['LOW'], harness: 'beta', model: 'm-new', grade: 'C' },
  ],
};

test('routing: the first route allowed for the level and grade wins', () => {
  assert.equal(selectRoute(routingConfig, { step: 'implement', level: 'LOW' }).model, 'm-fast');
  assert.equal(selectRoute(routingConfig, { step: 'implement', level: 'HIGH' }).model, 'm-best');
});

test('routing: nobody approves their own work; the reviewer comes from another family', () => {
  const review = selectRoute(routingConfig, { step: 'review', level: 'LOW', excludeFamilies: ['anthropic'] });
  assert.equal(review.family, 'openai');
  assert.throws(() => selectRoute(routingConfig, { step: 'review', level: 'LOW', excludeFamilies: ['anthropic', 'openai'] }), /No route/);
  assert.throws(() => assertIndependentReview(['anthropic'], 'anthropic'), /also authored/);
  assert.doesNotThrow(() => assertIndependentReview(['anthropic'], 'openai'));
  assert.deepEqual(families(routingConfig), ['anthropic', 'openai']);
});

test('routing: a grade C route only runs on the reference set', () => {
  assert.throws(() => selectRoute(routingConfig, { step: 'refute', level: 'LOW' }), /No route/);
  assert.equal(selectRoute(routingConfig, { step: 'refute', level: 'LOW', benchmark: true }).model, 'm-new');
  assert.throws(() => selectRoute(routingConfig, { step: 'review', level: 'UNKNOWN' }), /Unknown risk level/);
});

test('ledger: entries are chained and any edit, removal or reordering is detected', () => {
  const first = chainEntry(null, 'decision', { choice: 'a' }, '2026-11-20T10:00:00Z');
  const second = chainEntry(first, 'step', { ticket: '42', b: 1, a: 2 }, '2026-11-20T10:01:00Z');
  const third = chainEntry(second, 'merge', { change: '7' }, '2026-11-20T10:02:00Z');
  assert.deepEqual(verifyChain([first, second, third]), { valid: true, brokenAt: null });
  assert.deepEqual(verifyChain([first, { ...second, data: { ticket: '43' } }, third]), { valid: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([first, third]), { valid: false, brokenAt: 2 });
  assert.deepEqual(verifyChain([second, first, third]).valid, false);
  assert.deepEqual(verifyChain([]), { valid: true, brokenAt: null });
});

test('ledger: what is hashed is what is read back, and the head can be anchored elsewhere', () => {
  const entry = chainEntry(null, 'step', { tokens: undefined, at: new Date('2026-11-20T00:00:00Z') }, '2026-11-20T10:00:00Z');
  const reread = JSON.parse(JSON.stringify(entry));
  assert.equal(verifyChain([reread]).valid, true, 'values that JSON drops or rewrites do not raise a false alarm');
  const second = chainEntry(entry, 'merge', {}, '2026-11-20T10:01:00Z');
  assert.deepEqual(head([entry, second]), { seq: 2, hash: second.hash });
  assert.equal(verifyChain([entry]).valid, true, 'a cut tail is not detectable from the file alone');
  assert.notDeepEqual(head([entry]), head([entry, second]), 'which is why the head is compared with a copy kept elsewhere');
  assert.equal(head([]).seq, 0);
});

test('hygiene: non-English prose is reported, symbols are not', () => {
  const hits = findNonEnglish([{ path: 'a.md', content: 'ok -> fine\nd\u00e9cision prise\n' }]);
  assert.deepEqual(hits.map((h) => [h.path, h.line]), [['a.md', 2]]);
});

test('hygiene: committed secrets are reported without echoing them', () => {
  const samples = [
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    `token = "${'gh' + 'p_'}${'A'.repeat(36)}"`,
    `${'sk-' + 'ant-'}${'b'.repeat(24)}`,
    `${'AK' + 'IA'}${'C'.repeat(16)}`,
    `api_key: "${'d'.repeat(32)}"`,
  ];
  const hits = findSecrets([{ path: 'x.env', content: samples.join('\n') }]);
  assert.deepEqual([...new Set(hits.map((h) => h.line))], [1, 2, 3, 4, 5]);
  assert.ok(hits.every((hit) => !('excerpt' in hit)));
  assert.deepEqual(findSecrets([{ path: 'x.md', content: 'keyEnv: "ANTHROPIC_API_KEY"\n' }]), []);
});

test('hygiene: provisional information is listed and blocks production paths only', () => {
  const marker = ['PROVISIONAL', '(pricing): monthly price to confirm'].join('');
  const items = findProvisional(
    [{ path: 'src/pricing.js', content: `// ${marker}\n` }, { path: 'docs/plan.md', content: `${marker}\n` }],
    ['src/**'],
  );
  assert.deepEqual(items.map((i) => [i.id, i.path, i.blocksProduction]), [['pricing', 'src/pricing.js', true], ['pricing', 'docs/plan.md', false]]);
});

test('hygiene: inner layers must not import outer layers', () => {
  const layers = [
    { name: 'domain', paths: ['src/domain/**'], mayImport: [] },
    { name: 'application', paths: ['src/application/**'], mayImport: ['domain'] },
    { name: 'adapters', paths: ['src/adapters/**'], mayImport: ['domain', 'application'] },
  ];
  const files = [
    { path: 'src/domain/a.js', content: "import { x } from '../adapters/forge/github.js';\nimport y from './b.js';\nimport fs from 'node:fs';" },
    { path: 'src/application/run.js', content: "import { a } from '../domain/a.js';\nconst m = await import('../adapters/x.js');" },
    { path: 'src/domain/b.js', content: "import '../adapters/side-effect.js';" },
    { path: 'src/adapters/x.js', content: "import { a } from '../domain/a.js';" },
  ];
  assert.deepEqual(findLayerViolations(files, layers).map((v) => v.rule), ['domain must not import adapters', 'application must not import adapters', 'domain must not import adapters']);
});

test('hygiene: a letter of any other script is reported, whatever its alphabet', () => {
  const letters = [0x00e9, 0x0142, 0x03b1, 0x0434, 0x05d0, 0x0627, 0x0915, 0x4e2d, 0x3042, 0xac00].map((code) => String.fromCharCode(code));
  for (const letter of letters) assert.equal(findNonEnglish([{ path: 'a.md', content: `word ${letter} word` }]).length, 1, letter.codePointAt(0).toString(16));
  const symbols = [0x2192, 0x2014, 0x00a9, 0x2713].map((code) => String.fromCharCode(code)).join(' ');
  assert.deepEqual(findNonEnglish([{ path: 'a.md', content: `plain ASCII, digits 123 and symbols ${symbols}` }]), []);
});

test('egress: only global unicast addresses are public, and an embedded IPv4 address is judged as itself', () => {
  for (const address of ['2001:db8::1', '2001::1', '2001:10::1', '3fff::1', 'ff02::1', '::', '100::1', '::ffff:169.254.169.254', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1', '1.2.3', '256.1.1.1', '01.2.3.4', '1::2::3', 'fe80::1%eth0', '224.0.0.1', '240.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['2001:4860:4860::8888', '2a00:1450:4007::200e', '::ffff:1.1.1.1', '1.1.1.1', '172.32.0.1', '100.128.0.1']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});
