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
 * @param {{startedKinds: string[], history: Array<{ticket: string, type: string, outcome?: string}>}} memory
 *   `history` holds the ledger entries of type "arbitration" and "ticket_outcome", oldest first.
 * @param {object} config
 * @param {object} ports the pipeline ports plus `store`, whose `update(fn)` applies one change to the queue state at a time
 * @returns {Promise<{started: string[], held: Array<{id: string, reason: string}>, outcomes: Record<string, string>}>}
 */
export async function dispatchTick(memory, config, ports) {
  const { forge, ledger, store } = ports;
  const outcomes = {};
  const note = async (ticket, outcome, reason) => {
    await ledger.append('ticket_outcome', { ticket, outcome, reason });
    memory.history.push({ type: 'ticket_outcome', ticket, outcome });
  };

  // Changes that passed every gate and wait for a person: the label
  // "factory:approved" sends the reviewed commit to the queue, and only that
  // commit. The decision is saved first; labels and comments follow.
  const approved = await forge.approvedChanges();
  const admitted = [];
  let state = await store.update((current) => {
    let next = current;
    for (const { id, sha } of approved) {
      const waiting = next.awaiting?.[id];
      if (!waiting || waiting.sha !== sha) continue;
      const { [id]: entry, ...awaiting } = next.awaiting;
      next = { ...admitChange(next, { id, ...entry }), awaiting };
      admitted.push({ id, ticketId: entry.ticketId });
    }
    return next;
  });
  for (const { id, sha } of approved) {
    // An approval is spent once: it never carries over to a later commit of the same change request.
    await forge.clearApproval(id);
    const entry = admitted.find((change) => change.id === id);
    if (entry) {
      await forge.setTicketState(entry.ticketId, 'queued', `Approved; change #${id} entered the merge queue.`);
      outcomes[entry.ticketId] = 'queued';
    } else if (!state.changes[id]) {
      const reviewed = state.awaiting?.[id]?.sha;
      const why = reviewed ? `it points to ${sha}, and the commit that passed the gates is ${reviewed}` : 'it is not waiting for an approval';
      await forge.comment(id, `The label "factory:approved" was removed from this change request: ${why}.`);
    }
  }

  // A change stops waiting when its ticket is no longer in the owner's hands
  // (relabelled, closed): its files are free again.
  if (Object.keys(state.awaiting ?? {}).length > 0) {
    const withOwner = new Set((await forge.listTickets('factory:needs-owner')).map((issue) => String(issue.id)));
    state = await store.update((current) => ({
      ...current,
      awaiting: Object.fromEntries(Object.entries(current.awaiting ?? {}).filter(([, change]) => withOwner.has(String(change.ticketId)))),
    }));
  }
  const pending = [...Object.values(state.changes), ...Object.values(state.awaiting ?? {})];

  // A tick waits for every ticket it starts, so a ticket still marked in
  // progress when a tick begins has nobody working on it: the factory was
  // restarted, or the forge refused a label. It starts again, within the cap.
  const known = new Set(pending.map((change) => String(change.ticketId)));
  for (const issue of await forge.listTickets('factory:in-progress')) {
    if (known.has(String(issue.id))) continue;
    const reason = 'Interrupted before it finished; it will start again.';
    await note(String(issue.id), 'rework', reason);
    await forge.setTicketState(String(issue.id), 'rework', reason);
  }

  const issues = [...(await forge.listTickets('factory:rework')), ...(await forge.listTickets('factory:ready'))];
  const own = (id, type) => memory.history.filter((entry) => entry.ticket === id && entry.type === type);
  /** Times a ticket was sent back since the owner last had it in hand. */
  const reworksOf = (id) => {
    const results = own(id, 'ticket_outcome');
    return results.slice(results.findLastIndex((entry) => entry.outcome === 'needs_owner') + 1).filter((entry) => entry.outcome === 'rework').length;
  };
  const tickets = issues.map((issue) => ({ ...parseTicket(issue), escalations: own(String(issue.id), 'arbitration').length, reworks: reworksOf(String(issue.id)) }));

  const eligible = [];
  for (const ticket of tickets) {
    if (admit(ticket, config.milestone) === 'later') {
      outcomes[ticket.id] = 'later';
      await forge.setTicketState(ticket.id, 'later', `Milestone "${config.milestone.name}" is frozen and this ticket does not block one of its exit criteria.`);
    } else if (ticket.reworks >= config.scheduling.maxReworks) {
      outcomes[ticket.id] = 'needs_owner';
      const reason = `Sent back to rework ${ticket.reworks} times; the owner decides what happens next. Labelling it "factory:ready" again gives it a fresh allowance.`;
      await note(ticket.id, 'needs_owner', reason);
      await forge.setTicketState(ticket.id, 'needs_owner', reason);
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
      await forge.clearApproval(id); // a label left from an earlier commit approves nothing
      await store.update((current) => ({ ...current, awaiting: { ...(current.awaiting ?? {}), [id]: waiting } }));
      await forge.setTicketState(ticket.id, 'needs_owner', `${result.reason} To send change #${id} to the merge queue, add the label "factory:approved" to it.`);
    } else if (result.outcome === 'split') {
      const created = [];
      for (const child of result.children) {
        const labels = child.kind === 'debt' ? ['kind:debt'] : child.kind === 'fix' ? ['kind:fix'] : [];
        created.push((await forge.createTicket({ title: child.title, body: renderTicketBody(child), labels })).id);
      }
      await forge.setTicketState(ticket.id, 'split', `Too large for one change. Proposed replacements: ${created.map((id) => `#${id}`).join(', ')}. Each needs the label "factory:ready" from a person before it is worked.`);
    } else if (result.outcome === 'halted') {
      await forge.setTicketState(ticket.id, 'rework', 'Stopped by a halt of the factory; it will start again.');
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
        await note(ticket.id, 'needs_owner', `Pipeline error: ${error.message}`).catch(() => {});
        await forge.setTicketState(ticket.id, 'needs_owner', `The pipeline stopped on an unexpected error: ${error.message}`).catch(() => {});
      }
      outcomes[ticket.id] = result.outcome;
    }),
  );
  return { started: start.map((ticket) => ticket.id), held, outcomes };
}
