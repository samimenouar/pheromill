/**
 * GitHub adapter: tickets, change requests, checks and settings over the REST
 * API. Runs in the control zone only. Tokens are obtained from a provider
 * function on every call and never logged or included in an error.
 */
import { createSign } from 'node:crypto';

const STATE_LABELS = {
  later: 'factory:later',
  ready: 'factory:ready',
  in_progress: 'factory:in-progress',
  in_review: 'factory:in-progress',
  queued: 'factory:queued',
  rework: 'factory:rework',
  needs_owner: 'factory:needs-owner',
};

/** Only people the repository already trusts can write text that agents will read. */
const TRUSTED_AUTHORS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * Short-lived installation tokens for a GitHub App, limited to one repository
 * and to the permissions the control zone needs.
 * @param {{appId: string, installationId: string, privateKey: string, repository: string,
 *   permissions: Record<string, string>, fetch?: typeof fetch, clock?: {now: () => Date}, apiUrl?: string}} options
 * @returns {() => Promise<string>}
 */
export function appTokenProvider(options) {
  const doFetch = options.fetch ?? globalThis.fetch;
  const clock = options.clock ?? { now: () => new Date() };
  const apiUrl = options.apiUrl ?? 'https://api.github.com';
  let cached = null;

  return async () => {
    const now = clock.now().getTime();
    if (cached && cached.expiresAt - now > 5 * 60 * 1000) return cached.token;
    const seconds = Math.floor(now / 1000);
    const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: options.appId }))}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(options.privateKey).toString('base64url');
    const response = await doFetch(`${apiUrl}/app/installations/${options.installationId}/access_tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${unsigned}.${signature}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: JSON.stringify({ repositories: [options.repository.split('/')[1]], permissions: options.permissions }),
    });
    if (!response.ok) throw new Error(`GitHub App token request failed with status ${response.status}.`);
    const body = await response.json();
    cached = { token: body.token, expiresAt: new Date(body.expires_at).getTime() };
    return cached.token;
  };
}

export class GitHubForge {
  /**
   * @param {{repository: string, trunk: string, token: () => Promise<string>, requiredChecks: string[], checksAppId?: number|null,
   *   fetch?: typeof fetch, apiUrl?: string, pollMs?: number, timeoutMs?: number,
   *   sleep?: (ms: number) => Promise<void>}} options
   */
  constructor(options) {
    this.repository = options.repository;
    this.trunk = options.trunk;
    this.token = options.token;
    this.requiredChecks = options.requiredChecks;
    this.checksAppId = options.checksAppId ?? null;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiUrl = options.apiUrl ?? 'https://api.github.com';
    this.pollMs = options.pollMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async api(method, path, body) {
    const response = await this.fetch(`${this.apiUrl}/repos/${this.repository}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed with status ${response.status}.`);
    return response.status === 204 ? null : response.json();
  }

  // --- Forge port -----------------------------------------------------------

  async listTickets(label) {
    const issues = await this.api('GET', `/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`);
    // An issue is a ticket only if a trusted person wrote it: its author can edit
    // the text at any time, including after it was labelled.
    return issues
      .filter((issue) => !issue.pull_request && TRUSTED_AUTHORS.includes(issue.author_association))
      .map((issue) => ({
        id: String(issue.number),
        title: issue.title,
        body: issue.body ?? '',
        labels: issue.labels.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
        milestone: issue.milestone?.title ?? null,
      }));
  }

  async setTicketState(id, state, note) {
    const current = (await this.api('GET', `/issues/${id}/labels`)).map((label) => label.name);
    const kept = current.filter((name) => !Object.values(STATE_LABELS).includes(name));
    const next = STATE_LABELS[state] ? [...kept, STATE_LABELS[state]] : kept;
    await this.api('PUT', `/issues/${id}/labels`, { labels: next });
    if (note) await this.api('POST', `/issues/${id}/comments`, { body: note });
    if (state === 'done') await this.api('PATCH', `/issues/${id}`, { state: 'closed', state_reason: 'completed' });
    if (state === 'split') await this.api('PATCH', `/issues/${id}`, { state: 'closed', state_reason: 'not_planned' });
  }

  async createTicket(ticket) {
    const issue = await this.api('POST', '/issues', { title: ticket.title, body: ticket.body, labels: ticket.labels });
    return { id: String(issue.number) };
  }

  async openChange(change) {
    const owner = this.repository.split('/')[0];
    const open = await this.api('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${change.branch}`)}`);
    const pull =
      open[0] ??
      (await this.api('POST', '/pulls', {
        title: change.title,
        head: change.branch,
        base: this.trunk,
        body: `${change.body}\n\nTicket: #${change.ticketId}`,
      }));
    await this.setLabels(String(pull.number), change.labels);
    return { id: String(pull.number) };
  }

  /** Change requests a person with triage rights approved for the merge queue. */
  async approvedChanges() {
    const issues = await this.api('GET', `/issues?state=open&per_page=100&labels=${encodeURIComponent('factory:approved')}`);
    return issues.filter((issue) => issue.pull_request).map((issue) => String(issue.number));
  }

  async comment(changeId, body) {
    await this.api('POST', `/issues/${changeId}/comments`, { body });
  }

  async setLabels(changeId, labels) {
    const current = (await this.api('GET', `/issues/${changeId}/labels`)).map((label) => label.name);
    const kept = current.filter((name) => !name.startsWith('risk:'));
    await this.api('PUT', `/issues/${changeId}/labels`, { labels: [...new Set([...kept, ...labels])] });
  }

  // --- Checks port ----------------------------------------------------------

  /** The latest run of each required check, from the expected app when one is configured. */
  async latestRuns(sha) {
    const result = await this.api('GET', `/commits/${sha}/check-runs?per_page=100`);
    const runs = result.check_runs.filter((run) => this.checksAppId === null || run.app?.id === this.checksAppId);
    return this.requiredChecks.map((name) => ({ name, run: runs.filter((entry) => entry.name === name).sort((a, b) => b.id - a.id)[0] ?? null }));
  }

  /** Every required check must have completed successfully; a missing one is pending. */
  async status(sha) {
    const latest = await this.latestRuns(sha);
    if (latest.some(({ run }) => run?.status === 'completed' && run.conclusion !== 'success')) return 'fail';
    return latest.every(({ run }) => run?.status === 'completed') ? 'pass' : 'pending';
  }

  async wait(sha) {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const status = await this.status(sha);
      if (status === 'pass') return { status, signature: null };
      if (status === 'fail') {
        const failed = (await this.latestRuns(sha)).find(({ run }) => run?.status === 'completed' && run.conclusion !== 'success');
        return { status, signature: failed ? `${failed.name}: ${failed.run.output?.title ?? failed.run.conclusion}` : 'unknown' };
      }
      if (Date.now() >= deadline) return { status: 'fail', signature: 'checks timed out' };
      await this.sleep(this.pollMs);
    }
  }

  // --- Settings as code -----------------------------------------------------

  async readSettings() {
    const [repository, labels, summaries] = await Promise.all([
      this.api('GET', ''),
      this.api('GET', '/labels?per_page=100'),
      this.api('GET', '/rulesets?per_page=100'),
    ]);
    const rulesets = await Promise.all(summaries.map((summary) => this.api('GET', `/rulesets/${summary.id}`)));
    return { repository, labels, rulesets };
  }

  /** @param {{op: string, target: string, payload: object, id?: number}} operation from planSettings */
  async applySetting(operation) {
    const { op, target, payload, id } = operation;
    if (op === 'update_repository') return this.api('PATCH', '', payload);
    if (op === 'create_label') return this.api('POST', '/labels', payload);
    if (op === 'update_label') return this.api('PATCH', `/labels/${encodeURIComponent(target)}`, { color: payload.color, description: payload.description });
    if (op === 'create_ruleset') return this.api('POST', '/rulesets', payload);
    if (op === 'update_ruleset') return this.api('PUT', `/rulesets/${id}`, payload);
    throw new Error(`Unknown settings operation: ${op}`);
  }
}
