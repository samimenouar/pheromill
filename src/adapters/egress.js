/**
 * Egress service: the only door out of a sandbox.
 *
 * - Step grants: a random token per step, stored hashed, short-lived, bound
 *   to one role and at most one model provider.
 * - Proxy: HTTPS tunnels (CONNECT) to the exact hosts listed for the role.
 *   Every refusal is reported.
 * - Model gateway: forwards model calls and adds the real provider key
 *   itself, so the key never enters a sandbox. Inside the sandbox, the
 *   "API key" is the step token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { decideEgress, isPrivateAddress } from '../domain/egress-policy.js';

const HOP_HEADERS = ['connection', 'proxy-authorization', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'x-api-key', 'cookie'];
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const hashOf = (token) => createHash('sha256').update(token).digest('hex');

/** @returns {Promise<string>} the token to hand to the step; only its hash is stored */
export async function issueGrant(directory, { role, runId, provider = null, ttlSeconds }, now) {
  const token = randomBytes(32).toString('hex');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const grant = { role, runId, provider, expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString() };
  await writeFile(join(directory, `${hashOf(token)}.json`), JSON.stringify(grant), { mode: 0o600 });
  return token;
}

export async function revokeGrant(directory, token) {
  await rm(join(directory, `${hashOf(token)}.json`), { force: true });
}

async function readGrant(directory, token, now) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  try {
    const grant = JSON.parse(await readFile(join(directory, `${hashOf(token)}.json`), 'utf8'));
    return new Date(grant.expiresAt).getTime() > now.getTime() ? grant : null;
  } catch {
    return null;
  }
}

function proxyToken(header) {
  const match = /^Basic (.+)$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1);
}

/**
 * @param {{egress: Record<string, string[]>, grants: string, report: (event: object) => void,
 *   clock?: {now: () => Date}, resolve?: (host: string) => Promise<string[]>,
 *   connect?: (address: string, port: number) => net.Socket}} options
 */
export function createEgressProxy(options) {
  const clock = options.clock ?? { now: () => new Date() };
  const resolve = options.resolve ?? (async (host) => (await lookup(host, { all: true })).map((entry) => entry.address));
  const connect = options.connect ?? ((address, port) => net.connect(port, address));

  const server = http.createServer((request, response) => {
    options.report({ type: 'egress_refused', reason: 'not_a_tunnel', host: request.headers.host ?? null });
    response.writeHead(405).end();
  });

  const handle = async (request, client) => {
    const refuse = (status, event) => {
      options.report({ type: 'egress_refused', ...event });
      client.end(`HTTP/1.1 ${status} Refused\r\n\r\n`);
    };
    const separator = request.url.lastIndexOf(':');
    const host = request.url.slice(0, separator).toLowerCase();
    const port = Number(request.url.slice(separator + 1));
    const grant = await readGrant(options.grants, proxyToken(request.headers['proxy-authorization']), clock.now());
    if (!grant) return refuse(407, { reason: 'no_valid_grant', host });

    const decision = decideEgress(options.egress, grant.role, host, port);
    if (!decision.allowed) return refuse(403, { reason: decision.reason, host, role: grant.role, runId: grant.runId });

    let addresses;
    try {
      addresses = await resolve(host);
    } catch {
      return refuse(502, { reason: 'unresolvable', host, role: grant.role, runId: grant.runId });
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      return refuse(403, { reason: 'private_address', host, role: grant.role, runId: grant.runId });
    }
    const upstream = connect(addresses[0], port);
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('connect', () => {
      options.report({ type: 'egress_allowed', host, role: grant.role, runId: grant.runId });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
  };

  server.on('connect', (request, client) => {
    client.on('error', () => {});
    client.setTimeout(IDLE_TIMEOUT_MS, () => client.destroy());
    // Nothing a sandbox sends may take the service down: every failure ends this connection only.
    handle(request, client).catch(() => client.destroy());
  });
  return server;
}

/**
 * @param {{providers: Record<string, {baseUrl: string, authHeader: string, keyEnv: string, paths: string[]}>, grants: string,
 *   env: Record<string, string|undefined>, report: (event: object) => void, clock?: {now: () => Date},
 *   allowInsecureUpstream?: boolean}} options
 */
export function createModelGateway(options) {
  const clock = options.clock ?? { now: () => new Date() };

  const handle = async (request, response) => {
    const refuse = (status, reason, extra = {}) => {
      options.report({ type: 'gateway_refused', reason, ...extra });
      if (response.headersSent) response.destroy();
      else response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: reason }));
    };
    const match = /^\/([a-z0-9-]+)(\/[^?#]*)?(\?[^#]*)?$/.exec(request.url ?? '');
    const name = match?.[1];
    if (!match || !Object.hasOwn(options.providers, name)) return refuse(404, 'unknown_provider');
    const provider = options.providers[name];
    const path = match[2] ?? '/';
    // Exact paths only, and nothing an upstream could normalise into another path.
    if (/[%\;]|\/\/|\/\.\.?(\/|$)/.test(path)) return refuse(400, 'invalid_path');
    if (!provider.paths.includes(path)) return refuse(403, 'path_not_listed', { provider: name });

    const presented = String(request.headers[provider.authHeader.toLowerCase()] ?? '').replace(/^Bearer\s+/i, '');
    const grant = await readGrant(options.grants, presented, clock.now());
    if (!grant || grant.provider !== name) return refuse(401, 'no_valid_grant', { provider: name });

    const key = options.env[provider.keyEnv];
    if (!key) return refuse(503, 'provider_key_missing', { provider: name });
    const upstream = new URL(provider.baseUrl);
    if (upstream.protocol !== 'https:' && !options.allowInsecureUpstream) return refuse(500, 'insecure_upstream');

    const headers = Object.fromEntries(Object.entries(request.headers).filter(([header]) => !HOP_HEADERS.includes(header)));
    headers.host = upstream.host;
    headers[provider.authHeader.toLowerCase()] = provider.authHeader.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;

    const transport = upstream.protocol === 'https:' ? https : http;
    const forward = transport.request(
      { hostname: upstream.hostname, port: upstream.port || undefined, method: request.method, path: `${path}${match[3] ?? ''}`, headers, timeout: IDLE_TIMEOUT_MS },
      (answer) => {
        options.report({ type: 'gateway_call', provider: name, runId: grant.runId, role: grant.role, status: answer.statusCode });
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.on('error', () => response.destroy());
        answer.pipe(response);
      },
    );
    forward.on('timeout', () => forward.destroy());
    forward.on('error', () => refuse(502, 'upstream_unreachable', { provider: name }));
    response.on('close', () => forward.destroy());
    request.on('error', () => forward.destroy());
    request.pipe(forward);
  };

  return http.createServer((request, response) => {
    // Nothing a sandbox sends may take the service down: every failure ends this request only.
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else response.writeHead(500).end();
    });
  });
}
