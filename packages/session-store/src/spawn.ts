import { spawn } from 'node:child_process';

export type Run = {
  /** Exit status, or null when the child was killed, failed to start or overflowed. */
  status: number | null;
  stdout: string;
  failure: 'timeout' | 'failed' | 'overflow' | undefined;
};

export type RunOptions = {
  timeoutMs: number;
  /** Larger output is never an answer; the child is killed once it exceeds this. */
  maxBytes: number;
};

/**
 * Run an absolute executable without a shell, stdin closed, stderr discarded, and only PATH and
 * HOME in its environment. The promise settles by `timeoutMs` even when the child ignores
 * SIGKILL or a grandchild keeps its stdout open: the timer, not the child's exit, ends the wait.
 */
export function runBounded(file: string, args: string[], options: RunOptions): Promise<Run> {
  const { promise, resolve } = Promise.withResolvers<Run>();
  const chunks: Buffer[] = [];
  let bytes = 0;

  const env = { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '/' };

  const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });

  const finish = (status: number | null, failure: Run['failure']): void => {
    clearTimeout(timer);
    // Ends any wait on the child: stdout is closed and the process is never awaited again.
    child.stdout.destroy();

    if (failure !== undefined && child.exitCode === null) child.kill('SIGKILL');
    resolve({ status, stdout: Buffer.concat(chunks).toString('utf8'), failure });
  };

  const timer = setTimeout(() => finish(null, 'timeout'), options.timeoutMs);

  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;

    if (bytes > options.maxBytes) finish(null, 'overflow');
    else chunks.push(chunk);
  });
  child.on('error', () => finish(null, 'failed'));
  child.on('close', (status) => finish(status, undefined));

  return promise;
}
