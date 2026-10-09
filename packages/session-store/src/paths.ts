import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { SessionStoreError } from './errors.js';
import { LocalKeyFileProvider, type KeyProvider } from './keys.js';
import { testSeam } from './seam.js';
import { checkNames } from './secret.js';

export type SessionPathOptions = {
  /** A pre-XDG location that keeps precedence while its file exists, so old installs keep working. */
  legacy?: string | undefined;
};

export type StorePathOptions = {
  /** Test seam. Default `process.platform`. */
  platform?: NodeJS.Platform | undefined;
};

export type DefaultKeyProviderOptions = StorePathOptions & {
  server: string;
  profile: string;
};

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True where the store lives under `~/Library/Application Support/family-mcp`. */
export function macStore(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' && !testSeam();
}

/** The user's absolute home directory (HOME, else the password entry); anything else is refused. */
export function homeDirectory(): string {
  // Read on every call: Bun's homedir() keeps the HOME it started with.
  const home = process.env['HOME'] || homedir();

  if (!isAbsolute(home))
    throw new SessionStoreError(
      'STORE_UNAVAILABLE',
      'The home directory is not known; set HOME to an absolute path.',
    );

  return home;
}

/** macOS: `~/Library/Application Support/family-mcp`, holding `keys/` and one directory per server. */
export function macStoreRoot(): string {
  return join(homeDirectory(), 'Library', 'Application Support', 'family-mcp');
}

/**
 * `$XDG_CONFIG_HOME/<appName>/session.json`, defaulting to `~/.config/<appName>/session.json`, on
 * every platform: only the encrypted store moves on macOS. A relative `XDG_CONFIG_HOME` is
 * ignored, as the XDG base directory specification requires.
 */
export function defaultSessionPath(appName: string, options: SessionPathOptions = {}): string {
  const directory = join(xdgBase('XDG_CONFIG_HOME', '.config'), plainName(appName));

  if (options.legacy !== undefined && isExistingFile(options.legacy)) return options.legacy;

  return join(directory, 'session.json');
}

/**
 * macOS: `~/Library/Application Support/family-mcp/<appName>/session.enc`. Linux and other
 * platforms: `$XDG_CONFIG_HOME/<appName>/session.enc`, defaulting to `~/.config`. `keys` is
 * refused as a name, so a store never shares the key directory.
 */
export function defaultSecretRecordPath(appName: string, options: StorePathOptions = {}): string {
  plainName(appName);

  if (appName === 'keys') throw new RangeError('appName must not be keys.');

  return join(
    macStore(options.platform) ? macStoreRoot() : xdgBase('XDG_CONFIG_HOME', '.config'),
    appName,
    'session.enc',
  );
}

/**
 * The key file on macOS and Linux, the only key provider: macOS
 * `~/Library/Application Support/family-mcp/keys/<server>.<profile>.key`, Linux
 * `$XDG_DATA_HOME/family-mcp/keys/<server>.<profile>.key` (default `~/.local/share`), apart from
 * the records. `FAMILY_MCP_KEY_BACKEND` is retired: unset, empty or `file` changes nothing and
 * any other value is refused. Other platforms have no provider and throw STORE_UNAVAILABLE.
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

  if (platform !== 'darwin' && platform !== 'linux')
    throw new SessionStoreError('STORE_UNAVAILABLE', 'This platform has no supported store key.');

  const root = macStore(platform)
    ? macStoreRoot()
    : join(xdgBase('XDG_DATA_HOME', join('.local', 'share')), 'family-mcp');

  return new LocalKeyFileProvider({ path: join(root, 'keys', `${server}.${profile}.key`) });
}

/**
 * Where an earlier, unreleased build kept this store on macOS (`~/.config/<server>/session.enc`
 * and its marker and lock, `~/.local/share/family-mcp/keys/<server>.<profile>.key`, or their
 * absolute-XDG equivalents), without the current store's own record, marker, lock and key, which
 * XDG variables pointing into Application Support would otherwise name. Paths only; nothing here
 * touches the files. Empty off macOS.
 */
export function retiredStorePaths(
  server: string,
  profile = 'default',
  options: StorePathOptions = {},
): string[] {
  checkNames(server, profile);

  if (!macStore(options.platform)) return [];
  const home = homeDirectory();
  const configs = new Set([join(home, '.config'), xdgBase('XDG_CONFIG_HOME', '.config')]);

  const data = new Set([
    join(home, '.local', 'share'),
    xdgBase('XDG_DATA_HOME', join('.local', 'share')),
  ]);

  const root = macStoreRoot();

  const current = new Set([
    ...RECORD_FILES.map((name) => join(root, server, name)),
    join(root, 'keys', `${server}.${profile}.key`),
  ]);

  return [
    ...[...configs].flatMap((config) => RECORD_FILES.map((name) => join(config, server, name))),
    ...[...data].map((base) => join(base, 'family-mcp', 'keys', `${server}.${profile}.key`)),
  ].filter((path) => !current.has(resolve(path)));
}

const RECORD_FILES = ['session.enc', 'session.enc.marker', 'session.enc.lock'];

function plainName(appName: string): string {
  if (!APP_NAME.test(appName)) throw new RangeError('appName must be a plain directory name.');

  return appName;
}

/** A relative XDG variable is ignored, as the XDG base directory specification requires. */
function xdgBase(variable: string, fallback: string): string {
  const configured = process.env[variable];

  return configured !== undefined && isAbsolute(configured)
    ? configured
    : join(homeDirectory(), fallback);
}

function isExistingFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}
