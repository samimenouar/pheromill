/**
 * Tickets: the unit of work. A ticket is something a user can see or test,
 * sized 1 to 5 points. "Done means done": a ticket closes only when every
 * acceptance criterion is evidenced, otherwise it returns to rework under the
 * same number and never spawns a child.
 */
import { normalizePath } from './glob.js';

const HEADINGS = ['What the user will see', 'Acceptance criteria', 'Likely files', 'Points'];
const LIKELY_FILE = /^[\w.@*?/-]+$/;

/**
 * Split a form body into its four answers. The headings must each appear
 * exactly once, in order; a body that quotes a heading inside an answer is
 * ambiguous and is refused rather than guessed.
 * @returns {Record<string, string>|null}
 */
function sections(body) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const marks = [];
  lines.forEach((line, index) => {
    const match = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (match && HEADINGS.includes(match[1])) marks.push({ title: match[1], index });
  });
  if (marks.length !== HEADINGS.length || marks.some((mark, i) => mark.title !== HEADINGS[i])) return null;
  const result = {};
  marks.forEach((mark, i) => {
    result[mark.title] = lines.slice(mark.index + 1, marks[i + 1]?.index ?? lines.length).join('\n').trim();
  });
  return result;
}

function listItems(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').trim())
    .filter((line) => line !== '' && line !== '_No response_');
}

/**
 * Parse the body produced by the ticket form (headings followed by answers).
 * @param {{id: string|number, title: string, body: string, labels?: string[], milestone?: string|null}} issue
 */
export function parseTicket(issue) {
  const labels = issue.labels ?? [];
  const answers = sections(issue.body ?? '');
  const points = /^\d+$/.test(answers?.Points.trim() ?? '') ? Number(answers.Points.trim()) : null;
  return {
    id: String(issue.id),
    title: issue.title,
    wellFormed: answers !== null,
    description: answers?.['What the user will see'] ?? '',
    acceptanceCriteria: listItems(answers?.['Acceptance criteria'] ?? ''),
    likelyFiles: listItems(answers?.['Likely files'] ?? '').map((item) => normalizePath(item.replace(/^`|`$/g, ''))),
    points,
    kind: labels.includes('kind:debt') ? 'debt' : labels.includes('kind:fix') ? 'fix' : 'feature',
    level: labels.includes('risk:critical') ? 'CRITICAL' : labels.includes('risk:high') ? 'HIGH' : 'LOW',
    milestone: issue.milestone ?? null,
    blocksExitCriterion: labels.includes('blocks-exit-criterion'),
  };
}

/** Render a ticket in the form format, so that tickets created by the factory parse like any other. */
export function renderTicketBody(ticket) {
  return [
    '### What the user will see',
    '',
    ticket.description || ticket.title,
    '',
    '### Acceptance criteria',
    '',
    ...ticket.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
    '',
    '### Likely files',
    '',
    ...ticket.likelyFiles.map((file) => `- \`${file}\``),
    '',
    '### Points',
    '',
    String(ticket.points),
    '',
  ].join('\n');
}

/**
 * @param {ReturnType<typeof parseTicket>} ticket
 * @param {{limits: {minPoints: number, maxPoints: number}}} config
 * @returns {string[]} problems; empty when the ticket can be dispatched
 */
export function validateTicket(ticket, config) {
  const problems = [];
  const { minPoints, maxPoints } = config.limits;
  const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
  if (ticket?.wellFormed === false) problems.push('The body does not follow the ticket form: each heading must appear exactly once, in order.');
  if (typeof ticket?.title !== 'string' || ticket.title.trim() === '') problems.push('Title is missing.');
  if (!Number.isInteger(ticket?.points) || ticket.points < minPoints || ticket.points > maxPoints) {
    problems.push(`Points must be an integer from ${minPoints} to ${maxPoints}.`);
  }
  if (!strings(ticket?.acceptanceCriteria) || ticket.acceptanceCriteria.length === 0 || ticket.acceptanceCriteria.some((item) => /[\r\n]/.test(item))) {
    problems.push('At least one acceptance criterion a user can see or test is required.');
  }
  if (!strings(ticket?.likelyFiles) || ticket.likelyFiles.length === 0) {
    problems.push('At least one likely file or glob is required to schedule the ticket without overlap.');
  } else if (!ticket.likelyFiles.every((file) => LIKELY_FILE.test(file) && !file.split('/').some((segment) => segment === '..' || segment === '.' || segment === ''))) {
    problems.push('Likely files must be plain paths or globs, one per line.');
  }
  return problems;
}

/**
 * A new ticket enters the active milestone only if it blocks one of its exit
 * criteria; everything else waits in "later".
 * @param {ReturnType<typeof parseTicket>} ticket
 * @param {{name: string, frozen: boolean}} milestone
 * @returns {'ready'|'later'}
 */
export function admit(ticket, milestone) {
  if (!milestone.frozen) return 'ready';
  return ticket.milestone === milestone.name && ticket.blocksExitCriterion ? 'ready' : 'later';
}

/**
 * @param {ReturnType<typeof parseTicket>} ticket
 * @param {Record<string, boolean>} evidence acceptance criterion -> proven
 * @returns {{done: boolean, unmet: string[]}}
 */
export function closure(ticket, evidence) {
  const unmet = ticket.acceptanceCriteria.filter((criterion) => evidence[criterion] !== true);
  return { done: unmet.length === 0, unmet };
}
