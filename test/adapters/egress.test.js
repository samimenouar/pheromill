import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createEgressProxy, createModelGateway, issueGrant, revokeGrant } from '../../src/adapters/egress.js';

const now = new Date('2026-11-20T10:00:00Z');
const clock = { now: () => now };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const servers = [];
const events = [];
let grants;
let proxyPort;
let gatewayPort;
let upstreamSeen;

before(async () => {
  grants = mkdtempSync(join(tmpdir(), 'pheromill-grants-'));

  const target = net.createServer((socket) => socket.end('hello from the registry'));
  const targetPort = await listen(target);
  const proxy = createEgressProxy({
    egress: { author: ['registry.example.org'], reader: ['internal.example.org'] },
    grants,
    clock,
    report: (event) => events.push(event),
    resolve: async (host) => (host === 'internal.example.org' ? ['10.0.0.5'] : ['93.184.216.34']),
    connect: () => net.connect(targetPort, '127.0.0.1'),
  });
  proxyPort = await listen(proxy);

  const upstream = http.createServer((request, response) => {
    upstreamSeen = { url: request.url, headers: request.headers };
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);
  const gateway = createModelGateway({
    providers: {
      anthropic: { baseUrl: `http://127.0.0.1:${upstreamPort}`, authHeader: 'x-api-key', keyEnv: 'ANTHROPIC_API_KEY', paths: ['/v1/messages'] },
      openai: { baseUrl: `http://127.0.0.1:${upstreamPort}`, authHeader: 'Authorization', keyEnv: 'OPENAI_API_KEY', paths: ['/v1/responses'] },
      unset: { baseUrl: `http://127.0.0.1:${upstreamPort}`, authHeader: 'x-api-key', keyEnv: 'MISSING_KEY', paths: ['/v1'] },
    },
    grants,
    clock,
    env: { ANTHROPIC_API_KEY: 'real-anthropic-key', OPENAI_API_KEY: 'real-openai-key' },
    report: (event) => events.push(event),
    allowInsecureUpstream: true,
  });
  gatewayPort = await listen(gateway);
  servers.push(target, proxy, upstream, gateway);
});

after(() => {
  servers.forEach((server) => server.close());
  rmSync(grants, { recursive: true, force: true });
});

function tunnel(host, token) {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, '127.0.0.1');
    let data = '';
    const auth = token ? `Proxy-Authorization: Basic ${Buffer.from(`step:${token}`).toString('base64')}\r\n` : '';
    socket.on('connect', () => socket.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${auth}\r\n`));
    socket.on('data', (chunk) => (data += chunk));
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
  });
}

function call(path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: gatewayPort, path, method: 'POST', headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end('{}');
  });
}

test('egress: a grant stores only a hash of the step token', async () => {
  const token = await issueGrant(grants, { role: 'author', runId: 'r0', ttlSeconds: 60 }, now);
  const stored = readdirSync(grants).map((name) => name + readFileSync(join(grants, name), 'utf8')).join('\n');
  assert.equal(stored.includes(token), false);
  await revokeGrant(grants, token);
});

test('egress: a listed host is reachable through the tunnel with a valid grant', async () => {
  const token = await issueGrant(grants, { role: 'author', runId: 'r1', ttlSeconds: 60 }, now);
  const answer = await tunnel('registry.example.org:443', token);
  assert.match(answer, /^HTTP\/1\.1 200/);
  assert.match(answer, /hello from the registry$/);
  assert.ok(events.some((event) => event.type === 'egress_allowed' && event.runId === 'r1'));
});

test('egress: unlisted hosts, other ports, missing, expired or revoked grants are refused and reported', async () => {
  const token = await issueGrant(grants, { role: 'author', runId: 'r2', ttlSeconds: 60 }, now);
  const expired = await issueGrant(grants, { role: 'author', runId: 'r3', ttlSeconds: -1 }, now);
  const revoked = await issueGrant(grants, { role: 'author', runId: 'r4', ttlSeconds: 60 }, now);
  await revokeGrant(grants, revoked);
  events.length = 0;

  assert.match(await tunnel('evil.example.org:443', token), /^HTTP\/1\.1 403/);
  assert.match(await tunnel('registry.example.org:22', token), /^HTTP\/1\.1 403/);
  assert.match(await tunnel('169.254.169.254:443', token), /^HTTP\/1\.1 403/);
  assert.match(await tunnel('registry.example.org:443', null), /^HTTP\/1\.1 407/);
  assert.match(await tunnel('registry.example.org:443', expired), /^HTTP\/1\.1 407/);
  assert.match(await tunnel('registry.example.org:443', revoked), /^HTTP\/1\.1 407/);
  assert.match(await tunnel('registry.example.org:443', 'f'.repeat(64)), /^HTTP\/1\.1 407/);
  assert.deepEqual(events.map((event) => event.reason), ['host_not_listed', 'port_not_443', 'not_a_host_name', 'no_valid_grant', 'no_valid_grant', 'no_valid_grant', 'no_valid_grant']);
});

test('egress: a listed host that resolves to a private address is refused', async () => {
  const token = await issueGrant(grants, { role: 'reader', runId: 'r5', ttlSeconds: 60 }, now);
  assert.match(await tunnel('internal.example.org:443', token), /^HTTP\/1\.1 403/);
  assert.equal(events.at(-1).reason, 'private_address');
});

test('egress: plain HTTP through the proxy is refused', async () => {
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: proxyPort, path: 'http://registry.example.org/' }, (response) => resolve(response.statusCode));
  });
  assert.equal(status, 405);
});

test('gateway: the provider key is added outside the sandbox; the sandbox only holds the step token', async () => {
  const token = await issueGrant(grants, { role: 'author', runId: 'r6', provider: 'anthropic', ttlSeconds: 60 }, now);
  const answer = await call('/anthropic/v1/messages?beta=1', { 'x-api-key': token, cookie: 'a=b', 'content-type': 'application/json' });
  assert.deepEqual([answer.status, answer.body], [200, '{"ok":true}']);
  assert.equal(upstreamSeen.url, '/v1/messages?beta=1');
  assert.equal(upstreamSeen.headers['x-api-key'], 'real-anthropic-key');
  assert.equal(upstreamSeen.headers.cookie, undefined);
  assert.equal(JSON.stringify(upstreamSeen.headers).includes(token), false);

  const bearer = await issueGrant(grants, { role: 'reviewer', runId: 'r7', provider: 'openai', ttlSeconds: 60 }, now);
  await call('/openai/v1/responses', { authorization: `Bearer ${bearer}` });
  assert.equal(upstreamSeen.headers.authorization, 'Bearer real-openai-key');
});

test('gateway: a grant works for its own provider only, and never without a grant', async () => {
  const token = await issueGrant(grants, { role: 'author', runId: 'r8', provider: 'anthropic', ttlSeconds: 60 }, now);
  const proxyOnly = await issueGrant(grants, { role: 'author', runId: 'r9', ttlSeconds: 60 }, now);
  assert.equal((await call('/openai/v1/responses', { authorization: `Bearer ${token}` })).status, 401);
  assert.equal((await call('/anthropic/v1/messages', { 'x-api-key': proxyOnly })).status, 401);
  assert.equal((await call('/anthropic/v1/messages', {})).status, 401);
  assert.equal((await call('/anthropic/v1/messages', { 'x-api-key': 'real-anthropic-key' })).status, 401);
  assert.equal((await call('/nowhere/v1', { 'x-api-key': token })).status, 404);
  assert.equal((await call('/anthropic/../admin', { 'x-api-key': token })).status, 400);
  assert.equal((await call('/anthropic/v1/organizations/api_keys', { 'x-api-key': token })).status, 403, 'only listed API paths are forwarded');
  assert.equal((await call('/anthropic/v1/messages/batches', { 'x-api-key': token })).status, 403, 'a listed path does not open its sub-resources');
  for (const path of ['/anthropic/v1/messages/%2e%2e/files', '/anthropic/v1//messages', '/anthropic/v1/messages;x', '/anthropic/v1/./messages']) {
    assert.equal((await call(path, { 'x-api-key': token })).status, 400, path);
  }
  for (const name of ['constructor', 'hasownproperty', 'tostring', 'valueof']) {
    assert.equal((await call(`/${name}/v1/messages`, { 'x-api-key': token })).status, 404, `${name} is not a provider and must not crash the gateway`);
  }
  assert.equal((await call('/anthropic/v1/messages', { 'x-api-key': token })).status, 200, 'the gateway is still serving');
  const unset = await issueGrant(grants, { role: 'author', runId: 'r10', provider: 'unset', ttlSeconds: 60 }, now);
  assert.equal((await call('/unset/v1', { 'x-api-key': unset })).status, 503);
});
