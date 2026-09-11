import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
  buildFalDirectorModelInput,
  falPoll,
  falSubmit,
} from "./fal-executor.js";
import { falAdapter } from "./fal-adapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(
  body: unknown,
  status = 200,
): {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "error",
    text: async () => JSON.stringify(body),
  };
}

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
    invocationId: "fal-invocation-1",
    taskId: "fal-task-1",
    projectId: "project-1",
    operation: options.operation ?? "submit",
    target: {
      pluginId: "clash.fal",
      version: "0.2.0",
      exportId: "fal-execute",
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
  resolveReference: (reference: unknown) => Promise<unknown> = async () => {
    throw new Error("unexpected reference");
  },
) {
  return {
    store: {
      get: async (key: string) =>
        key === "apiKey"
          ? "fal-key"
          : key === "queueBaseUrl"
            ? "https://queue.fal.test"
            : key === "storageBaseUrl"
              ? "https://storage.fal.test"
              : undefined,
      put: async () => undefined,
      remove: async () => undefined,
    },
    reference: resolveReference,
  } as never;
}

describe("fal executor", () => {
  // Endpoint/parameter contract: fal.ai/models/openai/gpt-image-2.5/flare/text-to-image/api
  it.each(["flare", "sunburst"])(
    "routes GPT Image 2.5 %s edits and preserves quality, size and alpha",
    async (variant) => {
      const fetch = vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(
          `https://queue.fal.test/openai/gpt-image-2.5/${variant}/edit`,
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          image_size: { width: 3840, height: 2160 },
          quality: "max",
          background: "transparent",
          output_format: "webp",
          num_images: 1,
          image_urls: ["https://assets.example.test/pose.png"],
        });
        return jsonResponse({ request_id: "gpt25" });
      });
      vi.stubGlobal("fetch", fetch);
      const result = await falAdapter.submit(
        invocation(
          {
            modelId: `gpt-image-2.5-${variant}`,
            upstreamModel: `openai/gpt-image-2.5/${variant}/text-to-image`,
            kind: "image",
            prompt: "keep the pose",
            aspectRatio: "16:9",
            modelParams: {
              resolution: "3840x2160",
              quality: "max",
              background: "transparent",
              output_format: "webp",
            },
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
        context(async () => ({
          form: "provider-url",
          providerUrl: "https://assets.example.test/pose.png",
          kind: "image",
          mediaType: "image/png",
        })),
      );
      expect(result.status).toBe("accepted");
    },
  );

  it("translates Director quality into the upstream Hunyuan3D request", () => {
    expect(
      buildFalDirectorModelInput({
        prompt: "A chestnut horse",
        quality: "low-poly",
        pbr: true,
        faceCount: 123_456,
      }),
    ).toEqual({
      prompt: "A chestnut horse",
      enable_pbr: true,
      face_count: 123_456,
      generate_type: "LowPoly",
      polygon_type: "quadrilateral",
    });
  });

  it("submits once and returns the opaque request id without polling", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ request_id: "request-9" }),
    );
    const result = await falSubmit({
      apiKey: "fal-key",
      endpoint: HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
      input: { prompt: "A chestnut horse", quality: "normal", pbr: true },
      fetch,
      queueBaseUrl: "https://queue.fal.test",
    });

    expect(result).toEqual({
      status: "accepted",
      pollState: { requestId: "request-9" },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `https://queue.fal.test/${HUNYUAN3D_TEXT_TO_3D_ENDPOINT}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("checks a queued request once and leaves scheduling to the Host", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: "IN_PROGRESS" }),
    );
    const result = await falPoll({
      apiKey: "fal-key",
      endpoint: HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
      state: { requestId: "request-9" },
      fetch,
      queueBaseUrl: "https://queue.fal.test",
    });

    expect(result).toEqual({
      status: "accepted",
      pollState: { requestId: "request-9" },
      retryAfterMs: 1_000,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("checkpoints a completed status before fetching the GLB result", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "COMPLETED" }))
      .mockResolvedValueOnce(
        jsonResponse({
          model_glb: {
            url: "https://fal.media/horse.glb",
            content_type: "model/gltf-binary",
          },
          thumbnail: { url: "https://fal.media/horse.png" },
        }),
      );
    const status = await falPoll({
      apiKey: "fal-key",
      endpoint: HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
      state: { requestId: "request-9" },
      fetch,
      queueBaseUrl: "https://queue.fal.test",
    });
    expect(status).toEqual({
      status: "accepted",
      pollState: { requestId: "request-9", phase: "result" },
      retryAfterMs: 0,
    });
    expect(fetch).toHaveBeenCalledOnce();

    const result = await falPoll({
      apiKey: "fal-key",
      endpoint: HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
      state: { requestId: "request-9", phase: "result" },
      fetch,
      queueBaseUrl: "https://queue.fal.test",
    });

    expect(result).toEqual({
      status: "completed",
      media: {
        url: "https://fal.media/horse.glb",
        contentType: "model/gltf-binary",
      },
      thumbnailUrl: "https://fal.media/horse.png",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toMatch(/\/status$/);
    expect(fetch.mock.calls[1]?.[0]).not.toMatch(/\/status$/);
  });

  it("preserves the checkpointed result phase through the SDK adapter", async () => {
    const fetch = vi.fn(async (_url: string) =>
      jsonResponse({
        model_glb: {
          url: "https://fal.media/recovered.glb",
          content_type: "model/gltf-binary",
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await falAdapter.poll!(
      {
        protocol: "clash.plugin.invoke/v1",
        invocationId: "fal-result-phase",
        taskId: "director:run-1:media",
        projectId: "project-1",
        operation: "poll",
        target: {
          pluginId: "clash.fal",
          version: "0.1.0",
          exportId: "fal-execute",
          schemaHash: `sha256:${"f".repeat(64)}`,
          kind: "provider-executor",
        },
        input: {
          values: {
            kind: "model",
            upstreamModel: HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
          },
          references: [],
        },
        pollState: { requestId: "request-9", phase: "result" },
        actor: { kind: "system", id: "local-aigc" },
      } as never,
      {
        store: {
          get: async (key: string) =>
            key === "apiKey"
              ? "fal-key"
              : key === "queueBaseUrl"
                ? "https://queue.fal.test"
                : undefined,
          put: async () => undefined,
          remove: async () => undefined,
        },
      } as never,
    );

    expect(result).toEqual({
      status: "completed",
      media: {
        media: {
          url: "https://fal.media/recovered.glb",
          mediaType: "model/gltf-binary",
          kind: "model",
        },
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).not.toMatch(/\/status$/);
  });

  it("preserves the accepted-state boundary on poll failures", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ detail: "upstream unavailable" }, 503),
    );
    await expect(
      falPoll({
        apiKey: "fal-key",
        endpoint: HUNYUAN3D_TEXT_TO_3D_ENDPOINT,
        state: { requestId: "request-9" },
        fetch,
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "provider_unavailable",
        retryable: true,
        requestState: "accepted",
      },
    });
  });

  it("selects the image edit endpoint and passes resolved image URLs", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: "keep the pose, change the costume",
        aspect_ratio: "9:16",
        num_images: 1,
        output_format: "png",
        image_urls: ["https://assets.example.test/pose.png"],
      });
      return jsonResponse({ request_id: "image-request" });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      falAdapter.submit(
        invocation(
          {
            modelId: "nano-banana-2",
            upstreamModel: "fal-ai/nano-banana-2",
            kind: "image",
            prompt: "keep the pose, change the costume",
            aspectRatio: "9:16",
            modelParams: {},
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
        context(async () => ({
          form: "provider-url",
          providerUrl: "https://assets.example.test/pose.png",
          kind: "image",
          mediaType: "image/png",
        })),
      ),
    ).resolves.toEqual({
      status: "accepted",
      pollState: {
        requestId: "image-request",
        endpoint: "fal-ai/nano-banana-2/edit",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://queue.fal.test/fal-ai/nano-banana-2/edit",
    );
  });

  it("resumes a dynamic endpoint from opaque poll state", async () => {
    const fetch = vi.fn(async (_url: string) =>
      jsonResponse({ status: "IN_PROGRESS" }),
    );
    vi.stubGlobal("fetch", fetch);

    await falAdapter.poll!(
      invocation(
        {
          modelId: "nano-banana-2",
          upstreamModel: "fal-ai/nano-banana-2",
          kind: "image",
        },
        {
          operation: "poll",
          pollState: {
            requestId: "image-request",
            endpoint: "fal-ai/nano-banana-2/edit",
          },
        },
      ),
      context(),
    );

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://queue.fal.test/fal-ai/nano-banana-2/edit/requests/image-request/status",
    );
  });

  it("uploads Host-resolved bytes before the single paid queue submission", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://storage.fal.test/storage/upload/initiate")) {
        return jsonResponse({
          upload_url: "https://uploads.fal.test/reference",
          file_url: "https://v3.fal.media/reference.png",
        });
      }
      if (url === "https://uploads.fal.test/reference") {
        expect(init?.method).toBe("PUT");
        return jsonResponse({});
      }
      if (url === "https://queue.fal.test/fal-ai/nano-banana-2/edit") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          image_urls: ["https://v3.fal.media/reference.png"],
        });
        return jsonResponse({ request_id: "uploaded-image-request" });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    await falAdapter.submit(
      invocation(
        {
          modelId: "nano-banana-2",
          upstreamModel: "fal-ai/nano-banana-2",
          kind: "image",
          prompt: "restyle",
          modelParams: {},
        },
        {
          references: [
            {
              slot: "image",
              index: 0,
              asset: {
                assetId: "local-image",
                uri: "clash-asset://local-image",
                kind: "image",
              },
            },
          ],
        },
      ),
      context(async () => ({
        form: "bytes",
        bytes: Uint8Array.from([1, 2, 3]),
        kind: "image",
        mediaType: "image/png",
      })),
    );

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).startsWith("https://queue.fal.test/"),
      ),
    ).toHaveLength(1);
  });

  it("keeps mixed Seedance references in their provider fields", async () => {
    const referenceUrls = new Map([
      ["image", "https://assets.example.test/reference.png"],
      ["video", "https://assets.example.test/reference.mp4"],
      ["audio", "https://assets.example.test/reference.wav"],
    ]);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: "@Image1 attacks on @Video1 timing with @Audio1 rhythm",
        duration: "auto",
        resolution: "720p",
        aspect_ratio: "adaptive",
        generate_audio: true,
        seed: 42,
        image_urls: ["https://assets.example.test/reference.png"],
        video_urls: ["https://assets.example.test/reference.mp4"],
        audio_urls: ["https://assets.example.test/reference.wav"],
      });
      return jsonResponse({ request_id: "seedance-request" });
    });
    vi.stubGlobal("fetch", fetch);

    await falAdapter.submit(
      invocation(
        {
          modelId: "seedance-2-ref",
          upstreamModel: "bytedance/seedance-2.0/reference-to-video",
          kind: "video",
          prompt: "@Image1 attacks on @Video1 timing with @Audio1 rhythm",
          aspectRatio: "adaptive",
          duration: "auto",
          modelParams: { resolution: "720p", generate_audio: true, seed: 42 },
        },
        {
          references: ["image", "video", "audio"].map((kind, index) => ({
            slot: "content",
            index,
            asset: {
              assetId: `${kind}-1`,
              uri: `clash-asset://${kind}-1`,
              kind,
            },
          })),
        },
      ),
      context(async (reference: any) => ({
        form: "provider-url",
        providerUrl: referenceUrls.get(reference.asset.kind),
        kind: reference.asset.kind,
      })),
    );

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://queue.fal.test/bytedance/seedance-2.0/reference-to-video",
    );
  });

  it("maps three or more FLUX 3 references to explicit keyframe indices", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: "three-beat fight combination",
        duration: 10,
        aspect_ratio: "16:9",
        resolution: "1080p",
        generate_audio: false,
        safety_tolerance: 3,
        keyframes: [
          {
            image_url: "https://assets.example.test/keyframe-0.png",
            frame_index: 0,
          },
          {
            image_url: "https://assets.example.test/keyframe-1.png",
            frame_index: 72,
          },
          {
            image_url: "https://assets.example.test/keyframe-2.png",
            frame_index: 240,
          },
        ],
      });
      return jsonResponse({ request_id: "keyframe-request" });
    });
    vi.stubGlobal("fetch", fetch);

    await falAdapter.submit(
      invocation(
        {
          modelId: "flux-3-video-keyframes",
          upstreamModel: "blackforestlabs/flux-3/keyframes-to-video",
          kind: "video",
          prompt: "three-beat fight combination",
          aspectRatio: "16:9",
          duration: 10,
          modelParams: {
            resolution: "1080p",
            generate_audio: false,
            safety_tolerance: 3,
            keyframe_frame_indices: "[0,72,240]",
          },
        },
        {
          references: [0, 1, 2].map((index) => ({
            slot: "content",
            index,
            asset: {
              assetId: `keyframe-${index}`,
              uri: `clash-asset://keyframe-${index}`,
              kind: "image",
            },
          })),
        },
      ),
      context(async (reference: any) => ({
        form: "provider-url",
        providerUrl: `https://assets.example.test/${reference.asset.assetId}.png`,
        kind: "image",
      })),
    );

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://queue.fal.test/blackforestlabs/flux-3/keyframes-to-video",
    );
  });

  it("translates the MiniMax TTS card instead of sending the music payload", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        text: "Welcome aboard",
        voice_setting: {
          voice_id: "English_Graceful_Lady",
          speed: 1.2,
          pitch: 2,
        },
        audio_setting: { format: "mp3" },
      });
      return jsonResponse({ request_id: "tts-request" });
    });
    vi.stubGlobal("fetch", fetch);

    await falAdapter.submit(
      invocation({
        modelId: "minimax-tts",
        upstreamModel: "fal-ai/minimax/speech-02-hd",
        kind: "audio",
        prompt: "Welcome aboard",
        modelParams: { voice_id: "female-warm", speed: 1.2, pitch: 2 },
      }),
      context(),
    );

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://queue.fal.test/fal-ai/minimax/speech-02-hd",
    );
  });

  it("returns typed image, video, and audio outputs from the shared queue poller", async () => {
    for (const testCase of [
      {
        kind: "image",
        body: {
          images: [
            { url: "https://fal.media/out.png", content_type: "image/png" },
          ],
        },
        media: {
          url: "https://fal.media/out.png",
          mediaType: "image/png",
          kind: "image",
        },
      },
      {
        kind: "video",
        body: {
          video: {
            url: "https://fal.media/out.mp4",
            content_type: "video/mp4",
          },
        },
        media: {
          url: "https://fal.media/out.mp4",
          mediaType: "video/mp4",
          kind: "video",
        },
      },
      {
        kind: "audio",
        body: {
          audio: {
            url: "https://fal.media/out.mp3",
            content_type: "audio/mpeg",
          },
        },
        media: {
          url: "https://fal.media/out.mp3",
          mediaType: "audio/mpeg",
          kind: "audio",
        },
      },
    ] as const) {
      const fetch = vi.fn(async () => jsonResponse(testCase.body));
      vi.stubGlobal("fetch", fetch);
      await expect(
        falAdapter.poll!(
          invocation(
            {
              modelId: "test-model",
              upstreamModel: "fal-ai/test-model",
              kind: testCase.kind,
            },
            {
              operation: "poll",
              pollState: {
                requestId: `${testCase.kind}-request`,
                phase: "result",
              },
            },
          ),
          context(),
        ),
      ).resolves.toEqual({
        status: "completed",
        media: { media: testCase.media },
      });
      vi.unstubAllGlobals();
    }
  });
});
