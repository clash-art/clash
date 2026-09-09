import { afterEach, describe, expect, it, vi } from "vitest";

import { googleAdapter } from "./google-adapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type CapturedRequest = {
  url: string;
  method?: string;
  body: Record<string, unknown>;
};

function invocation(
  values: Record<string, unknown>,
  options: {
    operation?: "submit" | "poll";
    pollState?: unknown;
    references?: unknown[];
  } = {},
) {
  return {
    invocationId: "invocation-1",
    operation: options.operation ?? "submit",
    ...(options.pollState === undefined
      ? {}
      : { pollState: options.pollState }),
    input: {
      values: {
        ...values,
      },
      references: options.references ?? [],
    },
  } as never;
}

function context(
  responseBody: unknown,
  captured: CapturedRequest[],
  stored: Record<string, string> = {
    accessToken: "test-access-token",
    projectId: "test-project",
    region: "us-central1",
    service: "agent-platform",
  },
  reference?: (input: unknown) => Promise<unknown>,
) {
  vi.stubGlobal(
    "fetch",
    async (url: string, init: { method?: string; body?: string } = {}) => {
      captured.push({
        url,
        method: init.method,
        body: JSON.parse(init.body ?? "{}") as Record<string, unknown>,
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(responseBody),
      };
    },
  );
  return {
    store: {
      get: async (key: string) => stored[key],
      put: async () => undefined,
      remove: async () => undefined,
    },
    ...(reference ? { reference } : {}),
  } as never;
}

describe("Google API families", () => {
  // Wire contract and supported models:
  // https://ai.google.dev/gemini-api/docs/generate-content/video-understanding
  // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding
  it.each([
    ["gemini-3.8-flash", "agent-platform", false, true],
    ["gemini-3.7-flash", "agent-platform", false, true],
    ["gemini-3.6-flash", "agent-platform", false, true],
    ["gemini-3.5-flash-lite", "agent-platform", false, true],
    ["gemini-3.7-flash", "agent-platform", true, true],
    ["gemini-3.7-flash", "ai-studio", false, true],
    ["gemini-3.5-flash", "agent-platform", false, false],
    ["gemini-3.7-flash-image", "ai-studio", false, false],
  ] as const)("selects generateContent processing for %s on %s (project: %s, agentic: %s)", async (model, service, project, agentic) => {
    const requests: CapturedRequest[] = [];
    await googleAdapter.submit(
      invocation({
        modelId: "analysis-card", upstreamModel: model, kind: "text", prompt: "Describe.",
        modelParams: { video_media_resolution: "high" },
      }, { references: [{ slot: "video", index: 0, asset: {
        assetId: "video", uri: "clash-asset://video", kind: "video",
      } }] }),
      context({ candidates: [{ content: { parts: [{ text: "Description" }] } }] },
        requests, project
          ? { accessToken: "test-token", projectId: "test-project", service, region: "global" }
          : { apiKey: "test-key", service, region: "global" },
        async () => ({ form: "provider-url", providerUrl: "https://youtu.be/7Z5Vy9JBANs",
          kind: "video", mediaType: "video/mp4" })),
    );
    expect(requests[0]?.url).toBe(service === "ai-studio"
      ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
      : project
        ? `https://aiplatform.googleapis.com/v1beta1/projects/test-project/locations/global/publishers/google/models/${model}:generateContent`
        : `https://aiplatform.googleapis.com/${agentic ? "v1beta1" : "v1"}/publishers/google/models/${model}:generateContent`);
    expect(requests[0]?.body.generationConfig).toEqual(agentic
      ? { responseModalities: ["TEXT"] }
      : { responseModalities: ["TEXT"], mediaResolution: "MEDIA_RESOLUTION_HIGH" });
    expect(requests[0]?.body.contents).toEqual([{ role: "user", parts: [
      { text: "Describe." },
      { fileData: { mimeType: "video/mp4", fileUri: "https://youtu.be/7Z5Vy9JBANs" },
        ...(agentic ? { mediaProcessing: "AGENTIC" } : {}) },
    ] }]);
  });

  it.each([
    [{ video_processing: "static", video_fps: 12 }, false],
    [{ video_fps: 12 }, false],
    [{ video_processing: "auto", video_fps: 12 }, true],
  ] as const)("respects explicit sampling controls %j", async (modelParams, agentic) => {
    const requests: CapturedRequest[] = [];
    await googleAdapter.submit(invocation({
      upstreamModel: "gemini-3.7-flash", kind: "text", modelParams,
    }, { references: [{ slot: "content", index: 0, asset: {
      assetId: "video", uri: "clash-asset://video", kind: "video",
    } }] }), context({ candidates: [{ content: { parts: [{ text: "Answer" }] } }] },
      requests, { apiKey: "test-key", service: "ai-studio" },
      async () => ({ form: "bytes", bytes: new Uint8Array([1, 2]), kind: "video", mediaType: "video/mp4" })));
    expect(requests[0]?.body.contents).toEqual([{ role: "user", parts: [{
      inlineData: { mimeType: "video/mp4", data: "AQI=" },
      ...(agentic ? { mediaProcessing: "AGENTIC" } : { videoMetadata: { fps: 12 } }),
    }] }]);
  });

  it("classifies a non-JSON submit outage as an ambiguous retryable failure", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "<html>upstream unavailable</html>",
    }));

    await expect(
      googleAdapter.submit(
        invocation({
          modelId: "nano-banana-2",
          upstreamModel: "gemini-3.1-flash-image",
          kind: "image",
          prompt: "A red circle.",
        }),
        {
          store: {
            get: async (key: string) =>
              ({
                apiKey: "test-key",
                service: "ai-studio",
              })[key],
          },
        } as never,
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "provider_unavailable",
        retryable: true,
        requestState: "unknown",
        providerCode: "HTTP_503",
      },
    });
  });

  it("reads image resolution from the model parameter envelope used by the backend", async () => {
    const requests: CapturedRequest[] = [];
    await googleAdapter.submit(
      invocation({
        modelId: "nano-banana-2",
        upstreamModel: "gemini-3.1-flash-image",
        kind: "image",
        prompt: "A red circle.",
        aspectRatio: "1:1",
        modelParams: { resolution: "1K" },
      }),
      context(
        {
          candidates: [
            {
              content: {
                parts: [
                  { inlineData: { mimeType: "image/png", data: "AAE=" } },
                ],
              },
            },
          ],
        },
        requests,
      ),
    );

    expect(requests[0]?.body).toMatchObject({
      generationConfig: {
        imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
      },
    });
  });

  it("uses generateContent AUDIO and the selected voice for TTS", async () => {
    const requests: CapturedRequest[] = [];
    await googleAdapter.submit(
      invocation({
        modelId: "gemini-3.1-flash-tts",
        upstreamModel: "gemini-3.1-flash-tts-preview",
        kind: "audio",
        prompt: "Read this sentence.",
        modelParams: { voice_name: "Kore" },
      }),
      context(
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/L16;rate=24000",
                      data: "AAE=",
                    },
                  },
                ],
              },
            },
          ],
        },
        requests,
      ),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toMatch(
      /gemini-3\.1-flash-tts-preview:generateContent$/,
    );
    expect(requests[0]?.body).toMatchObject({
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
        },
      },
    });
  });

  it("emits a standards-readable WAV from captured L16 TTS media", async () => {
    const result = await googleAdapter.submit(
      invocation({
        modelId: "gemini-3.1-flash-tts",
        upstreamModel: "gemini-3.1-flash-tts-preview",
        kind: "audio",
        prompt: "Read this sentence.",
        modelParams: { voice_name: "Kore" },
      }),
      context(
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/L16;rate=24000",
                      data: "AAE=",
                    },
                  },
                ],
              },
            },
          ],
        },
        [],
      ),
    );

    expect(result).toMatchObject({
      status: "completed",
      media: { media: { mediaType: "audio/wav" } },
    });
    if (result.status !== "completed" || !("media" in result)) {
      throw new Error("expected completed media");
    }
    const media = result.media.media;
    if (!("base64" in media)) throw new Error("expected inline audio bytes");
    const wav = Buffer.from(media.base64, "base64");
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(38);
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(view.getUint32(40, true)).toBe(2);
    expect([...wav.subarray(44)]).toEqual([0, 1]);
  });

  it.each([
    {
      caseName: "missing sample rate",
      mimeType: "audio/L16",
      data: "AAE=",
    },
    {
      caseName: "zero channels",
      mimeType: "audio/L16;rate=24000;channels=0",
      data: "AAE=",
    },
    {
      caseName: "odd sample byte length",
      mimeType: "audio/L16;rate=24000;channels=1",
      data: "AA==",
    },
  ])("rejects $caseName in returned L16 media", async ({ mimeType, data }) => {
    await expect(
      googleAdapter.submit(
        invocation({
          modelId: "gemini-3.1-flash-tts",
          upstreamModel: "gemini-3.1-flash-tts-preview",
          kind: "audio",
          prompt: "Read this sentence.",
          modelParams: { voice_name: "Kore" },
        }),
        context(
          {
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType, data } }],
                },
              },
            ],
          },
          [],
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "invalid_response",
        retryable: false,
        requestState: "accepted",
      },
    });
  });

  it("sends a Host-resolved Provider URL to generateContent for ASR", async () => {
    const requests: CapturedRequest[] = [];
    const result = await googleAdapter.submit(
      invocation(
        {
          modelId: "gemini-3.5-flash",
          upstreamModel: "gemini-3.5-flash",
          kind: "text",
          prompt: "This scalar prompt must not replace authored content parts.",
        },
        {
          // Deliberately shuffled: `index`, not array insertion order, is the authored order.
          references: [
            {
              slot: "content",
              index: 1,
              asset: {
                assetId: "asr-audio",
                uri: "clash-asset://asr-audio",
                kind: "audio",
              },
            },
            {
              slot: "content",
              index: 0,
              text: {
                nodeId: "prompt-text",
                value: "Transcribe this audio exactly.",
              },
            },
          ],
        },
      ),
      context(
        {
          candidates: [
            { content: { parts: [{ text: "hello from the recording" }] } },
          ],
        },
        requests,
        undefined,
        async (reference) => {
          const typed = reference as {
            asset?: { assetId?: string };
            text?: { value?: string };
          };
          if (typed.text) {
            return { form: "text", text: typed.text.value ?? "" };
          }
          if (typed.asset?.assetId === "asr-audio") {
            return {
              form: "provider-url",
              providerUrl: "https://objects.example.test/asr.wav?sig=1",
              expiresAt: "2026-08-13T12:00:00.000Z",
              kind: "audio",
              mediaType: "audio/wav",
            };
          }
          throw new Error("unexpected Google reference");
        },
      ),
    );

    expect(requests[0]?.body).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [
            { text: "Transcribe this audio exactly." },
            {
              fileData: {
                mimeType: "audio/wav",
                fileUri: "https://objects.example.test/asr.wav?sig=1",
              },
            },
          ],
        },
      ],
      generationConfig: { responseModalities: ["TEXT"] },
    });
    expect(result).toEqual({
      status: "completed",
      outputs: [
        { slot: "text", kind: "value", value: "hello from the recording" },
      ],
    });
  });

  it.each([
    ["gemini-3.5-flash", "auto"],
    ["gemini-3.7-flash", "static"],
    ["gemini-3.7-flash", "auto"],
  ])("preserves clipped video sampling for %s in %s mode", async (model, processing) => {
    const requests: CapturedRequest[] = [];
    await googleAdapter.submit(
      invocation(
        {
          modelId: model,
          upstreamModel: model,
          kind: "text",
          prompt: "Review this boundary.",
          modelParams: {
            video_processing: processing,
            video_fps: 12,
            video_start_seconds: 4.25,
            video_end_seconds: 6.75,
            video_media_resolution: "high",
          },
        },
        {
          references: [{
            slot: "video",
            index: 0,
            asset: {
              assetId: "analysis-video",
              uri: "clash-asset://analysis-video",
              kind: "video",
            },
          }],
        },
      ),
      context(
        { candidates: [{ content: { parts: [{ text: '{"boundaryMs":5000}' }] } }] },
        requests,
        undefined,
        async () => ({
          form: "provider-url",
          providerUrl: "https://objects.example.test/video.mp4?sig=1",
          expiresAt: "2026-08-13T12:00:00.000Z",
          kind: "video",
          mediaType: "video/mp4",
        }),
      ),
    );

    expect(requests[0]?.url).toBe(`https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/${model}:generateContent`);
    expect(requests[0]?.body).toEqual({
      contents: [{
        role: "user",
        parts: [
          { text: "Review this boundary." },
          {
            fileData: {
              mimeType: "video/mp4",
              fileUri: "https://objects.example.test/video.mp4?sig=1",
            },
            videoMetadata: {
              fps: 12,
              startOffset: "4.25s",
              endOffset: "6.75s",
            },
          },
        ],
      }],
      generationConfig: {
        responseModalities: ["TEXT"],
        mediaResolution: "MEDIA_RESOLUTION_HIGH",
      },
    });
  });

  it("submits Veo text/reference work through predictLongRunning", async () => {
    const requests: CapturedRequest[] = [];
    const result = await googleAdapter.submit(
      invocation(
        {
          modelId: "veo-3.1-fast",
          upstreamModel: "veo-3.1-fast-generate-001",
          kind: "video",
          prompt: "A paper kite rises above a quiet beach.",
          aspectRatio: "16:9",
          duration: 4,
          modelParams: { generate_audio: true },
        },
        {
          references: [
            {
              slot: "image",
              index: 1,
              asset: {
                assetId: "kite-2",
                uri: "clash-asset://kite-2",
                kind: "image",
              },
            },
            {
              slot: "image",
              index: 0,
              asset: {
                assetId: "kite-1",
                uri: "clash-asset://kite-1",
                kind: "image",
              },
            },
          ],
        },
      ),
      context(
        {
          name: "projects/test-project/locations/us-central1/operations/operation-1",
        },
        requests,
        undefined,
        async (reference) => {
          const assetId = (reference as { asset?: { assetId?: string } }).asset
            ?.assetId;
          return {
            form: "bytes",
            bytes: Uint8Array.from(
              Buffer.from(
                assetId === "kite-1" ? "a2l0ZS0x" : "a2l0ZS0y",
                "base64",
              ),
            ),
            kind: "image",
            mediaType: "image/png",
          };
        },
      ),
    );

    expect(requests[0]?.url).toMatch(
      /veo-3\.1-fast-generate-001:predictLongRunning$/,
    );
    expect(requests[0]?.body).toMatchObject({
      instances: [
        {
          prompt: "A paper kite rises above a quiet beach.",
          referenceImages: [
            {
              image: {
                bytesBase64Encoded: "a2l0ZS0x",
                mimeType: "image/png",
              },
              referenceType: "asset",
            },
            {
              image: {
                bytesBase64Encoded: "a2l0ZS0y",
                mimeType: "image/png",
              },
              referenceType: "asset",
            },
          ],
        },
      ],
      parameters: {
        aspectRatio: "16:9",
        durationSeconds: 4,
        generateAudio: true,
        sampleCount: 1,
      },
    });
    expect(result).toEqual({
      status: "accepted",
      pollState: {
        family: "veo",
        model: "veo-3.1-fast-generate-001",
        operationName:
          "projects/test-project/locations/us-central1/operations/operation-1",
      },
    });
  });

  it("preserves Veo first and last frames as distinct fields", async () => {
    const requests: CapturedRequest[] = [];
    await googleAdapter.submit(
      invocation(
        {
          modelId: "veo-3.1-startend",
          upstreamModel: "veo-3.1-generate-001",
          kind: "video",
          prompt: "Move gently from dawn to dusk.",
        },
        {
          references: [
            {
              slot: "endFrame",
              index: 0,
              asset: {
                assetId: "end-frame",
                uri: "clash-asset://end-frame",
                kind: "image",
              },
            },
            {
              slot: "startFrame",
              index: 0,
              asset: {
                assetId: "start-frame",
                uri: "clash-asset://start-frame",
                kind: "image",
              },
            },
          ],
        },
      ),
      context(
        { name: "operation-2" },
        requests,
        undefined,
        async (reference) => {
          const assetId = (reference as { asset?: { assetId?: string } }).asset
            ?.assetId;
          const end = assetId === "end-frame";
          return {
            form: "bytes",
            bytes: Uint8Array.from(
              Buffer.from(end ? "ZW5k" : "c3RhcnQ=", "base64"),
            ),
            kind: "image",
            mediaType: end ? "image/jpeg" : "image/png",
          };
        },
      ),
    );

    expect(requests[0]?.body).toMatchObject({
      instances: [
        {
          image: { bytesBase64Encoded: "c3RhcnQ=", mimeType: "image/png" },
          lastFrame: { bytesBase64Encoded: "ZW5k", mimeType: "image/jpeg" },
        },
      ],
    });
  });

  it("polls Veo with fetchPredictOperation and returns generated bytes", async () => {
    const requests: CapturedRequest[] = [];
    const result = await googleAdapter.poll!(
      invocation(
        {
          upstreamModel: "veo-3.1-generate-001",
        },
        {
          operation: "poll",
          pollState: {
            family: "veo",
            model: "veo-3.1-generate-001",
            operationName:
              "projects/test-project/locations/us-central1/operations/operation-3",
          },
        },
      ),
      context(
        {
          done: true,
          response: {
            videos: [
              { bytesBase64Encoded: "AAAAIGZ0eXA=", mimeType: "video/mp4" },
            ],
          },
        },
        requests,
      ),
    );

    expect(requests[0]?.url).toMatch(
      /veo-3\.1-generate-001:fetchPredictOperation$/,
    );
    expect(requests[0]?.body).toEqual({
      operationName:
        "projects/test-project/locations/us-central1/operations/operation-3",
    });
    expect(result).toEqual({
      status: "completed",
      media: { media: { base64: "AAAAIGZ0eXA=", mediaType: "video/mp4" } },
    });
  });

  it("uses the Interactions API for Gemini Omni instead of generateContent", async () => {
    const requests: CapturedRequest[] = [];
    const result = await googleAdapter.submit(
      invocation(
        {
          modelId: "gemini-omni-flash",
          upstreamModel: "gemini-omni-flash-preview",
          apiShape: "google-ai-studio-interactions",
          kind: "video",
          prompt: "A stale scalar prompt.",
          aspectRatio: "16:9",
          duration: 5,
        },
        {
          references: [
            {
              slot: "content",
              index: 0,
              text: {
                nodeId: "omni-prompt",
                value:
                  "A small origami bird takes flight with soft wing sounds.",
              },
            },
          ],
        },
      ),
      context(
        {
          id: "interaction-7",
          status: "in_progress",
        },
        requests,
        undefined,
        async (reference) => ({
          form: "text",
          text: (reference as { text?: { value?: string } }).text?.value ?? "",
        }),
      ),
    );

    expect(requests[0]?.url).toMatch(
      /\/v1beta1\/projects\/test-project\/locations\/us-central1\/interactions$/,
    );
    expect(requests[0]?.body).toMatchObject({
      model: "gemini-omni-flash-preview",
      input: "A small origami bird takes flight with soft wing sounds.",
      response_format: {
        type: "video",
        aspect_ratio: "16:9",
        duration: "5s",
      },
      background: true,
      store: true,
      stream: false,
    });
    expect(
      (
        requests[0]?.body as {
          response_format?: Record<string, unknown>;
        }
      ).response_format,
    ).not.toHaveProperty("delivery");
    expect(result).toEqual({
      status: "accepted",
      pollState: { family: "interaction", interactionId: "interaction-7" },
    });
  });

  it("fails closed when Gemini Omni receives unrecorded reference media", async () => {
    const requests: CapturedRequest[] = [];

    await expect(
      googleAdapter.submit(
        invocation(
          {
            modelId: "gemini-omni-flash",
            upstreamModel: "gemini-omni-flash-preview",
            apiShape: "google-ai-studio-interactions",
            kind: "video",
            prompt: "Animate this image.",
          },
          {
            references: [
              {
                slot: "image",
                index: 0,
                asset: {
                  assetId: "unrecorded-omni-image",
                  uri: "clash-asset://unrecorded-omni-image",
                  kind: "image",
                },
              },
            ],
          },
        ),
        context(
          { id: "must-not-submit", status: "in_progress" },
          requests,
          undefined,
          async () => ({
            form: "bytes",
            bytes: Uint8Array.from([137, 80, 78, 71]),
            kind: "image",
            mediaType: "image/png",
          }),
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        code: "invalid_request",
        retryable: false,
        requestState: "rejected",
      },
    });
    expect(requests).toEqual([]);
  });

  it("addresses Gemini Omni on AI Studio when the account uses an API key", async () => {
    const requests: CapturedRequest[] = [];
    await googleAdapter.submit(
      invocation({
        modelId: "gemini-omni-flash",
        upstreamModel: "gemini-omni-flash-preview",
        kind: "video",
        prompt: "A paper bird takes flight.",
      }),
      context(
        { id: "interaction-ai-studio", status: "in_progress" },
        requests,
        { apiKey: "test-api-key", service: "ai-studio" },
      ),
    );

    expect(requests[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
    );
  });

  it("polls a completed Gemini Omni interaction for its video", async () => {
    const requests: CapturedRequest[] = [];
    const result = await googleAdapter.poll!(
      invocation(
        {},
        {
          operation: "poll",
          pollState: { family: "interaction", interactionId: "interaction-7" },
        },
      ),
      context(
        {
          id: "interaction-7",
          status: "completed",
          outputs: [
            { type: "video", data: "AAAAIGZ0eXA=", mime_type: "video/mp4" },
          ],
        },
        requests,
      ),
    );

    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toMatch(/\/interactions\/interaction-7$/);
    expect(result).toEqual({
      status: "completed",
      media: { media: { base64: "AAAAIGZ0eXA=", mediaType: "video/mp4" } },
    });
  });
});
