import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { SessionStoreError, throwIfAborted } from './errors.js';
import { KEY_BYTES, keyExists, keyUnavailable, malformedKey, type KeyProvider } from './keys.js';
import { checkNames } from './secret.js';

const SECURITY = '/usr/bin/security';

const PATH = '/usr/bin:/bin';

// `find-generic-password -w` prints a printable password as is, then a newline.
const HEX_KEY = /^([0-9a-f]{64})\n$/;

// Larger output is never a key; the child is killed once it exceeds this.
const MAX_OUTPUT_BYTES = 256;

/*
 * security(1) exits with its command's OSStatus truncated to 8 bits, also after `-i` (the last
 * command's result). Apple Security-61901.80.25 (github.com/apple-oss-distributions/Security):
 * SecurityTool/macOS/security.c main() and execute_command(), keychain_find.c
 * do_keychain_find_generic_password(); values from base/SecBase.h.
 */
const EXIT_STATUS = new Map<number, 'missing' | 'locked' | 'denied'>([
  [44, 'missing'], // errSecItemNotFound -25300
  [36, 'locked'], // errSecInteractionNotAllowed -25308, also a locked keychain without UI
  [29, 'locked'], // errSecInteractionRequired -25315
  [51, 'denied'], // errSecAuthFailed -25293
  [128, 'denied'], // errSecUserCanceled -128
]);

export type KeychainAccessorOptions = {
  server: string;
  profile: string;
  /** Recorded in the marker. Default `keychain`. */
  keyId?: string | undefined;
  /** Longest key read before the child is killed with STORE_TIMEOUT. Default 10 s. */
  readTimeoutMs?: number | undefined;
  /** Longest interactive key creation before the child is killed. Default 120 s. */
  createTimeoutMs?: number | undefined;
  /** Test seam only: the accessor executable. Default `/usr/bin/security`. */
  accessor?: string | undefined;
};

type Run = {
  status: number | null;
  stdout: Buffer;
  failure: 'timeout' | 'aborted' | 'failed' | undefined;
};

/**
 * The data key in a default-keychain generic password (service `family-mcp.<server>`, account
 * `<profile>.data-key`) as 64 lowercase hex characters, whose ACL trusts Apple's
 * `/usr/bin/security`. Any same-user process can fetch it while the keychain is unlocked.
 */
export class KeychainAccessorKeyProvider implements KeyProvider {
  readonly backend = 'encrypted-file';
  readonly keySource = 'keychain-accessor';
  readonly keyId: string;
  readonly #service: string;
  readonly #account: string;
  readonly #accessor: string;
  readonly #readTimeoutMs: number;
  readonly #createTimeoutMs: number;

  constructor(options: KeychainAccessorOptions) {
    checkNames(options.server, options.profile);
    this.#service = `family-mcp.${options.server}`;
    this.#account = `${options.profile}.data-key`;
    this.#accessor = options.accessor ?? SECURITY;
    this.keyId = options.keyId ?? 'keychain';
    this.#readTimeoutMs = options.readTimeoutMs ?? 10_000;
    this.#createTimeoutMs = options.createTimeoutMs ?? 120_000;
  }

  async getKey(signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal);

    const run = await this.#run(
      ['find-generic-password', '-s', this.#service, '-a', this.#account, '-w'],
      undefined,
      this.#readTimeoutMs,
      signal,
    );

    try {
      if (run.failure === 'aborted') throwIfAborted(signal);

      return parseKey(run);
    } finally {
      run.stdout.fill(0);
    }
  }

  async createKey(signal?: AbortSignal): Promise<void> {
    try {
      (await this.getKey(signal)).fill(0);
      throw keyExists();
    } catch (error) {
      if (!(error instanceof SessionStoreError && error.code === 'STORE_UNAVAILABLE')) throw error;
    }

    throwIfAborted(signal);
    const key = randomBytes(KEY_BYTES);
    // No -U (never update an item) and no -A (no allow-all ACL); only the Apple tool is trusted.
    const command = `add-generic-password -s ${this.#service} -a ${this.#account} -w ${key.toString('hex')} -T ${SECURITY}\n`;
    let written: Uint8Array;

    try {
      // `-i` reads the command from stdin, so the key never appears in any process's argv.
      const run = await this.#run(['-i'], command, this.#createTimeoutMs, signal);
      run.stdout.fill(0);

      if (run.failure !== undefined || run.status !== 0)
        throw new SessionStoreError('STORE_ERROR', 'The keychain did not confirm the new key.');
      // `-i` exits with the last command's status; a zero status still needs the stored key to
      // equal the generated one.
      written = await this.getKey(signal);
    } catch (error) {
      throw uncertainKey(error);
    }

    const same = timingSafeEqual(written, key);
    written.fill(0);
    key.fill(0);

    if (!same) throw uncertainKey();
  }

  #run(
    args: string[],
    input: string | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<Run> {
    return new Promise((resolve) => {
      // A minimal environment: no inherited tokens or credentials reach the child.
      const home = process.env['HOME'];
      const env = home === undefined ? { PATH } : { PATH, HOME: home };

      const child = spawn(this.#accessor, args, {
        env,
        shell: false,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
      });

      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Run['failure'];

      const stop = (reason: NonNullable<Run['failure']>): void => {
        failure ??= reason;
        child.kill('SIGKILL');
      };

      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const abort = (): void => stop('aborted');
      signal?.addEventListener('abort', abort, { once: true });

      if (signal?.aborted === true) abort();

      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        chunks.push(chunk);

        if (size > MAX_OUTPUT_BYTES) stop('failed');
      });

      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);

      const finish = (status: number | null): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        const stdout = Buffer.concat(chunks);

        for (const chunk of chunks) chunk.fill(0);
        resolve({ status, stdout, failure });
      };

      // A spawn failure starts no child; `close` follows both a normal exit and a kill, so no
      // child outlives the call.
      child.on('error', () => {
        failure ??= 'failed';
        finish(null);
      });
      child.on('close', finish);
    });
  }
}

function parseKey(run: Run): Uint8Array {
  if (run.failure === 'timeout')
    throw new SessionStoreError('STORE_TIMEOUT', 'The keychain did not answer in time.');

  if (run.failure === undefined && run.status === 0) {
    const match = HEX_KEY.exec(run.stdout.toString('latin1'));

    if (match?.[1] === undefined) throw malformedKey();

    return Buffer.from(match[1], 'hex');
  }

  const kind =
    run.failure === undefined && run.status !== null ? EXIT_STATUS.get(run.status) : undefined;

  if (kind === 'missing') throw keyUnavailable();

  if (kind === 'locked')
    throw new SessionStoreError(
      'STORE_LOCKED',
      'The keychain is locked or cannot ask for access now. Unlock it and try again.',
    );

  if (kind === 'denied')
    throw new SessionStoreError('STORE_ACCESS_DENIED', 'Access to the store key was denied.');
  throw new SessionStoreError('STORE_ERROR', 'The keychain could not read the store key.');
}

function uncertainKey(cause?: unknown): SessionStoreError {
  return new SessionStoreError(
    'STORE_WRITE_UNCERTAIN',
    'The new store key could not be confirmed. Check the keychain before setting up again.',
    { cause },
  );
}
