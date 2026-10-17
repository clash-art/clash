import { describe, expect, it, vi } from "vitest";
import {
  assemblePluginModule,
  defineExecutor,
} from "@clash/action-sdk/browser";
import type {
  ExecutablePluginInvocation,
  ExecutablePluginJsonValue,
} from "@clash/shared-types/executable-plugin";

import type { PluginExecutionRequest } from "@clash/shared-runtime/executable-plugin-port";
import { createInProcessPluginExecution } from "./in-process";

function invocation(
  idempotencyKey: string,
  operation: "submit" | "poll",
  pollState?: ExecutablePluginJsonValue,
): ExecutablePluginInvocation {
  return {
    protocol: "clash.plugin.invoke/v1",
    invocationId: idempotencyKey,
    taskId: idempotencyKey,
    projectId: "project-1",
    operation,
    target: {
      pluginId: "clash.test",
      version: "1.0.0",
      exportId: "execute",
      schemaHash: `sha256:${"a".repeat(64)}`,
      kind: "provider-executor",
    },
    input: { values: { prompt: "hello" }, references: [] },
    assetInputs: [],
    actor: { kind: "system", id: "test" },
    ...(pollState === undefined ? {} : { pollState }),
  };
}

function request(
  idempotencyKey: string,
  operation: "submit" | "poll",
  pollState?: ExecutablePluginJsonValue,
): PluginExecutionRequest {
  return {
    run: { actionRunId: "action-run-1", outputSlot: "output" },
    invocation: invocation(idempotencyKey, operation, pollState),
    timeoutMs: 5_000,
  };
}

describe("in-process plugin execution conformance", () => {
  it("submits, polls, completes, and replays a submit under one idempotency key", async () => {
    const effects = new Map<string, number>();
    let failSubmitAfterUpstreamOnce = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url !== "http://upstream.test/submit") {
        throw new Error(`Unexpected request ${url}`);
      }
      const key = new Headers(init?.headers).get("idempotency-key");
      if (!key) throw new Error("missing idempotency key");
      if (!effects.has(key)) effects.set(key, 0);
      // The mock upstream deduplicates by the key it receives. The port must
      // therefore be the thing that keeps the key stable on a retry.
      effects.set(key, effects.get(key)! + (effects.get(key) === 0 ? 1 : 0));
      return Response.json({ request_id: `upstream-${key}` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const module = assemblePluginModule({
      pluginId: "clash.test",
      functions: [
        {
          id: "execute",
          kind: "provider-executor",
          operations: ["submit", "poll"],
        },
      ],
      contributes: {
        execute: defineExecutor({
          async submit(invocation) {
            await fetch("http://upstream.test/submit", {
              method: "POST",
              headers: { "idempotency-key": invocation.invocationId },
            });
            if (failSubmitAfterUpstreamOnce) {
              failSubmitAfterUpstreamOnce = false;
              throw Object.assign(new TypeError("fetch failed"), {
                cause: { code: "ECONNRESET" },
              });
            }
            return {
              status: "accepted",
              pollState: { requestId: `upstream-${invocation.invocationId}` },
              retryAfterMs: 1000,
            };
          },
          async poll(_invocation, context) {
            const asset = await context.upload!({
              slot: "media",
              kind: "image",
              mediaType: "image/png",
              bytes: new Uint8Array([1, 2, 3]),
            });
            return { status: "completed", outputs: [asset] };
          },
        }),
      },
    });

    const port = createInProcessPluginExecution({
      modules: new Map([["clash.test", module]]),
      context: () => ({
        upload: async (upload) => ({
          slot: upload.slot,
          kind: "asset",
          asset: {
            assetId: "asset-1",
            uri: "clash-asset://asset-1",
            kind: upload.kind === "model" ? "image" : upload.kind,
            ...(upload.mediaType ? { mediaType: upload.mediaType } : {}),
          },
        }),
      }),
    });

    const key = "project:project-1:node:node-1:revision:abc";
    await expect(port.invoke(request(key, "submit"))).rejects.toThrow(
      "fetch failed",
    );
    const accepted = await port.invoke(request(key, "submit"));
    expect(accepted).toMatchObject({
      status: "accepted",
      pollState: { requestId: `upstream-${key}` },
    });

    // A crash between the plugin return and the journal checkpoint replays
    // the same submit; the accepted result is reused instead of buying again.
    const replay = await port.invoke(request(key, "submit"));
    expect(replay).toEqual(accepted);

    const completed = await port.invoke(
      request(key, "poll", accepted.status === "accepted" ? accepted.pollState : {}),
    );
    expect(completed).toMatchObject({
      status: "completed",
      outputs: [
        {
          slot: "media",
          kind: "asset",
          asset: { assetId: "asset-1", kind: "image" },
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...effects.entries()]).toEqual([[key, 1]]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("idempotency-key")).toBe(key);
    }
    vi.unstubAllGlobals();
  });
});
