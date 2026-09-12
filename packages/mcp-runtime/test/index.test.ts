import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { z } from 'zod/v4';
import { packageVersion, toolResult } from '../src/index.js';

const textContent = z.object({ type: z.literal('text'), text: z.string() });

test('toolResult returns structured content and redacts failures', async () => {
  const success = await toolResult(async () => ({ value: 1 }));
  assert.deepEqual(success.structuredContent, { value: 1 });
  assert.equal(success.isError, undefined);

  const failure = await toolResult(
    async () => {
      throw new Error('upstream https://example.test/private body');
    },
    { onUnknownError: (error) => (error instanceof Error ? error.message : 'failed') },
  );

  assert.equal(failure.isError, true);
  assert.equal(textContent.parse(failure.content[0]).text, 'upstream [redacted URL] body');

  const invalid = await toolResult(
    async () => {
      z.string().parse(1);

      return {};
    },
    { onUnknownError: () => 'should not be used' },
  );

  assert.equal(
    textContent.parse(invalid.content[0]).text,
    'Invalid input or unexpected upstream data.',
  );
  assert.ok(invalid.isError);
});

test('packageVersion reads the package next to the caller', () => {
  assert.equal(packageVersion(import.meta.url), '0.0.0');
});
