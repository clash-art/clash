import { afterEach, describe, expect, it, vi } from "vitest";

import { pikaAdapter } from "./pika-adapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function invocation(
  values: Record<string, unknown>,
  options: {
    operation?: "submit" | "poll";
    pollState?: unknown;
    references?: unknown[];
  } = {},
) {
  return {
    protocol: "clash.plugin.invoke/v1",
    invocationId: "invocation-1",
    taskId: "task-1",
    projectId: "project-1",
    operation: options.operation ?? "submit",
    target: {
      pluginId: "clash.pika",
      version: "0.1.0",
      exportId: "pika-execute",
      schemaHash: `sha256:${"a".repeat(64)}`,
      kind: "provider-executor",
    },
    input: { values, references: options.references ?? [] },
    ...(options.pollState === undefined
      ? {}
      : { pollState: options.pollState }),
    actor: { kind: "system", id: "local-aigc" },
  } as never;
}

function context(
  options: {
    reference?: (reference: unknown) => Promise<unknown>;
  } = {},
) {
  return {
    store: {
      get: async (key: string) =>
        key === "apiKey" ? "pk_live_test" : undefined,
      put: async () => undefined,
      remove: async () => undefined,
    },
    reference:
      options.reference ??
      (async () => {
        throw new Error("unexpected reference");
      }),
  } as never;
}

describe("Pika provider adapter", () => {
  it("completes chat synchronously through the documented model protocol", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        choices: [{ message: { content: "A concise answer." } }],
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      pikaAdapter.submit(
        invocation({
          modelId: "gpt-5.6-sol",
          upstreamModel: "openai/gpt-5.6-sol",
          kind: "text",
          prompt: "Answer briefly.",
        }),
        context(),
      ),
    ).resolves.toEqual({
      status: "completed",
      outputs: [{ slot: "text", kind: "value", value: "A concise answer." }],
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.dev.pika.art/v1/chat/completions",
    );
  });

  it("uploads byte references and submits a paid media request exactly once", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/v1/media/uploads")) {
          return Response.json({
            upload_url: "https://uploads.pika.test/reference",
            url: "https://media.pika.test/reference.png",
          });
        }
        if (url === "https://uploads.pika.test/reference") {
          return new Response(null, { status: 200 });
        }
        if (
          url.endsWith("/v1/media/google/gemini-3.1-flash-image/image-to-image")
        ) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          expect(body).toMatchObject({
            prompt: "make it cinematic",
            image_urls: ["https://media.pika.test/reference.png"],
          });
          return Response.json({ id: "pika-job-1", status: "queued" });
        }
        throw new Error(`unexpected request: ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetch);

    const result = await pikaAdapter.submit(
      invocation(
        {
          modelId: "nano-banana-2",
          upstreamModel: "google/gemini-3.1-flash-image/text-to-image",
          kind: "image",
          prompt: "make it cinematic",
          aspectRatio: "1:1",
          modelParams: { resolution: "1K", count: 1 },
        },
        {
          references: [
            {
              slot: "image",
              index: 0,
              asset: {
                assetId: "image-1",
                uri: "clash-asset://image-1",
                kind: "image",
              },
            },
          ],
        },
      ),
      context({
        reference: async () => ({
          form: "bytes",
          bytes: Uint8Array.from([1, 2, 3]),
          kind: "image",
          mediaType: "image/png",
        }),
      }),
    );

    expect(result).toEqual({
      status: "accepted",
      pollState: { jobId: "pika-job-1" },
      retryAfterMs: 1_000,
    });
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).includes("/v1/media/google/"),
      ),
    ).toHaveLength(1);
  });

  it("passes a Host-published provider URL through without re-uploading it", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        expect(url).toMatch(
          /\/v1\/media\/google\/gemini-3\.1-flash-image\/image-to-image$/,
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          image_urls: ["https://objects.example.test/reference.png?sig=1"],
        });
        return Response.json({ id: "pika-job-url", status: "queued" });
      },
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      pikaAdapter.submit(
        invocation(
          {
            modelId: "nano-banana-2",
            upstreamModel: "google/gemini-3.1-flash-image/text-to-image",
            kind: "image",
            prompt: "preserve the composition",
            modelParams: { count: 1 },
          },
          {
            references: [
              {
                slot: "image",
                index: 0,
                asset: {
                  assetId: "image-url",
                  uri: "clash-asset://image-url",
                  kind: "image",
                },
              },
            ],
          },
        ),
        context({
          reference: async () => ({
            form: "provider-url",
            providerUrl: "https://objects.example.test/reference.png?sig=1",
            expiresAt: "2026-08-13T12:00:00.000Z",
            kind: "image",
            mediaType: "image/png",
          }),
        }),
      ),
    ).resolves.toMatchObject({
      status: "accepted",
      pollState: { jobId: "pika-job-url" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checks an in-progress job once and leaves the schedule to the Host", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        id: "pika-job-2",
        status: "running",
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      pikaAdapter.poll!(
        invocation(
          { kind: "video" },
          {
            operation: "poll",
            pollState: { jobId: "pika-job-2" },
          },
        ),
        context(),
      ),
    ).resolves.toEqual({
      status: "accepted",
      pollState: { jobId: "pika-job-2" },
      retryAfterMs: 1_000,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checkpoints completion before obtaining the generated media URL", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/media/jobs/pika-job-3")) {
        return Response.json({ id: "pika-job-3", status: "completed" });
      }
      if (url.endsWith("/v1/media/jobs/pika-job-3/content")) {
        return Response.json({ url: "https://media.pika.test/final.mp4" });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const status = await pikaAdapter.poll!(
      invocation(
        { kind: "video" },
        {
          operation: "poll",
          pollState: { jobId: "pika-job-3" },
        },
      ),
      context(),
    );
    expect(status).toEqual({
      status: "accepted",
      pollState: { jobId: "pika-job-3", phase: "content" },
      retryAfterMs: 0,
    });
    expect(fetch).toHaveBeenCalledOnce();

    await expect(
      pikaAdapter.poll!(
        invocation(
          { kind: "video" },
          {
            operation: "poll",
            pollState: { jobId: "pika-job-3", phase: "content" },
          },
        ),
        context(),
      ),
    ).resolves.toEqual({
      status: "completed",
      media: {
        media: { url: "https://media.pika.test/final.mp4", kind: "video" },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed durable poll state before reading account secrets", async () => {
    const get = vi.fn(async () => "pk_live_test");
    await expect(
      pikaAdapter.poll!(
        invocation(
          { kind: "image" },
          {
            operation: "poll",
            pollState: {},
          },
        ),
        { store: { get } } as never,
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "contract_violation",
        requestState: "accepted",
        retryable: false,
      },
    });
    expect(get).not.toHaveBeenCalled();
  });
});

it.each([
  {form: "executor-url", executorUrl: "http://127.0.0.1/private-capability", expiresAt: "2099-01-01T00:00:00Z", kind: "image"},
  {form: "document", documentKind: "text.plain", schemaVersion: 1, body: "private document"},
] as const)("rejects $form before uploading a Provider reference", async (resolved) => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(pikaAdapter.submit(invocation({kind: "video", modelId: "pika-2.2", upstreamModel: "pika-v2.2", prompt: "Animate"}, {references: [{slot: "image", index: 0, asset: {assetId: "image", uri: "clash-asset://image", kind: "image"}}]}), context({reference: async () => resolved}))).rejects.toMatchObject({failure: {code: "invalid_request", requestState: "rejected", retryable: false}});
  expect(fetch).not.toHaveBeenCalled();
});
