import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialsForRoute: vi.fn(),
  submitMiniMaxVideo: vi.fn(),
  pollMiniMaxVideoOnce: vi.fn(),
  signedMediaUrl: vi.fn(),
  signedMediaUrls: vi.fn(),
}));

vi.mock("./provider-credentials", () => ({
  credentialsForRoute: mocks.credentialsForRoute,
}));

vi.mock("../../services/minimax-video", () => ({
  submitMiniMaxVideo: mocks.submitMiniMaxVideo,
  pollMiniMaxVideoOnce: mocks.pollMiniMaxVideoOnce,
}));

vi.mock("./media-url", () => ({
  signedMediaUrl: mocks.signedMediaUrl,
  signedMediaUrls: mocks.signedMediaUrls,
}));

import { minimaxVideoAdapter } from "./minimax-video";

function makeCtx() {
  const uploadFromUrl = vi
    .fn()
    .mockResolvedValue("projects/p1/uploads/task-1.mp4");
  const probe = vi
    .fn()
    .mockResolvedValue({ metadata: { width: 1280, height: 720 } });
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
      prompt: "Use subject, then motion.",
      promptParts: [
        { type: "text", text: "Use " },
        {
          type: "asset_ref",
          nodeId: "image-node",
          r2Key: "subject.png",
          modality: "image",
        },
        { type: "text", text: ", then " },
        {
          type: "asset_ref",
          nodeId: "video-node",
          r2Key: "motion.mp4",
          modality: "video",
        },
        { type: "text", text: "." },
      ],
      modelName: "minimax-h3-ref",
      referenceImageR2Keys: ["subject.png"],
      referenceVideoR2Keys: ["motion.mp4"],
      referenceAudioR2Keys: ["ambience.mp3"],
      selectedRoute: {
        modelCode: "minimax-h3-ref",
        kind: "video",
        providerId: "minimax",
        accountId: "minimax-primary",
        upstreamId: "minimax",
        upstreamModel: "MiniMax-H3",
        apiShape: "minimax",
        priority: 8,
        requiredCredentials: ["apiKey"],
        referenceBinding: {
          type: "ordered-content-parts",
          usesRoles: true,
          modalityScopedIndexes: true,
        },
      },
    },
    env: {
      DB: {} as D1Database,
      ACTION_SECRET_KEY: "secret-key",
      R2_PUBLIC_URL: "https://cdn.example",
    },
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

describe("minimaxVideoAdapter", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("translates resolved prompt parts to signed ordered H3 content", async () => {
    mocks.credentialsForRoute.mockResolvedValue({ apiKey: "mini-key" });
    mocks.signedMediaUrl.mockImplementation(
      async (_env, key: string) => `https://media.example/${key}`,
    );
    mocks.signedMediaUrls.mockImplementation(async (_env, keys?: string[]) =>
      keys?.map((key) => `https://media.example/${key}`),
    );
    mocks.submitMiniMaxVideo.mockResolvedValue({
      taskId: "h3-task",
      url: "https://video.example/out.mp4",
      model: "MiniMax-H3",
    });
    const ctx = makeCtx();

    await minimaxVideoAdapter.submit(ctx as never);

    expect(mocks.submitMiniMaxVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        orderedContentParts: [
          { type: "text", text: "Use " },
          { type: "image", url: "https://media.example/subject.png" },
          { type: "text", text: ", then " },
          { type: "video", url: "https://media.example/motion.mp4" },
          { type: "text", text: "." },
          { type: "audio", url: "https://media.example/ambience.mp3" },
        ],
      }),
    );
  });
});
