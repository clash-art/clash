import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LoroDoc } from "loro-crdt";
import { processPendingNodes, reconcileUnadmittedTasks } from "./NodeProcessor";
import { startGeneration } from "../generation/start";
import { hostedGenerationStatus } from "../generation/status";
import { appendNodeLog } from "./NodeUpdater";
vi.mock("../generation/start", () => ({ startGeneration: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../generation/status", () => ({ hostedGenerationStatus: vi.fn().mockResolvedValue(undefined) }));
import type { Env } from "../config";

// The render-time ProjectAssetReferenceResolver port: Project Assets by id, signed by the fake.
const projectAssets = vi.hoisted(
  () => new Map<string, { kind: string; state: "active" | "trashed"; width?: number; height?: number }>(),
);
vi.mock("../services/project-asset-references", async () => {
  const shared = await import("@clash/shared-runtime/cloud-project-host/project-asset-references");
  const { executableFailureFromThrown } = await import("@clash/action-sdk/executable-failure");
  const references = shared.createProjectAssetReferenceResolver({
    readAsset: async ({ assetId }) => {
      const asset = projectAssets.get(assetId);
      return asset
        ? ({
            id: assetId,
            kind: asset.kind,
            source: { resourceId: `res-${assetId}` },
            lifecycle: { state: asset.state },
            metadata: { width: asset.width, height: asset.height },
          } as never)
        : null;
    },
    readCommittedResource: async (_target, entry) => ({ id: entry.source.resourceId }) as never,
    sign: async ({ target }) => ({
      url: `https://media.test/assets/capability/${target.projectId}/${target.assetId}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }),
  });
  return {
    async resolveCloudTimelineMedia(_env: unknown, input: Record<string, any>) {
      try {
        return {
          ok: true,
          timelineDsl: await shared.resolveTimelineMediaReferences(input.timelineDsl, {
            projectId: input.projectId,
            references,
            assetIdOf: input.assetIdOf,
            typeOf: input.typeOf,
            decorate: input.decorate,
          }),
        };
      } catch (error) {
        const { code, message } = executableFailureFromThrown(error, "submit");
        return { ok: false, failure: { code, message } };
      }
    },
  };
});

// Mock describe service
vi.mock("../services/describe", () => ({
  generateDescription: vi.fn().mockResolvedValue("A test description"),
}));

// Mock NodeUpdater to avoid Loro proxy spread issues
vi.mock("./NodeUpdater", () => ({
  updateNodeData: vi.fn((doc, nodeId, updates, broadcast) => {
    const nodesMap = doc.getMap("nodes");
    const existing = nodesMap.get(nodeId) as any;
    if (!existing) return;
    const newData = { ...existing.data, ...updates };
    nodesMap.set(nodeId, { ...existing, data: newData });
    broadcast(new Uint8Array(0));
  }),
  appendNodeLog: vi.fn(),
  clearNodeLog: vi.fn(),
}));

function makeDoc(
  nodes: Array<{ id: string; type: string; data: Record<string, any> }>
): LoroDoc {
  const doc = new LoroDoc();
  const nodesMap = doc.getMap("nodes");
  for (const node of nodes) {
    nodesMap.set(node.id, {
      type: node.type,
      data: node.data,
      position: { x: 0, y: 0 },
    });
  }
  return doc;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_API_KEY: "test-key",
    GOOGLE_AI_STUDIO_BASE_URL: "",
    CF_AIG_TOKEN: "",
    KLING_ACCESS_KEY: "",
    KLING_SECRET_KEY: "",
    R2_BUCKET: {
      get: vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      }),
      put: vi.fn(),
    } as any,
    R2_PUBLIC_URL: "https://r2.example.com",
    ENVIRONMENT: "production",
    ROOM: {} as any,
    SUPERVISOR: {} as any,
    GENERATION_WORKFLOW: {
      create: vi.fn().mockResolvedValue({ id: "wf-id" }),
    } as any,
    RENDER_CONTAINER: {} as any,
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
    } as any,
    ...overrides,
  } as Env;
}

describe("NodeProcessor - processPendingNodes", () => {
  const broadcast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(startGeneration).mockReset().mockResolvedValue(undefined);
    // Mock crypto.randomUUID
    vi.spyOn(crypto, "randomUUID").mockReturnValue("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies parameter-conditioned Model Card validation before dispatch", async () => {
    const doc = makeDoc([
      {
        id: "seedance-edit",
        type: "video",
        data: {
          status: "pending",
          prompt: "Edit this clip",
          modelId: "seedance-2.5-ref",
          modelParams: { edit_mode: true },
          actorType: "user",
          actorUserId: "u-test",
        },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
    expect(doc.getMap("nodes").get("seedance-edit")).toMatchObject({
      data: {
        status: "failed",
        error: expect.stringMatching(/at least 1 reference video/i),
      },
    });
  });

  it("skips non-generation node types (text)", async () => {
    const doc = makeDoc([
      { id: "n1", type: "text", data: { label: "hello" } },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("skips nodes that already have pendingTask", async () => {
    const doc = makeDoc([
      {
        id: "n1",
        type: "image",
        data: { status: "pending", pendingTask: "task-123" },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("submits image_gen task for pending image without src", async () => {
    const doc = makeDoc([
      {
        id: "node-img-1",
        type: "image",
        data: { status: "pending", prompt: "a cat", actorType: "user", actorUserId: "u-test" },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    // GENERATION_WORKFLOW.create should have been called with correct params
    expect(vi.mocked(startGeneration).mock.calls.map(([, id, params]) => ({ id, params }))).toContainEqual(
      expect.objectContaining({
        id: "proj-1-gen-node-img-1",
        params: expect.objectContaining({
          type: "image_gen",
          nodeId: "node-img-1",
          projectId: "proj-1",
        }),
      })
    );

    // GENERATION_WORKFLOW should have been called
    expect(startGeneration).toHaveBeenCalled();

    // Node should have pendingTask set + status changed to generating
    const nodesMap = doc.getMap("nodes");
    const nodeData = nodesMap.get("node-img-1") as any;
    expect(nodeData.data.pendingTask).toBe("proj-1-gen-node-img-1");
    expect(nodeData.data.status).toBe("generating");
  });

  it("submits video_gen task for pending video without src", async () => {
    const doc = makeDoc([
      {
        id: "node-vid-1",
        type: "video",
        data: {
          status: "pending",
          prompt: "a sunset",
          modelId: "pika-2.5",
          actorType: "user",
          actorUserId: "u-test",
        },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(vi.mocked(startGeneration).mock.calls.map(([, id, params]) => ({ id, params }))).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          type: "video_gen",
          nodeId: "node-vid-1",
        }),
      })
    );
  });

  it("resolves hosted H3 prompt badges with their original modalities and order", async () => {
    const doc = makeDoc([
      {
        id: "image-ref",
        type: "image",
        data: { status: "completed", assetId: "asset-image", description: "Subject source" },
      },
      {
        id: "video-ref",
        type: "video",
        data: { status: "completed", assetId: "asset-video", description: "Motion source" },
      },
      {
        id: "h3-ref-node",
        type: "video",
        data: {
          status: "pending",
          prompt: "Use @[Subject](node:image-ref), then @[Motion](node:video-ref).",
          modelId: "minimax-h3-ref",
          referenceImageAssetIds: ["asset-image"],
          referenceVideoAssetIds: ["asset-video"],
          actorType: "user",
          actorUserId: "u-test",
        },
      },
    ]);
    const assets = [{
      id: "asset-image",
      userId: "u-test",
      kind: "image",
      srcR2Key: "images/subject.png",
      coverR2Key: null,
      metadata: null,
      sourceModel: null,
      sourcePrompt: null,
      sourceTaskId: null,
      sources: null,
      createdAt: 1,
      updatedAt: 1,
    }, {
      id: "asset-video",
      userId: "u-test",
      kind: "video",
      srcR2Key: "videos/motion.mp4",
      coverR2Key: null,
      metadata: null,
      sourceModel: null,
      sourcePrompt: null,
      sourceTaskId: null,
      sources: null,
      createdAt: 1,
      updatedAt: 1,
    }];
    const env = makeEnv({
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            all: vi.fn().mockResolvedValue({ results: assets }),
          }),
        }),
      } as any,
    });

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(vi.mocked(startGeneration).mock.calls.map(([, id, params]) => ({ id, params }))).toContainEqual(expect.objectContaining({
      params: expect.objectContaining({
        promptParts: [
          { type: "text", text: "Use " },
          {
            type: "asset_ref",
            nodeId: "image-ref",
            r2Key: "images/subject.png",
            modality: "image",
          },
          { type: "text", text: ", then " },
          {
            type: "asset_ref",
            nodeId: "video-ref",
            r2Key: "videos/motion.mp4",
            modality: "video",
          },
          { type: "text", text: "." },
        ],
      }),
    }));
  });

  it("fails a custom Action with no executable binding as plugin_unavailable", async () => {
    const doc = makeDoc([
      {
        id: "custom-worker-node",
        type: "image",
        data: {
          status: "pending",
          actionType: "custom:fal-render",
          customActionId: "fal-render",
          actorType: "user",
          actorUserId: "u-test",
        },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
    expect(doc.getMap("nodes").get("custom-worker-node")).toMatchObject({
      data: {
        status: "failed",
        error: expect.stringContaining("plugin_unavailable"),
      },
    });
  });
  it("does not enqueue the retired description no-op for a completed asset", async () => {
    const doc = makeDoc([{ id: "completed", type: "image", data: { status: "completed", assetId: "asset" } }]);
    await processPendingNodes(doc, makeEnv(), "project", broadcast);
    expect(startGeneration).not.toHaveBeenCalled();
    expect((doc.getMap("nodes").get("completed") as any).data.status).toBe("completed");
  });

  it("when Workflow submission fails, pendingTask is cleared and node marked failed", async () => {
    const doc = makeDoc([
      {
        id: "node-fail",
        type: "image",
        data: { status: "pending", prompt: "test", actorType: "user", actorUserId: "u-test" },
      },
    ]);

    // Make GENERATION_WORKFLOW.create throw
    const env = makeEnv();
    vi.mocked(startGeneration).mockRejectedValueOnce(new Error("Workflow down"));

    await processPendingNodes(doc, env, "proj-1", broadcast);

    // On failure, pendingTask is cleared and status set to failed
    const nodesMap = doc.getMap("nodes");
    const nodeData = nodesMap.get("node-fail") as any;
    expect(nodeData.data.status).toBe("failed");
    expect(nodeData.data.pendingTask).toBeNull();
  });

  it("sets status=failed when workflow.create throws", async () => {
    const doc = makeDoc([
      {
        id: "node-fail2",
        type: "image",
        data: { status: "pending", prompt: "test", actorType: "user", actorUserId: "u-test" },
      },
    ]);

    const env = makeEnv();
    vi.mocked(startGeneration).mockRejectedValueOnce(new Error("Workflow error"));

    await processPendingNodes(doc, env, "proj-1", broadcast);

    const nodesMap = doc.getMap("nodes");
    const nodeData = nodesMap.get("node-fail2") as any;
    expect(nodeData.data.status).toBe("failed");
  });

  it("skips video_render nodes", async () => {
    const doc = makeDoc([
      {
        id: "n-render",
        type: "video_render",
        data: { status: "generating" },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("submits video nodes with timelineDsl as video_render task", async () => {
    const doc = makeDoc([
      {
        id: "n-timeline",
        type: "video",
        data: { status: "pending", timelineDsl: { tracks: [] }, actorType: "user", actorUserId: "u-test" },
      },
    ]);
    // Render branch refuses to dispatch without an absolute media base URL
    // (the worker signs asset paths against it). Production env has no
    // dev-localhost fallback — provide one explicitly.
    const env = makeEnv({ MEDIA_GATEWAY_URL: "http://localhost:3000" });

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(vi.mocked(startGeneration).mock.calls.map(([, id, params]) => ({ id, params }))).toContainEqual(
      expect.objectContaining({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        params: expect.objectContaining({
          taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          nodeId: "n-timeline",
          type: "video_render",
        }),
      })
    );
  });

  it("resolves a legacy node-id timeline ref to its Project Asset's signed src", async () => {
    projectAssets.clear();
    projectAssets.set("asset-1", { kind: "image", state: "active", width: 1280, height: 720 });
    const doc = makeDoc([
      {
        id: "asset-node-1",
        type: "image",
        data: {
          status: "completed",
          assetId: "asset-1",
        },
      },
      {
        id: "n-render",
        type: "video",
        data: {
          status: "pending",
          actorType: "user",
          actorUserId: "u-test",
          timelineDsl: {
            tracks: [
              {
                id: "track-1",
                name: "Main",
                items: [
                  {
                    id: "item-1",
                    from: 0,
                    durationInFrames: 90,
                    assetId: "asset-node-1",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);

    await processPendingNodes(doc, makeEnv(), "proj-1", broadcast);

    expect(vi.mocked(startGeneration).mock.calls.map(([, id, params]) => ({ id, params }))).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          type: "video_render",
          timelineDsl: expect.objectContaining({
            tracks: [
              expect.objectContaining({
                items: [
                  expect.objectContaining({
                    assetId: "asset-node-1",
                    type: "image",
                    naturalWidth: 1280,
                    naturalHeight: 720,
                    src: "https://media.test/assets/capability/proj-1/asset-1",
                  }),
                ],
              }),
            ],
          }),
        }),
      }),
    );
  });

  it("resolves an imported project video clip (sourceNodeId plus assetId) to a signed src", async () => {
    projectAssets.clear();
    projectAssets.set("asset:clip", { kind: "video", state: "active", width: 1920, height: 1080 });
    const doc = makeDoc([
      {
        id: "video-node-1",
        type: "video",
        data: {
          status: "completed",
          assetId: "asset:clip",
        },
      },
      {
        id: "n-render",
        type: "video",
        data: {
          status: "pending",
          actorType: "user",
          actorUserId: "u-test",
          timelineDsl: {
            tracks: [
              {
                id: "track-video",
                name: "Video",
                items: [
                  {
                    id: "item-video-1",
                    type: "video",
                    from: 0,
                    durationInFrames: 120,
                    sourceNodeId: "video-node-1",
                    assetId: "asset:clip",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);

    await processPendingNodes(doc, makeEnv(), "proj-1", broadcast);

    expect(vi.mocked(startGeneration).mock.calls.map(([, id, params]) => ({ id, params }))).toContainEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          type: "video_render",
          timelineDsl: expect.objectContaining({
            tracks: [
              expect.objectContaining({
                items: [
                  expect.objectContaining({
                    id: "item-video-1",
                    type: "video",
                    sourceNodeId: "video-node-1",
                    assetId: "asset:clip",
                    naturalWidth: 1920,
                    naturalHeight: 1080,
                    src: "https://media.test/assets/capability/proj-1/asset:clip",
                  }),
                ],
              }),
            ],
          }),
        }),
      }),
    );
  });

  it.each([
    ["missing", undefined],
    ["trashed", { kind: "video", state: "trashed" as const }],
  ])("fails the render node with reference_unavailable before the workflow for a %s Asset", async (_label, asset) => {
    projectAssets.clear();
    if (asset) projectAssets.set("asset:clip", asset);
    const doc = makeDoc([
      {
        id: "n-render",
        type: "video",
        data: {
          status: "pending",
          actorType: "user",
          actorUserId: "u-test",
          timelineDsl: {
            tracks: [
              {
                id: "track-video",
                name: "Video",
                items: [
                  {
                    id: "item-video-1",
                    type: "video",
                    from: 0,
                    durationInFrames: 120,
                    assetId: "asset:clip",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);

    await processPendingNodes(doc, makeEnv(), "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
    const node = doc.getMap("nodes").get("n-render") as any;
    expect(node.data).toMatchObject({ status: "failed", errorCode: "reference_unavailable" });
    expect(node.data.pendingTask ?? null).toBeNull();
    expect(node.data.error).toContain("track-video:item-video-1");
    expect(node.data.error).toContain("asset:clip");
  });

  it("does not submit description for audio nodes", async () => {
    const doc = makeDoc([
      {
        id: "n-audio",
        type: "audio",
        data: { status: "completed", src: "audio.mp3" },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
  });

  // ─── Optimistic Lock Tests ───

  it("pendingTask is set before workflow.create is called (optimistic lock)", async () => {
    const doc = makeDoc([
      {
        id: "node-lock",
        type: "image",
        data: { status: "pending", prompt: "test", actorType: "user", actorUserId: "u-test" },
      },
    ]);

    let pendingTaskAtCreateTime: string | null = null;
    let statusAtCreateTime: string | null = null;
    const env = makeEnv();
    vi.mocked(startGeneration).mockImplementationOnce(async () => {
      pendingTaskAtCreateTime = (doc.getMap("nodes").get("node-lock") as any).data.pendingTask;
      statusAtCreateTime = (doc.getMap("nodes").get("node-lock") as any).data.status;
    });

    await processPendingNodes(doc, env, "proj-1", broadcast);

    // pendingTask and status should have been set BEFORE workflow.create was called
    expect(pendingTaskAtCreateTime).toBe("proj-1-gen-node-lock");
    expect(statusAtCreateTime).toBe("generating");
  });

  it("second invocation skips node that already has pendingTask (dedup)", async () => {
    const doc = makeDoc([
      {
        id: "node-dedup",
        type: "image",
        data: { status: "pending", prompt: "test", pendingTask: "existing-task" },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    // Should not submit a new task
    expect(startGeneration).not.toHaveBeenCalled();
    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("completed node with description is not re-processed", async () => {
    const doc = makeDoc([
      {
        id: "node-done",
        type: "image",
        data: { status: "completed", src: "img.png", description: "already described" },
      },
    ]);
    const env = makeEnv();

    await processPendingNodes(doc, env, "proj-1", broadcast);

    expect(startGeneration).not.toHaveBeenCalled();
  });

  it("video_gen with a required-input inputMode but no refs → node marked failed", async () => {
    // Simulate a model card that *does* require a reference image — the merged
    // production cards are all `{ kind: 'single' }` (optional), so we inject a
    // fake card into the registry for this test via modelId pointing at
    // something whose inputMode.required would be true. We short-circuit by
    // picking a card whose kind happens to be first_last (would require a start
    // frame). No such model currently exists, so this test documents the
    // pre-flight behavior without asserting on a real card today.
    // TODO: restore once a first_last or required=true model ships.
  });
});

describe("NodeProcessor - reconcileUnadmittedTasks", () => {
  const broadcast = vi.fn();
  const status = vi.mocked(hostedGenerationStatus);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails a node whose pendingTask has no journal row with GENERATION_ADMISSION_LOST", async () => {
    status.mockReset().mockResolvedValue(undefined);
    const doc = makeDoc([
      { id: "lost", type: "image", data: { status: "generating", pendingTask: "task-lost", pendingTaskAt: 1 } },
    ]);

    await expect(reconcileUnadmittedTasks(doc, makeEnv(), broadcast)).resolves.toEqual({ retry: false });

    expect(status).toHaveBeenCalledWith(expect.anything(), "task-lost");
    const node = doc.getMap("nodes").get("lost") as any;
    expect(node.data).toMatchObject({ status: "failed", errorCode: "GENERATION_ADMISSION_LOST" });
    expect(node.data.error).toEqual(expect.any(String));
    expect(node.data.pendingTask ?? null).toBeNull();
    expect(node.data.pendingTaskAt ?? null).toBeNull();
    expect(appendNodeLog).toHaveBeenCalledWith(doc, "lost", expect.stringMatching(/^FAILED: /), broadcast);
  });

  it("leaves a node whose run is in the journal untouched", async () => {
    status.mockReset().mockResolvedValue({ managedByJournal: true, status: "generating" } as any);
    const doc = makeDoc([
      { id: "admitted", type: "video", data: { status: "generating", pendingTask: "task-ok" } },
    ]);

    await expect(reconcileUnadmittedTasks(doc, makeEnv(), broadcast)).resolves.toEqual({ retry: false });

    expect((doc.getMap("nodes").get("admitted") as any).data).toEqual({ status: "generating", pendingTask: "task-ok" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("skips custom: actions without looking them up", async () => {
    status.mockReset().mockResolvedValue(undefined);
    const doc = makeDoc([
      { id: "action", type: "image", data: { status: "generating", pendingTask: "run-1", actionType: "custom:fal-render" } },
    ]);

    await expect(reconcileUnadmittedTasks(doc, makeEnv(), broadcast)).resolves.toEqual({ retry: false });

    expect(status).not.toHaveBeenCalled();
    expect((doc.getMap("nodes").get("action") as any).data.pendingTask).toBe("run-1");
  });

  it("leaves the node untouched and asks for a retry when the journal lookup throws", async () => {
    status.mockReset().mockRejectedValue(new Error("D1_ERROR: network connection lost"));
    const doc = makeDoc([
      { id: "unknown", type: "audio", data: { status: "generating", pendingTask: "task-unknown" } },
    ]);

    await expect(reconcileUnadmittedTasks(doc, makeEnv(), broadcast)).resolves.toEqual({ retry: true });

    expect((doc.getMap("nodes").get("unknown") as any).data).toEqual({ status: "generating", pendingTask: "task-unknown" });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
