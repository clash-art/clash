import { describe, expect, it, vi } from "vitest";

import { createLocalMediaAnalysisService } from "./local-media-analysis.js";

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
      references: [reference],
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
      modelParams: {
        video_processing: "auto",
        video_fps: 2,
        video_media_resolution: "high",
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
      modelParams: {
        video_processing: "static",
        video_fps: 12,
        video_media_resolution: "medium",
        video_start_seconds: 3.55,
        video_end_seconds: 6.05,
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
