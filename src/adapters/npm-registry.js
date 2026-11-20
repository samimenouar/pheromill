/**
 * npm registry lookup for the dependency gate. Runs in a trusted zone; the
 * agent that requested the package never talks to the registry for this.
 */
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare'];

export class NpmRegistry {
  /** @param {{fetch?: typeof fetch, url?: string}} [options] */
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.url = options.url ?? 'https://registry.npmjs.org';
  }

  /** @returns {Promise<object|null>} metadata for the dependency gate, or null when unknown */
  async metadata(request) {
    if (request.ecosystem !== 'npm') return null;
    const response = await this.fetch(`${this.url}/${request.name.replace('/', '%2F')}`, { headers: { accept: 'application/json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Registry lookup failed with status ${response.status}.`);
    const document = await response.json();
    const version = document.versions?.[request.version];
    if (!version) return null;
    const license = typeof version.license === 'string' ? version.license : version.license?.type ?? null;
    return {
      versionPublishedAt: document.time?.[request.version] ?? null,
      packageCreatedAt: document.time?.created ?? null,
      versionCount: Object.keys(document.versions).length,
      license,
      // A package with a binding.gyp and no install script gets an implicit native build at install time.
      installScripts: [...LIFECYCLE.filter((name) => typeof version.scripts?.[name] === 'string'), ...(version.gypfile === true ? ['native-build'] : [])],
      deprecated: typeof version.deprecated === 'string' && version.deprecated !== '',
    };
  }
}
