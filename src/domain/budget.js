/**
 * Per-ticket budget and loop detection. Every trigger is deterministic: the
 * dispatcher stops the step and calls the arbiter without asking a model
 * whether it is stuck.
 */

/**
 * @param {{points: number}} ticket
 * @param {{budget: object}} config
 */
export function budgetFor(ticket, config) {
  const b = config.budget;
  return {
    commits: b.commits,
    comments: b.comments,
    fixRounds: b.fixRounds,
    externalToolPasses: b.externalToolPasses,
    ciRuns: b.ciRuns,
    sandboxSeconds: b.sandboxSecondsPerPoint === null ? null : b.sandboxSecondsPerPoint * ticket.points,
    tokens: b.tokensPerPoint === null ? null : b.tokensPerPoint * ticket.points,
  };
}

/**
 * Share of the budget consumed, by counter. A null ceiling means "not
 * calibrated yet" and is reported as UNKNOWN rather than estimated.
 * @returns {Record<string, number|'UNKNOWN'>}
 */
export function usage(counters, budget) {
  const result = {};
  for (const [name, ceiling] of Object.entries(budget)) {
    const used = counters[name];
    result[name] = ceiling === null || used === undefined || used === null ? 'UNKNOWN' : used / ceiling;
  }
  return result;
}

/** Counters strictly above their ceiling. */
export function exceeded(counters, budget) {
  return Object.entries(usage(counters, budget))
    .filter(([, ratio]) => ratio !== 'UNKNOWN' && ratio > 1)
    .map(([name]) => name);
}

/** True when any known counter passed the alert ratio (80 % by default). */
export function nearLimit(counters, budget, alertRatio) {
  return Object.values(usage(counters, budget)).some((ratio) => ratio !== 'UNKNOWN' && ratio >= alertRatio);
}

/**
 * @param {{
 *   steps: Array<{errorSignature?: string|null, changedFiles: number}>,
 *   counters: Record<string, number>,
 *   changedLines: number,
 *   points: number,
 *   refutedFingerprints: string[],
 *   raisedFingerprints: string[],
 * }} run
 * @param {ReturnType<typeof budgetFor>} budget
 * @param {{midFlightChangedLines: number, maxPoints: number}} limits
 * @returns {null | {trigger: string, detail: string}}
 */
export function detectLoop(run, budget, limits) {
  const lastThree = run.steps.slice(-3);
  const signature = lastThree[0]?.errorSignature;
  if (lastThree.length === 3 && signature && lastThree.every((step) => step.errorSignature === signature)) {
    return { trigger: 'same_error_three_times', detail: signature };
  }
  const over = exceeded(run.counters, budget);
  if (over.length > 0) {
    return { trigger: 'counter_exceeded', detail: over.join(', ') };
  }
  const lastTwo = run.steps.slice(-2);
  if (lastTwo.length === 2 && lastTwo.every((step) => step.changedFiles === 0)) {
    return { trigger: 'no_change_twice', detail: 'Two consecutive steps changed no file.' };
  }
  if (run.changedLines > limits.midFlightChangedLines || run.points > limits.maxPoints) {
    return { trigger: 'size_exceeded', detail: `${run.changedLines} changed lines, ${run.points} points.` };
  }
  const returned = run.raisedFingerprints.find((fp) => run.refutedFingerprints.includes(fp));
  if (returned) {
    return { trigger: 'refuted_finding_returned', detail: returned };
  }
  return null;
}

/**
 * Arbiter policy. A model may propose an outcome, but only from the three
 * allowed ones, and only once per ticket: the second escalation always goes
 * to the owner.
 * @param {{trigger: string, escalations: number, otherFamilyAvailable: boolean, proposal?: string}} input
 * @returns {{action: 'split'|'reassign'|'ask_owner', reason: string}}
 */
export function arbitrate(input) {
  if (input.escalations >= 1) {
    return { action: 'ask_owner', reason: 'This ticket was already escalated once.' };
  }
  const allowed = ['split', 'reassign', 'ask_owner'];
  let action = allowed.includes(input.proposal) ? input.proposal : null;
  if (!action) {
    if (input.trigger === 'size_exceeded') action = 'split';
    else if (input.trigger === 'same_error_three_times' || input.trigger === 'no_change_twice') action = 'reassign';
    else action = 'ask_owner';
  }
  if (action === 'reassign' && !input.otherFamilyAvailable) {
    return { action: 'ask_owner', reason: 'No agent of another model family is configured.' };
  }
  return { action, reason: `Trigger ${input.trigger}.` };
}
