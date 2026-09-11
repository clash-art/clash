import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialsForRoute: vi.fn(),
  createInteraction: vi.fn(),
  getInteraction: vi.fn(),
  extractVideo: vi.fn(),
  downloadVideo: vi.fn(),
}));

vi.mock("./provider-credentials", () => ({
  credentialsForRoute: mocks.credentialsForRoute,
}));

vi.mock("@clash/shared-runtime", () => ({
  createGeminiOmniInteraction: mocks.createInteraction,
  getGeminiOmniInteraction: mocks.getInteraction,
  extractGeminiOmniVideo: mocks.extractVideo,
  geminiOmniInteractionId: (value: { id: string }) => value.id,
  geminiOmniInteractionStatus: (value: { status: string }) =>
    value.status.toLowerCase(),
  downloadGeminiOmniVideo: mocks.downloadVideo,
}));

import { googleAiStudioInteractionsAdapter } from "./google-ai-studio-interactions";

function makeCtx(env: Record<string, unknown> = {}) {
  const readR2Base64 = vi.fn(async (key: string) => ({
    bytesBase64Encoded: key === "jacket.png" ? "amFja2V0" : "bW9vZA==",
    mimeType: "image/png",
  }));
  const uploadBytes = vi
    .fn()
    .mockResolvedValue("projects/p1/uploads/task-1.mp4");
  const probe = vi
    .fn()
    .mockResolvedValue({
      metadata: { width: 720, height: 1280, durationMs: 7000 },
    });
  const createAsset = vi.fn().mockResolvedValue("asset-1");
  const notifyCompleted = vi.fn();

  return {
    params: {
      taskId: "task-1",
      nodeId: "node-1",
      projectId: "project-1",
      type: "video_gen",
      actorType: "user",
      actorUserId: "user-1",
      prompt: "Use the jacket and mood references.",
      promptParts: [
        { type: "text", text: "Use " },
        { type: "asset_ref", r2Key: "jacket.png", modality: "image" },
        { type: "text", text: " as the jacket reference." },
      ],
      referenceImageR2Keys: ["jacket.png", "mood.png"],
      aspectRatio: "9:16",
      duration: 7,
      modelName: "gemini-omni-flash",
      selectedRoute: {
        modelCode: "gemini-omni-flash",
        kind: "video",
        providerId: "official",
        accountId: "google-ai-studio-primary",
        upstreamId: "google-ai-studio",
        upstreamModel: "gemini-omni-flash-preview",
        apiShape: "google-ai-studio-interactions",
        priority: 10,
        requiredCredentials: ["apiKey"],
        referenceBinding: {
          type: "ordered-content-parts",
          usesRoles: false,
          modalityScopedIndexes: true,
        },
      },
    },
    env: { DB: {} as D1Database, ACTION_SECRET_KEY: "secret-key", ...env },
    tag: { taskId: "task-1", nodeId: "node-1" },
    step: async (
      _name: string,
      optsOrFn: unknown,
      maybeFn?: () => Promise<unknown>,
    ) => {
      const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
      if (!fn) throw new Error("missing step fn");
      return fn();
    },
    readR2Base64,
    uploadBytes,
    probe,
    createAsset,
    notifyCompleted,
    accepted: (pollState: unknown) => ({ status: "accepted", pollState }),
    completedMedia: (asset: unknown) => ({
      status: "completed",
      outputs: [{ slot: "output", kind: "asset", asset }],
    }),
    completedVideo: vi.fn(async () => ({ status: "completed", outputs: [] })),
  };
}

describe("googleAiStudioInteractionsAdapter", () => {
  afterEach(() => vi.clearAllMocks());

  it("keeps inline order and appends only unmentioned global image references", async () => {
    mocks.credentialsForRoute.mockResolvedValue({ apiKey: "gemini-key" });
    mocks.createInteraction.mockResolvedValue({
      id: "interactions/omni-1",
      status: "in_progress",
    });
    mocks.getInteraction.mockResolvedValue({
      id: "interactions/omni-1",
      status: "completed",
    });
    mocks.extractVideo.mockReturnValue({
      uri: "https://files.example/video.mp4",
      mimeType: "video/mp4",
    });
    mocks.downloadVideo.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]).buffer,
      mimeType: "video/mp4",
    });
    const ctx = makeCtx();

    const result = await googleAiStudioInteractionsAdapter.submit(ctx as never);
    if (result.status === "accepted") {
      expect(mocks.getInteraction).not.toHaveBeenCalled();
      const next = await googleAiStudioInteractionsAdapter.poll!(
        ctx as never,
        result.pollState,
      );
      if (next.status === "accepted")
        await googleAiStudioInteractionsAdapter.poll!(
          ctx as never,
          next.pollState,
        );
    }

    expect(mocks.createInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "gemini-key",
        model: "gemini-omni-flash-preview",
        aspectRatio: "9:16",
        duration: 7,
        input: [
          { type: "text", text: "Use " },
          { type: "image", data: "amFja2V0", mimeType: "image/png" },
          { type: "text", text: " as the jacket reference." },
          { type: "image", data: "bW9vZA==", mimeType: "image/png" },
        ],
      }),
    );
    expect(ctx.readR2Base64).toHaveBeenCalledTimes(2);
    expect(ctx.uploadBytes).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      "video/mp4",
    );
    expect(mocks.getInteraction).toHaveBeenCalledTimes(1);
  });

  it("uploads inline base64 output without a second download", async () => {
    mocks.credentialsForRoute.mockResolvedValue({ apiKey: "gemini-key" });
    mocks.createInteraction.mockResolvedValue({
      id: "interactions/omni-2",
      status: "completed",
    });
    mocks.extractVideo.mockReturnValue({ data: "AQID", mimeType: "video/mp4" });
    const ctx = makeCtx();

    const result = await googleAiStudioInteractionsAdapter.submit(ctx as never);
    if (result.status === "accepted") {
      expect(mocks.getInteraction).not.toHaveBeenCalled();
      const next = await googleAiStudioInteractionsAdapter.poll!(
        ctx as never,
        result.pollState,
      );
      if (next.status === "accepted")
        await googleAiStudioInteractionsAdapter.poll!(
          ctx as never,
          next.pollState,
        );
    }

    expect(mocks.downloadVideo).not.toHaveBeenCalled();
    expect(ctx.uploadBytes).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "video/mp4",
    );
  });
});
