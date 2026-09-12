import { readFileSync } from 'node:fs';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type {
  CallToolResult,
  McpServerFactory,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { ZodError, z } from 'zod/v4';

export type UnknownErrorHandler = (error: Error) => string;

export type ToolResultOptions = {
  onUnknownError?: UnknownErrorHandler;
};

const UNKNOWN_ERROR = 'The operation failed. Check the server logs for details.';

const ZOD_ERROR = 'Invalid input or unexpected upstream data.';

export async function toolResult<T extends Record<string, unknown>>(
  work: () => Promise<T>,
  options: ToolResultOptions = {},
): Promise<CallToolResult> {
  try {
    const output = await work();

    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    const text =
      error instanceof ZodError
        ? ZOD_ERROR
        : error instanceof Error
          ? (options.onUnknownError?.(error) ?? UNKNOWN_ERROR)
          : UNKNOWN_ERROR;

    return {
      isError: true,
      content: [{ type: 'text', text: redact(text) }],
    };
  }
}

function redact(text: string): string {
  return text.replace(/https?:\/\/[^\s)]+/gi, '[redacted URL]');
}

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const LOCAL_WRITE = {
  ...READ_ONLY,
  readOnlyHint: false,
} satisfies ToolAnnotations;

export const DESTRUCTIVE = {
  ...LOCAL_WRITE,
  destructiveHint: true,
  idempotentHint: false,
} satisfies ToolAnnotations;

export function startStdio(
  factory: McpServerFactory,
  options: { onClose?: () => void } = {},
): StdioServerHandle {
  const handle = serveStdio(factory);
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    process.stdin.removeListener('end', onEnd);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);

    try {
      await handle.close();
    } finally {
      options.onClose?.();
    }
  };

  const onEnd = (): void => {
    close().catch(() => {});
  };

  const onSignal = (): void => {
    close().catch(() => {});
  };

  process.stdin.once('end', onEnd);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return { close };
}

export function packageVersion(importMetaUrl: string): string {
  return z
    .object({ version: z.string().min(1) })
    .parse(JSON.parse(readFileSync(new URL('../package.json', importMetaUrl), 'utf8'))).version;
}
