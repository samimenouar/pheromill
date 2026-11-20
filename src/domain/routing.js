/**
 * Routing: which harness and model run which step. One line per route, so
 * changing a model is a one-line change, and every route carries a grade
 * earned on the reference set.
 *
 * Grades: C = candidate (reference set only), B = may work LOW changes,
 * A = may work every level.
 */

const GRADE_FOR_LEVEL = { LOW: ['A', 'B'], HIGH: ['A'], CRITICAL: ['A'] };

export class RoutingError extends Error {}

/**
 * @param {{routing: Array<{step: string, levels: string[], harness: string, model: string, grade: string}>,
 *   harnesses: Record<string, {family: string}>}} config
 * @param {{step: string, level: string, excludeFamilies?: string[], benchmark?: boolean}} query
 * @returns {{step: string, harness: string, model: string, grade: string, family: string}}
 */
export function selectRoute(config, query) {
  const exclude = query.excludeFamilies ?? [];
  const grades = query.benchmark ? ['A', 'B', 'C'] : GRADE_FOR_LEVEL[query.level];
  if (!grades) throw new RoutingError(`Unknown risk level: ${query.level}`);

  for (const route of config.routing) {
    const harness = config.harnesses[route.harness];
    if (!harness) continue;
    if (route.step !== query.step || !route.levels.includes(query.level)) continue;
    if (!grades.includes(route.grade)) continue;
    if (exclude.includes(harness.family)) continue;
    return { step: route.step, harness: route.harness, model: route.model, grade: route.grade, family: harness.family };
  }
  const constraint = exclude.length > 0 ? ` outside families [${exclude.join(', ')}]` : '';
  throw new RoutingError(`No route for step "${query.step}" at level ${query.level}${constraint} with grade ${grades.join('/')}.`);
}

/** Model families that have at least one usable harness. */
export function families(config) {
  return [...new Set(Object.values(config.harnesses).map((harness) => harness.family))];
}

/**
 * Nobody approves their own work: a reviewer must come from another model
 * family than every author of the change.
 * @param {string[]} authorFamilies
 * @param {string} reviewerFamily
 */
export function assertIndependentReview(authorFamilies, reviewerFamily) {
  if (authorFamilies.includes(reviewerFamily)) {
    throw new RoutingError(`Reviewer family "${reviewerFamily}" also authored the change.`);
  }
}
