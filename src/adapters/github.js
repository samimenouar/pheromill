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
const APPROVED = 'factory:approved';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

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
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? 30000),
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
   *   trustedAppId?: number|null, fetch?: typeof fetch, apiUrl?: string, pollMs?: number, timeoutMs?: number,
   *   requestTimeoutMs?: number, sleep?: (ms: number) => Promise<void>}} options
   *   `trustedAppId`: issues created by this GitHub App (the factory itself) are trusted like a collaborator's.
   */
  constructor(options) {
    this.repository = options.repository;
    this.trunk = options.trunk;
    this.token = options.token;
    this.requiredChecks = options.requiredChecks;
    this.checksAppId = options.checksAppId ?? null;
    this.trustedAppId = options.trustedAppId ?? null;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiUrl = options.apiUrl ?? 'https://api.github.com';
    this.pollMs = options.pollMs ?? 15_000;
    this.timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** One request, bounded in time from the first byte sent to the last byte read. */
  async api(method, path, body, { allow = [] } = {}) {
    const response = await this.fetch(`${this.apiUrl}/repos/${this.repository}${path}`, {
      method,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      headers: {
        authorization: `Bearer ${await this.token()}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (allow.includes(response.status)) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path} failed with status ${response.status}.`);
    return response.status === 204 ? null : response.json();
  }

  /** Every page of a list endpoint. `pick` extracts the items when the answer wraps them. */
  async list(path, pick = (answer) => answer) {
    const items = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = pick(await this.api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`));
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
    throw new Error(`GitHub GET ${path} has more than ${MAX_PAGES * PAGE_SIZE} items.`);
  }

  /**
   * Remove some labels and add others, one label at a time. The label set is
   * never replaced as a whole, so a label a person adds or removes meanwhile
   * (an approval, for instance) is never overwritten from a stale copy.
   */
  async swapLabels(number, shouldRemove, add) {
    const current = (await this.list(`/issues/${number}/labels`)).map((label) => label.name);
    // Add before removing: interrupted in between, an issue has two state labels, never none.
    const missing = add.filter((label) => !current.includes(label));
    if (missing.length > 0) await this.api('POST', `/issues/${number}/labels`, { labels: missing });
    for (const name of current.filter((label) => shouldRemove(label) && !add.includes(label))) {
      await this.api('DELETE', `/issues/${number}/labels/${encodeURIComponent(name)}`, undefined, { allow: [404] });
    }
  }

  // --- Forge port -----------------------------------------------------------

  async listTickets(label) {
    const issues = await this.list(`/issues?state=open&labels=${encodeURIComponent(label)}`);
    // An issue is a ticket only if a trusted party wrote it: its author can edit
    // the text at any time, including after it was labelled.
    const trusted = (issue) =>
      TRUSTED_AUTHORS.includes(issue.author_association) ||
      // Written by the App itself, not by a person acting through it.
      (this.trustedAppId !== null && issue.performed_via_github_app?.id === this.trustedAppId && issue.user?.type === 'Bot');
    return issues
      .filter((issue) => !issue.pull_request && trusted(issue))
      .map((issue) => ({
        id: String(issue.number),
        title: issue.title,
        body: issue.body ?? '',
        labels: issue.labels.map((entry) => (typeof entry === 'string' ? entry : entry.name)),
        milestone: issue.milestone?.title ?? null,
      }));
  }

  async setTicketState(id, state, note) {
    const next = STATE_LABELS[state] ? [STATE_LABELS[state]] : [];
    await this.swapLabels(id, (label) => Object.values(STATE_LABELS).includes(label), next);
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

  /**
   * Change requests a person with triage rights approved for the merge queue,
   * each with the commit the approval was given on (the head at this moment).
   */
  async approvedChanges() {
    const issues = await this.list(`/issues?state=open&labels=${encodeURIComponent(APPROVED)}`);
    const approved = [];
    for (const issue of issues.filter((entry) => entry.pull_request)) {
      const pull = await this.api('GET', `/pulls/${issue.number}`);
      approved.push({ id: String(issue.number), sha: pull.head.sha });
    }
    return approved;
  }

  /** Withdraw an approval: it was consumed, or the change it was given on is gone. */
  async clearApproval(changeId) {
    await this.api('DELETE', `/issues/${changeId}/labels/${encodeURIComponent(APPROVED)}`, undefined, { allow: [404] });
  }

  async comment(changeId, body) {
    await this.api('POST', `/issues/${changeId}/comments`, { body });
  }

  async setLabels(changeId, labels) {
    await this.swapLabels(changeId, (label) => label.startsWith('risk:'), labels);
  }

  // --- Checks port ----------------------------------------------------------

  /** The latest run of each required check, from the expected app when one is configured. */
  async latestRuns(sha) {
    const all = await this.list(`/commits/${sha}/check-runs`, (answer) => answer.check_runs);
    const runs = all.filter((run) => this.checksAppId === null || run.app?.id === this.checksAppId);
    return this.requiredChecks.map((name) => ({ name, run: runs.filter((entry) => entry.name === name).sort((x, y) => y.id - x.id)[0] ?? null }));
  }

  /** Verdict and failure signature from one snapshot of the check runs. */
  async verdict(sha) {
    const latest = await this.latestRuns(sha);
    const failed = latest.find(({ run }) => run?.status === 'completed' && run.conclusion !== 'success');
    if (failed) return { status: 'fail', signature: `${failed.name}: ${failed.run.output?.title ?? failed.run.conclusion}` };
    // Every required check must have completed successfully; a missing one is pending.
    return { status: latest.every(({ run }) => run?.status === 'completed') ? 'pass' : 'pending', signature: null };
  }

  async status(sha) {
    return (await this.verdict(sha)).status;
  }

  async wait(sha) {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const verdict = await this.verdict(sha);
      if (verdict.status !== 'pending') return verdict;
      if (Date.now() >= deadline) return { status: 'fail', signature: 'checks timed out' };
      await this.sleep(this.pollMs);
    }
  }

  // --- Settings as code -----------------------------------------------------

  async readSettings() {
    const [repository, labels, summaries] = await Promise.all([this.api('GET', ''), this.list('/labels'), this.list('/rulesets')]);
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
