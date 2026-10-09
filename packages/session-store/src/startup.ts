import { basename } from 'node:path';

import { SessionStoreError } from './errors.js';
import { checkSecretStore, type SecretRecordOptions, type StoreCheck } from './secret.js';
import { StoreRefusal } from './storage.js';

export type StartupCheckOptions = {
  /** The server's command name, such as `abler-mcp`. */
  server: string;
  /** The command that signs in again, such as `abler-mcp auth login`. */
  signIn: string;
  /** The store's options; built inside the check, so an unknown home is reported too. */
  store: () => Pick<SecretRecordOptions, 'path' | 'keys' | 'retired'>;
  /** Where the lines go. Default stderr; never stdout, which carries the MCP transport. */
  write?: ((text: string) => void) | undefined;
};

/**
 * A server CLI's preflight before it serves or runs a store command: `checkSecretStore`, then
 * one line `<server>: cannot start: <message> (<path>)` and false when the store is unsafe, or a
 * notice with the exact cleanup commands when an earlier build's store is still on disk.
 */
export async function startupCheck(options: StartupCheckOptions): Promise<boolean> {
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  let result: StoreCheck;

  try {
    result = await checkSecretStore(options.store());
  } catch (error) {
    if (!(error instanceof SessionStoreError)) throw error;
    const where = error instanceof StoreRefusal && error.path !== '' ? ` (${error.path})` : '';
    write(`${options.server}: cannot start: ${error.message}${where}\n`);

    return false;
  }

  if (result.retired.length > 0) write(retiredNotice(options, result));

  return true;
}

function retiredNotice(options: StartupCheckOptions, result: StoreCheck): string {
  const { server } = options;
  const files = result.retired.filter((path) => !path.endsWith('.lock'));
  const locks = result.retired.filter((path) => path.endsWith('.lock'));
  const hasKeyFile = files.some((path) => basename(path).endsWith('.key'));

  return [
    `${server}: an earlier build left a session store here; it is not used and nothing reads it:`,
    ...result.retired.map((path) => `  ${path}`),
    ...(result.exists ? [] : [`Sign in again: ${options.signIn}`]),
    `After the new sign-in works, stop every ${server} process, then remove the old files:`,
    ...(files.length > 0 ? [`  rm ${files.map(quote).join(' ')}`] : []),
    ...locks.map((path) => `  rm -r ${quote(path)}`),
    ...(hasKeyFile
      ? []
      : [
          'If that build kept its key in the macOS Keychain, remove it too (Keychain Access may ask for your password):',
          `  security delete-generic-password -s family-mcp.${server} -a default.data-key`,
        ]),
    'Older Time Machine backups may still hold those files.',
    '',
  ].join('\n');
}

function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
