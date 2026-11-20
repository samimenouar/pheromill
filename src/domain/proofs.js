/**
 * Proof registry. Every claim the factory makes is listed once with a status:
 * PROVEN (evidence exists and runs in CI), TO_PROVE (built, not yet evidenced
 * in a real environment) or PLANNED (not built). Nothing is implied.
 */

export const STATUSES = ['PROVEN', 'TO_PROVE', 'PLANNED'];

/**
 * @param {unknown} registry parsed proofs/registry.json
 * @param {(path: string) => string|null} readFile returns file content or null
 * @returns {string[]} problems; empty when the registry is consistent
 */
export function validateRegistry(registry, readFile) {
  const problems = [];
  const claims = /** @type {any} */ (registry)?.claims;
  if (!Array.isArray(claims)) return ['The registry must contain a "claims" array.'];
  const seen = new Set();

  for (const claim of claims) {
    const label = claim?.id ?? '(missing id)';
    if (typeof claim?.id !== 'string' || !/^[a-z0-9-]+$/.test(claim.id)) problems.push(`${label}: id must be a slug.`);
    if (seen.has(claim.id)) problems.push(`${label}: duplicate id.`);
    seen.add(claim.id);
    if (typeof claim.area !== 'string' || typeof claim.claim !== 'string') problems.push(`${label}: area and claim are required.`);
    if (!STATUSES.includes(claim.status)) {
      problems.push(`${label}: status must be one of ${STATUSES.join(', ')}.`);
      continue;
    }
    if (claim.status === 'PROVEN') {
      const evidence = claim.evidence ?? [];
      if (!Array.isArray(evidence) || evidence.length === 0) problems.push(`${label}: PROVEN requires evidence.`);
      for (const item of Array.isArray(evidence) ? evidence : []) {
        const content = readFile(item.file);
        if (content === null) problems.push(`${label}: evidence file ${item.file} does not exist.`);
        else if (!content.includes(`test('${item.test}`)) problems.push(`${label}: test "${item.test}" not found in ${item.file}.`);
      }
    } else if (typeof claim.next !== 'string' || claim.next.trim() === '') {
      problems.push(`${label}: ${claim.status} requires "next", the step that will prove or build it.`);
    }
  }
  return problems;
}

/** Render the registry as the public status page. */
export function renderStatus(registry) {
  const claims = registry.claims;
  const count = (status) => claims.filter((claim) => claim.status === status).length;
  const lines = [
    '# Status: what is proven and what is not',
    '',
    'Generated from `proofs/registry.json` by `pheromill proofs render`. Do not edit by hand.',
    '',
    `**${count('PROVEN')} proven, ${count('TO_PROVE')} to prove, ${count('PLANNED')} planned.**`,
    '',
    '- **PROVEN**: an automated test demonstrates the claim on every change. Tests that need a container runtime run in the `sandbox` CI job; both CI jobs are required.',
    '- **TO_PROVE**: the capability is built, but has not been demonstrated in a real environment.',
    '- **PLANNED**: the capability is designed and not built, or only its computation exists.',
    '',
    'A proven claim means the named tests pass. It does not mean the capability was exercised against a live forge or a real model provider: those are the TO_PROVE lines.',
    '',
  ];
  for (const area of [...new Set(claims.map((claim) => claim.area))]) {
    lines.push(`## ${area}`, '', '| Claim | Status | Evidence or next step |', '| --- | --- | --- |');
    for (const claim of claims.filter((entry) => entry.area === area)) {
      const detail =
        claim.status === 'PROVEN'
          ? claim.evidence.map((item) => `\`${item.file}\`: ${item.test}`).join('<br>')
          : claim.next;
      lines.push(`| ${claim.claim} | ${claim.status} | ${detail} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
