import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalMediaAnalysisService } from "./local-media-analysis.js";
import { createMockExternalAigcService } from "./local-aigc.js";
import { googleAdapter } from "../../../plugins/google/src/google-adapter.js";

afterEach(() => vi.unstubAllGlobals());

const reference = {
  slot: "source",
  index: 0,
  asset: { assetId: "asset-1", uri: "clash-asset://asset-1", kind: "video" as const, mediaType: "video/mp4" },
};

const frozenRoute = {
  providerId: "dummy-provider",
  accountId: "dummy-account",
  upstreamId: "dummy-upstream",
  upstreamModel: "provider-managed",
  apiShape: "dummy-shape",
};

function runnableOption() {
  return {
    id: "multi-route-card",
    name: "VLM",
    provider: "dummy-provider",
    route: "dummy-shape",
    consumer: { pluginId: "dummy.consumer" },
    visibility: "plugin-private" as const,
    underlyingModel: "provider-managed",
    implementation: frozenRoute,
    sourceKinds: ["video"] as const,
  };
}

describe("local media analysis execution", () => {
  it("sends the actual video and Settings sampling through strict Card validation to Google", async () => {
    const requests: Array<Record<string, any>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"text":"A train arrives."}' }] } }],
      }) };
    });
    const route = { providerId: "official", accountId: "google-test", upstreamId: "google-ai-studio",
      upstreamModel: "gemini-3.1-pro-preview", apiShape: "google-ai-studio",
      executorPluginId: "clash.google", executorExportId: "google-execute" };
    const aigc = createMockExternalAigcService({
      providerAccounts: async () => [{ id: "google-test", providerId: "official", upstreamId: "google-ai-studio",
        enabled: true, configuredCredentials: ["apiKey"], region: "global" }],
      providerPluginExecutor: async (request) => {
        const result = await googleAdapter.submit({ invocationId: request.taskId,
          input: { ...request.input, values: { ...request.input.values, kind: request.kind } },
        } as never, {
          store: { get: async (key: string) => ({ apiKey: "test-key", service: "ai-studio" })[key],
            put: async () => undefined, remove: async () => undefined },
          reference: async () => ({ form: "bytes", bytes: new Uint8Array([1, 2]), kind: "video", mediaType: "video/mp4" }),
        } as never);
        if (result.status !== "completed" || !("outputs" in result)) throw new Error("expected synchronous Google result");
        const output = result.outputs[0];
        if (output?.kind !== "value" || typeof output.value !== "string") throw new Error("expected text");
        return { status: "completed", binding: { pluginId: request.pluginId, exportId: request.exportId,
          version: "0.1.0", schemaHash: `sha256:${"f".repeat(64)}` },
        output: { slot: "text", kind: "value", value: output.value } };
      },
    });
    const service = createLocalMediaAnalysisService({
      config: {
        get: async () => ({ videoEnabled: true, modelId: "gemini-3.1-pro", allowedCategories: null,
          video: { fps: 2, mediaResolution: "high", boundaryRefinement: { enabled: false, fps: 12, safetyMarginSeconds: 0.75 } } }),
        assertRunnable: async () => ({ ...runnableOption(), id: "gemini-3.1-pro", consumer: { pluginId: "clash.media-analysis" }, implementation: route }),
      }, aigc,
    });
    await expect(service.analyze({ projectId: "project-1", invocationId: "analysis-1", taskId: "analysis-1",
      reference, modelId: "gemini-3.1-pro", route, category: "description", prompt: "Describe as JSON.", promptVersion: "v1",
    })).resolves.toMatchObject({ result: { text: "A train arrives." } });
    // Google video understanding's documented wire metadata; this catches dropped source slots as well as rejected controls.
    expect(requests[0]?.contents).toEqual([{ role: "user", parts: [
      { text: "Describe as JSON." },
      { inlineData: { mimeType: "video/mp4", data: "AQI=" }, videoMetadata: { fps: 2 } },
    ] }]);
    expect(requests[0]?.generationConfig).toEqual({ responseModalities: ["TEXT"], mediaResolution: "MEDIA_RESOLUTION_HIGH" });
    await expect(aigc.generateText({ taskId: "invalid-user-param", model: "gemini-3.1-pro", prompt: "Describe.",
      providerRoute: route, modelParams: { video_processing: "auto" },
    })).rejects.toThrow(/not declared/);
    expect(requests).toHaveLength(1);
  });

  it("returns a free-form answer without requiring model JSON or refining scenes", async () => {
    const answer = "The train enters from the left at 00:05.";
    const generateText = vi.fn(async () => ({ text: answer }));
    const service = createLocalMediaAnalysisService({
      config: {
        get: async () => ({
          videoEnabled: true, modelId: "multi-route-card", allowedCategories: null,
          video: { fps: 1, mediaResolution: "medium",
            boundaryRefinement: { enabled: true, fps: 24, safetyMarginSeconds: 0.5 } },
        }),
        assertRunnable: async () => runnableOption(),
      },
      aigc: { generateText } as never,
    });
    const result = await service.analyze({
      projectId: "project-1", invocationId: "ask-1", taskId: "ask-1", reference,
      modelId: "multi-route-card", route: frozenRoute, category: "description",
      prompt: "When and where does the train enter?", promptVersion: "ask/v1",
      responseFormat: "text",
    });
    expect(result).toMatchObject({ result: { text: answer } });
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "When and where does the train enter?",
    }));
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("pins generic text generation to the Host-frozen Provider route and reports its lineage", async () => {
    const generateText = vi.fn(async () => ({
      text: '{"text":"A train arrives."}',
      provider: "dummy-provider",
      modelEndpoint: "provider-managed",
    }));
    const service = createLocalMediaAnalysisService({
      config: {
        get: async () => ({
          videoEnabled: true,
          modelId: "multi-route-card",
          allowedCategories: null,
          video: {
            fps: 1,
            mediaResolution: "medium",
            boundaryRefinement: { enabled: false, fps: 24, safetyMarginSeconds: 0.5 },
          },
        }),
        assertRunnable: async () => runnableOption(),
      },
      aigc: { generateText } as never,
    });

    await expect(service.analyze({
      projectId: "project-1",
      invocationId: "invocation-1",
      taskId: "task-1",
      reference,
      modelId: "multi-route-card",
      route: frozenRoute,
      category: "description",
      prompt: "Describe as JSON.",
      promptVersion: "v1",
    })).resolves.toMatchObject({
      provider: "dummy-provider",
      route: "dummy-shape",
      underlyingModel: "provider-managed",
      result: { text: "A train arrives." },
    });
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: "multi-route-card",
      prompt: "Describe as JSON.",
      providerRoute: frozenRoute,
      references: [{ ...reference, slot: "video" }],
    }));
  });

  it("applies the selected video sampling controls and category policy to execution", async () => {
    const generateText = vi.fn(async () => ({
      text: '{"text":"A train arrives."}',
      provider: "dummy-provider",
      modelEndpoint: "provider-managed",
    }));
    const assertRunnable = vi.fn(async () => runnableOption());
    const service = createLocalMediaAnalysisService({
      config: {
        get: async () => ({
          videoEnabled: true,
          modelId: "multi-route-card",
          allowedCategories: ["description"],
          video: {
            fps: 2,
            mediaResolution: "high" as const,
            boundaryRefinement: { enabled: false, fps: 12, safetyMarginSeconds: 0.75 },
          },
        }),
        assertRunnable,
      },
      aigc: { generateText } as never,
    });

    await service.analyze({
      projectId: "project-1",
      invocationId: "invocation-1",
      taskId: "task-1",
      reference,
      modelId: "multi-route-card",
      route: frozenRoute,
      category: "description",
      prompt: "Describe as JSON.",
      promptVersion: "v1",
    });

    expect(assertRunnable).toHaveBeenCalledWith({
      sourceKind: "video",
      modelId: "multi-route-card",
      category: "description",
    });
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      mediaAnalysisVideo: {
        processing: "auto",
        fps: 2,
        mediaResolution: "high",
      },
    }));
  });

  it("reviews only coarse scene boundaries at the configured higher frame rate", async () => {
    const generateText = vi.fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          scenes: [
            { description: "Platform", startMs: 0, endMs: 4800 },
            { description: "Train", startMs: 4800, endMs: 10000 },
          ],
        }),
        provider: "dummy-provider",
        modelEndpoint: "provider-managed",
      })
      .mockResolvedValueOnce({
        text: '{"boundaryMs":5017}',
        provider: "dummy-provider",
        modelEndpoint: "provider-managed",
      });
    const config = {
      videoEnabled: true,
      modelId: "multi-route-card",
      allowedCategories: ["scene-shot"],
      video: {
        fps: 2,
        mediaResolution: "medium" as const,
        boundaryRefinement: { enabled: true, fps: 12, safetyMarginSeconds: 0.75 },
      },
    };
    const service = createLocalMediaAnalysisService({
      config: {
        get: async () => config,
        assertRunnable: async () => runnableOption(),
      },
      aigc: { generateText } as never,
    });

    const output = await service.analyze({
      projectId: "project-1",
      invocationId: "invocation-1",
      taskId: "task-1",
      reference,
      modelId: "multi-route-card",
      route: frozenRoute,
      category: "scene-shot",
      prompt: "Return scene boundaries as JSON.",
      promptVersion: "v1",
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1]?.[0]).toMatchObject({
      mediaAnalysisVideo: {
        processing: "static",
        fps: 12,
        mediaResolution: "medium",
        startSeconds: 3.55,
        endSeconds: 6.05,
      },
    });
    expect(output.status).toBe("completed");
    if (output.status !== "completed") throw new Error("expected completed analysis");
    expect(output.result).toEqual({
      scenes: [
        { description: "Platform", startMs: 0, endMs: 5017 },
        { description: "Train", startMs: 5017, endMs: 10000 },
      ],
    });
  });
});
