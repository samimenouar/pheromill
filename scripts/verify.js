#!/usr/bin/env node
/**
 * The single command that proves a change to Pheromill. CI runs exactly this,
 * and so does anyone before pushing. It stops at the first failure.
 */
import { spawnSync } from 'node:child_process';

const node = process.execPath;
const cli = 'bin/pheromill.js';
const steps = [
  [
    'tests and coverage',
    [
      '--test',
      '--experimental-test-coverage',
      '--test-coverage-include=src/**',
      // Service wiring only runs against real infrastructure; see docs/status.md.
      '--test-coverage-exclude=src/cli/serve.js',
      '--test-coverage-lines=95',
      '--test-coverage-branches=88',
      '--test-coverage-functions=90',
      'test/**/*.test.js',
      'holdout/**/*.test.js',
    ],
  ],
  ['hygiene: English only, no secret, no provisional data in shipped paths, layers', [cli, 'check', '--production']],
  ['proof registry and status page', [cli, 'proofs', 'render', '--check']],
  ['factory configuration', [cli, 'doctor']],
];

for (const [name, args] of steps) {
  console.log(`\n== ${name}`);
  const result = spawnSync(node, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\nFAILED: ${name}`);
    process.exit(result.status ?? 1);
  }
}
console.log('\nAll checks passed.');
