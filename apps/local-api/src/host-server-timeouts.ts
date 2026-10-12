import type { Server } from "node:http";

export interface HostServerTimeouts {
  /** Longest a client may take to send the request head. */
  headersTimeoutMs: number;
  /** Longest an unfinished request body may go without receiving a byte. */
  bodyIdleTimeoutMs: number;
}

export const HOST_SERVER_TIMEOUTS: HostServerTimeouts = {
  headersTimeoutMs: 60_000,
  bodyIdleTimeoutMs: 5 * 60_000,
};

/**
 * Node bounds a whole request at `requestTimeout` (300 s by default), which
 * cuts off a large raw-body `import-file` upload however steadily it arrives.
 * The Host disables that whole-request timer and bounds what a stalled client
 * can hold instead: the request head keeps its own deadline, and a body that
 * stops arriving is dropped once it has been idle for `bodyIdleTimeoutMs`.
 *
 * The idle limit watches only an unfinished request body. `server.timeout`
 * would also reset a request whose handler is legitimately busy after the body
 * arrived, so it is left at its default; `keepAliveTimeout` is left as well.
 */
export function configureHostServerTimeouts(
  server: Server,
  timeouts: Partial<HostServerTimeouts> = {},
): void {
  const { headersTimeoutMs, bodyIdleTimeoutMs } = {
    ...HOST_SERVER_TIMEOUTS,
    ...timeouts,
  };
  server.requestTimeout = 0;
  server.headersTimeout = headersTimeoutMs;
  server.on("request", (request) => {
    const socket = request.socket;
    let bytesRead = socket.bytesRead;
    // `bytesRead` advances as the body arrives without consuming the stream
    // the route reads from; `complete` turns true once the parser has seen the
    // whole message, whether or not the route has read it yet.
    const watchdog = setInterval(() => {
      if (request.complete || socket.destroyed) return stop();
      if (socket.bytesRead === bytesRead) {
        stop();
        socket.destroy();
        return;
      }
      bytesRead = socket.bytesRead;
    }, bodyIdleTimeoutMs);
    watchdog.unref();
    const stop = () => clearInterval(watchdog);
    request.once("close", stop);
  });
}
