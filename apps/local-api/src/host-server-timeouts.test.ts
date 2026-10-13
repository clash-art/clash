import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_SERVER_TIMEOUTS,
  configureHostServerTimeouts,
} from "./host-server-timeouts.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A loopback server that answers with the number of body bytes it received. */
async function listen(configure: (server: Server) => void): Promise<number> {
  const server = createServer(
    // Node only looks for expired requests on this interval.
    { connectionsCheckingInterval: 25 },
    (request, response) => {
      let received = 0;
      request.on("data", (chunk: Buffer) => {
        received += chunk.byteLength;
      });
      request.on("end", () => response.end(String(received)));
    },
  );
  configure(server);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

/**
 * Sends `chunkCount` one-byte chunks `intervalMs` apart, then either ends the
 * body or leaves it unfinished. Resolves with the response, rejects when the
 * server drops the connection first.
 */
function slowUpload(input: {
  port: number;
  chunkCount: number;
  intervalMs: number;
  finish: boolean;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: input.port,
      method: "POST",
      path: "/",
      headers: { "content-type": "application/octet-stream" },
    });
    request.on("error", reject);
    request.on("response", (response: IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
      response.on("error", reject);
    });
    void (async () => {
      for (let sent = 0; sent < input.chunkCount; sent += 1) {
        if (request.destroyed) return;
        request.write("x");
        await delay(input.intervalMs);
      }
      if (input.finish && !request.destroyed) request.end();
    })();
  });
}

describe("configureHostServerTimeouts", () => {
  it("disables the whole-request timer and keeps the other limits", () => {
    const server = createServer();
    const untouched = createServer();
    configureHostServerTimeouts(server);

    expect(server.requestTimeout).toBe(0);
    expect(server.headersTimeout).toBe(HOST_SERVER_TIMEOUTS.headersTimeoutMs);
    expect(server.headersTimeout).toBeGreaterThan(0);
    expect(HOST_SERVER_TIMEOUTS.bodyIdleTimeoutMs).toBeGreaterThan(0);
    expect(server.keepAliveTimeout).toBe(untouched.keepAliveTimeout);
    expect(server.timeout).toBe(untouched.timeout);
  });

  it("accepts a steady upload that outlives a whole-request timer", async () => {
    // The upload takes about a second; each gap stays far below the idle limit.
    const upload = { chunkCount: 10, intervalMs: 100, finish: true };

    const bounded = await listen((server) => {
      server.headersTimeout = 200;
      server.requestTimeout = 300;
    });
    const cutOff = await slowUpload({ port: bounded, ...upload }).catch(
      (error: unknown) => error,
    );
    // Node answers 408 and closes; the client sees that or the reset socket.
    expect(
      cutOff instanceof Error
        ? "dropped"
        : (cutOff as { status: number }).status,
    ).not.toBe(200);

    const configured = await listen((server) =>
      configureHostServerTimeouts(server, { bodyIdleTimeoutMs: 500 }),
    );
    await expect(slowUpload({ port: configured, ...upload })).resolves.toEqual({
      status: 200,
      body: String(upload.chunkCount),
    });
  });

  it("drops an upload whose body stops arriving", async () => {
    const port = await listen((server) =>
      configureHostServerTimeouts(server, { bodyIdleTimeoutMs: 150 }),
    );
    await expect(
      slowUpload({ port, chunkCount: 2, intervalMs: 20, finish: false }),
    ).rejects.toThrow();
  });

  it("leaves a slow response to a fully received request alone", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => setTimeout(() => response.end("done"), 500));
    });
    configureHostServerTimeouts(server, { bodyIdleTimeoutMs: 100 });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    await expect(
      slowUpload({ port, chunkCount: 1, intervalMs: 10, finish: true }),
    ).resolves.toEqual({ status: 200, body: "done" });
  });
});
