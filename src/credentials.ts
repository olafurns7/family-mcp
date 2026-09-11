import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { z } from 'zod';
import { InfoMentorError, throwIfAborted } from './session.js';

export const credentialsSchema = z
  .object({ username: z.string().min(1).max(512), password: z.string().min(1).max(4096) })
  .strict();

export type Credentials = z.infer<typeof credentialsSchema>;

export async function readCredentials(file: string, signal?: AbortSignal): Promise<Credentials> {
  throwIfAborted(signal);

  try {
    const handle = await open(file, 'r');

    try {
      const info = await handle.stat();

      if (
        !info.isFile() ||
        info.size > 16_384 ||
        (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      ) {
        throw new InfoMentorError(
          'INVALID_CONFIGURATION',
          'Use a private credentials JSON file (chmod 600) containing username and password.',
        );
      }

      const value = credentialsSchema.parse(
        JSON.parse(await handle.readFile({ encoding: 'utf8', signal })),
      );

      throwIfAborted(signal);

      return value;
    } finally {
      await handle.close();
    }
  } catch (error) {
    throwIfAborted(signal);

    if (error instanceof InfoMentorError) throw error;
    throw new InfoMentorError(
      'INVALID_CONFIGURATION',
      'Cannot read valid credentials. Supply a private JSON file containing username and password.',
    );
  }
}

/** The local form collects credentials only; all InfoMentor traffic uses direct HTTPS. */
export async function promptCredentials(
  signal: AbortSignal,
  onReady?: (url: string) => void,
): Promise<Credentials> {
  throwIfAborted(signal);
  const pending = Promise.withResolvers<Credentials>();
  const path = '/' + randomUUID();
  const csrf = randomUUID();
  let origin = '';

  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );

    if (request.headers.host !== new URL(origin).host || request.url !== path) {
      response.writeHead(404).end();

      return;
    }

    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>InfoMentor MCP sign in</title><style>body{font:18px system-ui;max-width:28rem;margin:12vh auto;padding:1.5rem}label,input,button{display:block}input,button{box-sizing:border-box;width:100%;font:inherit;padding:.65rem;margin:.4rem 0 1rem}p{line-height:1.5}</style><h1>Sign in to InfoMentor</h1><p>This local InfoMentor MCP form sends your credentials directly to InfoMentor over HTTPS. Only session cookies are saved.</p><form method="post" action="${path}"><input type="hidden" name="csrf" value="${csrf}"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required maxlength="512"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="4096"><button>Sign in</button></form><p>Credentials are never sent to your AI assistant.</p></html>`,
      );

      return;
    }

    if (
      request.method !== 'POST' ||
      request.headers.origin !== origin ||
      request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded'
    ) {
      response.writeHead(403).end();

      return;
    }

    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;

      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;

        if (size > 16_384) {
          response.writeHead(413).end();

          return;
        }

        chunks.push(bytes);
      }

      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));

      if (form.get('csrf') !== csrf) {
        response.writeHead(403).end();

        return;
      }

      const parsed = credentialsSchema.safeParse({
        username: form.get('username'),
        password: form.get('password'),
      });

      if (!parsed.success) {
        response.writeHead(400).end('Enter a username and password.');

        return;
      }

      throwIfAborted(signal);
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end(
        'Credentials received. You can close this page. Check the CLI or MCP setup status for the sign-in result.',
      );
      pending.resolve(parsed.data);
    })().catch(() => {
      response.writeHead(400).end();
    });
  });

  server.requestTimeout = 15_000;

  const cancel = (): void =>
    pending.reject(
      new InfoMentorError('CANCELLED', 'Login cancelled. The previous session was kept.'),
    );

  signal.addEventListener('abort', cancel, { once: true });
  server.on('error', () =>
    pending.reject(
      new InfoMentorError(
        'INVALID_CONFIGURATION',
        'Cannot open the local sign-in form. Use a credentials file instead.',
      ),
    ),
  );
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();

    // Node returns a string for Unix sockets; this listener always uses TCP.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (!address || typeof address === 'string') return;
    origin = `http://127.0.0.1:${address.port}`;
    const url = origin + path;
    onReady?.(url);

    if (
      process.platform === 'darwin' ||
      process.platform === 'win32' ||
      process.env['DISPLAY'] ||
      process.env['WAYLAND_DISPLAY']
    ) {
      const child =
        process.platform === 'darwin'
          ? spawn('open', [url], { stdio: 'ignore' })
          : process.platform === 'win32'
            ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], { stdio: 'ignore' })
            : spawn('xdg-open', [url], { stdio: 'ignore' });

      child.on('error', () => {});
      child.unref();
    }
  });

  if (signal.aborted) cancel();

  try {
    return await pending.promise;
  } finally {
    signal.removeEventListener('abort', cancel);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
