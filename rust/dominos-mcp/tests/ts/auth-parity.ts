import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { upstream } from './rust-dominos.ts';
import { profile } from './fixtures.ts';

export async function authParity(rust: string) {
  let count = 0;
  for (const [input, mode] of [
    ['5550123\n123456\n', 'ok'],
    ['+354 555-0123\n 123456 \n', 'ok'],
    ['bad\n123456\n', 'ok'],
    ['', 'ok'],
    ['5550123\n', 'ok'],
    ['5550123\n12345\n', 'ok'],
    ['5550123\n123456\n', '429'],
    ['5550123\n123456\n', '401'],
    ['5550123\n123456\n', 'invalid-token'],
    ['5550123\n123456\n', 'invalid-profile'],
    ['5550123\n123456\n', 'transport'],
  ]) {
    const results = [];
    for (const side of ['ts', 'rust']) {
      const home = mkdtempSync(join(tmpdir(), 'dominos-auth-parity-'));
      const seen: unknown[] = [];
      const fake = await upstream(async (url, options) => {
        const parsed = new URL(url);
        seen.push({
          path: parsed.pathname,
          query: parsed.search,
          method: options.method,
          authorization: new Headers(options.headers).get('authorization'),
          body: options.body ?? null,
        });
        if (parsed.pathname.endsWith('/sendPin')) return new Response('');
        if (mode === 'transport') throw new Error('synthetic-secret-cause');
        if (parsed.pathname.endsWith('/token')) {
          if (mode === '429' || mode === '401')
            return new Response('synthetic-secret-body', { status: Number(mode) });
          if (mode === 'invalid-token')
            return Response.json({ access_token: 'synthetic-secret-value' });
          return Response.json({
            access_token: 'parity-access',
            refresh_token: 'parity-refresh',
            expires_in: 3600,
            username: '3545550123',
            token_type: 'bearer',
          });
        }
        return Response.json(
          mode === 'invalid-profile' ? { secret: 'synthetic-secret-value' } : profile,
        );
      });
      try {
        const cli = resolve(import.meta.dir, '../../../../packages/dominos-mcp/src/cli.ts');
        const command =
          side === 'ts'
            ? [process.execPath, '--preload', join(import.meta.dir, 'rewrite.ts'), cli]
            : [rust];
        const child = Bun.spawn([...command, 'auth', 'login'], {
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: join(home, 'config'),
            XDG_DATA_HOME: join(home, 'data'),
            DOMINOS_TEST_ORIGIN: fake.origin,
          },
          stdin: new Blob([input!]),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        results.push({ exit, stdout, stderr, seen });
        assert.ok(!JSON.stringify({ stdout, stderr }).includes('synthetic-secret'));
        assert.ok(!JSON.stringify({ stdout, stderr }).includes('parity-access'));
      } finally {
        await fake.close();
        rmSync(home, { recursive: true, force: true });
      }
    }
    assert.deepEqual(results[1], results[0], `${mode}: ${JSON.stringify(input)}`);
    count++;
  }
  return count;
}
