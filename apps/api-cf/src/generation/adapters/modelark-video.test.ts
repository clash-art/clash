import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialsForRoute: vi.fn(),
  submitModelArkVideo: vi.fn(),
  pollModelArkVideoOnce: vi.fn(),
  signedMediaUrl: vi.fn(),
  signedMediaUrls: vi.fn(),
}));

vi.mock("./provider-credentials", () => ({
  credentialsForRoute: mocks.credentialsForRoute,
}));

vi.mock("../../services/modelark-video", () => ({
  submitModelArkVideo: mocks.submitModelArkVideo,
  pollModelArkVideoOnce: mocks.pollModelArkVideoOnce,
}));

vi.mock("./media-url", () => ({
  signedMediaUrl: mocks.signedMediaUrl,
  signedMediaUrls: mocks.signedMediaUrls,
}));

import { volcengineVideoAdapter } from "./modelark-video";

function makeCtx() {
  const uploadFromUrl = vi
    .fn()
    .mockResolvedValueOnce("projects/p1/uploads/task-1.mp4")
    .mockResolvedValueOnce("projects/p1/uploads/task-1-cover.jpg");
  const probe = vi
    .fn()
    .mockResolvedValue({ metadata: { width: 1280, height: 720 } });
  const createAsset = vi.fn().mockResolvedValue("asset-1");
  const notifyCompleted = vi.fn();

  const step = vi.fn(
    async (
      _name: string,
      optsOrFn: unknown,
      maybeFn?: () => Promise<unknown>,
    ) => {
      const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
      if (!fn) throw new Error("missing step fn");
      return fn();
    },
  );

  return {
    params: {
      taskId: "task-1",
      nodeId: "node-1",
      projectId: "project-1",
      type: "video_gen",
      actorType: "user",
      actorUserId: "user-1",
      prompt: "make it move",
      promptParts: [
        { type: "text", text: "Use " },
        { type: "asset_ref", r2Key: "ref.png", modality: "image" },
        { type: "text", text: " as the opening" },
      ],
      modelName: "seedance-2-ref",
      referenceImageR2Keys: ["ref.png"],
      selectedRoute: {
        modelCode: "seedance-2-ref",
        kind: "video",
        providerId: "volcengine",
        accountId: "volcengine-primary",
        upstreamId: "volcengine",
        upstreamModel: "doubao-seedance-2-0-260128",
        apiShape: "modelark",
        priority: 9,
        requiredCredentials: ["apiKey"],
        referenceBinding: {
          type: "positional-tokens",
          modalityScopedIndexes: true,
          tokens: { image: "@图像{n}", video: "@视频{n}", audio: "@音频{n}" },
        },
      },
    },
    env: {
      DB: {} as D1Database,
      ACTION_SECRET_KEY: "secret-key",
      R2_PUBLIC_URL: "https://cdn.example",
    },
    tag: { taskId: "task-1", nodeId: "node-1" },
    step,
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

describe("volcengineVideoAdapter", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads semantic ModelArk credentials from provider accounts", async () => {
    mocks.credentialsForRoute.mockResolvedValue({
      apiKey: "ark-provider-key",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    });
    mocks.signedMediaUrl.mockResolvedValue("https://media.example/ref.png");
    mocks.signedMediaUrls.mockImplementation(
      async (_env: unknown, keys?: string[]) =>
        keys?.map((key) => `https://media.example/${key}`) ?? [],
    );
    mocks.submitModelArkVideo.mockResolvedValue({
      url: "https://video.example/out.mp4",
      coverImageUrl: "https://video.example/cover.jpg",
      duration: 5,
      taskId: "ark-task-1",
    });
    const ctx = makeCtx();

    await volcengineVideoAdapter.submit(ctx as never);

    expect(mocks.credentialsForRoute).toHaveBeenCalledWith(
      ctx,
      ctx.params.selectedRoute,
    );
    expect(mocks.submitModelArkVideo).toHaveBeenCalledWith(
      "ark-provider-key",
      expect.objectContaining({
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        upstreamModel: "doubao-seedance-2-0-260128",
        prompt: "Use @图像1 as the opening",
      }),
    );
    expect(ctx.notifyCompleted).not.toHaveBeenCalled();
  });

  it("resumes the same provider task and keeps MOV output with its real MIME", async () => {
    mocks.credentialsForRoute.mockResolvedValue({ apiKey: "ark-provider-key" });
    mocks.signedMediaUrl.mockResolvedValue(undefined);
    mocks.signedMediaUrls.mockResolvedValue([]);
    mocks.submitModelArkVideo.mockResolvedValue({
      url: "https://video.example/out.mov",
      taskId: "ark-task-mov",
    });
    const ctx = makeCtx();
    (
      ctx.params as typeof ctx.params & { modelParams: Record<string, unknown> }
    ).modelParams = {
      output_format: "mov",
    };

    await volcengineVideoAdapter.submit(ctx as never);

    mocks.pollModelArkVideoOnce.mockResolvedValue({
      url: "https://video.example/out.mov",
      taskId: "ark-task-mov",
    });
    await volcengineVideoAdapter.poll!(ctx as never, {
      taskId: "ark-task-mov",
      model: "seedance",
    });
    expect(ctx.completedVideo).toHaveBeenCalledWith(
      "https://video.example/out.mov",
      "video/quicktime",
      expect.objectContaining({ taskId: "ark-task-mov" }),
    );
  });
});
