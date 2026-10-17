import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { createProjectTimeline, listTimelineExportProgress } from "@clash/shared-types";
import { commitProjectAssetImport } from "@clash/shared-runtime/cloud-project-host/project-assets";
import { runProjectRoomTimelineRenderCompletion } from "./project-room-host-command";

const RENDERED = {
  id: "resource-1",
  kind: "video" as const,
  digest: { algorithm: "sha256" as const, value: "a".repeat(64) },
  byteLength: 5,
  contentType: "video/mp4",
};

async function importRenderedAsset(doc: LoroDoc, projectAssetId = "asset-1") {
  const result = await commitProjectAssetImport(
    doc,
    {
      projectId: "project-1",
      projectAssetId,
      resource: RENDERED,
      name: "timeline-1.mp4",
      metadata: { bytes: 5, originalName: "timeline-1.mp4" },
      createdAt: 1,
    },
    { readResource: () => null },
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
}

function completionPort(doc: LoroDoc, persisted: Uint8Array[] = []) {
  return {
    projectId: "project-1",
    doc: () => doc,
    readProject: async () => ({ ownerId: "user-1", deletedAt: null }),
    serialize: <T,>(work: () => Promise<T>) => work(),
    persist: async (update: Uint8Array) => {
      persisted.push(update);
      doc.import(update);
    },
    broadcast: () => undefined,
    env: { ENVIRONMENT: "test", JWT_SECRET: "test-secret" },
  };
}

function docWithTimeline() {
  const doc = new LoroDoc();
  const created = createProjectTimeline(doc, {
    id: "timeline-1",
    name: "Cut",
    state: {
      tracks: [
        {
          id: "track",
          items: [
            { id: "title", type: "text", text: "Hi", from: 0, durationInFrames: 30 },
          ],
        },
      ],
    },
  });
  if (!created.ok) throw new Error(created.error);
  return { doc, timeline: created.timeline };
}

describe("Cloudflare browser render publication", () => {
  it("creates and completes the render node in one serialized write", async () => {
    const { doc, timeline } = docWithTimeline();
    await importRenderedAsset(doc);
    const persisted: Uint8Array[] = [];
    const result = await runProjectRoomTimelineRenderCompletion(
      {
        projectId: "project-1",
        doc: () => doc,
        readProject: async () => ({ ownerId: "user-1", deletedAt: null }),
        serialize: (work) => work(),
        persist: async (update) => {
          persisted.push(update);
          doc.import(update);
        },
        broadcast: () => undefined,
        env: { ENVIRONMENT: "test", JWT_SECRET: "test-secret" },
      },
      { userId: "user-1", timelineId: timeline.id, assetId: "asset-1" },
    );
    expect(result).toMatchObject({ status: 200, body: { submitted: true } });
    expect(persisted).toHaveLength(1);
    expect(listTimelineExportProgress(doc, timeline.id)).toEqual([
      expect.objectContaining({
        renderNodeId: (result.body as { renderNodeId: string }).renderNodeId,
        status: "completed",
        progress: 1,
      }),
    ]);
  });

  it("rejects a Timeline the user does not own without creating a node", async () => {
    const { doc, timeline } = docWithTimeline();
    const result = await runProjectRoomTimelineRenderCompletion(
      {
        projectId: "project-1",
        doc: () => doc,
        readProject: async () => ({ ownerId: "owner", deletedAt: null }),
        serialize: (work) => work(),
        persist: async () => undefined,
        broadcast: () => undefined,
        env: { ENVIRONMENT: "test", JWT_SECRET: "test-secret" },
      },
      { userId: "user-1", timelineId: timeline.id, assetId: "asset-1" },
    );
    expect(result).toMatchObject({
      status: 404,
      body: { code: "PROJECT_NOT_FOUND" },
    });
    expect(listTimelineExportProgress(doc, timeline.id)).toEqual([]);
  });

  it("is idempotent per Timeline and Asset: a retried publication returns the same node", async () => {
    const { doc, timeline } = docWithTimeline();
    await importRenderedAsset(doc);
    const persisted: Uint8Array[] = [];
    const input = { userId: "user-1", timelineId: timeline.id, assetId: "asset-1" };
    const first = await runProjectRoomTimelineRenderCompletion(completionPort(doc, persisted), input);
    const retry = await runProjectRoomTimelineRenderCompletion(completionPort(doc, persisted), input);
    expect(retry).toEqual(first);
    expect(persisted).toHaveLength(1);
    expect(listTimelineExportProgress(doc, timeline.id)).toHaveLength(1);
  });

  it("refuses to publish an Asset that is not in the Project", async () => {
    const { doc, timeline } = docWithTimeline();
    const result = await runProjectRoomTimelineRenderCompletion(completionPort(doc), {
      userId: "user-1",
      timelineId: timeline.id,
      assetId: "asset-from-elsewhere",
    });
    expect(result).toMatchObject({ status: 404, body: { error: "Asset not found" } });
    expect(listTimelineExportProgress(doc, timeline.id)).toHaveLength(0);
  });
});
