import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialsForRoute: vi.fn(),
  submitBflFlux3Video: vi.fn(),
  pollBflFlux3VideoOnce: vi.fn(),
  signedMediaUrls: vi.fn(),
}));

vi.mock("./provider-credentials", () => ({
  credentialsForRoute: mocks.credentialsForRoute,
}));

vi.mock("@clash/shared-runtime", () => ({
  submitBflFlux3Video: mocks.submitBflFlux3Video,
  pollBflFlux3VideoOnce: mocks.pollBflFlux3VideoOnce,
}));

vi.mock("./media-url", () => ({
  signedMediaUrls: mocks.signedMediaUrls,
}));

import { bflVideoAdapter } from "./bfl-video";

function makeCtx() {
  const uploadFromUrl = vi
    .fn()
    .mockResolvedValue("projects/p1/uploads/task-1.mp4");
  const probe = vi
    .fn()
    .mockResolvedValue({ metadata: { width: 1920, height: 1080 } });
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
      prompt: "connect the keyframes",
      duration: 10,
      aspectRatio: "16:9",
      modelName: "flux-3-video-keyframes",
      modelParams: { resolution: "1080p", generate_audio: true },
      referenceImageR2Keys: ["one.png", "two.png"],
      selectedRoute: {
        modelCode: "flux-3-video-keyframes",
        kind: "video",
        providerId: "official",
        upstreamId: "bfl",
        upstreamModel: "flux-3-video",
        apiShape: "bfl",
        priority: 10,
        requiredCredentials: ["apiKey"],
      },
    },
    env: { R2_PUBLIC_URL: "https://cdn.example" },
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
    uploadFromUrl,
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

describe("bflVideoAdapter", () => {
  afterEach(() => vi.clearAllMocks());

  it("uses the official account and signed FLUX 3 keyframe references", async () => {
    mocks.credentialsForRoute.mockResolvedValue({
      apiKey: "bfl-key",
      baseUrl: "https://api.bfl.ai",
    });
    mocks.signedMediaUrls.mockImplementation(
      async (_env: unknown, keys?: string[]) =>
        keys?.map((key) => `https://media.example/${key}`),
    );
    mocks.submitBflFlux3Video.mockResolvedValue({
      requestId: "bfl-task-1",
      url: "https://video.example/out.mp4",
      pollingUrl: "https://api.bfl.ai/v1/get_result?id=bfl-task-1",
    });
    const ctx = makeCtx();

    await bflVideoAdapter.submit(ctx as never);

    expect(mocks.credentialsForRoute).toHaveBeenCalledWith(
      ctx,
      ctx.params.selectedRoute,
    );
    expect(mocks.submitBflFlux3Video).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "bfl-key",
        baseUrl: "https://api.bfl.ai",
        input: expect.objectContaining({
          duration: 10,
          referenceImageUrls: [
            "https://media.example/one.png",
            "https://media.example/two.png",
          ],
        }),
      }),
    );
    expect(ctx.notifyCompleted).not.toHaveBeenCalled();
  });
});
