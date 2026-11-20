/**
 * Repository settings as code. The desired state lives in the repository;
 * this module computes what must change, and a forge adapter applies it.
 * Nothing is clicked by hand, so nothing drifts silently.
 */

/**
 * Desired forge settings derived from the factory configuration.
 * @param {{project: {trunk: string}, forge: {requiredChecks: string[], checksAppId: number|null, queueActor: {id: number, type: string}|null}}} config
 */
export function desiredSettings(config) {
  const options = config.forge;
  return {
    repository: { delete_branch_on_merge: true, allow_auto_merge: false },
    labels: [
      { name: 'factory:ready', color: '0e8a16', description: 'Ticket validated and ready to be dispatched' },
      { name: 'factory:in-progress', color: '1d76db', description: 'An agent is working on this ticket' },
      { name: 'factory:queued', color: '0052cc', description: 'All gates passed; waiting in the merge queue' },
      { name: 'factory:approved', color: '0e8a16', description: 'Put on a change request by a person: admit the reviewed commit to the merge queue' },
      { name: 'factory:rework', color: 'd93f0b', description: 'Acceptance criteria not met; same ticket, new attempt' },
      { name: 'factory:needs-owner', color: 'b60205', description: 'The factory stopped and needs a human decision' },
      { name: 'factory:later', color: 'c5def5', description: 'Outside the frozen scope of the active milestone' },
      { name: 'risk:low', color: 'c2e0c6', description: 'No reserved path, core module, existing test or dependency touched' },
      { name: 'risk:high', color: 'fbca04', description: 'Core module, existing test or dependency touched' },
      { name: 'risk:critical', color: 'b60205', description: 'Reserved path touched' },
      { name: 'kind:fix', color: 'ee0701', description: 'Unplanned work that corrects a defect' },
      { name: 'kind:debt', color: '5319e7', description: 'Scheduled debt reduction' },
      { name: 'blocks-exit-criterion', color: '000000', description: 'Blocks an exit criterion of the active milestone' },
    ],
    rulesets: [
      {
        name: 'pheromill-trunk',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: [`refs/heads/${config.project.trunk}`], exclude: [] } },
        bypass_actors: options.queueActor
          ? [{ actor_id: options.queueActor.id, actor_type: options.queueActor.type, bypass_mode: 'always' }]
          : [],
        rules: [
          { type: 'deletion' },
          { type: 'non_fast_forward' },
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 0,
              dismiss_stale_reviews_on_push: true,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: true,
            },
          },
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: false,
              required_status_checks: options.requiredChecks.map((context) => (options.checksAppId === null ? { context } : { context, integration_id: options.checksAppId })),
            },
          },
        ],
      },
    ],
  };
}

/**
 * True when `actual` already contains everything `desired` asks for. A forge
 * returns more fields than were sent, so equality would never hold.
 */
function covers(actual, desired) {
  if (Array.isArray(desired)) {
    return Array.isArray(actual) && desired.every((item) => actual.some((candidate) => covers(candidate, item)));
  }
  if (desired !== null && typeof desired === 'object') {
    return actual !== null && typeof actual === 'object' && Object.keys(desired).every((key) => covers(actual[key], desired[key]));
  }
  return actual === desired;
}

/** Lists where an extra entry weakens the rule (who may bypass, what is excluded) must match exactly. */
function sameSet(desired, actual) {
  return Array.isArray(actual) && actual.length === desired.length && covers(actual, desired);
}

function subsetDiffers(desired, actual) {
  return !covers(actual, desired);
}

/**
 * @param {ReturnType<typeof desiredSettings>} desired
 * @param {{repository: object, labels: Array<{name: string}>, rulesets: Array<{name: string, id?: number}>}} actual
 * @returns {Array<{op: string, target: string, payload: object, id?: number}>} operations, in apply order
 */
export function planSettings(desired, actual) {
  const operations = [];
  if (subsetDiffers(desired.repository, actual.repository)) {
    operations.push({ op: 'update_repository', target: 'repository', payload: desired.repository });
  }
  for (const label of desired.labels) {
    const existing = actual.labels.find((other) => other.name === label.name);
    if (!existing) operations.push({ op: 'create_label', target: label.name, payload: label });
    else if (subsetDiffers(label, existing)) operations.push({ op: 'update_label', target: label.name, payload: label });
  }
  for (const ruleset of desired.rulesets) {
    const existing = actual.rulesets.find((other) => other.name === ruleset.name);
    if (!existing) operations.push({ op: 'create_ruleset', target: ruleset.name, payload: ruleset });
    else if (subsetDiffers(ruleset, existing) || !sameSet(ruleset.bypass_actors, existing.bypass_actors) || !sameSet(ruleset.conditions.ref_name.include, existing.conditions?.ref_name?.include) || !sameSet(ruleset.conditions.ref_name.exclude, existing.conditions?.ref_name?.exclude)) {
      operations.push({ op: 'update_ruleset', target: ruleset.name, payload: ruleset, id: existing.id });
    }
  }
  return operations;
}
