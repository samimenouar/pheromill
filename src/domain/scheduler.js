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
  const waiting = [...ready];
  const blockerOf = (ticket) => active.find((other) => anyOverlap(ticket.likelyFiles, other.likelyFiles));

  // Fill one slot at a time, so that a debt ticket that can run is never passed
  // over because another debt ticket, ahead of it, is blocked.
  while (active.length < options.maxParallelTickets) {
    const runnable = waiting.filter((ticket) => !blockerOf(ticket));
    if (runnable.length === 0) break;
    const due = debtIsDue(kinds, options.featuresPerDebtTicket);
    const next = (due && runnable.find((ticket) => ticket.kind === 'debt')) || runnable[0];
    waiting.splice(waiting.indexOf(next), 1);
    active.push(next);
    kinds.push(next.kind);
    start.push(next);
  }
  const held = waiting.map((ticket) => {
    const blocker = blockerOf(ticket);
    return { id: ticket.id, reason: blocker ? `overlaps ${blocker.id}` : 'capacity' };
  });
  return { start, held };
}
