import { createHmac, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExecutablePluginInvocation } from "@clash/shared-types/executable-plugin";

import { durableRunIdempotencyKey } from "./durable-run-engine.js";
import {
  createRemotePluginExecution,
  REMOTE_PLUGIN_TIMEOUT_CAP_MS,
  RemotePluginEndpointError,
  remotePluginSignature,
  validateRemotePluginEndpoint,
} from "./executable-plugin-remote.js";
import type { PluginExecutionRequest } from "./executable-plugin-port.js";

const run = {
  actionRunId: "project:p:node:n:revision:abc",
  outputSlot: "media",
};
const key = durableRunIdempotencyKey(run);
const secret = "plugin-secret-value";

function invocation(
  operation: "submit" | "poll" = "submit",
): ExecutablePluginInvocation {
  return {
    protocol: "clash.plugin.invoke/v1",
    invocationId: key,
    taskId: run.actionRunId,
    projectId: "p",
    nodeId: "n",
    target: {
      pluginId: "third.party",
      version: "1.0.0",
      exportId: "run",
      schemaHash: `sha256:${"a".repeat(64)}`,
      kind: "action",
    },
    input: { values: { prompt: "hi" }, references: [] },
    assetInputs: [],
    actor: { kind: "user", id: "u" },
    operation,
  };
}

function request(): PluginExecutionRequest {
  return {
    run,
    invocation: invocation(),
    timeoutMs: 5_000,
  };
}

function completed(invocationId: string) {
  return Response.json({
    protocol: "clash.plugin.result/v1",
    invocationId,
    status: "completed",
    outputs: [{ slot: "media", kind: "value", value: "ok" }],
  });
}

describe("remote PluginExecutionPort binding", () => {
  it("rejects non-https, IP-literal, localhost and private/internal endpoints at save", () => {
    for (const endpoint of [
      "http://plugins.example.com/invoke",
      "https://127.0.0.1/invoke",
      "https://[::1]/invoke",
      "https://localhost/invoke",
      "https://plugin.internal/invoke",
      "https://plugin.corp/invoke",
      "https://single-label/invoke",
    ]) {
      expect(() => validateRemotePluginEndpoint(endpoint)).toThrow(
        RemotePluginEndpointError,
      );
    }
    expect(
      validateRemotePluginEndpoint("https://plugins.example.com/invoke"),
    ).toBe("https://plugins.example.com/invoke");
  });

  it("signs timestamp + idempotency key + body hash and sends the durable key", async () => {
    const fetch = vi.fn(async () => completed(key));
    const port = createRemotePluginExecution({
      fetch,
      now: () => 1_700_000_000_000,
      target: async () => ({
        endpoint: "https://plugins.example.com/invoke",
        secret,
        references: [
          {
            slot: "image",
            index: 0,
            url: "https://cdn.example.com/a.png?exp=1&sig=x",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        ],
      }),
    });

    await expect(port.invoke(request())).resolves.toMatchObject({
      status: "completed",
    });
    const [, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    const timestamp = headers.get("x-clash-timestamp")!;
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const expected = createHmac("sha256", secret)
      .update(`${timestamp}\n${key}\n${bodyHash}`)
      .digest("hex");

    expect(timestamp).toBe("1700000000");
    expect(headers.get("idempotency-key")).toBe(key);
    expect(headers.get("x-clash-signature")).toBe(expected);
    expect(headers.get("x-clash-plugin-id")).toBe("third.party");
    expect(JSON.parse(body)).toEqual({
      invocation: invocation(),
      references: [
        {
          slot: "image",
          index: 0,
          url: "https://cdn.example.com/a.png?exp=1&sig=x",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(
      await remotePluginSignature({
        secret,
        timestamp,
        idempotencyKey: key,
        body,
      }),
    ).toBe(expected);
  });

  it("reuses the same Idempotency-Key across a retry", async () => {
    const seen: string[] = [];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        return completed(key);
      },
    );
    const port = createRemotePluginExecution({
      fetch,
      target: async () => ({
        endpoint: "https://plugins.example.com/invoke",
        secret,
        references: [],
      }),
    });
    await port.invoke(request());
    await port.invoke(request());
    expect(seen).toEqual([key, key]);
  });

  it("honours the remaining-lease timeout", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    );
    const port = createRemotePluginExecution({
      fetch,
      target: async () => ({
        endpoint: "https://plugins.example.com/invoke",
        secret,
        references: [],
      }),
    });
    const started = Date.now();
    await expect(
      port.invoke({ ...request(), timeoutMs: 25 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(REMOTE_PLUGIN_TIMEOUT_CAP_MS).toBe(60_000);
  });

  it("maps a 409 for the same key with a different body to contract_violation", async () => {
    const fetch = vi.fn(async () => new Response("conflict", { status: 409 }));
    const port = createRemotePluginExecution({
      fetch,
      target: async () => ({
        endpoint: "https://plugins.example.com/invoke",
        secret,
        references: [],
      }),
    });
    await expect(port.invoke(request())).rejects.toMatchObject({
      failure: {
        code: "contract_violation",
        retryable: false,
        requestState: "unknown",
      },
    });
  });

  it("rejects a result that answers another invocation", async () => {
    const fetch = vi.fn(async () => completed("another-key"));
    const port = createRemotePluginExecution({
      fetch,
      target: async () => ({
        endpoint: "https://plugins.example.com/invoke",
        secret,
        references: [],
      }),
    });
    await expect(port.invoke(request())).rejects.toMatchObject({
      failure: { code: "contract_violation", retryable: false },
    });
  });
});
