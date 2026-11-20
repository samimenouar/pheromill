/** Shared test helpers. */
import { defaultConfig, mergeConfig } from '../src/domain/config.js';

/** Build a git-style diff for one file. */
export function fileDiff(path, { removed = [], added = [], status = 'modified' } = {}) {
  const header = [`diff --git a/${path} b/${path}`];
  if (status === 'added') header.push('new file mode 100644');
  if (status === 'deleted') header.push('deleted file mode 100644');
  header.push('index 1111111..2222222 100644');
  header.push(status === 'added' ? '--- /dev/null' : `--- a/${path}`);
  header.push(status === 'deleted' ? '+++ /dev/null' : `+++ b/${path}`);
  const hunk = `@@ -1,${removed.length} +1,${added.length} @@`;
  return [...header, hunk, ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n') + '\n';
}

/** A valid configuration for tests, with optional overrides. */
export function testConfig(overrides = {}) {
  return mergeConfig(
    mergeConfig(defaultConfig(), {
      project: { name: 'demo' },
      forge: { repository: 'acme/demo' },
      paths: { core: ['src/domain/**'], thresholds: ['package.json'] },
    }),
    overrides,
  );
}
