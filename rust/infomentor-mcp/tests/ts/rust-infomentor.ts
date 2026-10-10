// Drop-ins that run packages/infomentor-mcp/test/integration.test.ts against the Rust binary in
// INFOMENTOR_RUST_BINARY. The TypeScript cases inject a fetch stand-in into the client and the
// login functions; here that same function answers the binary's requests on a loopback upstream
// (INFOMENTOR_TEST_ORIGIN). Client methods are MCP tool calls to one `infomentor-mcp serve` per
// client, and the auth functions under test are the CLI commands that call them.
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, dirname, join } from 'node:path';

import { LocalKeyFileProvider, type KeyProvider } from '@family-mcp/session-store';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  InfoMentorError,
  type ErrorCode,
} from '../../../../packages/infomentor-mcp/src/session.js';
import type { MigrateResult } from '../../../../packages/infomentor-mcp/src/store.js';

const rustBinary = process.env.INFOMENTOR_RUST_BINARY;

if (!rustBinary)
  throw new RangeError('INFOMENTOR_RUST_BINARY must name the Rust infomentor-mcp binary.');

// The binary keeps its store in scratch directories only through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError(
    'Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.',
  );

/** A closed loopback port: a case without an upstream can never reach InfoMentor. */
const NOWHERE = 'http://127.0.0.1:9';

export type Fetch = (input: URL, init: RequestInit) => Response | Promise<Response>;

type Upstream = { origin: string; close: () => Promise<void> };

async function body(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

async function answer(response: Response, out: ServerResponse): Promise<void> {
  out.statusCode = response.status;

  for (const [name, value] of response.headers)
    if (name !== 'set-cookie') out.setHeader(name, value);

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
 * Serve `request` on loopback. The binary sends `https://<host><path>` as
 * `<origin>/<host><path>`; `request` gets the InfoMentor URL back, with the method, headers,
 * body, an abort signal, and `redirect: 'manual'`, as the TypeScript client passes them. A
 * thrown error drops the connection, as a failed fetch. A loopback port scanner's requests never
 * reach it.
 */
async function upstream(request: Fetch): Promise<Upstream> {
  const server = createServer(async (incoming, out) => {
    const [, host = ''] = (incoming.url ?? '/').split('/');

    if (!host.endsWith('infomentor.is')) {
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
      response = await request(new URL(`https://${incoming.url!.slice(1)}`), {
        method: incoming.method,
        headers,
        body: await body(incoming),
        redirect: 'manual',
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
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
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

/**
 * Each reviewed message of the TypeScript sources with its code: the binary reports only the
 * message, and a case that checks the code gets it back from here.
 */
const codes = (() => {
  const source = join(import.meta.dir, '../../../../packages/infomentor-mcp/src');
  const found = new Map<string, ErrorCode>();

  for (const file of readdirSync(source).filter((name) => name.endsWith('.ts')))
    for (const [, code, message] of readFileSync(join(source, file), 'utf8').matchAll(
      /InfoMentorError\(\s*'([A-Z_]+)',\s*'([^']*)'/g,
    ))
      found.set(message!, code as ErrorCode);

  return found;
})();

/** A reviewed message becomes an `InfoMentorError` again; any other text stays an `Error`. */
function failure(message: string, exit?: number): Error {
  const code = exit === 130 ? 'CANCELLED' : codes.get(message);

  return code ? new InfoMentorError(code, message) : new Error(message);
}

/**
 * The binary reads only a key file, which follows XDG_DATA_HOME; a key file elsewhere in that
 * layout moves the data home with it.
 */
function keyEnvironment(keys?: KeyProvider): Record<string, string> {
  if (keys === undefined) return {};

  if (keys instanceof LocalKeyFileProvider && basename(keys.path) === 'infomentor-mcp.default.key')
    return { XDG_DATA_HOME: dirname(dirname(dirname(keys.path))) };
  throw new RangeError('The binary reads only its own key file; use a LocalKeyFileProvider.');
}

type SessionOptions = {
  sessionFile?: string;
  credentialsFile?: string;
  fetch?: Fetch;
  keys?: KeyProvider;
};

const sessionArgs = (options: SessionOptions): string[] =>
  options.sessionFile ? ['--session', options.sessionFile] : [];

/** One CLI command; a failure throws its diagnostic as the TypeScript function would. */
async function cli(
  args: string[],
  { fetch, keys, signal }: { fetch?: Fetch; keys?: KeyProvider; signal?: AbortSignal } = {},
): Promise<string> {
  const served = fetch ? await upstream(fetch) : undefined;

  try {
    const child = Bun.spawn([rustBinary!, ...args], {
      env: {
        ...process.env,
        ...keyEnvironment(keys),
        INFOMENTOR_TEST_ORIGIN: served?.origin ?? NOWHERE,
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // An aborted signal is the terminal's Ctrl-C.
    const interrupt = () => child.kill('SIGINT');
    signal?.addEventListener('abort', interrupt, { once: true });

    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]).finally(() => signal?.removeEventListener('abort', interrupt));

    if (exit !== 0) throw failure(stderr.trim(), exit);

    return stderr;
  } finally {
    await served?.close();
  }
}

type LoginOptions = SessionOptions & {
  timeoutMs?: number;
  signal?: AbortSignal;
  allowAccountChange?: boolean;
};

/**
 * `login`: the CLI's `login`. Its `--timeout` counts whole seconds, so a shorter timeout is one
 * second. Returns the credentials file its advice names.
 */
export async function login(options: LoginOptions = {}): Promise<string | undefined> {
  const out = await cli(
    [
      'login',
      ...sessionArgs(options),
      ...(options.credentialsFile ? ['--credentials', options.credentialsFile] : []),
      ...(options.timeoutMs === undefined
        ? []
        : ['--timeout', String(Math.max(1, Math.ceil(options.timeoutMs / 1000)))]),
      ...(options.allowAccountChange ? ['--allow-account-change'] : []),
    ],
    options,
  );

  return /You can delete (.*) now\.$/m.exec(out)?.[1];
}

/** `importSession`: the CLI's `login --import`. */
export async function importSession(
  file: string,
  options: Omit<LoginOptions, 'timeoutMs' | 'signal'> = {},
  signal?: AbortSignal,
): Promise<void> {
  await cli(
    [
      'login',
      '--import',
      file,
      ...sessionArgs(options),
      ...(options.allowAccountChange ? ['--allow-account-change'] : []),
    ],
    { ...options, signal },
  );
}

const outcomes: Record<string, MigrateResult> = {
  'Moved the InfoMentor session into the encrypted store and removed its file.': 'migrated',
  'The InfoMentor session is already in the encrypted store.': 'already',
  'The InfoMentor session is already in the encrypted store; removed the leftover plaintext file.':
    'already-removed-legacy',
};

/** `migrate`: the CLI's `migrate`. */
export async function migrate(
  legacy: string,
  credentialsFile?: string,
  keys?: KeyProvider,
): Promise<MigrateResult> {
  const out = await cli(
    [
      'migrate',
      '--session',
      legacy,
      ...(credentialsFile ? ['--credentials', credentialsFile] : []),
    ],
    { keys },
  );
  const outcome = outcomes[out.split('\n')[0]!];

  if (!outcome) throw new RangeError(`Unexpected migrate output: ${out}`);

  return outcome;
}

/** `logout`: the CLI's `logout`. */
export async function logout(legacy: string, keys?: KeyProvider): Promise<void> {
  await cli(['logout', '--session', legacy], { keys });
}

type Connection = { client: Client; close: () => Promise<void> };

/**
 * `InfoMentorClient(options)`: one `serve` for the client's life, started at its first call with
 * the environment of that moment, as each TypeScript operation reads it.
 */
export class InfoMentorClient {
  #connection: Promise<Connection> | undefined;

  constructor(private readonly options: SessionOptions = {}) {}

  getOverview = () => this.#call('infomentor_get_overview', {});
  selectChild = (input: object) => this.#call('infomentor_select_child', input);
  getMessages = (input: object = {}) => this.#call('infomentor_get_messages', input);
  getMessage = (input: object) => this.#call('infomentor_get_message', input);
  getNotifications = (input: object = {}) => this.#call('infomentor_get_notifications', input);
  collectUpdates = (input: object = {}) => this.#call('infomentor_collect_updates', input);
  getSessionStatus = () => this.#call('infomentor_session_status', {});

  /** Rust: the CLI's `logout` until the logout tool ports with the setup tools. */
  logout = async () => {
    await this.close();
    await logout(this.options.sessionFile!, this.options.keys);
  };

  close = async () => {
    const connection = this.#connection;
    this.#connection = undefined;
    await (await connection)?.close();
  };

  #connect(): Promise<Connection> {
    this.#connection ??= (async () => {
      const served = this.options.fetch ? await upstream(this.options.fetch) : undefined;
      const transport = new StdioClientTransport({
        command: rustBinary!,
        args: [
          'serve',
          ...sessionArgs(this.options),
          ...(this.options.credentialsFile ? ['--credentials', this.options.credentialsFile] : []),
        ],
        env: {
          ...(process.env as Record<string, string>),
          ...keyEnvironment(this.options.keys),
          INFOMENTOR_TEST_ORIGIN: served?.origin ?? NOWHERE,
        },
        stderr: 'pipe',
      });
      const client = new Client({ name: 'infomentor-rust-integration', version: '1.0.0' });
      await client.connect(transport);

      return {
        client,
        close: async () => {
          await client.close();
          await served?.close();
        },
      };
    })();

    return this.#connection;
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- Each method returns its tool's output.
  async #call(name: string, args: object): Promise<any> {
    const { client } = await this.#connect();
    const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
    const [content] = result.content as { text: string }[];

    if (result.isError) throw failure(content?.text ?? '');

    return result.structuredContent;
  }
}
