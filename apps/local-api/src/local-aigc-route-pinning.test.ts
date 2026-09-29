import { describe, expect, it } from "vitest";

import { createMockExternalAigcService } from "./local-aigc.js";

const card = {
  id: "multi-route-card",
  aliases: [],
  name: "Dummy analysis",
  provider: "dummy-a",
  kind: "text" as const,
  semanticShape: "media_analysis",
  visibility: { scope: "public" as const },
  parameters: [],
  defaultParams: {},
  defaultAspectRatio: "1:1",
  input: {
    requiresPrompt: true,
    inputMode: { images: { max: 1 } },
    promptModalities: ["text" as const, "image" as const],
  },
  providerImplementations: [
    {
      providerId: "dummy-a",
      upstreamId: "dummy-a",
      upstreamModel: "model-a",
      apiShape: "shape-a",
      executorPluginId: "dummy.plugin-a",
      executorExportId: "execute-a",
      priority: 1,
    },
    {
      providerId: "dummy-b",
      upstreamId: "dummy-b",
      upstreamModel: "model-b",
      apiShape: "shape-b",
      executorPluginId: "dummy.plugin-b",
      executorExportId: "execute-b",
      priority: 2,
    },
  ],
};

const pinnedRouteB = {
  providerId: "dummy-b",
  upstreamId: "dummy-b",
  upstreamModel: "model-b",
  apiShape: "shape-b",
  executorPluginId: "dummy.plugin-b",
  executorExportId: "execute-b",
};

function account(providerId: string, enabled = true) {
  return {
    id: `${providerId}-account`,
    providerId,
    upstreamId: providerId,
    enabled,
    configuredCredentials: [],
  };
}

function service(accounts: ReturnType<typeof account>[], requests: Array<Record<string, any>>) {
  return createMockExternalAigcService({
    modelCards: async () => [card as never],
    providerAccounts: async () => accounts,
    providerPluginExecutor: async (request) => {
      requests.push(request as unknown as Record<string, any>);
      return {
        status: "completed",
        binding: {
          pluginId: request.pluginId,
          version: "0.1.0",
          exportId: request.exportId,
          schemaHash: `sha256:${"f".repeat(64)}`,
        },
        output: { slot: "text", kind: "value", value: "{}" },
      };
    },
  });
}

describe("frozen Provider route pinning", () => {
  it("executes the exact pinned implementation instead of the preferred fallback order", async () => {
    const requests: Array<Record<string, any>> = [];
    const aigc = service([account("dummy-a"), account("dummy-b")], requests);

    await aigc.generateText({
      taskId: "unpinned",
      model: "multi-route-card",
      prompt: "inspect",
    });
    expect(requests[0]).toMatchObject({ pluginId: "dummy.plugin-a", exportId: "execute-a" });

    await aigc.generateText({
      taskId: "pinned",
      model: "multi-route-card",
      prompt: "inspect",
      providerRoute: pinnedRouteB,
    });
    expect(requests[1]).toMatchObject({ pluginId: "dummy.plugin-b", exportId: "execute-b" });
    expect(requests[1]?.input.values).toMatchObject({ apiShape: "shape-b" });
  });

  it("fails instead of silently substituting when the pinned route is unavailable", async () => {
    const requests: Array<Record<string, any>> = [];
    const aigc = service([account("dummy-a"), account("dummy-b", false)], requests);

    await expect(
      aigc.generateText({
        taskId: "pinned-unavailable",
        model: "multi-route-card",
        prompt: "inspect",
        providerRoute: pinnedRouteB,
      }),
    ).rejects.toThrow(/no longer available/i);
    expect(requests).toHaveLength(0);
  });

  it("fails before dispatch when the pinned executor cannot honor video sampling controls", async () => {
    const requests: Array<Record<string, any>> = [];
    const aigc = service([account("dummy-b")], requests);
    await expect(aigc.generateText({ taskId: "unsupported-video-controls", model: "multi-route-card", prompt: "inspect",
      providerRoute: pinnedRouteB,
      mediaAnalysisVideo: { processing: "static", fps: 12, mediaResolution: "medium", startSeconds: 3, endSeconds: 4 },
    })).rejects.toThrow(/does not support media-analysis video controls/);
    expect(requests).toHaveLength(0);
  });
});
