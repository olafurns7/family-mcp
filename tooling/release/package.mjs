import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const relativeFile = z
  .string()
  .regex(/^[\w.-]+(?:\/[\w.-]+)*$/)
  .refine((path) => !path.split('/').includes('..'));

const manifestSchema = z.object({
  name: z.enum(['abler-mcp', 'infomentor-mcp']),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  packageManager: z.string().regex(/^bun@\d+\.\d+\.\d+$/),
  familyMcp: z.object({
    release: z.object({
      tools: z.array(z.string()).nonempty(),
      extraFiles: z
        .array(
          z.object({
            source: relativeFile,
            destination: relativeFile,
            platform: z.enum(['linux', 'darwin']),
            executable: z.boolean().default(false),
          }),
        )
        .default([]),
    }),
  }),
});

/** @param {string | undefined} path */
export async function readPackage(path) {
  assert.ok(path, 'Use --package <directory>.');
  const root = resolve(path);

  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')),
  );

  return { root, ...manifest, envPrefix: manifest.name.replace('-mcp', '').toUpperCase() };
}
