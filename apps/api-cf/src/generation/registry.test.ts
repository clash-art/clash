import { describe, expect, it } from "vitest";

import type { ModelUpstreamRoute } from "@clash/shared-types";

import type { GenerationParams } from "./params";
import { resolveAdapter } from "./registry";

function params(
  type: GenerationParams["type"],
  modelName?: string,
  selectedRoute?: ModelUpstreamRoute,
): GenerationParams {
  return {
    taskId: "task-1",
    nodeId: "node-1",
    projectId: "project-1",
    type,
    actorType: "user",
    actorUserId: "user-1",
    modelName,
    selectedRoute,
  };
}

describe("generation provider registry", () => {
  it("routes Pika API Club media implementations to the Pika provider", () => {
    const route: ModelUpstreamRoute = {
      modelCode: "nano-banana-2",
      kind: "image",
      providerId: "pika",
      upstreamId: "pika",
      upstreamModel: "google/gemini-3.1-flash-image/text-to-image",
      apiShape: "pika",
      priority: 18,
    };
    expect(resolveAdapter(params("image_gen", "nano-banana-2", route)).name).toBe("pika-media");
    expect(resolveAdapter(params("video_gen", "pika-2.5", { ...route, modelCode: "pika-2.5", kind: "video" })).name)
      .toBe("pika-media");
    expect(resolveAdapter(params("audio_gen", "minimax-music-3", { ...route, modelCode: "minimax-music-3", kind: "audio" })).name)
      .toBe("pika-media");
  });

  it("routes Seedance model codes to the hosted Volcengine video provider", () => {
    expect(resolveAdapter(params("video_gen", "seedance-2-ref", {
      modelCode: "seedance-2-ref",
      kind: "video",
      providerId: "volcengine",
      upstreamId: "volcengine",
      upstreamModel: "doubao-seedance-2-0-260128",
      apiShape: "modelark",
      priority: 9,
    })).name).toBe("volcengine-video");
  });

  it("routes Kling model codes to the hosted Kling video provider", () => {
    expect(resolveAdapter(params("video_gen", "kling-3", {
      modelCode: "kling-3",
      kind: "video",
      providerId: "kling",
      upstreamId: "kling",
      upstreamModel: "kling-v3",
      apiShape: "kling",
      priority: 8,
    })).name).toBe("kling-video");
  });

  it("routes Google image model codes to the Google image provider", () => {
    expect(resolveAdapter(params("image_gen", "nano-banana-2", {
      modelCode: "nano-banana-2",
      kind: "image",
      providerId: "official",
      upstreamId: "google-agent-platform",
      upstreamModel: "gemini-3.1-flash-image",
      apiShape: "google-agent-platform",
      priority: 10,
    })).name).toBe("google-image");
  });

  it("routes allowlisted plugin-owned Fal routes to the plugin provider adapter", () => {
    const falRoute: ModelUpstreamRoute = {
      modelCode: "gpt-image-2",
      kind: "image",
      providerId: "fal",
      accountId: "fal-secondary",
      upstreamId: "fal",
      upstreamModel: "openai/gpt-image-2",
      apiShape: "fal",
      priority: 20,
    };
    const officialRoute: ModelUpstreamRoute = {
      modelCode: "gpt-image-2",
      kind: "image",
      providerId: "official",
      accountId: "openai-primary",
      upstreamId: "openai",
      upstreamModel: "gpt-image-2",
      apiShape: "openai-images",
      priority: 10,
    };

    falRoute.executorPluginId = "clash.fal";
    falRoute.executorExportId = "fal-execute";
    expect(
      resolveAdapter(params("image_gen", "gpt-image-2", falRoute)).name,
    ).toBe("plugin-provider:clash.fal");
    expect(
      resolveAdapter(params("image_gen", "gpt-image-2", officialRoute)).name,
    ).toBe("openai-image");
  });

  it("does not choose a default image provider when no route was selected", () => {
    expect(() => resolveAdapter(params("image_gen", "gpt-image-2"))).toThrow(
      "No configured provider route",
    );
  });

  it("routes MiniMax TTS to the hosted MiniMax audio provider", () => {
    expect(resolveAdapter(params("audio_gen", "minimax-tts", {
      modelCode: "minimax-tts",
      kind: "audio",
      providerId: "minimax",
      upstreamId: "minimax",
      upstreamModel: "speech-02-hd",
      apiShape: "minimax",
      priority: 8,
    })).name).toBe("minimax-audio");
  });

  it("routes allowlisted Fal audio routes to the plugin provider adapter", () => {
    expect(
      resolveAdapter(
        params("audio_gen", "minimax-music-3", {
          modelCode: "minimax-music-3",
          kind: "audio",
          providerId: "fal",
          upstreamId: "fal",
          upstreamModel: "fal-ai/minimax-music/v3",
          apiShape: "fal",
          executorPluginId: "clash.fal",
          executorExportId: "fal-execute",
          priority: 9,
        }),
      ).name,
    ).toBe("plugin-provider:clash.fal");
  });

  it("keeps unregistered plugin executors fail-closed", () => {
    const route: ModelUpstreamRoute = {
      modelCode: "some-model",
      kind: "image",
      providerId: "example",
      upstreamId: "example",
      upstreamModel: "example/model",
      apiShape: "fal",
      executorPluginId: "example.plugin",
      executorExportId: "execute",
      priority: 9,
    };
    expect(() =>
      resolveAdapter(params("image_gen", "some-model", route)),
    ).toThrow("Hosted provider adapter is not implemented for example");
  });

  it("routes MiniMax H3 to the hosted MiniMax video provider", () => {
    expect(resolveAdapter(params("video_gen", "minimax-h3", {
      modelCode: "minimax-h3",
      kind: "video",
      providerId: "minimax",
      upstreamId: "minimax",
      upstreamModel: "MiniMax-H3",
      apiShape: "minimax",
      priority: 8,
    })).name).toBe("minimax-video");
  });

  it("routes Gemini Omni to the Google AI Studio Interactions provider", () => {
    expect(resolveAdapter(params("video_gen", "gemini-omni-flash", {
      modelCode: "gemini-omni-flash",
      kind: "video",
      providerId: "official",
      upstreamId: "google-ai-studio",
      upstreamModel: "gemini-omni-flash-preview",
      apiShape: "google-ai-studio-interactions",
      priority: 10,
    })).name).toBe("gemini-omni");
  });

  it("routes the official FLUX 3 implementation to BFL", () => {
    expect(resolveAdapter(params("video_gen", "flux-3-video", {
      modelCode: "flux-3-video",
      kind: "video",
      providerId: "official",
      upstreamId: "bfl",
      upstreamModel: "flux-3-video",
      apiShape: "bfl",
      priority: 10,
    } as any)).name).toBe("bfl-video");
  });

  it("routes ElevenLabs TTS to the hosted ElevenLabs audio provider", () => {
    expect(resolveAdapter(params("audio_gen", "elevenlabs-tts", {
      modelCode: "elevenlabs-tts",
      kind: "audio",
      providerId: "elevenlabs",
      upstreamId: "elevenlabs",
      upstreamModel: "eleven_multilingual_v2",
      apiShape: "elevenlabs",
      priority: 8,
    })).name).toBe("elevenlabs-tts");
  });

  it("routes the selected Suno account to the Suno adapter", () => {
    expect(resolveAdapter(params("audio_gen", "suno-v5.5", {
      modelCode: "suno-v5.5",
      kind: "audio",
      providerId: "suno",
      accountId: "suno-primary",
      upstreamId: "suno",
      upstreamModel: "V5_5",
      apiShape: "suno",
      priority: 8,
    })).name).toBe("suno-audio");
  });
});
