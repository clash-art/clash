import { describe, it, expect, vi, beforeEach } from "vitest";
import { LoroDoc } from "loro-crdt";
import { hasPendingTasks, pollNodeTasks } from "./TaskPolling";
import { hostedGenerationStatus } from "../generation/status";
vi.mock("../generation/status", () => ({ hostedGenerationStatus: vi.fn().mockResolvedValue(undefined) }));
import type { Env } from "../config";

vi.mock("../services/assets", () => ({
  getAssetByTaskId: vi.fn(),
}));

import { getAssetByTaskId } from "../services/assets";

function makeDocWithNodes(
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
    GOOGLE_API_KEY: "",
    CF_AIG_TOKEN: "",
    KLING_ACCESS_KEY: "",
    KLING_SECRET_KEY: "",
    R2_BUCKET: {} as any,
    R2_PUBLIC_URL: "",
    ENVIRONMENT: "production",
    ROOM: {} as any,
    SUPERVISOR: {} as any,
    GENERATION_WORKFLOW: {
      get: vi.fn().mockRejectedValue(new Error("not found")),
    } as any,
    RENDER_CONTAINER: {} as any,
    DB: {} as any,
    ...overrides,
  } as Env;
}

/** Build a row matching the new AssetRecord shape returned by getAssetByTaskId. */
function asset(over: Partial<{ id: string; srcR2Key: string; coverR2Key: string | null; kind: string }> = {}) {
  return {
    id: over.id ?? "asset-1",
    userId: "u-1",
    kind: over.kind ?? "image",
    srcR2Key: over.srcR2Key ?? "projects/p1/assets/img.png",
    coverR2Key: over.coverR2Key ?? null,
    width: null, height: null, durationMs: null, bytes: null,
    sourceModel: null, sourcePrompt: null, sourceTaskId: "task-1",
    createdAt: 0, updatedAt: 0,
  };
}

describe("TaskPolling", () => {
  const broadcast = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── hasPendingTasks ───

  describe("hasPendingTasks", () => {
    it("returns false for empty doc", () => {
      expect(hasPendingTasks(new LoroDoc())).toBe(false);
    });

    it("returns false when no nodes have pendingTask", () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "completed", src: "url" } },
        { id: "n2", type: "text", data: { label: "hello" } },
      ]);
      expect(hasPendingTasks(doc)).toBe(false);
    });

    it("returns true when a node has pendingTask", () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "task-123" } },
      ]);
      expect(hasPendingTasks(doc)).toBe(true);
    });
  });

  // ─── pollNodeTasks ───

  describe("pollNodeTasks", () => {
    it("returns false when no nodes have pendingTask", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "completed", src: "url" } },
      ]);
      const result = await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);
      expect(result).toBe(false);
    });

    it("asset row found → writes assetId + status=completed + clears pendingTask", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "task-1" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(
        asset({ id: "asset-xyz", srcR2Key: "projects/p1/assets/img.png" }),
      );

      const result = await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);
      expect(result).toBe(false);

      const nodeData = doc.getMap("nodes").get("n1") as any;
      expect(nodeData.data.assetId).toBe("asset-xyz");
      expect(nodeData.data.src).toBeUndefined();
      expect(nodeData.data.status).toBe("completed");
      expect(nodeData.data.pendingTask).toBeNull();
    });

    it("video asset with cover → writes coverUrl", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "video", data: { status: "generating", pendingTask: "task-vid" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(
        asset({
          kind: "video",
          srcR2Key: "projects/p1/assets/vid.mp4",
          coverR2Key: "projects/p1/assets/vid-cover.jpg",
        }),
      );

      await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);

      const nodeData = doc.getMap("nodes").get("n1") as any;
      expect(nodeData.data.assetId).toBe("asset-1");
      expect(nodeData.data.coverUrl).toBe("projects/p1/assets/vid-cover.jpg");
    });

    it("no asset row + workflow errored → marks failed via workflow.status()", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "task-wf-fail" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(null);

      const env = makeEnv({
        GENERATION_WORKFLOW: {
          get: vi.fn().mockResolvedValue({
            status: vi.fn().mockResolvedValue({
              status: "errored",
              error: { message: "FAL API timeout" },
            }),
          }),
        } as any,
      });

      const result = await pollNodeTasks(doc, env, "proj-1", broadcast);
      expect(result).toBe(false);

      const nodeData = doc.getMap("nodes").get("n1") as any;
      expect(nodeData.data.status).toBe("failed");
      expect(nodeData.data.error).toBe("FAL API timeout");
      expect(nodeData.data.pendingTask).toBeNull();
    });

    it("no asset row + workflow still running → returns true (keep polling)", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "task-wf-running" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(null);

      const env = makeEnv({
        GENERATION_WORKFLOW: {
          get: vi.fn().mockResolvedValue({
            status: vi.fn().mockResolvedValue({ status: "running" }),
          }),
        } as any,
      });

      const result = await pollNodeTasks(doc, env, "proj-1", broadcast);
      expect(result).toBe(true);
    });

    it("multiple nodes: one completed, one pending → returns true", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "task-done" } },
        { id: "n2", type: "video", data: { status: "generating", pendingTask: "task-pending" } },
      ]);
      (getAssetByTaskId as any)
        .mockResolvedValueOnce(asset({ id: "a1", srcR2Key: "img.png" }))
        .mockResolvedValueOnce(null);

      const result = await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);
      expect(result).toBe(true);

      const n1 = doc.getMap("nodes").get("n1") as any;
      expect(n1.data.status).toBe("completed");
    });

    it("broadcast is called when a node is updated", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "task-bc" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(asset());
      await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);
      expect(broadcast).toHaveBeenCalled();
    });

    it("nodes without pendingTask are skipped (no DB query)", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "completed", src: "u" } },
        { id: "n2", type: "text", data: { label: "x" } },
      ]);
      const result = await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);
      expect(result).toBe(false);
      expect(getAssetByTaskId).not.toHaveBeenCalled();
    });

    it("workflow terminated → marks failed with default error message", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "t-term" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(null);
      const env = makeEnv({
        GENERATION_WORKFLOW: {
          get: vi.fn().mockResolvedValue({
            status: vi.fn().mockResolvedValue({ status: "terminated" }),
          }),
        } as any,
      });
      await pollNodeTasks(doc, env, "proj-1", broadcast);
      const nodeData = doc.getMap("nodes").get("n1") as any;
      expect(nodeData.data.status).toBe("failed");
      expect(nodeData.data.error).toBe("Workflow failed");
    });

    it("workflow.get throws (instance gone) → returns true (still pending, no crash)", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "t-gone" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(null);
      const env = makeEnv({
        GENERATION_WORKFLOW: {
          get: vi.fn().mockRejectedValue(new Error("instance not found")),
        } as any,
      });
      const result = await pollNodeTasks(doc, env, "proj-1", broadcast);
      // Treated as still pending — orphan recovery in NodeProcessor handles long-running cases.
      expect(result).toBe(true);
    });

    it("DB query throws → keeps the node pending (transient DB errors must not flip Loro state)", async () => {
      // A schema-migration-lag style failure (e.g. SELECT references a column
      // that hasn't been ALTERed in yet) used to translate into a permanent
      // status:"failed" overwrite, which corrupted live nodes for ~all users
      // while migration caught up. Now the catch returns Pending so the next
      // poll retries — workflow.status() above is the authoritative failure
      // signal, not D1 reachability.
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "t-db" } },
      ]);
      (getAssetByTaskId as any).mockRejectedValueOnce(new Error("D1 down"));
      const result = await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);
      expect(result).toBe(true); // still pending → loop should keep ticking
      const nodeData = doc.getMap("nodes").get("n1") as any;
      expect(nodeData.data.status).toBe("generating"); // unchanged
      expect(nodeData.data.error).toBeUndefined();
    });

    it("video asset without cover → coverUrl is not written", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "video", data: { status: "generating", pendingTask: "t-vid" } },
      ]);
      (getAssetByTaskId as any).mockResolvedValue(asset({ kind: "video", srcR2Key: "v.mp4", coverR2Key: null }));
      await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);
      const nodeData = doc.getMap("nodes").get("n1") as any;
      expect(nodeData.data.assetId).toBe("asset-1");
      expect(nodeData.data.coverUrl).toBeUndefined();
    });

    it("two completed nodes → both updated and broadcast called for each", async () => {
      const doc = makeDocWithNodes([
        { id: "n1", type: "image", data: { status: "generating", pendingTask: "t-1" } },
        { id: "n2", type: "image", data: { status: "generating", pendingTask: "t-2" } },
      ]);
      (getAssetByTaskId as any)
        .mockResolvedValueOnce(asset({ id: "a-1", srcR2Key: "k1" }))
        .mockResolvedValueOnce(asset({ id: "a-2", srcR2Key: "k2" }));
      await pollNodeTasks(doc, makeEnv(), "proj-1", broadcast);

      const n1 = doc.getMap("nodes").get("n1") as any;
      const n2 = doc.getMap("nodes").get("n2") as any;
      expect(n1.data.assetId).toBe("a-1");
      expect(n2.data.assetId).toBe("a-2");
      // 2 updateNodeData + 2 clearNodeLog → broadcast called at least twice
      expect((broadcast as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});


it("does not apply a historical result if a newer task arrived during the status read", async () => {
  const doc = makeDocWithNodes([{ id: "node", type: "video", data: { pendingTask: "old", status: "generating" } }]);
  vi.mocked(hostedGenerationStatus).mockResolvedValue(undefined);
  vi.mocked(getAssetByTaskId).mockImplementationOnce(async () => {
    const node = doc.getMap("nodes").get("node") as any;
    doc.getMap("nodes").set("node", { ...node, data: { ...node.data, pendingTask: "new" } });
    return asset() as any;
  });
  await pollNodeTasks(doc, makeEnv(), "project", vi.fn());
  expect((doc.getMap("nodes").get("node") as any).data).toEqual({ pendingTask: "new", status: "generating" });
  doc.free();
});

it("leaves journal-owned node publication to its durable publisher even when legacy bytes exist", async () => {
  const doc = makeDocWithNodes([{ id: "node", type: "video", data: { pendingTask: "task", status: "generating" } }]);
  vi.mocked(hostedGenerationStatus).mockResolvedValueOnce({ managedByJournal: true, status: "completed", assetId: "asset" } as any);
  const lookup = vi.mocked(getAssetByTaskId); lookup.mockClear();
  await pollNodeTasks(doc, makeEnv(), "project", vi.fn());
  expect(lookup).not.toHaveBeenCalled();
  expect((doc.getMap("nodes").get("node") as any).data.pendingTask).toBe("task");
  doc.free();
});
