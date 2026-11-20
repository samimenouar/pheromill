/**
 * Delivery metrics, computed without any model from records agents cannot
 * write: the delivery log (one line per deployment) and the change records.
 *
 * The five DORA metrics follow the definitions published at dora.dev:
 * three measure throughput, two measure instability.
 */

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const time = (iso) => new Date(iso).getTime();

/**
 * @param {Array<{environment: string, at: string, result: 'success'|'failure', kind: 'deploy'|'rollback',
 *   changeIds: string[], causedIncident?: boolean}>} deliveries delivery log, any order; a rollback lists the changes it reverts
 * @param {Array<{id: string, firstCommitAt: string, isFix: boolean, level: string, agent: string}>} changes
 * @param {{environment: string, from: string, to: string}} window
 */
export function computeDora(deliveries, changes, window) {
  const byId = new Map(changes.map((change) => [change.id, change]));
  const inEnvironment = deliveries.filter((d) => d.environment === window.environment).sort((a, b) => time(a.at) - time(b.at));
  const inWindow = inEnvironment.filter((d) => time(d.at) >= time(window.from) && time(d.at) < time(window.to));
  const deploys = inWindow.filter((d) => d.kind === 'deploy');
  const successes = deploys.filter((d) => d.result === 'success');

  const leadTimes = [];
  for (const deploy of successes) {
    for (const id of deploy.changeIds) {
      const change = byId.get(id);
      const hours = change ? (time(deploy.at) - time(change.firstCommitAt)) / HOUR_MS : -1;
      if (hours >= 0) leadTimes.push(hours);
    }
  }

  // A rollback counts against the deployment it reverts, even when it happens after the window.
  const rollbackOf = (deploy) =>
    inEnvironment.find((later) => later.kind === 'rollback' && time(later.at) > time(deploy.at) && later.changeIds.some((id) => deploy.changeIds.includes(id)));
  const isFailed = (deploy) => deploy.result === 'failure' || deploy.causedIncident === true || rollbackOf(deploy) !== undefined;

  const failed = deploys.filter(isFailed);
  const recoveries = [];
  for (const deploy of failed) {
    const recovery =
      rollbackOf(deploy) ??
      inEnvironment.find((later) => later.kind === 'deploy' && time(later.at) > time(deploy.at) && later.result === 'success' && !isFailed(later));
    if (recovery && recovery.result === 'success') recoveries.push((time(recovery.at) - time(deploy.at)) / HOUR_MS);
  }

  const rework = deploys.filter((d) => d.changeIds.some((id) => byId.get(id)?.isFix));
  const weeks = (time(window.to) - time(window.from)) / WEEK_MS;
  const ratio = (part) => (deploys.length === 0 ? null : part / deploys.length);

  return {
    environment: window.environment,
    deployments: deploys.length,
    changeLeadTimeHours: median(leadTimes),
    deploymentsPerWeek: weeks > 0 ? successes.length / weeks : null,
    failedDeploymentRecoveryHours: median(recoveries),
    changeFailRate: ratio(failed.length),
    reworkRate: ratio(rework.length),
  };
}

/** The same metrics, sliced by a change attribute such as `agent` or `level`. */
export function computeDoraBy(deliveries, changes, window, attribute) {
  const result = {};
  for (const value of new Set(changes.map((change) => change[attribute]))) {
    const subset = changes.filter((change) => change[attribute] === value);
    const ids = new Set(subset.map((change) => change.id));
    const relevant = deliveries.filter((d) => d.changeIds.some((id) => ids.has(id)));
    result[value] = computeDora(relevant, subset, window);
  }
  return result;
}

/**
 * Net progress of a milestone: tickets closed minus tickets created, per week.
 * Zero or below means the milestone is not converging and the owner is told.
 * @param {Array<{createdAt: string, closedAt: string|null}>} tickets
 * @param {{from: string, to: string}} week
 */
export function netProgress(tickets, week) {
  const within = (iso) => iso && time(iso) >= time(week.from) && time(iso) < time(week.to);
  const created = tickets.filter((ticket) => within(ticket.createdAt)).length;
  const closed = tickets.filter((ticket) => within(ticket.closedAt)).length;
  const net = closed - created;
  return { created, closed, net, alertOwner: net <= 0 };
}

/**
 * Cost indicators from the budget ledger. A cost that no harness reported
 * stays UNKNOWN; it is never estimated.
 * @param {Array<{ticket: string, agent: string, tokens: number|null, seconds: number}>} steps
 * @param {Array<{ticket: string, points: number, merged: boolean}>} tickets
 */
export function costReport(steps, tickets) {
  const merged = tickets.filter((ticket) => ticket.merged);
  const mergedIds = new Set(merged.map((ticket) => ticket.ticket));
  const points = merged.reduce((sum, ticket) => sum + ticket.points, 0);
  const relevant = steps.filter((step) => mergedIds.has(step.ticket));
  const seconds = relevant.reduce((sum, step) => sum + step.seconds, 0);
  const tokensKnown = relevant.length > 0 && relevant.every((step) => typeof step.tokens === 'number');
  const tokens = tokensKnown ? relevant.reduce((sum, step) => sum + step.tokens, 0) : 'UNKNOWN';
  const per = (total, count) => (total === 'UNKNOWN' ? 'UNKNOWN' : count === 0 ? null : total / count);
  return {
    mergedTickets: merged.length,
    points,
    secondsPerPoint: per(seconds, points),
    tokensPerPoint: per(tokens, points),
    tokensPerMergedTicket: per(tokens, merged.length),
  };
}
