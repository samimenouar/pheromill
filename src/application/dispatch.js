/**
 * Dispatcher: picks the tickets that may run now, runs each through the
 * pipeline, and records the outcome on the forge. It owns operational state;
 * agents never label, close or create dispatchable tickets themselves.
 */
import { selectRunnable } from '../domain/scheduler.js';
import { admit, parseTicket, renderTicketBody } from '../domain/ticket.js';
import { admitChange } from './process-queue.js';
import { runTicket } from './run-ticket.js';

/**
 * @param {{startedKinds: string[], recovered?: boolean,
 *   history: Array<{ticket: string, type: string, outcome?: string}>}} memory
 *   `history` holds the ledger entries of type "arbitration" and "ticket_outcome".
 * @param {object} config
 * @param {object} ports the pipeline ports plus `store`, whose `update(fn)` applies one change to the queue state at a time
 * @returns {Promise<{started: string[], held: Array<{id: string, reason: string}>, outcomes: Record<string, string>}>}
 */
export async function dispatchTick(memory, config, ports) {
  const { forge, ledger, store } = ports;
  const outcomes = {};

  // Changes that passed every gate and wait for a person: the label
  // "factory:approved" on the change request sends the reviewed commit to the queue.
  const approved = await forge.approvedChanges();
  let state = await store.update(async (current) => {
    let next = current;
    for (const changeId of approved) {
      const waiting = next.awaiting?.[changeId];
      if (!waiting) continue;
      const { [changeId]: admitted, ...awaiting } = next.awaiting;
      next = { ...admitChange(next, { id: changeId, ...admitted }), awaiting };
      await forge.setTicketState(admitted.ticketId, 'queued', `Approved; change #${changeId} entered the merge queue.`);
      outcomes[admitted.ticketId] = 'queued';
    }
    return next;
  });
  const pending = [...Object.values(state.changes), ...Object.values(state.awaiting ?? {})];

  // After a restart, a ticket still marked in progress has no agent working on it.
  if (!memory.recovered) {
    memory.recovered = true;
    const known = new Set(pending.map((change) => change.ticketId));
    for (const issue of await forge.listTickets('factory:in-progress')) {
      if (!known.has(String(issue.id))) await forge.setTicketState(String(issue.id), 'rework', 'Interrupted by a restart of the factory; it will start again.');
    }
  }

  const issues = [...(await forge.listTickets('factory:rework')), ...(await forge.listTickets('factory:ready'))];
  const count = (id, predicate) => memory.history.filter((entry) => entry.ticket === id && predicate(entry)).length;
  const tickets = issues.map((issue) => ({
    ...parseTicket(issue),
    escalations: count(String(issue.id), (entry) => entry.type === 'arbitration'),
    reworks: count(String(issue.id), (entry) => entry.type === 'ticket_outcome' && entry.outcome === 'rework'),
  }));

  const eligible = [];
  for (const ticket of tickets) {
    if (admit(ticket, config.milestone) === 'later') {
      outcomes[ticket.id] = 'later';
      await forge.setTicketState(ticket.id, 'later', `Milestone "${config.milestone.name}" is frozen and this ticket does not block one of its exit criteria.`);
    } else if (ticket.reworks >= config.scheduling.maxReworks) {
      outcomes[ticket.id] = 'needs_owner';
      await forge.setTicketState(ticket.id, 'needs_owner', `Sent back to rework ${ticket.reworks} times; the owner decides what happens next.`);
    } else {
      eligible.push(ticket);
    }
  }

  // Changes waiting in the queue or for approval still occupy their files.
  const occupied = pending.map((change) => ({ id: `ticket ${change.ticketId}`, likelyFiles: change.likelyFiles ?? [] }));
  const { start, held } = selectRunnable(eligible, occupied, {
    maxParallelTickets: config.scheduling.maxParallelTickets + occupied.length,
    featuresPerDebtTicket: config.scheduling.featuresPerDebtTicket,
    startedKinds: memory.startedKinds,
  });

  const record = async (ticket, result) => {
    const change = { id: result.changeId, branch: `factory/t${ticket.id}`, sha: result.sha, ticketId: ticket.id, likelyFiles: ticket.likelyFiles };
    if (result.outcome === 'queued') {
      await store.update((current) => admitChange(current, change));
      await forge.setTicketState(ticket.id, 'queued', '');
    } else if (result.outcome === 'needs_owner' && result.gatesPassed && result.changeId) {
      const { id, ...waiting } = change;
      await store.update((current) => ({ ...current, awaiting: { ...(current.awaiting ?? {}), [id]: waiting } }));
      await forge.setTicketState(ticket.id, 'needs_owner', `${result.reason} To send change #${id} to the merge queue, add the label "factory:approved" to it.`);
    } else if (result.outcome === 'split') {
      const created = [];
      for (const child of result.children) {
        const labels = child.kind === 'debt' ? ['kind:debt'] : child.kind === 'fix' ? ['kind:fix'] : [];
        created.push((await forge.createTicket({ title: child.title, body: renderTicketBody(child), labels })).id);
      }
      await forge.setTicketState(ticket.id, 'split', `Too large for one change. Proposed replacements: ${created.map((id) => `#${id}`).join(', ')}. Each needs the label "factory:ready" from a person before it is worked.`);
    } else if (result.outcome === 'rework') {
      if (result.level && result.level !== 'LOW') await forge.setLabels(ticket.id, [`risk:${result.level.toLowerCase()}`]);
      await forge.setTicketState(ticket.id, 'rework', result.reason);
    } else {
      await forge.setTicketState(ticket.id, 'needs_owner', result.reason);
    }
  };

  await Promise.all(
    start.map(async (ticket) => {
      memory.startedKinds.push(ticket.kind);
      let result;
      try {
        await forge.setTicketState(ticket.id, 'in_progress', '');
        result = await runTicket(ticket, config, ports);
        await record(ticket, result);
      } catch (error) {
        // Whatever failed, the ticket must not stay "in progress" with nobody working on it.
        result = { outcome: 'needs_owner' };
        await ledger.append('ticket_outcome', { ticket: ticket.id, outcome: 'needs_owner', reason: `Pipeline error: ${error.message}` }).catch(() => {});
        await forge.setTicketState(ticket.id, 'needs_owner', `The pipeline stopped on an unexpected error: ${error.message}`).catch(() => {});
      }
      outcomes[ticket.id] = result.outcome;
    }),
  );
  return { started: start.map((ticket) => ticket.id), held, outcomes };
}
