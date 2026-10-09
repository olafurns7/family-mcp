// Drop-ins that run packages/abler-mcp/test/integration.test.ts against the Rust binary in
// ABLER_RUST_BINARY. The TypeScript cases inject a fetch stand-in into `AblerClient` or a
// `--preload` file; here that same function answers the binary's requests on a loopback upstream
// (ABLER_TEST_ORIGIN). Client methods are MCP tool calls to `abler-mcp serve` over stdio, and the
// auth functions under test are the CLI commands that call them.
import { afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import { LocalKeyFileProvider, type KeyProvider } from '@family-mcp/session-store';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CookieJar } from 'tough-cookie';

import { ORIGIN, type MigrateResult } from '../../../../packages/abler-mcp/src/auth.js';

const rustBinary = process.env.ABLER_RUST_BINARY;

if (!rustBinary) throw new RangeError('ABLER_RUST_BINARY must name the Rust abler-mcp binary.');

/** A closed loopback port: a case without an upstream can never reach Abler. */
export const NOWHERE = 'http://127.0.0.1:9';

export type Fetch = (url: string, init: RequestInit) => Response | Promise<Response>;

type Upstream = { origin: string; close: () => Promise<void> };

async function body(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

async function answer(response: Response, out: ServerResponse): Promise<void> {
  out.statusCode = response.status;

  for (const [name, value] of response.headers) if (name !== 'set-cookie') out.setHeader(name, value);

  const cookies = response.headers.getSetCookie();

  if (cookies.length) out.setHeader('set-cookie', cookies);

  if (!response.body) {
    out.end();

    return;
  }
  const reader = response.body.getReader();
  // A client that stops reading closes the socket; the stream sees `cancel`, as with fetch.
  const closed = new Promise<void>((resolve) => out.once('close', resolve));
  void closed.then(() => !out.writableFinished && reader.cancel().catch(() => {}));

  for (;;) {
    const next = await Promise.race([reader.read(), closed.then(() => undefined)]);

    if (!next || next.done) break;

    if (!out.write(next.value))
      await Promise.race([new Promise((resolve) => out.once('drain', resolve)), closed]);
  }
  out.end();
}

/**
 * Serve `request` on loopback. Each request reaches it as `<base><path>` with the
 * method, headers, body and an abort signal, and `redirect: 'error'` (the binary never follows
 * one; the loopback case checks that). A thrown error drops the connection, as a failed fetch.
 * A loopback port scanner's `GET /` never reaches it.
 */
export async function upstream(request: Fetch, port = 0, base = ORIGIN): Promise<Upstream> {
  const server = createServer(async (incoming, out) => {
    if (incoming.url === '/') {
      out.statusCode = 404;
      out.end();

      return;
    }
    const aborted = new AbortController();
    // The binary exiting mid-request aborts it, as fetch's signal would.
    out.once('close', () => aborted.abort());

    const headers = new Headers();

    for (const [name, value] of Object.entries(incoming.headers))
      for (const item of [value ?? []].flat()) headers.append(name, item);

    let response: Response;

    try {
      response = await request(`${base}${incoming.url}`, {
        method: incoming.method,
        headers,
        body: await body(incoming),
        redirect: 'error',
        signal: aborted.signal,
      });
    } catch {
      incoming.socket.destroy();

      return;
    }

    await answer(response, out).catch(() => out.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  const address = server.address();

  if (!address || typeof address === 'string') throw new RangeError('No upstream port.');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A preload file's `globalThis.fetch`, and its `process.stdin` replacement if it has one. */
function preloaded(file: string) {
  const sandbox: { fetch?: Fetch } = {};
  const stdin: { [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> } = {};
  const stderr = { write: (text: string) => preloadOutput(text) };
  // oxlint-disable-next-line typescript/no-implied-eval -- The suite's own synthetic preload files.
  new Function('globalThis', 'process', readFileSync(file, 'utf8'))(sandbox, { stdin, stderr });

  return { fetch: sandbox.fetch, stdin: stdin[Symbol.asyncIterator] };
}

/** The upstream a preload file's fetch would have replaced. */
export async function preloadUpstream(file: string): Promise<Upstream> {
  const { fetch } = preloaded(file);

  if (!fetch) throw new RangeError('The preload file replaces no fetch.');

  return upstream(fetch);
}

/** What a preload file writes to stderr (only the SIGTERM case's FETCH_STARTED). */
let preloadOutput: (text: string) => void = () => {};

export function onPreloadOutput(listener: (text: string) => void): void {
  preloadOutput = listener;
}

/**
 * A replaced `process.stdin` becomes real input: what it yields, or, if it throws before
 * yielding, a descriptor whose reads fail (a directory), as an unreviewed read error.
 */
async function stdinOf(iterate: () => AsyncIterator<Buffer>): Promise<Blob | number> {
  const chunks: Buffer[] = [];
  const iterator = iterate();

  try {
    for (let next = await iterator.next(); !next.done; next = await iterator.next())
      chunks.push(next.value);
  } catch {
    if (!chunks.length) return openSync('/', 'r');
  }

  return new Blob(chunks);
}

type SpawnOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: Blob;
  stdout?: 'pipe';
  stderr?: 'pipe';
};

const CHROME = 'http://127.0.0.1:9222';

/** The last default-port listener's closing, awaited before the port is taken again. */
let chromeClosed: Promise<unknown> = Promise.resolve();

/**
 * In place of `Bun.spawn([bun, '--preload', preload, 'src/cli.ts', ...args], options)`: the binary
 * with `args`, its upstream the preload's fetch (or none). The fetch replaced every request, so
 * it also answers a bare `auth capture` on the default Chrome port, which must be free.
 */
export async function spawnCli(preload: string | undefined, args: string[], options: SpawnOptions) {
  const loaded = preload === undefined ? {} : preloaded(preload);
  const served = loaded.fetch ? await upstream(loaded.fetch) : undefined;

  const chrome =
    loaded.fetch && args.length === 2 && args[0] === 'auth' && args[1] === 'capture'
      ? await chromeClosed.then(() => upstream(loaded.fetch!, 9222, CHROME))
      : undefined;

  const child = Bun.spawn([rustBinary!, ...args], {
    ...options,
    stdin: loaded.stdin ? await stdinOf(loaded.stdin) : (options.stdin ?? 'ignore'),
    env: { ...options.env, ABLER_TEST_ORIGIN: served?.origin ?? NOWHERE },
  });

  const closed = child.exited.then(() => Promise.all([served?.close(), chrome?.close()]));

  if (chrome) chromeClosed = closed;

  return child;
}

/**
 * A key file in its own data home, in place of `FakeKeyProvider`: the binary reads only a key
 * file on Linux. With no key the store key is missing; `malformed` makes it unreadable.
 */
export class KeyFile extends LocalKeyFileProvider {
  readonly dataHome: string;

  constructor(key?: Uint8Array) {
    const dataHome = mkdtempSync(join(keyRoot(), 'data-'));
    super({ path: join(dataHome, 'family-mcp', 'keys', 'abler-mcp.default.key') });
    this.dataHome = dataHome;

    if (key) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, key, { mode: 0o600 });
    }
  }
}

let keyDirectory: string | undefined;

function keyRoot(): string {
  keyDirectory ??= mkdtempSync(join(tmpdir(), 'abler-keys-'));

  return keyDirectory;
}

afterAll(() => {
  if (keyDirectory) rmSync(keyDirectory, { recursive: true, force: true });
});

/**
 * The store failures the binary can meet on Linux, in place of a provider that throws `code`:
 * the macOS Keychain's STORE_LOCKED, STORE_TIMEOUT and STORE_ACCESS_DENIED are Rust unit tests.
 */
export function failing(code: 'STORE_UNAVAILABLE' | 'STORE_ERROR'): KeyFile {
  return new KeyFile(code === 'STORE_ERROR' ? new Uint8Array(31) : undefined);
}

function keyEnvironment(keys?: KeyProvider): Record<string, string> {
  if (keys === undefined) return {};

  if (keys instanceof KeyFile) return { XDG_DATA_HOME: keys.dataHome };
  throw new RangeError('The binary reads only a key file; use KeyFile.');
}

const UNKNOWN_ERROR = 'The operation failed. Check the server logs for details.';
const ZOD_ERROR = 'Invalid input or unexpected upstream data.';

/** A reviewed message becomes a `SafeError` again; the fixed unknown and input errors do not. */
function failure(message: string): Error {
  return [UNKNOWN_ERROR, ZOD_ERROR, 'Abler MCP failed.'].includes(message)
    ? new Error(message)
    : new SafeError(message);
}

/** `AblerClient(path, request, keys)`: each method is one tool call to a fresh `serve`. */
export class AblerClient {
  constructor(
    private readonly path: string,
    private readonly request: Fetch,
    private readonly keys?: KeyProvider,
  ) {}

  status = (forceRefresh = false) => this.#call('auth_status', {}, forceRefresh);
  profile = () => this.#call('get_profile', {});
  groups = async () => (await this.#call('list_groups', {})).groups;
  schedule = (input: object = {}) => this.#call('list_schedule', input);
  childSchedules = (input: object = {}) => this.#call('list_child_schedules', input);
  event = (input: object) => this.#call('get_event', input);
  conversations = (input: object = {}) => this.#call('list_conversations', input);
  messages = (input: object) => this.#call('list_messages', input);
  close = async () => {};

  // oxlint-disable-next-line typescript/no-explicit-any -- Each method returns its tool's output.
  async #call(name: string, args: object, forceRefresh = false): Promise<any> {
    const served = await upstream(this.request);

    try {
      const transport = new StdioClientTransport({
        command: rustBinary!,
        args: ['serve'],
        env: {
          ...(process.env as Record<string, string>),
          ...keyEnvironment(this.keys),
          ABLER_SESSION_FILE: this.path,
          ABLER_TEST_ORIGIN: served.origin,
          ...(forceRefresh ? { ABLER_TEST_FORCE_REFRESH: '1' } : {}),
        },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'abler-rust-integration', version: '1.0.0' });
      await client.connect(transport);

      const result = await client
        .callTool({ name, arguments: args as Record<string, unknown> })
        .finally(() => client.close());
      const [content] = result.content as { text: string }[];

      if (result.isError) throw failure(content?.text ?? '');

      return result.structuredContent;
    } finally {
      await served.close();
    }
  }
}

/** The binary's MCP server over stdio, its upstream `request`. Close both when done. */
export async function serveStdio(path: string, request: Fetch) {
  const served = await upstream(request);

  const transport = new StdioClientTransport({
    command: rustBinary!,
    args: ['serve'],
    env: {
      ...(process.env as Record<string, string>),
      ABLER_SESSION_FILE: path,
      ABLER_TEST_ORIGIN: served.origin,
    },
    stderr: 'pipe',
  });

  return { transport, close: served.close };
}

/** One CLI command; a failure throws its diagnostic as the TypeScript function would. */
async function cli(
  args: string[],
  legacy: string,
  { keys, request, stdin }: { keys?: KeyProvider; request?: Fetch; stdin?: string } = {},
): Promise<string> {
  const served = request ? await upstream(request) : undefined;

  try {
    const child = Bun.spawn([rustBinary!, ...args], {
      env: {
        ...process.env,
        ...keyEnvironment(keys),
        ABLER_SESSION_FILE: legacy,
        ABLER_TEST_ORIGIN: served?.origin ?? NOWHERE,
      },
      stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (exit !== 0) throw failure(stderr.trim());

    return stdout;
  } finally {
    await served?.close();
  }
}

/** A verification that runs in the binary: its refresh and read go to `request`. */
export type Verify = (() => Promise<object>) & { request?: Fetch };

/**
 * In place of `() => new AblerClient(path, request, keys, 'candidate').status(true)`, which the
 * binary runs itself when it verifies a candidate.
 */
export function verifier(request: Fetch): Verify {
  return Object.assign(
    () => Promise.reject(new RangeError('The binary runs this verification itself.')),
    { request },
  );
}

const outcomes: Record<string, MigrateResult> = {
  'Abler session moved to the encrypted store; the plaintext files were removed.\n': 'migrated',
  'A failed-import candidate moved to the encrypted store; the plaintext files were removed. Run abler-mcp auth retry-candidate to verify and use it.\n':
    'candidate',
  'Already migrated.\n': 'already',
  'Already migrated. Removed leftover plaintext session files.\n': 'already-removed-legacy',
};

/** `auth migrate`. */
export async function migrateSession(legacy: string, keys?: KeyProvider): Promise<MigrateResult> {
  const out = await cli(['auth', 'migrate'], legacy, { keys });
  const outcome = outcomes[out];

  if (!outcome) throw new RangeError(`Unexpected migrate output: ${out}`);

  return outcome;
}

/** `auth logout`. */
export async function logoutSession(legacy: string, keys?: KeyProvider): Promise<void> {
  await cli(['auth', 'logout'], legacy, { keys });
}

/** `auth status`: in place of `sessionStorage`, where it is the call under test. */
export async function statusCli(legacy: string, keys?: KeyProvider): Promise<string> {
  return cli(['auth', 'status'], legacy, { keys });
}

/** `auth retry-candidate`; a verification without a `request` has no upstream. */
export async function retryCandidate(verify: Verify, legacy: string, keys?: KeyProvider) {
  await cli(['auth', 'retry-candidate'], legacy, { keys, request: verify.request });
}

/** `auth import -` of `jar`'s cookies; true if a store whose key was lost was replaced. */
export async function saveVerifiedSession(
  jar: CookieJar,
  verify: Verify,
  legacy: string,
  keys?: KeyProvider,
): Promise<boolean> {
  const cookies = (await jar.serialize()).cookies.map((cookie) => ({
    name: cookie.key,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    ...(typeof cookie.expires === 'string' ? { expires: Date.parse(cookie.expires) / 1000 } : {}),
  }));

  const out = await cli(['auth', 'import', '-'], legacy, {
    keys,
    request: verify.request,
    stdin: JSON.stringify(cookies),
  });

  return out.includes('could not be read without its key and was replaced');
}

/** `auth capture endpoint`, in place of `captureCookies` then `saveVerifiedSession`. */
export async function captureAndSave(endpoint: string, verify: Verify, legacy: string) {
  const out = await cli(['auth', 'capture', endpoint], legacy, { request: verify.request });

  return out.includes('could not be read without its key and was replaced');
}
