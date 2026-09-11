import { describe, expect, it, vi } from "vitest";

import { ProviderExecutionError } from "@clash/action-sdk";

import { moveAiAdapter } from "./move-ai-adapter.js";

function graphqlResponse(status: number, body: unknown, statusText = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function putResponse(status: number, statusText = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return "";
    },
  };
}

function fetchSequence(...responses: Array<ReturnType<typeof graphqlResponse>>) {
  let call = 0;
  return vi.fn(async (_input: string, _init?: {body?: string | Uint8Array<ArrayBuffer>}) => {
    const response = responses[call];
    call += 1;
    if (!response) throw new Error("fetch called more times than expected");
    return response;
  });
}

function context(options: {
  apiKey?: string;
  reference?: (reference: unknown) => Promise<unknown>;
  fetch: ReturnType<typeof vi.fn>;
}) {
  const originalFetch = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = options.fetch as never;
  return {
    upload: vi.fn(),
    asset: vi.fn(),
    document: vi.fn(),
    store: {
      get: vi.fn(async (key: string) =>
        key === "apiKey" ? options.apiKey : undefined,
      ),
      put: vi.fn(),
      remove: vi.fn(),
    },
    reference:
      options.reference ??
      (async () => {
        throw new Error("no reference resolver configured for this test");
      }),
    hostTools: {} as never,
    restoreFetch: () => {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    },
  };
}

const videoReference = {
  slot: "video",
  index: 0,
  asset: {
    assetId: "asset-1",
    uri: "clash-asset://asset-1",
    kind: "video" as const,
    mediaType: "video/mp4",
  },
};

const CREATE_FILE_OK = graphqlResponse(200, {
  data: { createFile: { id: "file_1", presignedUrl: "https://upload.example.test/file_1" } },
});
const TAKE_OK = graphqlResponse(200, { data: { createSingleCamTake: { id: "take_1" } } });
const JOB_OK = graphqlResponse(200, { data: { createSingleCamJob: { id: "job_1" } } });
const PUT_OK = putResponse(200);

describe("moveAiAdapter.submit", () => {
  it("rejects a submit with no video reference before reading credentials", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      failure: { code: "invalid_request", retryable: false, requestState: "rejected" },
    });
    expect(ctx.store.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects a submit with two video references before reading credentials", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [videoReference, videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      failure: { code: "invalid_request", retryable: false, requestState: "rejected" },
    });
    expect(ctx.store.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects a submit with a video reference plus an extra non-video reference before reading credentials", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    const extraReference = {
      slot: "reference",
      index: 1,
      asset: {
        assetId: "asset-2",
        uri: "clash-asset://asset-2",
        kind: "image" as const,
        mediaType: "image/png",
      },
    };
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [videoReference, extraReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      failure: { code: "invalid_request", retryable: false, requestState: "rejected" },
    });
    expect(ctx.store.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects an upstreamModel other than S2 before reading credentials", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S3" },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      failure: { code: "invalid_request", retryable: false, requestState: "rejected" },
    });
    expect(ctx.store.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("fails before any request when the account has no apiKey stored", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "", fetch });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      failure: { code: "authentication_failed", retryable: false, requestState: "rejected" },
    });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects a provider-url resolved video reference: Move AI requires uploaded bytes", async () => {
    const fetch = vi.fn();
    const reference = vi.fn(async () => ({
      form: "provider-url" as const,
      providerUrl: "https://objects.example.test/video.mp4?sig=1",
      expiresAt: "2026-01-01T00:00:00.000Z",
      kind: "video" as const,
    }));
    const ctx = context({ apiKey: "sk-test", fetch, reference });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({ failure: { code: "invalid_request", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects an executor-url resolved video reference", async () => {
    const fetch = vi.fn();
    const reference = vi.fn(async () => ({
      form: "executor-url" as const,
      executorUrl: "https://executor.example.test/video.mp4?sig=1",
      expiresAt: "2026-01-01T00:00:00.000Z",
      kind: "video" as const,
    }));
    const ctx = context({ apiKey: "sk-test", fetch, reference });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({ failure: { code: "invalid_request", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects a text-resolved video reference", async () => {
    const fetch = vi.fn();
    const reference = vi.fn(async () => ({ form: "text" as const, text: "hello" }));
    const ctx = context({ apiKey: "sk-test", fetch, reference });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({ failure: { code: "invalid_request", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects a document-resolved video reference", async () => {
    const fetch = vi.fn();
    const reference = vi.fn(async () => ({
      form: "document" as const,
      documentKind: "timeline",
      schemaVersion: 1,
      body: {},
    }));
    const ctx = context({ apiKey: "sk-test", fetch, reference });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2" },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({ failure: { code: "invalid_request", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("submits resolved bytes with the exact media type through moveAiSubmitTake", async () => {
    const fetch = fetchSequence(CREATE_FILE_OK, PUT_OK, TAKE_OK, JOB_OK);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const reference = vi.fn(async () => ({
      form: "bytes" as const,
      bytes,
      mediaType: "video/mp4",
      kind: "video" as const,
    }));
    const ctx = context({ apiKey: "sk-test", fetch, reference });
    const result = await moveAiAdapter.submit(
      {
        taskId: "t1",
        operation: "submit",
        input: {
          values: { modelId: "move-ai-s2", upstreamModel: "S2" },
          references: [videoReference],
        },
      } as never,
      ctx as never,
    );
    expect(reference).toHaveBeenCalledWith(videoReference);
    expect(fetch).toHaveBeenCalledTimes(4);
    const createFileBody = JSON.parse(
      (fetch.mock.calls[0]![1] as { body: string }).body,
    );
    expect(createFileBody.variables).toEqual({ type: "mp4" });
    expect(result).toEqual({ status: "accepted", pollState: { jobId: "job_1" } });
    ctx.restoreFetch();
  });

  it("reads trackFingers/floorPlane/trackBall from modelParams and forwards them", async () => {
    const fetch = fetchSequence(CREATE_FILE_OK, PUT_OK, TAKE_OK, JOB_OK);
    const reference = vi.fn(async () => ({
      form: "bytes" as const,
      bytes: new Uint8Array([1]),
      mediaType: "video/mp4",
      kind: "video" as const,
    }));
    const ctx = context({ apiKey: "sk-test", fetch, reference });
    await moveAiAdapter.submit(
      {
        taskId: "t1",
        operation: "submit",
        input: {
          values: {
            modelId: "move-ai-s2",
            upstreamModel: "S2",
            modelParams: { trackFingers: false, floorPlane: true, trackBall: true },
          },
          references: [videoReference],
        },
      } as never,
      ctx as never,
    );
    const jobBody = JSON.parse((fetch.mock.calls[3]![1] as { body: string }).body);
    expect(jobBody.variables.options).toEqual({
      mocapModel: "S2",
      trackFingers: false,
      floorPlane: true,
      trackBall: true,
    });
    ctx.restoreFetch();
  });

  it("reads trackFingers/floorPlane/trackBall from top-level values when modelParams is absent", async () => {
    const fetch = fetchSequence(CREATE_FILE_OK, PUT_OK, TAKE_OK, JOB_OK);
    const reference = vi.fn(async () => ({
      form: "bytes" as const,
      bytes: new Uint8Array([1]),
      mediaType: "video/mp4",
      kind: "video" as const,
    }));
    const ctx = context({ apiKey: "sk-test", fetch, reference });
    await moveAiAdapter.submit(
      {
        taskId: "t1",
        operation: "submit",
        input: {
          values: {
            modelId: "move-ai-s2",
            upstreamModel: "S2",
            trackFingers: true,
          },
          references: [videoReference],
        },
      } as never,
      ctx as never,
    );
    const jobBody = JSON.parse((fetch.mock.calls[3]![1] as { body: string }).body);
    expect(jobBody.variables.options).toEqual({ mocapModel: "S2", trackFingers: true });
    ctx.restoreFetch();
  });

  it("rejects a non-boolean trackFingers before any request", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: {
              modelId: "move-ai-s2",
              upstreamModel: "S2",
              modelParams: { trackFingers: "yes" },
            },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({ failure: { code: "invalid_request", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects a non-boolean floorPlane before any request", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: { modelId: "move-ai-s2", upstreamModel: "S2", floorPlane: 1 },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({ failure: { code: "invalid_request", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("rejects a non-boolean trackBall before any request", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.submit(
        {
          taskId: "t1",
          operation: "submit",
          input: {
            values: {
              modelId: "move-ai-s2",
              upstreamModel: "S2",
              modelParams: { trackBall: "true" },
            },
            references: [videoReference],
          },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({ failure: { code: "invalid_request", retryable: false } });
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });
});

describe("moveAiAdapter.poll", () => {
  it("rejects an unusable poll state before reading account data", async () => {
    const fetch = vi.fn();
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.poll!(
        {
          taskId: "t1",
          operation: "poll",
          pollState: {},
          input: { values: {}, references: [] },
        } as never,
        ctx as never,
      ),
    ).rejects.toMatchObject({
      failure: { code: "contract_violation", requestState: "accepted" },
    });
    expect(ctx.store.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    ctx.restoreFetch();
  });

  it("passes an accepted job state through unchanged", async () => {
    const fetch = fetchSequence(
      graphqlResponse(200, { data: { getJob: { progress: { state: "RUNNING" }, outputs: [] } } }),
    );
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.poll!(
        {
          taskId: "t1",
          operation: "poll",
          pollState: { jobId: "job_1" },
          input: { values: {}, references: [] },
        } as never,
        ctx as never,
      ),
    ).resolves.toMatchObject({ status: "accepted", pollState: { jobId: "job_1" } });
    ctx.restoreFetch();
  });

  it("completes with a model-kind media output pinned to model/gltf-binary", async () => {
    const fetch = fetchSequence(
      graphqlResponse(200, {
        data: {
          getJob: {
            progress: { state: "FINISHED" },
            outputs: [
              { key: "MAIN_GLB", file: { id: "f1", presignedUrl: "https://cdn.move.ai/output/model.glb" } },
            ],
          },
        },
      }),
    );
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.poll!(
        {
          taskId: "t1",
          operation: "poll",
          pollState: { jobId: "job_1" },
          input: { values: {}, references: [] },
        } as never,
        ctx as never,
      ),
    ).resolves.toEqual({
      status: "completed",
      media: {
        media: {
          url: "https://cdn.move.ai/output/model.glb",
          mediaType: "model/gltf-binary",
          kind: "model",
        },
      },
    });
    ctx.restoreFetch();
  });

  it("surfaces a failed job as a Provider failure", async () => {
    const fetch = fetchSequence(
      graphqlResponse(200, { data: { getJob: { progress: { state: "FAILED" }, outputs: [] } } }),
    );
    const ctx = context({ apiKey: "sk-test", fetch });
    await expect(
      moveAiAdapter.poll!(
        {
          taskId: "t1",
          operation: "poll",
          pollState: { jobId: "job_1" },
          input: { values: {}, references: [] },
        } as never,
        ctx as never,
      ),
    ).rejects.toBeInstanceOf(ProviderExecutionError);
    ctx.restoreFetch();
  });

  it("never leaks the apiKey through an accepted poll result", async () => {
    const fetch = fetchSequence(
      graphqlResponse(200, { data: { getJob: { progress: { state: "RUNNING" }, outputs: [] } } }),
    );
    const ctx = context({ apiKey: "sk-super-secret", fetch });
    const result = await moveAiAdapter.poll!(
      {
        taskId: "t1",
        operation: "poll",
        pollState: { jobId: "job_1" },
        input: { values: {}, references: [] },
      } as never,
      ctx as never,
    );
    expect(JSON.stringify(result)).not.toContain("sk-super-secret");
    ctx.restoreFetch();
  });
});
