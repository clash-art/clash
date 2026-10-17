import { describe, expect, it, vi } from "vitest";

import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import type { ModelUpstreamRoute } from "@clash/shared-types";

import { createCloudPluginExecution } from "./plugin-execution";
import type { GenerationParams } from "./params";
import { createPluginProviderAdapter } from "./plugin-provider-adapter";
import { resolveAdapter } from "./registry";
import {
  createHostedGenerationRuntime,
  enqueueHostedGeneration,
} from "./runtime";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const route: ModelUpstreamRoute = {
  modelCode: "flux-schnell",
  kind: "image",
  providerId: "fal",
  upstreamId: "fal",
  upstreamModel: "fal-ai/flux/schnell",
  apiShape: "fal",
  executorPluginId: "clash.fal",
  executorExportId: "fal-execute",
  priority: 9,
};

const params: GenerationParams = {
  taskId: "fal-task-1",
  projectId: "project-1",
  nodeId: "node-1",
  type: "image_gen",
  actorType: "user",
  actorUserId: "user-1",
  modelName: "flux-schnell",
  prompt: "a test image",
  aspectRatio: "1:1",
  modelParams: { num_inference_steps: 1 },
  selectedRoute: route,
};

function journal() {
  const rows = new Map<string, DurableRunRecord>();
  return {
    rows,
    async create(run: DurableRunRecord) {
      rows.set(run.actionRunId, structuredClone(run));
    },
    async load(id: { actionRunId: string }) {
      const row = rows.get(id.actionRunId);
      return row && structuredClone(row);
    },
    async compareAndSet(
      id: { actionRunId: string },
      revision: number,
      next: DurableRunRecord,
    ) {
      if (rows.get(id.actionRunId)?.revision !== revision) return false;
      rows.set(id.actionRunId, structuredClone(next));
      return true;
    },
    async listRecoverable() {
      return [...rows.values()];
    },
  };
}

function bucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, value: Uint8Array | string) {
      objects.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
      return {};
    },
    async get(key: string) {
      const body = objects.get(key);
      if (!body) return null;
      return {
        size: body.byteLength,
        httpMetadata: { contentType: "application/json" },
        async json() {
          return JSON.parse(new TextDecoder().decode(body));
        },
        async arrayBuffer() {
          return body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          );
        },
      };
    },
    async head(key: string) {
      const body = objects.get(key);
      return body ? { size: body.byteLength } : null;
    },
  };
}

describe("plugin-owned provider routes on the Cloudflare adapter", () => {
  it("resolves the fal plugin adapter and runs it through the shared durable runtime", async () => {
    expect(resolveAdapter(params).name).toBe("plugin-provider:clash.fal");

    let submitCalls = 0;
    let statusCalls = 0;
    let submitAuthorization: string | null = null;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(request.url.startsWith("http://fal.mock/")).toBe(true);
        if (
          request.method === "POST" &&
          new URL(request.url).pathname === "/fal-ai/flux/schnell"
        ) {
          submitCalls += 1;
          submitAuthorization = request.headers.get("authorization");
          return Response.json({
            request_id: "fal-request-1",
            status_url: "http://fal.mock/status",
            response_url: "http://fal.mock/response",
          });
        }
        if (request.url.endsWith("/requests/fal-request-1/status")) {
          statusCalls += 1;
          return Response.json({
            status: statusCalls === 1 ? "IN_QUEUE" : "COMPLETED",
            request_id: "fal-request-1",
          });
        }
        if (request.url.endsWith("/requests/fal-request-1")) {
          return Response.json({
            images: [
              {
                url: "http://fal.mock/media/result.png",
                content_type: "image/png",
              },
            ],
          });
        }
        if (request.url === "http://fal.mock/media/result.png") {
          return new Response(PNG, {
            headers: { "content-type": "image/png" },
          });
        }
        throw new Error(`Unexpected fal request: ${request.method} ${request.url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const state = journal();
    let now = Date.now();
    const published = vi.fn(async () => undefined);
    const env = { R2_BUCKET: bucket(), DB: {} } as never;
    const port = await createCloudPluginExecution(env, {
      credentials: async () => ({
        apiKey: "fal-secret-test-key",
        queueBaseUrl: "http://fal.mock",
      }),
    });
    const options = {
      journal: state,
      resolveRoute: async () => route,
      assertAccess: async () => undefined,
      claim: async () => undefined,
      hooks: {},
      clock: { now: () => now },
      adapter: () => createPluginProviderAdapter(route, port),
      publish: published,
      hookCheckpoint: async (_name: string, action: () => Promise<void>) =>
        action(),
    };
    await enqueueHostedGeneration(
      { GENERATION_WORKFLOW: { create: async () => {} } } as never,
      params.taskId,
      params,
      options,
    );
    const identity = { actionRunId: params.taskId, outputSlot: "output" };
    for (
      let attempt = 0;
      attempt < 10 && state.rows.get(params.taskId)?.phase !== "succeeded";
      attempt++
    ) {
      now += 60_000;
      await createHostedGenerationRuntime(env, options).coordinate({
        type: "advance",
        identity,
      });
    }

    expect(state.rows.get(params.taskId)?.phase).toBe("succeeded");
    expect(submitCalls).toBe(1);
    expect(statusCalls).toBe(2);
    expect(submitAuthorization).toBe("Key fal-secret-test-key");
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: params.taskId }),
      expect.objectContaining({
        updates: { assetId: params.taskId },
        asset: expect.objectContaining({
          kind: "image",
          sourceTaskId: params.taskId,
          metadata: expect.objectContaining({ contentType: "image/png" }),
        }),
      }),
    );
    expect(JSON.stringify(state.rows.get(params.taskId))).not.toContain(
      "fal-secret-test-key",
    );
    vi.unstubAllGlobals();
  });

  it("fails an ambiguous plugin submit terminally instead of submitting twice", async () => {
    // A 5xx answer to a submit may arrive after fal accepted (and charged) the job:
    // the shared HTTP failure contract marks it ambiguous (`requestState: "unknown"`).
    let submitCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === "POST") {
          submitCalls += 1;
          return new Response("upstream gateway timeout", { status: 504 });
        }
        throw new Error(`Unexpected fal request: ${request.method} ${request.url}`);
      }),
    );
    const ambiguous = { ...params, taskId: "fal-task-ambiguous" };
    const state = journal();
    let now = Date.now();
    const env = { R2_BUCKET: bucket(), DB: {} } as never;
    const port = await createCloudPluginExecution(env, {
      credentials: async () => ({
        apiKey: "fal-secret-test-key",
        queueBaseUrl: "http://fal.mock",
      }),
    });
    const options = {
      journal: state,
      resolveRoute: async () => route,
      assertAccess: async () => undefined,
      claim: async () => undefined,
      hooks: {},
      clock: { now: () => now },
      adapter: () => createPluginProviderAdapter(route, port),
      publish: vi.fn(async () => undefined),
      hookCheckpoint: async (_name: string, action: () => Promise<void>) =>
        action(),
    };
    await enqueueHostedGeneration(
      { GENERATION_WORKFLOW: { create: async () => {} } } as never,
      ambiguous.taskId,
      ambiguous,
      options,
    );
    const identity = { actionRunId: ambiguous.taskId, outputSlot: "output" };
    for (let attempt = 0; attempt < 6; attempt++) {
      now += 10_000;
      await createHostedGenerationRuntime(env, options).coordinate({
        type: "advance",
        identity,
      });
      if (state.rows.get(ambiguous.taskId)?.phase === "failed") break;
    }
    const row = state.rows.get(ambiguous.taskId);
    expect(row?.phase).toBe("failed");
    expect(row?.failure).toMatchObject({ requestState: "unknown", retryable: true });
    expect(submitCalls).toBe(1);
    vi.unstubAllGlobals();
  });
});
