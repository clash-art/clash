import { describe, expect, it, vi } from "vitest";

import type {
  ExecutablePluginBrokerRequest,
  ExecutablePluginJsonValue,
} from "@clash/shared-types";
import { createLocalExecutablePluginBroker } from "./local-plugin-broker.js";

const reference = {
  slot: "source",
  index: 0,
  asset: {
    assetId: "video-1",
    uri: "clash-asset://video-1",
    kind: "video" as const,
    mediaType: "video/mp4",
  },
};

const frozenRoute = {
  providerId: "dummy-provider",
  upstreamId: "dummy-upstream",
  upstreamModel: "provider-managed",
  apiShape: "dummy-shape",
};

function context(
  pluginId = "clash.media-analysis",
  values: Record<string, ExecutablePluginJsonValue> = {
    modelId: "analysis-card",
    modelRoute: frozenRoute,
    categories: ["scene-shot"],
    modelConsumer: {
      semanticShape: "media_analysis",
      outputs: [{
        slot: "scene-shot",
        prompt: "Return scenes as JSON.",
        promptVersion: "media-analysis/v1",
      }],
    },
  },
) {
  return {
    manifest: {
      apiVersion: "clash.plugin/v1" as const,
      id: pluginId,
      version: "0.1.0",
      name: pluginId,
      runtime: { kind: "local" as const, transport: "stdio" as const, entrypoint: "dist/stdio.mjs", args: [] },
      contributes: {
        cards: [], providers: [], modelBindings: [], generators: [], views: [],
        functions: [{ id: "analyze", kind: "action" as const, operations: ["submit"] as ["submit"] }],
        hostTools: ["media.analyze" as const],
      },
      contractTests: [],
    },
    invocation: {
      protocol: "clash.plugin.invoke/v1" as const,
      invocationId: "invocation-1",
      taskId: "task-1",
      projectId: "project-1",
      target: { pluginId, version: "0.1.0", exportId: "analyze", schemaHash: `sha256:${"a".repeat(64)}` as const, kind: "action" as const },
      input: {
        values,
        references: [reference],
      },
      assetInputs: [],
      actor: { kind: "agent" as const, id: "agent-1" },
      operation: "submit" as const,
    },
  };
}

function request(operation: ExecutablePluginBrokerRequest["operation"]): ExecutablePluginBrokerRequest {
  return {
    protocol: "clash.plugin.broker-request/v1" as const,
    requestId: "request-1",
    invocationId: "invocation-1",
    operation,
  };
}

describe("media analysis plugin broker", () => {
  it("authorizes the exact frozen source and forwards the Host-frozen Provider route", async () => {
    const analyzeMedia = vi.fn(async (input: Record<string, unknown>) => ({
      status: "completed" as const,
      provider: "dummy-provider",
      route: "dummy-shape",
      underlyingModel: "provider-managed",
      result: { scenes: [{ description: "station" }] },
    }));
    const broker = createLocalExecutablePluginBroker({ loadProviderAccounts: async () => [], analyzeMedia });
    await expect(broker(request({
      kind: "media.analyze",
      reference,
      modelId: "analysis-card",
      category: "scene-shot",
      prompt: "Return scenes as JSON.",
      promptVersion: "media-analysis/v1",
    }), context())).resolves.toMatchObject({ provider: "dummy-provider" });
    expect(analyzeMedia).toHaveBeenCalledWith(expect.objectContaining({
      reference,
      modelId: "analysis-card",
      category: "scene-shot",
      route: frozenRoute,
    }));
    expect(analyzeMedia.mock.calls[0]![0]).not.toHaveProperty("upstreamModel");
  });

  it("rejects an invocation whose Provider route was never Host-frozen", async () => {
    const analyzeMedia = vi.fn();
    const broker = createLocalExecutablePluginBroker({ loadProviderAccounts: async () => [], analyzeMedia });
    await expect(broker(request({
      kind: "media.analyze",
      reference,
      modelId: "analysis-card",
      category: "scene-shot",
      prompt: "Return scenes as JSON.",
      promptVersion: "media-analysis/v1",
    }), context("clash.media-analysis", {
      modelId: "analysis-card",
      categories: ["scene-shot"],
      modelConsumer: {
        semanticShape: "media_analysis",
        outputs: [{
          slot: "scene-shot",
          prompt: "Return scenes as JSON.",
          promptVersion: "media-analysis/v1",
        }],
      },
    }))).rejects.toThrow(/frozen provider route/i);
    expect(analyzeMedia).not.toHaveBeenCalled();
  });

  it("uses the declared Host-tool capability rather than a product plugin id", async () => {
    const analyzeMedia = vi.fn(async () => ({
      status: "completed" as const,
      provider: "dummy",
      route: "dummy-shape",
      underlyingModel: "dummy-model",
      result: { text: "ok" },
    }));
    const broker = createLocalExecutablePluginBroker({ loadProviderAccounts: async () => [], analyzeMedia });
    await expect(broker(request({
      kind: "media.analyze", reference, modelId: "vlm", category: "description", prompt: "Describe.", promptVersion: "v1",
    }), context("other.plugin", {
      modelId: "vlm",
      modelRoute: frozenRoute,
      categories: ["description"],
      modelConsumer: {
        semanticShape: "media_analysis",
        outputs: [{ slot: "description", prompt: "Describe.", promptVersion: "v1" }],
      },
    }))).resolves.toMatchObject({ provider: "dummy" });
    expect(analyzeMedia).toHaveBeenCalledTimes(1);
  });

  it("rejects model, category, prompt, or version drift from the frozen invocation", async () => {
    const analyzeMedia = vi.fn();
    const broker = createLocalExecutablePluginBroker({ loadProviderAccounts: async () => [], analyzeMedia });
    const base = {
      kind: "media.analyze" as const,
      reference,
      modelId: "analysis-card",
      category: "scene-shot",
      prompt: "Return scenes as JSON.",
      promptVersion: "media-analysis/v1",
    };
    for (const drift of [
      { modelId: "other" },
      { category: "description" },
      { prompt: "Different prompt." },
      { promptVersion: "v2" },
      { responseFormat: "text" as const },
    ]) {
      await expect(broker(request({ ...base, ...drift }), context())).rejects.toThrow(/frozen invocation/i);
    }
    expect(analyzeMedia).not.toHaveBeenCalled();
  });

  it("forwards the frozen free-form prompt and response format", async () => {
    const prompt = "What happens before the train arrives?";
    const analyzeMedia = vi.fn(async () => ({ status: "completed" as const,
      provider: "dummy", route: "dummy", underlyingModel: "dummy", result: { text: "People wait." } }));
    const broker = createLocalExecutablePluginBroker({ loadProviderAccounts: async () => [], analyzeMedia });
    await broker(request({ kind: "media.analyze", reference, modelId: "analysis-card",
      category: "description", prompt, promptVersion: "v1", responseFormat: "text" }),
    context("clash.media-analysis", {
      modelId: "analysis-card", modelRoute: frozenRoute, categories: ["description"],
      modelConsumer: { semanticShape: "media_analysis", outputs: [{
        slot: "description", prompt, promptVersion: "v1", responseFormat: "text",
      }] },
    }));
    expect(analyzeMedia).toHaveBeenCalledWith(expect.objectContaining({ prompt, responseFormat: "text" }));
  });

  it("rejects an unfrozen source before the execution route", async () => {
    const analyzeMedia = vi.fn();
    const broker = createLocalExecutablePluginBroker({ loadProviderAccounts: async () => [], analyzeMedia });
    await expect(broker(request({
      kind: "media.analyze",
      reference: { ...reference, asset: { ...reference.asset, assetId: "other" } },
      modelId: "analysis-card", category: "scene-shot", prompt: "Return scenes as JSON.", promptVersion: "media-analysis/v1",
    }), context())).rejects.toThrow(/not authorized/i);
    expect(analyzeMedia).not.toHaveBeenCalled();
  });
});
