/**
 * Dependency gate. Agents never install a package: they write a request, and
 * this deterministic check decides. The registry metadata is fetched by a
 * trusted adapter, not by the agent.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param {unknown} raw parsed content of the dependency request file
 * @returns {{requests: Array<{ecosystem: string, name: string, version: string, reason: string}>, errors: string[]}}
 */
export function parseDependencyRequest(raw) {
  const errors = [];
  const requests = [];
  if (!Array.isArray(raw)) return { requests, errors: ['The request must be a JSON array.'] };
  raw.forEach((item, index) => {
    const { ecosystem, name, version, reason } = item ?? {};
    if (typeof ecosystem !== 'string' || typeof name !== 'string' || !NAME.test(name)) {
      errors.push(`Entry ${index}: invalid ecosystem or package name.`);
    } else if (typeof version !== 'string' || !VERSION.test(version)) {
      errors.push(`Entry ${index}: an exact version is required (no range, no tag).`);
    } else if (typeof reason !== 'string' || reason.trim().length < 10) {
      errors.push(`Entry ${index}: a reason explaining why existing dependencies do not suffice is required.`);
    } else {
      requests.push({ ecosystem, name, version, reason });
    }
  });
  return { requests, errors };
}

/**
 * @param {{name: string, version: string}} request
 * @param {null | {
 *   versionPublishedAt: string|null, packageCreatedAt: string|null, versionCount: number,
 *   license: string|null, installScripts: string[], deprecated: boolean}} metadata null when the package or version does not exist
 * @param {{minVersionAgeDays: number, minPackageAgeDays: number, minVersions: number,
 *   licenses: string[], allowedInstallScripts: string[]}} policy
 * @param {Date} now
 * @returns {{approved: boolean, reasons: string[]}}
 */
export function evaluateDependency(request, metadata, policy, now) {
  const reasons = [];
  if (!metadata) {
    return { approved: false, reasons: [`${request.name}@${request.version} does not exist in the registry.`] };
  }
  const ageDays = (iso) => (iso ? (now.getTime() - new Date(iso).getTime()) / DAY_MS : Number.NaN);

  const versionAge = ageDays(metadata.versionPublishedAt);
  if (!(versionAge >= policy.minVersionAgeDays)) {
    reasons.push(`Version is younger than ${policy.minVersionAgeDays} days or its publication date is unknown.`);
  }
  const packageAge = ageDays(metadata.packageCreatedAt);
  if (!(packageAge >= policy.minPackageAgeDays)) {
    reasons.push(`Package is younger than ${policy.minPackageAgeDays} days or its creation date is unknown.`);
  }
  if (metadata.versionCount < policy.minVersions) {
    reasons.push(`Package has fewer than ${policy.minVersions} published versions.`);
  }
  if (!metadata.license || !policy.licenses.includes(metadata.license)) {
    reasons.push(`License ${metadata.license ?? 'unknown'} is not on the allowlist.`);
  }
  if (metadata.deprecated) reasons.push('Version is deprecated.');
  const unnamed = metadata.installScripts.filter((script) => !policy.allowedInstallScripts.includes(`${request.name}:${script}`));
  if (unnamed.length > 0) {
    reasons.push(`Install scripts not explicitly allowed: ${unnamed.join(', ')}.`);
  }
  return { approved: reasons.length === 0, reasons };
}
