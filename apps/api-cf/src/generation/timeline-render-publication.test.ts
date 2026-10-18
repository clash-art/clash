import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import type { ProjectAssetImportResult } from "@clash/shared-runtime/cloud-project-host/project-assets";
import { timelineRenderPublicationUpdate } from "./timeline-render-publication";

function renderDoc(data: Record<string, unknown>) {
  const doc = new LoroDoc();
  doc.getMap("nodes").set("render-1", {
    id: "render-1",
    type: "video",
    data: {
      sourceTimelineId: "timeline-1",
      sourceTimelineRevisionId: "revision-1",
      ...data,
    },
  });
  doc.commit();
  return doc;
}

const renderData = (doc: LoroDoc) =>
  (doc.getMap("nodes").get("render-1") as { data: Record<string, unknown> })
    .data;

const imported = async () =>
  ({ ok: true }) as unknown as ProjectAssetImportResult;

describe("timelineRenderPublicationUpdate", () => {
  it("projects a failed run's message and code onto the render node", async () => {
    const doc = renderDoc({ status: "generating", pendingTask: "run-1" });
    const update = await timelineRenderPublicationUpdate(
      doc,
      "project-1",
      {
        taskId: "run-1",
        nodeId: "render-1",
        actorUserId: "user-1",
        failure: { code: "deadline_exceeded", message: "Render timed out" },
      },
      imported,
    );
    doc.import(update!);
    expect(renderData(doc)).toMatchObject({
      status: "failed",
      error: "Render timed out",
      errorCode: "deadline_exceeded",
    });
    expect(renderData(doc).pendingTask ?? null).toBeNull();
    doc.free();
  });

  it("clears an earlier failure message and code when the run completes", async () => {
    const doc = renderDoc({
      status: "generating",
      pendingTask: "run-2",
      error: "Render timed out",
      errorCode: "deadline_exceeded",
    });
    const update = await timelineRenderPublicationUpdate(
      doc,
      "project-1",
      {
        taskId: "run-2",
        nodeId: "render-1",
        actorUserId: "user-1",
        render: {
          resource: {} as never,
          name: "render.mp4",
          metadata: {},
          createdAt: 1,
        },
      },
      imported,
    );
    doc.import(update!);
    expect(renderData(doc)).toMatchObject({
      status: "completed",
      assetId: "run-2",
    });
    expect(renderData(doc).error ?? null).toBeNull();
    expect(renderData(doc).errorCode ?? null).toBeNull();
    doc.free();
  });
});
