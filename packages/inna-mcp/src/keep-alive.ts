import type { EventEmitter } from 'node:events';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InnaClient } from './client.js';

const INTERVAL_MS = 10 * 60_000;

// An unreferenced timer never keeps the server process alive on its own.
function repeat(tick: () => void, milliseconds: number): () => void {
  const timer = setInterval(tick, milliseconds);
  timer.unref();

  return () => clearInterval(timer);
}

export type KeepAliveOptions = {
  intervalMs?: number;
  /** Calls tick every interval and returns the function that cancels it. */
  repeat?: (tick: () => void, milliseconds: number) => () => void;
  /** The protocol output stream; its error or close ends the connection and stops the ticks. */
  output?: EventEmitter;
};

/**
 * Touches the saved session on a fixed interval while the server runs. The first request comes
 * one interval after start, ticks never overlap, and nothing is logged.
 *
 * The ticks follow the attached MCP servers: when the last one closes, the timer is cancelled
 * and the request in flight is aborted, and a server attached later starts a fresh interval.
 * That covers a connection the SDK closes by itself and a discarded negotiation instance alike.
 * stop() is final; a closed or failed output stream also stops, because a broken pipe never
 * reaches the stdio shutdown handler.
 */
export function startKeepAlive(
  client: Pick<InnaClient, 'keepAlive'>,
  options: KeepAliveOptions = {},
) {
  let active: { controller: AbortController; cancel: () => void } | undefined;
  let attached = 0;
  let running = false;
  let stopped = false;

  const resume = (): void => {
    const controller = new AbortController();

    const tick = (): void => {
      if (running || controller.signal.aborted) return;
      running = true;
      client
        .keepAlive(controller.signal)
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    };

    active = {
      controller,
      cancel: (options.repeat ?? repeat)(tick, options.intervalMs ?? INTERVAL_MS),
    };
  };

  const suspend = (): void => {
    active?.cancel();
    active?.controller.abort();
    active = undefined;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    // Removed so this listener never becomes the only one and hides a later stream error.
    options.output?.off('error', stop).off('close', stop);
    suspend();
  };

  const attach = (server: McpServer): McpServer => {
    const previous = server.server.onclose;
    let open = true;
    attached += 1;

    if (!active && !stopped) resume();

    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the SDK server offers only this callback property
    server.server.onclose = () => {
      try {
        previous?.();
      } finally {
        if (open) {
          open = false;
          attached -= 1;

          if (attached === 0) suspend();
        }
      }
    };

    return server;
  };

  options.output?.on('error', stop).on('close', stop);
  resume();

  return { stop, attach };
}
