// Drop-ins that run packages/inna-mcp/test/integration.test.ts against the Rust binary in
// INNA_RUST_BINARY. The TypeScript cases inject a fetch stand-in and a clock into the client;
// here that fetch answers the binary's requests on a loopback upstream (INNA_TEST_ORIGIN), and
// the clock is a file the binary reads at each use (INNA_TEST_NOW), written before each call and
// after each upstream answer. A client's reads are MCP tool calls to one `inna-mcp serve` for the
// client's life, and its keep-alive is that serve's own, ticked by SIGUSR1 (INNA_TEST_KEEP_ALIVE).
// An import, a migration and a logout are the binary's `auth` commands, against the same upstream
// and clock. `checkStore` and `defaultUserId` run only inside the binary's sign-in, and
// `saveVerifiedSession` and absence previews are not the binary's yet, so those four are still
// the TypeScript client's: they read and write the store and absence record the binary shares.
import { afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SafeError } from '@family-mcp/mcp-runtime';
import { LocalKeyFileProvider, type KeyProvider } from '@family-mcp/session-store';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import {
  InnaClient as TypeScriptClient,
  type ClientOptions,
  type KeepAlive,
} from '../../../../packages/inna-mcp/src/client.js';

const rustBinary = process.env.INNA_RUST_BINARY;

if (!rustBinary) throw new RangeError('INNA_RUST_BINARY must name the Rust inna-mcp binary.');

// The binary keeps its store in scratch directories only through the store test seam.
if (process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new RangeError(
    'Tests must keep FAMILY_MCP_STORE_TEST_SEAM=1; the real store is never used.',
  );

/** A closed loopback port: a case without an upstream can never reach Inna. */
const NOWHERE = 'http://127.0.0.1:9';

type Fetch = (url: string, options: RequestInit) => Promise<Response>;

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
  // The status goes out before the body, which may never come, as fetch resolves on headers.
  out.flushHeaders();
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
 * `<origin>/<host><path>`; `request` gets the Inna URL back, with the method, headers, body, an
 * abort signal, and `redirect: 'manual'`, as the TypeScript client passes them. A thrown error
 * drops the connection, as a failed fetch. `answered` runs before each answer goes back.
 */
async function upstream(request: Fetch, answered: () => void): Promise<Upstream> {
  const server = createServer(async (incoming, out) => {
    const [, host = ''] = (incoming.url ?? '/').split('/');

    if (host !== 'nam.inna.is') {
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
      response = await request(`https://${incoming.url!.slice(1)}`, {
        method: incoming.method,
        headers,
        body: await body(incoming),
        redirect: 'manual',
        signal: aborted.signal,
      });
    } catch {
      answered();
      incoming.socket.destroy();

      return;
    }

    answered();
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

/** Each reviewed message of the TypeScript sources: the binary reports only the text. */
const safeMessages = (() => {
  const source = join(import.meta.dir, '../../../../packages/inna-mcp/src');
  const found = new Set<string>();

  for (const file of readdirSync(source).filter((name) => name.endsWith('.ts')))
    for (const [, message] of readFileSync(join(source, file), 'utf8').matchAll(
      /new SafeError\(\s*'([^']*)'/g,
    ))
      found.add(message!);

  return found;
})();

/** A reviewed message becomes a `SafeError` again; any other text stays an `Error`. */
function failure(message: string): Error {
  return safeMessages.has(message) ? new SafeError(message) : new Error(message);
}

/**
 * The store the binary reads follows XDG_CONFIG_HOME and XDG_DATA_HOME through the store test
 * seam, so a store must be the layout `storeAt(home)` builds.
 */
function storeEnvironment(store?: { path: string; keys: KeyProvider }): Record<string, string> {
  if (store === undefined) return {};

  const config = dirname(dirname(store.path));
  const data =
    store.keys instanceof LocalKeyFileProvider && dirname(dirname(dirname(store.keys.path)));

  if (
    !data ||
    join(data, 'family-mcp', 'keys', 'inna-mcp.default.key') !== store.keys.path ||
    join(config, 'inna-mcp', 'session.enc') !== store.path
  )
    throw new RangeError('The binary reads only its own store layout; use storeAt(home).');

  return { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data };
}

type Served = {
  client: Client;
  transport: StdioClientTransport;
  /** Each keep-alive tick waiting for the status the binary reports next. */
  waiting: ((status: string) => void)[];
};

const open = new Set<() => Promise<void>>();

// Every serve a case started ends with it; one still reading a stalled body is killed.
afterEach(async () => {
  for (const close of [...open]) await close();
});

/**
 * In place of `createServer(options)` over an InMemoryTransport: the binary's `serve` over stdio,
 * with the options' fetch, clock and store. Connect a client to `transport`; `close` stops the
 * binary and the upstream once the client has closed.
 */
/**
 * The options' fetch on a loopback upstream and their clock in a file, for the binary's runs:
 * `env` is a run's environment, `tick` writes the clock, and `close` ends both with the case.
 */
async function harness(options: ClientOptions) {
  const clock = options.now && mkdtempSync(join(tmpdir(), 'inna-clock-'));
  const now = options.now;
  const tick = () => clock && now && writeFileSync(join(clock, 'now'), String(now()));
  tick();
  const served = options.fetch ? await upstream(options.fetch, tick) : undefined;
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    open.delete(close);
    await served?.close();

    if (clock) rmSync(clock, { recursive: true, force: true });
  };

  open.add(close);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(options.sessionFile ? { INNA_SESSION_FILE: options.sessionFile } : {}),
    ...storeEnvironment(options.store),
    ...(clock ? { INNA_TEST_NOW: join(clock, 'now') } : {}),
    INNA_TEST_ORIGIN: served?.origin ?? NOWHERE,
    INNA_TEST_KEEP_ALIVE: '1',
  };

  return { env, tick, close };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/**
 * In place of `createServer(options)` over an InMemoryTransport: the binary's `serve` over stdio,
 * with the options' fetch, clock and store. Connect a client to `transport`; `close` stops the
 * binary once the client has closed, and the upstream unless a client shares it.
 */
export async function serveStdio(options: ClientOptions = {}, shared?: Harness) {
  const run = shared ?? (await harness(options));

  const transport = new StdioClientTransport({
    command: rustBinary!,
    args: ['serve', ...(options.allowAbsenceWrites ? ['--allow-absence-writes'] : [])],
    env: run.env,
    stderr: 'pipe',
  });

  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    open.delete(close);
    const pid = transport.pid;
    await transport.close().catch(() => {});

    try {
      if (pid) process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }

    if (!shared) await run.close();
  };

  open.add(close);

  return { transport, tick: run.tick, close };
}

const MIGRATED: Record<string, Awaited<ReturnType<TypeScriptClient['migrate']>>> = {
  'Inna session moved to the encrypted store; the plaintext file was removed.\n': 'migrated',
  'Already migrated.\n': 'already',
  'Already migrated. Removed the leftover plaintext session file.\n': 'already-removed-legacy',
};

/**
 * `InnaClient(options)`: one `serve` for the client's life, started at its first read with the
 * environment of that moment.
 */
export class InnaClient {
  readonly path: string;
  #harness: Promise<Harness> | undefined;
  #served: Promise<Served> | undefined;
  #typescript: TypeScriptClient;

  constructor(private readonly options: ClientOptions = {}) {
    this.#typescript = new TypeScriptClient(options);
    this.path = this.#typescript.path;
  }

  status = (signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_session_status', { studentKey }, signal);
  listStudents = (signal?: AbortSignal) => this.#call('inna_list_students', {}, signal);
  overview = (signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_overview', { studentKey }, signal);
  timetable = (input: object, signal?: AbortSignal) =>
    this.#call('inna_get_timetable', input, signal);
  assignments = (type: string, signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_assignments', { type, studentKey }, signal);
  assignment = (assignmentId: string, signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_assignment', { assignmentId, studentKey }, signal);
  grades = (termId?: string, signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_grades', { termId, studentKey }, signal);
  courseGrades = (groupId: string, signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_course_grades', { groupId, studentKey }, signal);
  // The TypeScript client reads an empty termId as none.
  attendance = (termId = '', signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_attendance', { termId: termId || undefined, studentKey }, signal);
  materials = (groupId: string, signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_materials', { groupId, studentKey }, signal);
  // The TypeScript client's own default end row is 21, whatever the first row.
  messages = (rowFrom = 1, rowTo = 21, signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_messages', { rowFrom, rowTo, studentKey }, signal);
  message = (messageId: string, type: string, signal?: AbortSignal, studentKey?: string) =>
    this.#call('inna_get_message', { messageId, type, studentKey }, signal);
  absences = (input: object, signal?: AbortSignal) =>
    this.#call('inna_get_absences', input, signal);
  absenceStatus = (signal?: AbortSignal) => this.#call('inna_absence_status', {}, signal);

  importSession = async (source: string, allowAccountChange = false) => {
    const stdout = await this.#cli([
      'auth',
      'import',
      source,
      ...(allowAccountChange ? ['--allow-account-change'] : []),
    ]);

    return {
      storage: /^Signed in\. (.*)\n$/m.exec(stdout)?.[1],
      replaced: stdout.startsWith('The old Inna session store could not be read'),
    };
  };
  migrate = async () => MIGRATED[await this.#cli(['auth', 'migrate'])];
  logout = async () => {
    await this.#cli(['auth', 'logout']);
  };
  saveVerifiedSession = (...args: Parameters<TypeScriptClient['saveVerifiedSession']>) =>
    this.#typescript.saveVerifiedSession(...args);
  checkStore = () => this.#typescript.checkStore();
  defaultUserId = () => this.#typescript.defaultUserId();
  prepareAbsence = (...args: Parameters<TypeScriptClient['prepareAbsence']>) =>
    this.#typescript.prepareAbsence(...args);

  /** One tick of the binary's own keep-alive. The signal is the scheduler's; ticks end by themselves. */
  keepAlive = async (_signal?: AbortSignal): Promise<KeepAlive> => {
    const served = await this.#serve();
    (await this.#harness)?.tick();
    const status = new Promise<string>((resolve) => served.waiting.push(resolve));
    process.kill(served.transport.pid!, 'SIGUSR1');

    return { status: (await status) as KeepAlive['status'] };
  };

  #run(): Promise<Harness> {
    this.#harness ??= harness(this.options);

    return this.#harness;
  }

  /** One `inna-mcp` command line; its stdout, or its stderr line as the failure. */
  async #cli(args: string[]): Promise<string> {
    const run = await this.#run();
    run.tick();
    const child = Bun.spawn([rustBinary!, ...args], {
      env: run.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    if (code !== 0) throw failure(stderr.replace(/\n$/, ''));

    return stdout;
  }

  #serve(): Promise<Served> {
    this.#served ??= (async () => {
      const served = await serveStdio(this.options, await this.#run());
      const client = new Client({ name: 'inna-rust-integration', version: '1.0.0' });
      const waiting: ((status: string) => void)[] = [];
      let buffered = '';

      served.transport.stderr?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';

        for (const line of lines) {
          const status = /^keep-alive: (\w+)$/.exec(line)?.[1];

          if (status) waiting.shift()?.(status);
        }
      });
      await client.connect(served.transport);

      return { client, transport: served.transport, waiting };
    })();

    return this.#served;
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- Each method returns its tool's output.
  async #call(name: string, args: object, signal?: AbortSignal): Promise<any> {
    const { client } = await this.#serve();
    (await this.#harness)?.tick();
    // JSON leaves out undefined arguments, as the TypeScript client's defaults leave them unset.
    const call = client.callTool({
      name,
      arguments: JSON.parse(JSON.stringify(args)) as Record<string, unknown>,
    });
    // An aborted call rejects with its reason, as the TypeScript client's would; the binary's own
    // request runs on until its deadline.
    const aborted = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
      : undefined;
    const result = await (aborted ? Promise.race([call, aborted]) : call);
    const [content] = result.content as { text: string }[];

    if (result.isError) throw failure(content?.text ?? '');

    return result.structuredContent;
  }
}
