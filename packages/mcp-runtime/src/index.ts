import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type {
  CallToolResult,
  McpServerFactory,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { ZodError } from 'zod/v4';

const UNKNOWN_ERROR = 'The operation failed. Check the server logs for details.';

const ZOD_ERROR = 'Invalid input or unexpected upstream data.';

export class ResponseBodyTooLargeError extends Error {
  constructor() {
    super('Response body exceeded its size limit.');
    this.name = 'ResponseBodyTooLargeError';
  }
}

export async function readBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > maxBytes) throw new ResponseBodyTooLargeError();
      chunks.push(value);
    }

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** An error whose fixed, reviewed message is safe to show to an MCP caller. */
export class SafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeError';
  }
}

export async function toolResult<T extends Record<string, unknown>>(
  work: () => Promise<T>,
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
        : error instanceof SafeError
          ? error.message
          : UNKNOWN_ERROR;

    return {
      isError: true,
      content: [{ type: 'text', text }],
    };
  }
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
  options: { onClose?: () => void | Promise<void> } = {},
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
      await options.onClose?.();
    } finally {
      await handle.close();
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
