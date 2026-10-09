import { beforeEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { TEST_SEAM, defaultSecretRecordPath, testSeam } from '../src/index.js';

/*
 * Preloaded by every package's tests (their bunfig.toml). A test run must never touch the real
 * store under ~/Library/Application Support/family-mcp or ~/.config. The test seam makes macOS
 * honour XDG directories like Linux and skips Time Machine exclusion unless a test names a fake
 * tmutil; unset XDG directories point into this process's scratch path. Children that inherit
 * the environment get the same; a child given its own environment needs the variable too.
 */
process.env[TEST_SEAM] = '1';

for (const [variable, name] of [
  ['XDG_CONFIG_HOME', 'config'],
  ['XDG_DATA_HOME', 'data'],
] as const)
  if (!isAbsolute(process.env[variable] ?? ''))
    process.env[variable] = join(tmpdir(), `family-mcp-test-${process.pid}`, name);

beforeEach(() => {
  if (!testSeam() || defaultSecretRecordPath('test-guard').includes('Application Support'))
    throw new Error(`Tests must keep ${TEST_SEAM}=1; the real store is never used.`);
});
