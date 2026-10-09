import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FakeKeyProvider,
  LocalKeyFileProvider,
  SessionStoreError,
  createSecretKey,
  existingPaths,
  readSecretRecord,
  resetSecretStore,
  secretStoreExists,
  withSecretRecord,
  withSecretStore,
  writePrivateFile,
  type KeyProvider,
  type SecretRecordOptions,
} from '../src/index.js';

const worker = fileURLToPath(new URL('./secret-worker.ts', import.meta.url));

const KEY = new Uint8Array(32).fill(7);

const SECRET = 'refresh-token-c2VjcmV0';

const hasCode =
  (code: string) =>
  (cause: unknown): boolean =>
    cause instanceof SessionStoreError && cause.code === code;

async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'session-store-secret-'));

  try {
    await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function options(
  directory: string,
  keys: KeyProvider = new FakeKeyProvider(KEY),
  maxBytes = 1024,
): SecretRecordOptions {
  return {
    path: join(directory, 'records', 'session.enc'),
    server: 'test-mcp',
    profile: 'default',
    purpose: 'session',
    schema: 1,
    keys,
    maxBytes,
  };
}

const flip = (text: string, at: number): string =>
  `${text.slice(0, at)}${text[at] === 'A' ? 'B' : 'A'}${text.slice(at + 1)}`;

const pending = (marker: string, generation: number, nonce: string): string =>
  marker.replace('}\n', `,"pending":{"generation":${generation},"nonce":"${nonce}"}}\n`);

const put = (store: SecretRecordOptions, value: string): Promise<string | null> =>
  withSecretRecord(store, async () => value);

const nonceOf = (record: string): string => /"nonce":"([\w-]+)"/.exec(record)?.[1] ?? '';

const MAX_INTEGER = 999_999_999_999_999;

/** A transaction that fails with `code` before its update callback runs. */
async function refuses(store: SecretRecordOptions, code: string): Promise<void> {
  let called = false;

  await assert.rejects(
    withSecretRecord(store, async () => {
      called = true;

      return 'changed';
    }),
    hasCode(code),
  );
  expect(called).toBe(false);
}

/** Seal a record directly, for generations a test cannot reach by writing. */
function forge(store: SecretRecordOptions, generation: number, plaintext: string): string {
  const nonce = randomBytes(12);

  const header = JSON.stringify({
    v: 1,
    server: store.server,
    profile: store.profile,
    purpose: store.purpose,
    schema: store.schema,
    generation,
    keyId: store.keys.keyId,
    nonce: nonce.toString('base64url'),
  });

  const cipher = createCipheriv('aes-256-gcm', KEY, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(header, 'utf8'));

  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return `${header}\n${body.toString('base64url')}\n`;
}

test('records round-trip as owner-only ciphertext with a committed marker per generation', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    expect(await withSecretRecord(store, async () => undefined)).toBeNull();
    await assert.rejects(readSecretRecord(store), hasCode('SECRET_NOT_FOUND'));

    expect(await put(store, SECRET)).toBe(SECRET);
    expect(await put(store, `${SECRET}-2`)).toBe(`${SECRET}-2`);
    expect(await readSecretRecord(store)).toBe(`${SECRET}-2`);
    expect(await withSecretRecord(store, async () => undefined)).toBe(`${SECRET}-2`);

    const record = await readFile(store.path, 'utf8');
    expect(record).not.toContain(SECRET);
    expect(record.split('\n')[0]).toMatch(/^\{"v":1,"server":"test-mcp",.*"generation":2,/);

    expect(await readFile(`${store.path}.marker`, 'utf8')).toBe(
      '{"backend":"test","keySource":"memory","keyId":"test","profile":"default","migrated":true,"generation":2}\n',
    );

    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${store.path}.marker`)).mode & 0o777).toBe(0o600);

    // Another purpose, schema or profile never opens this record.
    for (const other of [{ purpose: 'journal' }, { schema: 2 }, { server: 'other-mcp' }])
      await assert.rejects(readSecretRecord({ ...store, ...other }), hasCode('STORE_ERROR'));
  });
});

test('1 MiB payloads round-trip and size bounds are enforced', async () => {
  await scratch(async (directory) => {
    const store = options(directory, undefined, 1_048_576);
    const payload = 'x'.repeat(1_048_576);
    await put(store, payload);
    expect(await readSecretRecord(store)).toBe(payload);
    await assert.rejects(put(store, `${payload}y`), hasCode('TOO_LARGE'));
    expect(await readSecretRecord(store)).toBe(payload);
    await assert.rejects(readSecretRecord({ ...store, maxBytes: 1024 }), hasCode('TOO_LARGE'));
  });
});

test('header tampering, ciphertext tampering and a wrong key are one STORE_ERROR', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    await put(store, SECRET);
    const original = await readFile(store.path, 'utf8');
    const [header = '', body = ''] = original.split('\n');

    const tampered = [
      `${header.replace('"schema":1', '"schema":2')}\n${body}\n`,
      `${flip(header, header.indexOf('"nonce":"') + 9)}\n${body}\n`,
      `${header}\n${flip(body, 3)}\n`,
      `${header}\n${body}A\n`,
      `${header}\n${body}\n\n`,
    ];

    for (const text of tampered) {
      await writePrivateFile(store.path, text);
      await assert.rejects(readSecretRecord(store), hasCode('STORE_ERROR'));
    }

    await writePrivateFile(store.path, original);
    expect(await readSecretRecord(store)).toBe(SECRET);

    const wrongKey = { ...store, keys: new FakeKeyProvider(new Uint8Array(32).fill(8)) };
    await assert.rejects(readSecretRecord(wrongKey), hasCode('STORE_ERROR'));
    await assert.rejects(put(wrongKey, 'x'), hasCode('STORE_ERROR'));
    expect(await readFile(store.path, 'utf8')).toBe(original);

    const otherKeyId = { ...store, keys: new FakeKeyProvider(KEY, 'rotated') };
    await assert.rejects(readSecretRecord(otherKeyId), hasCode('STORE_ERROR'));
  });
});

test('a missing key is STORE_UNAVAILABLE and is never regenerated', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'keys', 'test-mcp.key');
    const keys = new LocalKeyFileProvider({ path: keyPath });
    const store = options(directory, keys);
    await assert.rejects(readSecretRecord(store), hasCode('STORE_UNAVAILABLE'));
    await assert.rejects(put(store, SECRET), hasCode('STORE_UNAVAILABLE'));

    await createSecretKey(store);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'keys'))).mode & 0o777).toBe(0o700);
    expect((await readFile(keyPath)).length).toBe(32);
    await put(store, SECRET);

    await assert.rejects(createSecretKey(store), hasCode('STORE_ERROR'));
    await rm(keyPath);
    await assert.rejects(createSecretKey(store), hasCode('STORE_ERROR'));
    await assert.rejects(readSecretRecord(store), hasCode('STORE_UNAVAILABLE'));
    await assert.rejects(put(store, 'x'), hasCode('STORE_UNAVAILABLE'));
    await assert.rejects(stat(keyPath));

    // Even without a store, an existing key file is never replaced.
    const fresh = options(join(directory, 'fresh'), keys);
    await writePrivateFile(keyPath, KEY);
    await assert.rejects(createSecretKey(fresh), hasCode('STORE_ERROR'));
    expect(new Uint8Array(await readFile(keyPath))).toEqual(KEY);
  });
});

test('reset removes an undecryptable store only while its key is missing', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'keys', 'test-mcp.key');
    const store = options(directory, new LocalKeyFileProvider({ path: keyPath }));
    await createSecretKey(store);
    await put(store, SECRET);

    // A readable store, or a key failure other than a missing key, is never reset.
    await assert.rejects(resetSecretStore(store), hasCode('STORE_ERROR'));

    const locked: KeyProvider = {
      backend: 'encrypted-file',
      keySource: 'local-file',
      keyId: 'local',
      getKey: () => Promise.reject(new SessionStoreError('STORE_LOCKED', 'Locked.')),
      createKey: () => Promise.reject(new Error('Not called.')),
    };

    await assert.rejects(resetSecretStore({ ...store, keys: locked }), hasCode('STORE_LOCKED'));
    expect(await readSecretRecord(store)).toBe(SECRET);

    expect(await secretStoreExists(store.path)).toBe(true);
    await rm(keyPath);
    await resetSecretStore(store);
    await assert.rejects(stat(store.path), { code: 'ENOENT' });

    // The marker is rewritten, never removed: the store still decides after a crash here.
    expect(await readFile(`${store.path}.marker`, 'utf8')).toBe(
      '{"backend":"encrypted-file","keySource":"local-file","keyId":"local","profile":"default","migrated":false,"generation":0}\n',
    );
    expect(await secretStoreExists(store.path)).toBe(true);
    await assert.rejects(readSecretRecord(store), hasCode('STORE_UNAVAILABLE'));
    await resetSecretStore(store);

    await createSecretKey(store);
    await assert.rejects(readSecretRecord(store), hasCode('SECRET_NOT_FOUND'));
    await assert.rejects(createSecretKey(store), hasCode('STORE_ERROR'));
    expect(await put(store, 'next')).toBe('next');
    expect(await readSecretRecord(store)).toBe('next');
  });
});

test('a key is created only for an empty store whose key is conclusively missing', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'keys', 'test-mcp.key');
    const store = options(directory, new LocalKeyFileProvider({ path: keyPath }));
    const marker = `${store.path}.marker`;
    expect(await secretStoreExists(store.path)).toBe(false);

    const empty =
      '{"backend":"encrypted-file","keySource":"local-file","keyId":"local","profile":"default","migrated":false,"generation":0}\n';

    // A pending first write, or a marker past generation 0, is never set up again.
    for (const text of [
      pending(empty, 1, 'AAAAAAAAAAAAAAAA'),
      empty.replace('"migrated":false,"generation":0', '"migrated":true,"generation":1'),
    ]) {
      await writePrivateFile(marker, text);
      await assert.rejects(createSecretKey(store), hasCode('STORE_ERROR'));
      await assert.rejects(stat(keyPath), { code: 'ENOENT' });
    }

    // A generation-0 marker with a readable key is refused; with a locked key the error stays.
    await writePrivateFile(marker, empty);
    await writePrivateFile(keyPath, KEY);
    await assert.rejects(createSecretKey(store), hasCode('STORE_ERROR'));
    await rm(keyPath);

    const locked: KeyProvider = {
      backend: 'encrypted-file',
      keySource: 'local-file',
      keyId: 'local',
      getKey: () => Promise.reject(new SessionStoreError('STORE_LOCKED', 'Locked.')),
      createKey: () => Promise.reject(new Error('Not called.')),
    };

    await assert.rejects(createSecretKey({ ...store, keys: locked }), hasCode('STORE_LOCKED'));

    await createSecretKey(store);
    expect((await readFile(keyPath)).length).toBe(32);
    expect(await put(store, SECRET)).toBe(SECRET);
  });
});

test('withSecretStore holds one lock across setup, reads and writes', async () => {
  await scratch(async (directory) => {
    const store = options(directory, new FakeKeyProvider());

    const result = await withSecretStore(store, async (held) => {
      expect(await held.exists()).toBe(false);
      await held.createKey();
      expect(await held.update(async () => undefined)).toBeNull();
      expect(await held.exists()).toBe(false);
      expect(await held.update(async () => SECRET)).toBe(SECRET);

      // Another caller waits for this hold instead of interleaving.
      await assert.rejects(
        withSecretRecord({ ...store, waitMs: 0 }, async () => 'other'),
        hasCode('BUSY'),
      );

      return held.exists();
    });

    expect(result).toBe(true);
    expect(await readSecretRecord(store)).toBe(SECRET);
  });
});

test('withSecretStore commits every write in one hold as its own generation', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    const markerPath = `${store.path}.marker`;

    await withSecretStore(store, async (held) => {
      expect(await held.read()).toBeNull();
      await held.write('one');
      expect(await readFile(markerPath, 'utf8')).toContain('"generation":1}');
      await held.write('two');
      expect(await held.read()).toBe('two');
      await held.write('three');
      expect(await readFile(markerPath, 'utf8')).toContain('"generation":3}');
    });

    expect(await readSecretRecord(store)).toBe('three');

    // A write without a read first loads the store itself.
    await withSecretStore(store, (held) => held.write('four'));
    expect(await readSecretRecord(store)).toBe('four');
    expect(await readFile(markerPath, 'utf8')).toContain('"generation":4}');
  });
});

test('a withSecretStore handle stops working after its hold or a failed write', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    const markerPath = `${store.path}.marker`;
    const leaked = await withSecretStore(store, async (held) => held);

    for (const call of [
      () => leaked.read(),
      () => leaked.write('late'),
      () => leaked.update(async () => 'late'),
      () => leaked.exists(),
      () => leaked.createKey(),
      () => leaked.reset(),
    ])
      await assert.rejects(call(), hasCode('STORE_ERROR'));
    await assert.rejects(stat(markerPath));

    await withSecretStore(store, async (held) => {
      expect(await held.read()).toBeNull();
      // The record path cannot be replaced, so the write fails after its pending marker.
      await mkdir(join(store.path, 'blocked'), { recursive: true });
      await assert.rejects(held.write('lost'), hasCode('STORE_WRITE_UNCERTAIN'));
      await assert.rejects(held.read(), hasCode('STORE_WRITE_UNCERTAIN'));
      await assert.rejects(held.write('again'), hasCode('STORE_WRITE_UNCERTAIN'));
    });

    // The next hold finds the write never committed and drops it.
    await rm(store.path, { recursive: true });
    expect(await readFile(markerPath, 'utf8')).toContain('"pending"');
    await withSecretStore(store, async (held) => expect(await held.read()).toBeNull());
    expect(await readFile(markerPath, 'utf8')).not.toContain('"pending"');

    // A write refused before any file changed keeps its code and still ends the handle.
    await withSecretStore({ ...store, maxBytes: 4 }, async (held) => {
      await assert.rejects(held.write('too large'), hasCode('TOO_LARGE'));
      await assert.rejects(held.write('ok'), hasCode('TOO_LARGE'));
    });

    // A write that fails while opening the store ends the handle too, though the key then works.
    let refusals = 0;

    const flaky: KeyProvider = {
      backend: 'test',
      keySource: 'memory',
      keyId: 'test',
      createKey: async () => undefined,
      getKey: async () => {
        if (refusals++ === 0) throw new SessionStoreError('STORE_LOCKED', 'synthetic refusal');

        return KEY;
      },
    };

    await withSecretStore(options(directory, flaky), async (held) => {
      await assert.rejects(held.write('first'), hasCode('STORE_LOCKED'));
      await assert.rejects(held.write('second'), hasCode('STORE_LOCKED'));
      await assert.rejects(held.read(), hasCode('STORE_LOCKED'));
    });
    expect(refusals).toBe(1);
    await assert.rejects(readSecretRecord(store), hasCode('SECRET_NOT_FOUND'));
  });
});

test('key files must be single-link, owner-only regular files of exactly 32 bytes', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'keys', 'test-mcp.key');
    const store = options(directory, new LocalKeyFileProvider({ path: keyPath }));
    await writePrivateFile(keyPath, KEY);
    await put(store, SECRET);

    const alias = join(directory, 'alias.key');
    await symlink(keyPath, alias);
    const linked = options(directory, new LocalKeyFileProvider({ path: alias }));
    await assert.rejects(readSecretRecord(linked), hasCode('UNSAFE_FILE'));
    await rm(alias);

    await link(keyPath, alias);
    await assert.rejects(readSecretRecord(store), hasCode('UNSAFE_FILE'));
    await rm(alias);

    for (const mode of [0o640, 0o604, 0o620]) {
      await chmod(keyPath, mode);
      await assert.rejects(readSecretRecord(store), hasCode('UNSAFE_FILE'));
    }

    await chmod(keyPath, 0o400);
    expect(await readSecretRecord(store)).toBe(SECRET);

    for (const bad of [KEY.subarray(1), new Uint8Array(33), Buffer.from(KEY).toString('hex')]) {
      await writePrivateFile(keyPath, bad);
      await assert.rejects(readSecretRecord(store), hasCode('STORE_ERROR'));
    }
  });
});

test('an interrupted write is committed or dropped by where it stopped, and nothing else is guessed', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    const markerPath = `${store.path}.marker`;
    await put(store, 'one');
    const record1 = await readFile(store.path, 'utf8');
    const marker1 = await readFile(markerPath, 'utf8');
    const marker2 = marker1.replace('"generation":1', '"generation":2');
    await put(store, 'two');
    const record2 = await readFile(store.path, 'utf8');
    const nonce2 = nonceOf(record2);

    // Crash after the record rename, before the marker commit: the candidate is committed.
    await writePrivateFile(markerPath, pending(marker1, 2, nonce2));
    expect(await readSecretRecord(store)).toBe('two');
    expect(await readFile(markerPath, 'utf8')).toBe(marker2);

    // Crash before the record rename: the write never committed, so generation 1 is kept.
    await writePrivateFile(store.path, record1);
    await writePrivateFile(markerPath, pending(marker1, 2, nonce2));
    expect(await readSecretRecord(store)).toBe('one');
    expect(await readFile(markerPath, 'utf8')).toBe(marker1);
    await put(store, 'three');
    expect(await readSecretRecord(store)).toBe('three');
    expect(await readFile(markerPath, 'utf8')).toBe(marker2);
    await put(store, 'four');
    const record3 = await readFile(store.path, 'utf8');

    const uncertain = [
      // The exact announced candidate, but pending moves backward or skips a generation.
      { record: record1, marker: pending(marker2, 1, nonceOf(record1)) },
      { record: record3, marker: pending(marker1, 3, nonceOf(record3)) },
      // A record at the pending generation that is not the announced candidate.
      { record: record2, marker: pending(marker1, 2, 'AAAAAAAAAAAAAAAA') },
      // A pending generation that is not the next one, or a record at neither generation.
      { record: record2, marker: pending(marker1, 3, nonce2) },
      { record: record1, marker: pending(marker2, 3, nonce2) },
      // A stale marker, or a marker ahead of a rolled-back record.
      { record: record2, marker: marker1 },
      { record: record1, marker: marker2 },
    ];

    for (const state of uncertain) {
      await writePrivateFile(store.path, state.record);
      await writePrivateFile(markerPath, state.marker);
      await assert.rejects(readSecretRecord(store), hasCode('STORE_WRITE_UNCERTAIN'));
      await refuses(store, 'STORE_WRITE_UNCERTAIN');
      expect(await readFile(store.path, 'utf8')).toBe(state.record);
      expect(await readFile(markerPath, 'utf8')).toBe(state.marker);
    }

    await rm(markerPath);
    await assert.rejects(readSecretRecord(store), hasCode('STORE_WRITE_UNCERTAIN'));

    await writePrivateFile(markerPath, marker1);
    await rm(store.path);
    await assert.rejects(readSecretRecord(store), hasCode('STORE_WRITE_UNCERTAIN'));
    await assert.rejects(put(store, 'four'), hasCode('STORE_WRITE_UNCERTAIN'));
    await assert.rejects(stat(store.path));

    await writePrivateFile(markerPath, marker1.replace('"keyId":"test"', '"keyId":"other"'));
    await assert.rejects(readSecretRecord(store), hasCode('STORE_ERROR'));
    await writePrivateFile(markerPath, '{"backend":"test"}\n');
    await assert.rejects(readSecretRecord(store), hasCode('STORE_ERROR'));
  });
});

test('a first write that stopped before its record leaves an empty store', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    const markerPath = `${store.path}.marker`;

    const empty =
      '{"backend":"test","keySource":"memory","keyId":"test","profile":"default","migrated":false,"generation":0}\n';

    await writePrivateFile(
      markerPath,
      empty.replace('}\n', ',"pending":{"generation":1,"nonce":"AAAAAAAAAAAAAAAA"}}\n'),
    );
    await assert.rejects(readSecretRecord(store), hasCode('SECRET_NOT_FOUND'));
    expect(await readFile(markerPath, 'utf8')).toBe(empty);
    await put(store, 'one');
    expect(await readSecretRecord(store)).toBe('one');
    expect(await readFile(markerPath, 'utf8')).toBe(
      empty.replace('"migrated":false,"generation":0', '"migrated":true,"generation":1'),
    );
  });
});

test('error messages contain no path, key or secret', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'keys', 'test-mcp.key');
    const store = options(directory, new LocalKeyFileProvider({ path: keyPath }));
    const errors: unknown[] = [];

    const capture = async (attempt: Promise<unknown>): Promise<void> => {
      try {
        await attempt;
      } catch (error) {
        errors.push(error);
      }
    };

    await capture(readSecretRecord(store));
    await writePrivateFile(keyPath, KEY);
    await capture(readSecretRecord(store));
    await put(store, SECRET);
    await capture(put(store, SECRET.repeat(100)));
    await capture(readSecretRecord({ ...store, keys: new FakeKeyProvider(new Uint8Array(32)) }));
    await writePrivateFile(`${store.path}.marker`, '{}\n');
    await capture(readSecretRecord(store));
    await chmod(keyPath, 0o644);
    await capture(readSecretRecord(store));

    const codes = errors.map((error) => (error instanceof SessionStoreError ? error.code : ''));
    expect(codes).toEqual([
      'STORE_UNAVAILABLE',
      'SECRET_NOT_FOUND',
      'TOO_LARGE',
      'STORE_ERROR',
      'STORE_ERROR',
      'UNSAFE_FILE',
    ]);

    for (const error of errors) {
      const message = error instanceof Error ? error.message : '';
      expect(message).not.toContain(directory);
      expect(message).not.toContain('session.enc');
      expect(message).not.toContain('test-mcp.key');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(Buffer.from(KEY).toString('hex'));
    }
  });
});

test('separate processes serialize encrypted read-modify-write cycles', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'keys', 'test-mcp.key');
    const store = options(directory, new LocalKeyFileProvider({ path: keyPath }), 64);
    await createSecretKey(store);

    const runs = [1, 2, 3].map(async () => {
      const child = spawn(process.execPath, [worker, store.path, keyPath, '150'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let err = '';

      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      await once(child, 'close');

      return { exit: child.exitCode, err };
    });

    expect(await Promise.all(runs)).toEqual([0, 1, 2].map(() => ({ exit: 0, err: '' })));
    expect(await readSecretRecord(store)).toBe('3');
    expect(await readFile(`${store.path}.marker`, 'utf8')).toContain('"generation":3}');
  });
}, 30_000);

test('separate processes serialize holds with several writes, and a crash keeps the last commit', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'keys', 'test-mcp.key');
    const store = options(directory, new LocalKeyFileProvider({ path: keyPath }), 64);
    await createSecretKey(store);

    const start = (pause: string) =>
      spawn(process.execPath, [worker, store.path, keyPath, pause, 'store'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    const runs = [1, 2, 3].map(async () => {
      const child = start('150');
      let err = '';

      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
      });
      await once(child, 'close');

      return { exit: child.exitCode, err };
    });

    expect(await Promise.all(runs)).toEqual([0, 1, 2].map(() => ({ exit: 0, err: '' })));
    expect(await readSecretRecord(store)).toBe('6');
    expect(await readFile(`${store.path}.marker`, 'utf8')).toContain('"generation":6}');

    // Killed between its two writes while holding the lock: the first write stays committed.
    const child = start('60000');
    await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await once(child, 'close');
    expect(await readSecretRecord(store)).toBe('7');
    expect(await readFile(`${store.path}.marker`, 'utf8')).toContain('"generation":7}');
  });
}, 30_000);

test('an existing empty key file is malformed and never filled in', async () => {
  await scratch(async (directory) => {
    const keyPath = join(directory, 'k.key');
    await writeFile(keyPath, '', { mode: 0o600 });
    const store = options(directory, new LocalKeyFileProvider({ path: keyPath }));
    await assert.rejects(readSecretRecord(store), hasCode('STORE_ERROR'));
    await assert.rejects(createSecretKey(store), hasCode('STORE_ERROR'));
    expect((await readFile(keyPath)).length).toBe(0);
  });
});

test('a migrated marker without a record is never an empty store', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    const markerPath = `${store.path}.marker`;
    const base = '{"backend":"test","keySource":"memory","keyId":"test","profile":"default",';

    for (const marker of [
      `${base}"migrated":true,"generation":0,"pending":{"generation":1,"nonce":"AAAAAAAAAAAAAAAA"}}\n`,
      `${base}"migrated":true,"generation":0}\n`,
      `${base}"migrated":false,"generation":1}\n`,
    ]) {
      await writePrivateFile(markerPath, marker);
      await assert.rejects(readSecretRecord(store), hasCode('STORE_WRITE_UNCERTAIN'));
      await refuses(store, 'STORE_WRITE_UNCERTAIN');
      expect(await readFile(markerPath, 'utf8')).toBe(marker);
      await assert.rejects(stat(store.path));
    }
  });
});

test('schemas and generations stay in the range the reader parses', async () => {
  await scratch(async (directory) => {
    const store = options(directory);
    const markerPath = `${store.path}.marker`;

    for (const schema of [MAX_INTEGER + 1, Number.MAX_SAFE_INTEGER])
      await assert.rejects(
        withSecretRecord({ ...store, schema }, async () => {
          throw new Error('update must not run');
        }),
        RangeError,
      );
    await assert.rejects(stat(join(directory, 'records')));

    const widest = { ...store, schema: MAX_INTEGER };
    await put(widest, SECRET);
    expect(await readSecretRecord(widest)).toBe(SECRET);

    // The last generation is written and read back; a write past it is refused before update.
    const marker = `{"backend":"test","keySource":"memory","keyId":"test","profile":"default","migrated":true,"generation":${MAX_INTEGER - 1}}\n`;
    await writePrivateFile(store.path, forge(store, MAX_INTEGER - 1, SECRET));
    await writePrivateFile(markerPath, marker);
    expect(await put(store, 'last')).toBe('last');
    const last = await readFile(store.path, 'utf8');
    const lastMarker = await readFile(markerPath, 'utf8');
    expect(lastMarker).toBe(marker.replace(`${MAX_INTEGER - 1}`, `${MAX_INTEGER}`));

    await refuses(store, 'STORE_ERROR');
    expect(await readFile(store.path, 'utf8')).toBe(last);
    expect(await readFile(markerPath, 'utf8')).toBe(lastMarker);
  });
});

// Each change rewrites the header and the matching marker without re-encrypting, so only the
// authenticated data can reject it.
for (const change of [
  { field: 'generation', from: '"generation":1', to: '"generation":2', marker: true },
  { field: 'server', from: '"server":"test-mcp"', to: '"server":"other-mcp"', server: 'other-mcp' },
  {
    field: 'profile',
    from: '"profile":"default"',
    to: '"profile":"other"',
    profile: 'other',
    marker: true,
  },
  { field: 'purpose', from: '"purpose":"session"', to: '"purpose":"journal"', purpose: 'journal' },
  { field: 'schema', from: '"schema":1', to: '"schema":2', schema: 2 },
  {
    field: 'keyId',
    from: '"keyId":"test"',
    to: '"keyId":"rotated"',
    keyId: 'rotated',
    marker: true,
  },
])
  test(`the record header ${change.field} is authenticated, not only compared`, async () => {
    await scratch(async (directory) => {
      const original = options(directory);
      const markerPath = `${original.path}.marker`;
      await put(original, SECRET);
      const [header = '', body = ''] = (await readFile(original.path, 'utf8')).split('\n');
      const record = `${header.replace(change.from, change.to)}\n${body}\n`;
      const marker = await readFile(markerPath, 'utf8');

      const changedMarker =
        change.marker === true ? marker.replace(change.from, change.to) : marker;

      expect(record).not.toContain(change.from);
      await writePrivateFile(original.path, record);
      await writePrivateFile(markerPath, changedMarker);

      const store = {
        ...original,
        server: change.server ?? original.server,
        profile: change.profile ?? original.profile,
        purpose: change.purpose ?? original.purpose,
        schema: change.schema ?? original.schema,
        keys: new FakeKeyProvider(KEY, change.keyId ?? 'test'),
      };

      await assert.rejects(readSecretRecord(store), hasCode('STORE_ERROR'));
      await refuses(store, 'STORE_ERROR');
      expect(await readFile(original.path, 'utf8')).toBe(record);
      expect(await readFile(markerPath, 'utf8')).toBe(changedMarker);
    });
  });

test('a custom key provider with a malformed key is STORE_ERROR before any read or write', async () => {
  await scratch(async (directory) => {
    const keys: KeyProvider = {
      backend: 'test',
      keySource: 'memory',
      keyId: 'test',
      getKey: async () => new Uint8Array(31),
      createKey: async () => undefined,
    };

    const store = options(directory, keys);
    await assert.rejects(readSecretRecord(store), hasCode('STORE_ERROR'));
    await refuses(store, 'STORE_ERROR');
    await assert.rejects(stat(store.path));
    await assert.rejects(stat(`${store.path}.marker`));
  });
});

const RETIRED =
  "This store is a leftover of an earlier test build that kept its key in the macOS Keychain, which is no longer used. Remove session.enc and session.enc.marker from the server's folder in ~/Library/Application Support/family-mcp, then sign in again.";

test('a store set up with the retired Keychain accessor is refused before any key or reset', async () => {
  await scratch(async (directory) => {
    const keys = new LocalKeyFileProvider({ path: join(directory, 'keys', 'test-mcp.key') });
    const store = options(directory, keys);
    const marker = `${store.path}.marker`;

    const retired = (cause: unknown) =>
      hasCode('STORE_BACKEND_RETIRED')(cause) &&
      cause instanceof Error &&
      cause.message === RETIRED;

    await mkdir(join(directory, 'records'), { mode: 0o700 });

    await writeFile(
      marker,
      '{"backend":"encrypted-file","keySource":"keychain-accessor","keyId":"keychain","profile":"default","migrated":true,"generation":1}\n',
      { mode: 0o600 },
    );

    await writeFile(store.path, forge(store, 1, SECRET), { mode: 0o600 });
    const before = [await readFile(store.path), await readFile(marker)];

    // Without a key file, as that build leaves it, and with one: the marker decides first.
    for (const withKey of [false, true]) {
      if (withKey) await keys.createKey();
      await assert.rejects(readSecretRecord(store), retired);
      await refuses(store, 'STORE_BACKEND_RETIRED');
      await assert.rejects(resetSecretStore(store), retired);
      await assert.rejects(createSecretKey(store), retired);
      await assert.rejects(
        withSecretStore(store, (held) => held.checkKey()),
        retired,
      );
      expect([await readFile(store.path), await readFile(marker)]).toEqual(before);
    }
  });
});

test('files of a retired layout make the store decide without being read', async () => {
  await scratch(async (directory) => {
    const old = join(directory, 'old', 'session.enc.marker');
    const store = { ...options(directory), retired: [join(directory, 'missing'), old] };

    expect(await withSecretStore(store, (held) => held.exists())).toBe(false);
    await mkdir(join(directory, 'old'));
    // Unreadable and malformed: existence is all that is checked.
    await writeFile(old, 'not a marker', { mode: 0o000 });
    expect(await withSecretStore(store, (held) => held.exists())).toBe(true);
    expect(await withSecretStore(store, (held) => held.read())).toBeNull();
    expect(await existingPaths(store.retired)).toEqual([old]);
  });
});
