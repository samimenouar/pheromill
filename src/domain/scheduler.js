/**
 * Scheduling rules for the dispatcher. Parallelism is safe only when tickets
 * cannot collide, so two tickets whose likely files may overlap never run at
 * the same time, and a share of capacity is reserved for debt.
 */
import { anyOverlap } from './glob.js';

/**
 * Decide whether the next slot goes to a debt ticket.
 * One debt ticket is owed for every `featuresPerDebtTicket` feature tickets.
 * @param {Array<'feature'|'fix'|'debt'>} startedKinds kinds already started in the period
 * @param {number} featuresPerDebtTicket
 */
export function debtIsDue(startedKinds, featuresPerDebtTicket) {
  const debt = startedKinds.filter((kind) => kind === 'debt').length;
  const other = startedKinds.length - debt;
  return Math.floor(other / featuresPerDebtTicket) > debt;
}

/**
 * @param {Array<{id: string, kind: string, likelyFiles: string[]}>} ready in priority order
 * @param {Array<{id: string, likelyFiles: string[]}>} running
 * @param {{maxParallelTickets: number, featuresPerDebtTicket: number, startedKinds: string[]}} options
 * @returns {{start: Array<{id: string}>, held: Array<{id: string, reason: string}>}}
 */
export function selectRunnable(ready, running, options) {
  const active = [...running];
  const kinds = [...options.startedKinds];
  const start = [];
  const held = [];

  const candidates = [...ready];
  if (debtIsDue(kinds, options.featuresPerDebtTicket)) {
    const debtIndex = candidates.findIndex((ticket) => ticket.kind === 'debt');
    if (debtIndex > 0) candidates.unshift(...candidates.splice(debtIndex, 1));
  }

  for (const ticket of candidates) {
    if (active.length >= options.maxParallelTickets) {
      held.push({ id: ticket.id, reason: 'capacity' });
      continue;
    }
    const blocker = active.find((other) => anyOverlap(ticket.likelyFiles, other.likelyFiles));
    if (blocker) {
      held.push({ id: ticket.id, reason: `overlaps ${blocker.id}` });
      continue;
    }
    active.push(ticket);
    kinds.push(ticket.kind);
    start.push(ticket);
  }
  return { start, held };
}
