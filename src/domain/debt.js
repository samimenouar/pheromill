/**
 * Technical debt register. A model-free job measures; the register keeps each
 * measure with its trend; at most three debt tickets are proposed per week,
 * each justified by a number.
 */

/**
 * @param {Array<{module: string, metric: string, value: number}>} previous
 * @param {Array<{module: string, metric: string, value: number}>} measured lower is better for every metric
 * @returns {Array<{module: string, metric: string, value: number, previous: number|null, trend: 'new'|'worse'|'better'|'stable'}>}
 */
export function updateRegister(previous, measured) {
  const before = new Map(previous.map((entry) => [`${entry.module}\n${entry.metric}`, entry.value]));
  return measured
    .map((entry) => {
      const old = before.get(`${entry.module}\n${entry.metric}`);
      const trend = old === undefined ? 'new' : entry.value > old ? 'worse' : entry.value < old ? 'better' : 'stable';
      return { ...entry, previous: old ?? null, trend };
    })
    .sort((a, b) => a.module.localeCompare(b.module) || a.metric.localeCompare(b.metric));
}

/**
 * Pick the entries worth a debt ticket: those getting worse first, by size of
 * the regression, then the largest standing values. Never more than `max`.
 */
export function proposeDebtTickets(register, max = 3) {
  const worsening = register
    .filter((entry) => entry.trend === 'worse')
    .sort((a, b) => b.value - b.previous - (a.value - a.previous));
  const standing = register
    .filter((entry) => entry.trend !== 'worse' && entry.value > 0)
    .sort((a, b) => b.value - a.value);
  return [...worsening, ...standing].slice(0, max).map((entry) => ({
    module: entry.module,
    metric: entry.metric,
    justification:
      entry.trend === 'worse'
        ? `${entry.metric} in ${entry.module} went from ${entry.previous} to ${entry.value}.`
        : `${entry.metric} in ${entry.module} stands at ${entry.value}.`,
  }));
}

/** Render the register as a Markdown table. */
export function renderRegister(register, measuredAt) {
  const rows = register.map(
    (e) => `| ${e.module} | ${e.metric} | ${e.value} | ${e.previous ?? 'n/a'} | ${e.trend} |`,
  );
  return [
    '# Debt register',
    '',
    `Generated ${measuredAt} by a model-free job. Do not edit by hand.`,
    '',
    '| Module | Metric | Value | Previous | Trend |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}
