import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelCardSchema } from "@clash/shared-types";

import {
  createMockExternalAigcService,
  type ProviderPluginExecutorRequest,
} from "./local-aigc.js";

afterEach(() => vi.restoreAllMocks());

const model = ModelCardSchema.parse({
  id: "provider-capability-audio",
  name: "Provider capability audio",
  provider: "Test",
  kind: "audio",
  defaultAspectRatio: "1:1",
  parameters: [
    {
      id: "voice_id",
      label: "Voice ID",
      type: "text",
      defaultValue: "",
    },
  ],
  defaultParams: { voice_id: "" },
  input: {
    requiresPrompt: true,
    inputMode: {},
    promptModalities: ["text"],
  },
  availableProviders: ["speech-basic", "speech-full"],
  defaultProvider: "speech-basic",
  providerImplementations: [
    {
      providerId: "speech-basic",
      upstreamId: "speech-basic",
      upstreamModel: "audio-v1",
      apiShape: "speech-basic",
      priority: 1,
      excludedParameterIds: ["voice_id"],
      executorPluginId: "test.speech",
      executorExportId: "basic-execute",
    },
    {
      providerId: "speech-full",
      upstreamId: "speech-full",
      upstreamModel: "audio-v1",
      apiShape: "speech-full",
      priority: 2,
      executorPluginId: "test.speech",
      executorExportId: "full-execute",
      assetInputs: [{
        match: { kinds: ["audio"] },
        representations: ["bytes"],
        mediaTypes: ["audio/wav"],
      }],
    },
  ],
});

const legacyRemoteApiShapes = [
  "openai-images",
  "openai-compatible",
  "anthropic-compatible",
  "google-ai-studio",
  "google-ai-studio-interactions",
  "google-agent-platform",
  "fal",
  "bfl",
  "suno",
  "minimax",
  "replicate",
  "pika",
  "pika-chat",
] as const;

function legacyRemoteModel(apiShape: string) {
  const providerId = `legacy-${apiShape}`;
  return ModelCardSchema.parse({
    id: `legacy-${apiShape}-video`,
    name: `Legacy ${apiShape} video`,
    provider: "Legacy",
    kind: "video",
    defaultAspectRatio: "16:9",
    parameters: [],
    defaultParams: {},
    input: {
      requiresPrompt: true,
      inputMode: {},
      promptModalities: ["text"],
    },
    availableProviders: [providerId],
    defaultProvider: providerId,
    providerImplementations: [
      {
        providerId,
        upstreamId: providerId,
        upstreamModel: `${apiShape}-model`,
        apiShape,
        priority: 1,
        requiredCredentials: ["apiKey"],
      },
    ],
  });
}

describe("provider parameter routing", () => {
  it.each(legacyRemoteApiShapes)(
    "refuses a %s route without an executable contract before vendor submission",
    async (apiShape) => {
      const legacyModel = legacyRemoteModel(apiShape);
      const providerId = `legacy-${apiShape}`;
      const vendorFetch = vi.spyOn(globalThis, "fetch").mockImplementation(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const executePlugin = vi.fn();
      const service = createMockExternalAigcService({
        modelCards: async () => [legacyModel],
        providerAccounts: async () => [
          {
            id: `${providerId}-account`,
            providerId,
            upstreamId: providerId,
            enabled: true,
            configuredCredentials: ["apiKey"],
            credentials: { apiKey: "legacy-secret" },
          },
        ],
        providerPluginExecutor: executePlugin,
      });

      await expect(
        service.generateVideo({
          taskId: "legacy-task",
          model: legacyModel.id,
          prompt: "Do not submit this through a blocking adapter.",
        }),
      ).rejects.toThrow(
        /does not declare an executable submit\/poll contract/i,
      );
      expect(vendorFetch).not.toHaveBeenCalled();
      expect(executePlugin).not.toHaveBeenCalled();
    },
  );

  it("freezes the selected executable route, account, binding, and input without submitting", async () => {
    const execute = vi.fn();
    const binding = {
      pluginId: "test.speech",
      version: "2.0.0",
      exportId: "full-execute",
      schemaHash: `sha256:${"b".repeat(64)}`,
    } as const;
    const resolveBinding = vi.fn(async () => binding);
    const service = createMockExternalAigcService({
      modelCards: async () => [model],
      providerAccounts: async () => [
        {
          id: "full-account",
          providerId: "speech-full",
          upstreamId: "speech-full",
          enabled: true,
        },
      ],
      providerPluginExecutor: execute,
      resolveProviderPluginBinding: resolveBinding,
    });

    const plan = await service.planProviderPlugin?.(
      {
        taskId: "ignored-before-durable-identity",
        projectId: "project-1",
        nodeId: "node-1",
        model: model.id,
        prompt: "Read this line.",
        modelParams: { voice_id: "speaker-123" },
      },
      "audio",
    );

    expect(plan).toMatchObject({
      binding,
      accountId: "full-account",
      assetInputs: [{
        match: { kinds: ["audio"] },
        representations: ["bytes"],
        mediaTypes: ["audio/wav"],
      }],
      kind: "audio",
      projectId: "project-1",
      nodeId: "node-1",
      provider: "speech-full",
      modelEndpoint: "audio-v1",
      input: {
        values: {
          modelId: model.id,
          upstreamModel: "audio-v1",
          apiShape: "speech-full",
          prompt: "Read this line.",
          modelParams: { voice_id: "speaker-123" },
        },
        references: [],
      },
    });
    expect(resolveBinding).toHaveBeenCalledWith(
      "test.speech",
      "full-execute",
      "provider-executor",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("routes a selected provider-only feature to an implementation that supports it", async () => {
    const requests: ProviderPluginExecutorRequest[] = [];
    const service = createMockExternalAigcService({
      modelCards: async () => [model],
      providerAccounts: async () => [
        {
          id: "basic-account",
          providerId: "speech-basic",
          upstreamId: "speech-basic",
          enabled: true,
        },
        {
          id: "full-account",
          providerId: "speech-full",
          upstreamId: "speech-full",
          enabled: true,
        },
      ],
      providerPluginExecutor: async (request) => {
        requests.push(request);
        return {
          status: "completed",
          binding: {
            pluginId: request.pluginId,
            version: "0.1.0",
            exportId: request.exportId,
            schemaHash: `sha256:${"a".repeat(64)}`,
          },
          media: {
            assetId: "plugin-output:routed-audio",
            uri: "clash-asset://plugin-output:routed-audio",
            kind: "audio",
            mediaType: "audio/wav",
          },
        };
      },
      resolveProviderPluginStagedAsset: async () => ({
        bytes: new Uint8Array([0]),
        kind: "audio",
        contentType: "audio/wav",
      }),
    });

    await service.generateAudio({
      taskId: "audio-with-voice",
      projectId: "project-1",
      model: model.id,
      prompt: "Read this line.",
      modelParams: { voice_id: "speaker-123" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.exportId).toBe("full-execute");
    expect(requests[0]?.assetInputs).toEqual([{
      match: { kinds: ["audio"] },
      representations: ["bytes"],
      mediaTypes: ["audio/wav"],
    }]);
  });
});
