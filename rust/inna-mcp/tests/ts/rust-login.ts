// The drop-in for packages/inna-mcp/src/login.ts in tests/ts/login.test.ts: each sign-in is one
// `inna-mcp auth login` of the Rust binary in INNA_RUST_BINARY, with the phone number on its
// standard input and its own scratch store. The case's fetch answers every sign-in host on a
// loopback upstream (INNA_TEST_ORIGIN). The binary records each poll wait in INNA_TEST_WAITS
// instead of sleeping, and they are replayed to the case's `wait`. The authenticate request is
// held until the binary has shown the security code, which then goes to `onCode`, so the case
// still sees the code before that request. The binary then verifies the school session with
// Inna's GetLoggedInUser, which this drop-in answers, and saves it; the returned jar is the
// saved one. A preferred user id is the default student of a session saved there beforehand,
// as the CLI reads it.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';

import { InnaClient } from '../../../../packages/inna-mcp/src/client.js';
import {
  readStored,
  storeAt,
  storeEnvironment,
} from '../../../../packages/inna-mcp/test/scratch.js';
import { failure, upstream, type Fetch } from './rust-inna.js';

const rustBinary = process.env.INNA_RUST_BINARY;

if (!rustBinary) throw new RangeError('INNA_RUST_BINARY must name the Rust inna-mcp binary.');

const HOSTS = ['r.inna.is', 'heimdallur.inna.is', 'innskra.island.is', 'inna.is', 'nam.inna.is'];

const CODE = /^Security code (\d{4}): verify the match/m;

/** The user Inna reports for the new school session: the saved default student, if any. */
const user = (userId: number) => ({
  userId,
  studentId: '2',
  schoolId: '3',
  studentName: 'Synthetic student',
  name: 'Synthetic guardian',
  schoolLong: 'Synthetic school',
  defaultTermId: '4',
  isGuardian: true,
  logInType: '2',
  olderThan18: false,
  registerAbsenceGuardian: '1',
  registerAbsenceUnder18: '0',
  registerAbsenceOver18: '1',
  registerAbsence: '1',
  student18RegisterAbsence: '1',
  registerLeave: '1',
  student18RegisterLeave: '1',
  registerIllnessTomorrow: '1',
});

export async function loginWithElectronicId(
  phone: string,
  onCode: (code: string) => void,
  options: {
    fetch?: Fetch;
    signal?: AbortSignal;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    preferredUserId?: number | undefined;
  } = {},
): Promise<CookieJar> {
  const fetcher = options.fetch;

  if (!fetcher) throw new RangeError('Each case gives its fetch: tests never reach Inna.');
  const home = mkdtempSync(join(tmpdir(), 'inna-login-'));
  const store = storeAt(home);
  const sessionFile = join(home, 'legacy', 'session.json');
  const userId = options.preferredUserId ?? 2;
  let stderr = '';
  let shown: (() => void) | undefined;
  const codeShown = new Promise<void>((resolve) => (shown = resolve));

  const served = await upstream(
    async (url, init) => {
      const { pathname, hostname } = new URL(url);

      if (hostname === 'nam.inna.is' && pathname === '/api/UserData/GetLoggedInUser')
        return Response.json(user(userId));

      if (hostname === 'innskra.island.is' && pathname === '/login/phone/authenticate') {
        await codeShown;
        onCode(CODE.exec(stderr)![1]!);
      }

      return fetcher(url, init);
    },
    () => {},
    HOSTS,
  );

  try {
    if (options.preferredUserId !== undefined) {
      const jar = new CookieJar();
      await jar.setCookie(
        'SESSION=synthetic-saved; Path=/; Secure; HttpOnly',
        'https://nam.inna.is/',
      );
      await jar.setCookie(
        'XSRF-TOKEN=synthetic-saved-xsrf; Path=/; Secure',
        'https://nam.inna.is/',
      );
      await new InnaClient({
        sessionFile,
        store,
        fetch: async () => Response.json(user(userId)),
      }).saveVerifiedSession(jar);
    }

    const child = Bun.spawn([rustBinary!, 'auth', 'login'], {
      env: {
        ...(process.env as Record<string, string>),
        ...storeEnvironment(home),
        INNA_SESSION_FILE: sessionFile,
        INNA_TEST_ORIGIN: served.origin,
        INNA_TEST_WAITS: join(home, 'waits'),
      },
      stdin: new TextEncoder().encode(`${phone}\n`),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const errors = (async () => {
      const decoder = new TextDecoder();

      for await (const chunk of child.stderr) {
        stderr += decoder.decode(chunk, { stream: true });

        if (CODE.test(stderr)) shown?.();
      }
    })();

    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      errors,
    ]);

    let waits: string[] = [];

    try {
      waits = readFileSync(join(home, 'waits'), 'utf8').split('\n').filter(Boolean);
    } catch {
      // No poll waited.
    }

    for (const milliseconds of waits)
      await options.wait?.(Number(milliseconds), new AbortController().signal);

    if (code !== 0) throw failure(stderr.replace(/\n$/, '').split('\n').at(-1) ?? '');

    if (!stdout.endsWith('Signed in. Saved in an encrypted file.\n'))
      throw new Error('The binary did not report a saved session.');

    return await CookieJar.deserialize(JSON.parse(JSON.parse(await readStored(store)).jar));
  } finally {
    await served.close();
    rmSync(home, { recursive: true, force: true });
  }
}
