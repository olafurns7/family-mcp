import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { z } from 'zod/v4';
import { SafeError, toolResult } from '../src/index.js';

const textContent = z.object({ type: z.literal('text'), text: z.string() });

test('toolResult returns structured content and only exposes safe error messages', async () => {
  const success = await toolResult(async () => ({ value: 1 }));
  assert.deepEqual(success.structuredContent, { value: 1 });
  assert.equal(success.isError, undefined);

  const safe = await toolResult(async () => {
    throw new SafeError('Abler session expired. Sign in again.');
  });

  assert.equal(textContent.parse(safe.content[0]).text, 'Abler session expired. Sign in again.');

  for (const privateMessage of [
    'Bearer bare-private-token',
    'refreshToken=bare-private-refresh',
    'Set-Cookie: refreshToken=private-cookie; Path=/',
    'GraphQL body contains private response data without a URL',
  ]) {
    const failure = await toolResult(async () => {
      throw new Error(privateMessage);
    });

    const output = textContent.parse(failure.content[0]).text;
    assert.equal(failure.isError, true);
    assert.equal(output, 'The operation failed. Check the server logs for details.');
    assert.equal(output.includes(privateMessage), false);
  }

  const invalid = await toolResult(async () => {
    z.string().parse(1);

    return {};
  });

  assert.equal(
    textContent.parse(invalid.content[0]).text,
    'Invalid input or unexpected upstream data.',
  );
  assert.ok(invalid.isError);
});
