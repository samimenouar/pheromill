/**
 * In-memory adapters. They implement every port without touching a network,
 * a forge or a container, so the whole pipeline can be exercised end to end
 * in tests and in `pheromill demo`.
 */
import { parseUnifiedDiff } from '../domain/diff.js';
import { chainEntry } from '../domain/ledger.js';

export class MemoryLedger {
  constructor(clock = { now: () => new Date('2026-01-01T00:00:00Z') }) {
    this.entries = [];
    this.clock = clock;
  }

  async append(type, data) {
    const previous = this.entries.at(-1) ?? null;
    this.entries.push(chainEntry(previous, type, data, this.clock.now().toISOString()));
  }

  ofType(type) {
    return this.entries.filter((entry) => entry.type === type).map((entry) => entry.data);
  }
}

export class MemoryForge {
  constructor() {
    this.tickets = new Map();
    this.changes = new Map();
    this.comments = [];
    /** Change requests a person labelled as approved. */
    this.approved = new Set();
  }

  async approvedChanges() {
    return [...this.approved];
  }

  async listTickets(label) {
    return [...this.tickets.values()].filter((ticket) => ticket.labels.includes(label));
  }

  async setTicketState(id, state, note) {
    const ticket = this.tickets.get(id) ?? { id, labels: [] };
    this.tickets.set(id, { ...ticket, state, note });
  }

  async createTicket(ticket) {
    const id = String(this.tickets.size + 1000);
    this.tickets.set(id, { id, milestone: null, ...ticket });
    return { id };
  }

  async openChange(change) {
    const id = `change-${this.changes.size + 1}`;
    this.changes.set(id, { id, ...change });
    return { id };
  }

  async comment(changeId, body) {
    this.comments.push({ changeId, body });
  }

  async setLabels(changeId, labels) {
    this.changes.set(changeId, { ...this.changes.get(changeId), labels });
  }
}

export class MemoryVcs {
  constructor(trunk = 'main') {
    this.count = 0;
    this.parents = new Map([['base', null]]);
    this.refs = new Map([[trunk, 'base']]);
    this.published = [];
    this.conflicts = new Set();
    /** Changes merged into each candidate commit. */
    this.contents = new Map();
  }

  commit(parent) {
    this.count += 1;
    const sha = `c${this.count}`;
    this.parents.set(sha, parent);
    return sha;
  }

  async head(ref) {
    return this.refs.get(ref);
  }

  async publish({ base, branch, patches, message }) {
    const sha = this.commit(base);
    this.refs.set(branch, sha);
    this.published.push({ branch, patches, message, sha });
    return sha;
  }

  /** In memory, the patch text is taken as it is; git is the authority only in the real adapter. */
  async canonicalize({ patches }) {
    const STATUS = { added: 'A', deleted: 'D', modified: 'M' };
    const patch = patches.join('');
    const entries = parseUnifiedDiff(patch).map((file) => ({ path: file.path, status: STATUS[file.status] ?? 'M', oldMode: '100644', newMode: '100644' }));
    return { patch, entries };
  }

  async buildCandidate({ parent, changes, ref }) {
    const conflict = changes.find((change) => this.conflicts.has(change.id));
    if (conflict) return { conflict: conflict.id };
    const sha = this.commit(parent);
    this.refs.set(ref, sha);
    this.contents.set(sha, [...(this.contents.get(parent) ?? []), ...changes.map((change) => change.id)]);
    return { sha };
  }

  async isAncestor(ancestor, descendant) {
    for (let cursor = descendant; cursor !== null && cursor !== undefined; cursor = this.parents.get(cursor)) {
      if (cursor === ancestor) return true;
    }
    return false;
  }

  async fastForward(trunk, sha) {
    const current = this.refs.get(trunk);
    if (!(await this.isAncestor(current, sha))) throw new Error(`Not a fast-forward: ${sha} does not descend from ${current}.`);
    this.refs.set(trunk, sha);
  }
}

/** Check results decided by a function of the commit, for tests and demos. */
export class ScriptedChecks {
  constructor(decide = () => ({ status: 'pass', signature: null })) {
    this.decide = decide;
    this.calls = [];
  }

  async wait(sha) {
    this.calls.push(sha);
    return this.decide(sha, this.calls.length);
  }

  async status(sha) {
    return this.decide(sha, this.calls.length).status;
  }
}

/**
 * A runner whose agents are plain functions: `script[step](job, attempt)`
 * returns `{patch?, report?, seconds?, tokens?}`.
 */
export class ScriptedRunner {
  constructor(script) {
    this.script = script;
    this.jobs = [];
  }

  async run(job) {
    this.jobs.push(job);
    const attempt = this.jobs.filter((other) => other.step === job.step).length;
    const handler = this.script[job.step];
    if (!handler) throw new Error(`No scripted agent for step "${job.step}".`);
    const output = (await handler(job, attempt)) ?? {};
    return { patch: output.patch ?? '', report: output.report ?? {}, seconds: output.seconds ?? 1, tokens: output.tokens ?? null };
  }
}

export class StaticRegistry {
  constructor(packages = {}) {
    this.packages = packages;
  }

  async metadata(request) {
    return this.packages[`${request.name}@${request.version}`] ?? null;
  }
}
