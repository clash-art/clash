import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  credentialsForRoute: vi.fn(),
  generateOpenAIImage: vi.fn(),
}));

vi.mock("./provider-credentials", () => ({
  credentialsForRoute: mocks.credentialsForRoute,
}));

vi.mock("../../services/openai-image", () => ({
  generateOpenAIImage: mocks.generateOpenAIImage,
}));

import { openaiImageAdapter } from "./openai-image";

function makeCtx() {
  const uploadBytes = vi
    .fn()
    .mockResolvedValue("projects/p1/uploads/task-1.png");
  const probe = vi
    .fn()
    .mockResolvedValue({ metadata: { width: 1024, height: 1024 } });
  const createAsset = vi.fn().mockResolvedValue("asset-1");
  const notifyCompleted = vi.fn();

  return {
    params: {
      taskId: "task-1",
      nodeId: "node-1",
      projectId: "project-1",
      type: "image_gen",
      actorType: "user",
      actorUserId: "user-1",
      prompt: "render a product hero",
      modelName: "gpt-image-2",
      modelParams: { quality: "high" },
      selectedRoute: {
        modelCode: "gpt-image-2",
        kind: "image",
        providerId: "official",
        accountId: "openai-primary",
        upstreamId: "openai",
        upstreamModel: "gpt-image-2",
        apiShape: "openai-images",
        priority: 10,
        requiredCredentials: ["apiKey"],
      },
    },
    env: {
      DB: {} as D1Database,
      ACTION_SECRET_KEY: "secret-key",
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

describe("openaiImageAdapter", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads OpenAI credentials from provider accounts", async () => {
    mocks.credentialsForRoute.mockResolvedValue({
      apiKey: "provider-openai-key",
      baseUrl: "https://openai-compatible.example/v1",
    });
    mocks.generateOpenAIImage.mockResolvedValue({
      data: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      model: "gpt-image-2",
    });
    const ctx = makeCtx();

    const result = await openaiImageAdapter.submit(ctx as never);

    expect(mocks.credentialsForRoute).toHaveBeenCalledWith(
      ctx,
      ctx.params.selectedRoute,
    );
    expect(mocks.generateOpenAIImage).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "provider-openai-key",
        baseUrl: "https://openai-compatible.example/v1",
        modelName: "gpt-image-2",
      }),
    );
    expect(result).toMatchObject({
      status: "completed",
      outputs: [{ kind: "asset" }],
    });
  });
});
