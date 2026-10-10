// The unchanged synthetic TS fetch fixtures answer the binary through a loopback HTTP server.
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { SafeError } from '@family-mcp/mcp-runtime';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const rustBinary = process.env.DOMINOS_RUST_BINARY;
if (!rustBinary || process.env.FAMILY_MCP_STORE_TEST_SEAM !== '1')
  throw new Error('Binary and scratch store required.');
export type Fetch = (url: string, init: RequestInit) => Response | Promise<Response>;
type Upstream = { origin: string; close: () => Promise<void> };
async function body(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(chunk as Buffer);

  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

async function answer(response: Response, out: ServerResponse): Promise<void> {
  out.statusCode = response.status;

  for (const [name, value] of response.headers) out.setHeader(name, value);

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
 * Serve `request` on loopback. Each request reaches it as `the production Domino’s/Adyen URL` with the
 * method, headers, body and an abort signal, and `redirect: 'error'` (the binary never follows
 * one; the loopback case checks that). A thrown error drops the connection, as a failed fetch.
 * A loopback port scanner's `GET /` never reaches it.
 */
export async function upstream(request: Fetch): Promise<Upstream> {
  const server = httpServer(async (incoming, out) => {
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
      response = await request(
        incoming.url!.startsWith('/website/')
          ? `https://www.dominos.is${incoming.url!.slice(8)}`
          : incoming.url!.startsWith('/adyen/')
            ? `https://checkoutshopper-live.adyen.com${incoming.url!.slice(6)}`
            : `https://api.dominos.is${incoming.url}`,
        {
          method: incoming.method,
          headers,
          body: await body(incoming),
          redirect: 'error',
          signal: aborted.signal,
        },
      );
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

export class DominosClient {
  constructor(
    private readonly path: string,
    private readonly request: Fetch,
  ) {}
  private readonly active = new Set<Client>();
  async close() {
    await Promise.all([...this.active].map((client) => client.close()));
  }
  async serve() {
    const fake = await upstream(this.request);
    const transport = new StdioClientTransport({
      command: rustBinary!,
      args: ['serve'],
      env: {
        ...(process.env as Record<string, string>),
        DOMINOS_SESSION_FILE: this.path,
        DOMINOS_TEST_ORIGIN: fake.origin,
      },
      stderr: 'pipe',
    });
    return { transport, close: () => fake.close() };
  }
  // oxlint-disable-next-line typescript/no-explicit-any -- Each method returns its tool's output.
  async call(name: string, args: object = {}): Promise<any> {
    const served = await this.serve();
    const client = new Client({ name: 'dominos-rust-integration', version: '1' });
    this.active.add(client);
    try {
      await client.connect(served.transport);
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      if (result.isError) {
        const text = (result.content as { text: string }[])[0]?.text ?? '';
        throw new SafeError(text);
      }
      return result.structuredContent;
    } finally {
      await client.close();
      this.active.delete(client);
      await served.close();
    }
  }
  status = () => this.call('auth_status');
  profile = () => this.call('get_profile');
  stores = () => this.call('list_stores');
  searchMenu = (input: object = {}) => this.call('search_menu', input);
  menuItem = (input: object) => this.call('get_menu_item', input);
  addresses = (query: string) => this.call('search_addresses', { query });
  deliveryStore = (address: string, postalCode: string) =>
    this.call('get_delivery_store', { address, postalCode });
  receipts = () => this.call('list_receipts');
  tracker = () => this.call('get_tracker');
  quoteOrder = (input: object) => this.call('quote_order', input);
  createCheckout = (input: object) => this.call('create_checkout', input);
  getCheckout = (input: object) => this.call('get_checkout', input);
  paySavedCard = (input: object) => this.call('pay_saved_card', input);
}

/** CLI-backed auth functions; TS helpers only seed or inspect synthetic records. */
async function cli(args: string[], path: string, request?: Fetch, stdin?: string) {
  const fake = request ? await upstream(request) : undefined;
  try {
    const child = Bun.spawn([rustBinary!, ...args], {
      env: {
        ...process.env,
        DOMINOS_SESSION_FILE: path,
        DOMINOS_TEST_ORIGIN: fake?.origin ?? 'http://127.0.0.1:9',
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
    if (exit !== 0)
      throw new SafeError(
        stderr
          .replace(/^Icelandic phone number \(input hidden\): /, '')
          .replace(/^\nSMS sent\. Six-digit code \(input hidden\): /, '')
          .trim(),
      );
    return stdout;
  } finally {
    await fake?.close();
  }
}
export async function login(phone: string, pin: string, path: string, request: Fetch) {
  // The module-level TS login exchanges an already requested code. The CLI requests one first;
  // answer that extra request locally without calling the module fixture again. CLI parity
  // and prompt tests check the actual complete SMS sequence separately.
  const out = await cli(
    ['auth', 'login'],
    path,
    (url, options) => (url.includes('/sendPin') ? new Response('') : request(url, options)),
    `${phone}\n${pin}\n`,
  );
  return out.includes('was replaced.');
}
export async function requestCode(phone: string, request: Fetch) {
  try {
    await cli(
      ['auth', 'login'],
      `${process.env.XDG_CONFIG_HOME}/dominos-code.json`,
      request,
      `${phone}\n`,
    );
  } catch (error) {
    if ((error as Error).message === 'Sign-in cancelled.') return;
    throw error;
  }
}
export async function migrate(path: string) {
  const out = await cli(['auth', 'migrate'], path);
  if (out.startsWith('Domino’s session moved')) return 'migrated';
  if (out.startsWith('Already migrated. Removed')) return 'already-removed-legacy';
  if (out === 'Already migrated.\n') return 'already';
  throw new Error('Unexpected migrate result.');
}
export async function logout(path: string) {
  await cli(['auth', 'logout'], path);
}
export async function sessionStorage(path: string) {
  // No verification is required by the TS helper, but the CLI verifies after printing storage.
  // Answer that read locally; no credential or account result escapes this helper.
  return (
    await cli(['auth', 'status'], path, () =>
      Response.json({ id: 1, name: null, phoneNumber: '', email: null }),
    )
  ).split('\n')[0]!;
}
