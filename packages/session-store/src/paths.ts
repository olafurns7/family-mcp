import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { SessionStoreError } from './errors.js';
import { KeychainAccessorKeyProvider } from './keychain.js';
import { LocalKeyFileProvider, type KeyProvider } from './keys.js';
import { checkNames } from './secret.js';

export type SessionPathOptions = {
  /** A pre-XDG location that keeps precedence while its file exists, so old installs keep working. */
  legacy?: string | undefined;
};

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `$XDG_CONFIG_HOME/<appName>/session.json`, defaulting to `~/.config/<appName>/session.json`.
 * A relative `XDG_CONFIG_HOME` is ignored, as the XDG base directory specification requires.
 */
export function defaultSessionPath(appName: string, options: SessionPathOptions = {}): string {
  const directory = configDirectory(appName);

  if (options.legacy !== undefined && isExistingFile(options.legacy)) return options.legacy;

  return join(directory, 'session.json');
}

/** `$XDG_CONFIG_HOME/<appName>/session.enc`, defaulting to `~/.config/<appName>/session.enc`. */
export function defaultSecretRecordPath(appName: string): string {
  return join(configDirectory(appName), 'session.enc');
}

export type DefaultKeyProviderOptions = {
  server: string;
  profile: string;
  /** Test seam. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
};

/**
 * macOS: the login keychain through `/usr/bin/security`. Linux: a key file at
 * `$XDG_DATA_HOME/family-mcp/keys/<server>.<profile>.key` (default `~/.local/share`), apart from
 * the records under `~/.config`. `FAMILY_MCP_KEY_BACKEND=file` selects that key file on macOS
 * too, for a Mac whose keychain is locked; any other value is refused. Other platforms have no
 * provider and throw STORE_UNAVAILABLE.
 */
export function defaultKeyProvider(options: DefaultKeyProviderOptions): KeyProvider {
  const { server, profile, platform = process.platform } = options;
  checkNames(server, profile);
  const backend = process.env['FAMILY_MCP_KEY_BACKEND'] ?? '';

  if (backend !== '' && backend !== 'file')
    throw new SessionStoreError(
      'STORE_UNAVAILABLE',
      'FAMILY_MCP_KEY_BACKEND is not supported. Set it to file or unset it.',
    );

  if (platform === 'darwin' && backend === '')
    return new KeychainAccessorKeyProvider({ server, profile });

  if (platform === 'darwin' || platform === 'linux')
    return new LocalKeyFileProvider({
      path: join(
        xdgBase('XDG_DATA_HOME', join('.local', 'share')),
        'family-mcp',
        'keys',
        `${server}.${profile}.key`,
      ),
    });
  throw new SessionStoreError('STORE_UNAVAILABLE', 'This platform has no supported store key.');
}

function configDirectory(appName: string): string {
  if (!APP_NAME.test(appName)) throw new RangeError('appName must be a plain directory name.');

  return join(xdgBase('XDG_CONFIG_HOME', '.config'), appName);
}

/** A relative XDG variable is ignored, as the XDG base directory specification requires. */
function xdgBase(variable: string, fallback: string): string {
  const configured = process.env[variable];

  return configured !== undefined && isAbsolute(configured)
    ? configured
    : join(homedir(), fallback);
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}
