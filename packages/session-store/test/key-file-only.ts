import { beforeEach } from 'bun:test';

import { LocalKeyFileProvider, defaultKeyProvider } from '../src/index.js';

/*
 * Preloaded by every package's tests (their bunfig.toml). The default store key on macOS is the
 * login Keychain, which a test run must never read or write: this selects the key file for the
 * test process and the children that inherit its environment, and fails any test that starts
 * with another provider selected. A child given its own environment needs the variable too.
 */
process.env['FAMILY_MCP_KEY_BACKEND'] = 'file';

beforeEach(() => {
  const keys = defaultKeyProvider({ server: 'test-guard', profile: 'default', platform: 'darwin' });

  if (!(keys instanceof LocalKeyFileProvider))
    throw new Error('Tests must keep FAMILY_MCP_KEY_BACKEND=file; the Keychain is never used.');
});
