import { describe, expect, it } from "vitest";

import { createExecutorContext } from "./define-plugin.js";

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

describe("media analysis SDK Host tool", () => {
  it("maps the typed SDK request onto the credential-free Broker operation", async () => {
    let received: unknown;
    const context = createExecutorContext({}, async (operation) => {
      received = operation;
      return {
        status: "completed",
        provider: "hilo-hub",
        route: "hilo-hub",
        underlyingModel: "provider-managed",
        result: { text: "A train arrives." },
      };
    });

    await expect(
      context.hostTools.mediaAnalyze({
        reference,
        modelId: "hilo-hub-media-analysis",
        category: "description",
        prompt: "Describe the media as JSON.",
        promptVersion: "media-analysis/v1",
      }),
    ).resolves.toMatchObject({ provider: "hilo-hub" });
    expect(received).toEqual({
      kind: "media.analyze",
      reference,
      modelId: "hilo-hub-media-analysis",
      category: "description",
      prompt: "Describe the media as JSON.",
      promptVersion: "media-analysis/v1",
    });
  });

  it("rejects a response without actual provider lineage", async () => {
    const context = createExecutorContext({}, async () => ({
      status: "completed",
      result: { text: "missing route" },
    }));
    await expect(
      context.hostTools.mediaAnalyze({
        reference,
        modelId: "hilo-hub-media-analysis",
        category: "description",
        prompt: "Describe.",
        promptVersion: "media-analysis/v1",
      }),
    ).rejects.toThrow(/invalid media analysis result/i);
  });

  it("preserves a Host execution error instead of reporting it as an invalid result", async () => {
    const failure = Object.assign(new Error("Provider account is missing a region."), { code: "PROVIDER_CONFIGURATION_INCOMPLETE" });
    const context = createExecutorContext({}, async () => { throw failure; });
    await expect(context.hostTools.mediaAnalyze({
      reference, modelId: "configured-analysis", category: "description", prompt: "Describe.", promptVersion: "v1",
    })).rejects.toBe(failure);
  });
});
