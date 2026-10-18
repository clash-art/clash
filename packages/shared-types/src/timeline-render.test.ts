import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { Canvas } from "./canvas-ops.js";
import {
  listActionAssetBindingsForOwner,
  listActionAssetReferences,
  markActionAssetBindingAuthority,
  trashProjectAssetIfUnreferenced,
} from "./action-asset-bindings.js";
import {
  createProjectAsset,
  markProjectAssetAuthority,
} from "./project-assets.js";
import * as workspace from "./project-workspace.js";
import * as timelineRender from "./timeline-render.js";

const timelineState = {
  compositionWidth: 1920,
  compositionHeight: 1080,
  fps: 30,
  durationInFrames: 60,
  tracks: [
    {
      id: "video-track",
      items: [
        {
          id: "clip-1",
          type: "video",
          from: 0,
          durationInFrames: 60,
          assetId: "asset-1",
        },
      ],
    },
  ],
};

function authoritativeTimelineDoc(): LoroDoc {
  const doc = new LoroDoc();
  for (const id of ["asset-1", "asset-2"]) {
    expect(
      createProjectAsset(doc, {
        id,
        kind: "video",
        source: { kind: "owned", resourceId: `sha256:${id}` },
        lifecycle: { state: "active" },
        metadata: {},
      }),
    ).toMatchObject({ ok: true });
  }
  expect(markProjectAssetAuthority(doc)).toMatchObject({ ok: true });
  expect(markActionAssetBindingAuthority(doc)).toMatchObject({ ok: true });
  return doc;
}

describe("Timeline render requests", () => {
  it("projects one render node into the shared Timeline export progress contract", () => {
    expect(
      timelineRender.timelineExportProgressFromRenderNode,
    ).toBeTypeOf("function");
    expect(
      timelineRender.timelineExportProgressFromRenderNode(
        "render-1",
        {
          type: "video",
          data: {
            sourceTimelineId: "timeline-1",
            sourceTimelineRevisionId: "timeline-revision-v1:abc",
            status: "generating",
            progress: 0.42,
          },
        },
      ),
    ).toEqual({
      renderNodeId: "render-1",
      timelineId: "timeline-1",
      timelineRevisionId: "timeline-revision-v1:abc",
      status: "rendering",
      progress: 0.42,
    });
  });

  it("lists persisted exports for one Timeline from the shared Loro replica", () => {
    const doc = new LoroDoc();
    doc.getMap("nodes").set("render-current", {
      type: "video",
      data: {
        sourceTimelineId: "timeline-1",
        sourceTimelineRevisionId: "timeline-revision-v1:abc",
        status: "pending",
      },
    });
    doc.getMap("nodes").set("render-other", {
      type: "video",
      data: {
        sourceTimelineId: "timeline-2",
        sourceTimelineRevisionId: "timeline-revision-v1:def",
        status: "generating",
      },
    });

    expect(timelineRender.listTimelineExportProgress).toBeTypeOf(
      "function",
    );
    expect(
      timelineRender.listTimelineExportProgress(doc, "timeline-1"),
    ).toEqual([
      {
        renderNodeId: "render-current",
        timelineId: "timeline-1",
        timelineRevisionId: "timeline-revision-v1:abc",
        status: "queued",
      },
    ]);
  });

  it("exports the canonical render DSL projection shared with authority validation", () => {
    expect((timelineRender as any).canonicalTimelineRenderDsl).toBeTypeOf(
      "function",
    );
    expect(
      (timelineRender as any).canonicalTimelineRenderDsl({
        durationInFrames: 5,
        tracks: [
          {
            id: "video",
            items: [{ id: "clip", from: 12, durationInFrames: 18 }],
          },
        ],
      }),
    ).toEqual({
      durationInFrames: 30,
      tracks: [
        {
          id: "video",
          items: [{ id: "clip", from: 12, durationInFrames: 18 }],
        },
      ],
    });
  });

  it("creates a backend-only render request for a Project-owned Timeline", () => {
    const doc = authoritativeTimelineDoc();
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-project",
      name: "Project Cut",
      state: timelineState,
    });

    expect((timelineRender as any).requestTimelineRender).toBeTypeOf(
      "function",
    );
    const result = (timelineRender as any).requestTimelineRender(doc, {
      timelineId: "timeline-project",
      actorUserId: "user-1",
      generateId: () => "render-project-1",
    });

    expect(result).toMatchObject({
      ok: true,
      renderNodeId: "render-project-1",
      target: { kind: "project-assets" },
    });
    expect(doc.getMap("nodes").get("render-project-1")).toMatchObject({
      canvasId: (timelineRender as any).PROJECT_ASSET_RENDER_CANVAS_ID,
      type: "video",
      data: {
        status: "pending",
        actorType: "user",
        actorUserId: "user-1",
        sourceTimelineId: "timeline-project",
        sourceTimelineActionId: "timeline:timeline-project",
        sourceTimelineActionRunId: "timeline-render:render-project-1",
        renderTarget: { kind: "project-assets" },
        timelineDsl: { durationInFrames: 60 },
      },
    });
    expect((workspace as any).listProjectCanvases(doc)).toEqual([]);
  });

  it("places the pending render video on a Canvas-owned Timeline's parent Canvas", () => {
    const doc = authoritativeTimelineDoc();
    (workspace as any).createProjectCanvas(doc, { id: "shots", name: "Shots" });
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-canvas",
      name: "Canvas Cut",
      state: timelineState,
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-canvas",
      canvasId: "shots",
      actionNodeId: "timeline-action",
      position: { x: 20, y: 40 },
    });

    const result = (timelineRender as any).requestTimelineRender(doc, {
      timelineId: "timeline-canvas",
      actorUserId: "user-1",
      generateId: () => "render-canvas-1",
    });

    expect(result).toMatchObject({
      ok: true,
      renderNodeId: "render-canvas-1",
      target: {
        kind: "canvas",
        canvasId: "shots",
        actionNodeId: "timeline-action",
      },
    });
    expect(
      new Canvas(doc, () => {}, "shots").readNode("render-canvas-1"),
    ).toMatchObject({
      type: "video",
      upstream: [{ nodeId: "timeline-action" }],
      data: {
        status: "pending",
        actorUserId: "user-1",
        sourceTimelineId: "timeline-canvas",
        sourceTimelineActionId: "node:timeline-action",
        sourceTimelineActionRunId: "timeline-render:render-canvas-1",
        renderTarget: {
          kind: "canvas",
          canvasId: "shots",
          actionNodeId: "timeline-action",
        },
      },
    });
  });

  it("pins Timeline inputs to the render run when the editable Timeline is rewired", () => {
    const doc = authoritativeTimelineDoc();
    expect(
      (workspace as any).createProjectTimeline(doc, {
        id: "timeline-project",
        name: "Project Cut",
        state: timelineState,
      }),
    ).toMatchObject({ ok: true });

    const requested = (timelineRender as any).requestTimelineRender(doc, {
      timelineId: "timeline-project",
      actorUserId: "user-1",
      generateId: () => "render-project-1",
    });
    expect(requested).toMatchObject({ ok: true });
    const runOwner = {
      kind: "run" as const,
      actionId: "timeline:timeline-project",
      actionRevisionId: (workspace as any).readProjectTimeline(
        doc,
        "timeline-project",
      ).revisionId,
      actionRunId: "timeline-render:render-project-1",
    };
    expect(listActionAssetBindingsForOwner(doc, runOwner)).toMatchObject([
      {
        owner: runOwner,
        direction: "input",
        slot: "timeline:item:clip-1",
        projectAssetId: "asset-1",
      },
    ]);

    expect(
      (workspace as any).updateProjectTimelineState(doc, "timeline-project", {
        ...timelineState,
        tracks: [
          {
            id: "video-track",
            items: [
              {
                id: "clip-1",
                type: "video",
                from: 0,
                durationInFrames: 60,
                assetId: "asset-2",
              },
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: true });

    expect(listActionAssetBindingsForOwner(doc, runOwner)).toMatchObject([
      { slot: "timeline:item:clip-1", projectAssetId: "asset-1" },
    ]);
    expect(
      listActionAssetReferences(doc, "asset-1").filter(
        (binding) => binding.direction === "input",
      ),
    ).toMatchObject([{ owner: runOwner, projectAssetId: "asset-1" }]);
    expect(
      trashProjectAssetIfUnreferenced(doc, {
        id: "asset-1",
        deleteOperationId: "delete-asset-1",
        deletedAt: "2026-08-13T00:00:00.000Z",
        purgeAfter: "2026-09-12T00:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "ASSET_IN_USE" } });
  });
});

describe("completeTimelineRenderNode", () => {
  it("projects an uploaded Asset into the same completed node the container writes", () => {
    const doc = authoritativeTimelineDoc();
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-browser",
      name: "Browser Cut",
      state: timelineState,
    });
    const requested = (timelineRender as any).requestTimelineRender(doc, {
      timelineId: "timeline-browser",
      actorUserId: "user-1",
      generateId: () => "render-browser-1",
    });
    const completed = (timelineRender as any).completeTimelineRenderNode(doc, {
      renderNodeId: requested.renderNodeId,
      assetId: "asset-browser-1",
    });
    expect(completed).toEqual({
      ok: true,
      renderNodeId: "render-browser-1",
      assetId: "asset-browser-1",
    });
    expect(doc.getMap("nodes").get("render-browser-1")).toMatchObject({
      type: "video",
      data: {
        status: "completed",
        assetId: "asset-browser-1",
        progress: 1,
      },
    });
    expect(
      (timelineRender as any).listTimelineExportProgress(doc, "timeline-browser"),
    ).toEqual([
      {
        renderNodeId: "render-browser-1",
        timelineId: "timeline-browser",
        timelineRevisionId: requested.renderNodeId
          ? (doc.getMap("nodes").get("render-browser-1") as any).data
              .sourceTimelineRevisionId
          : "",
        status: "completed",
        progress: 1,
      },
    ]);
    expect(
      (timelineRender as any).completeTimelineRenderNode(doc, {
        renderNodeId: "missing",
        assetId: "asset-browser-1",
      }),
    ).toMatchObject({ ok: false });
  });

  it("clears a previous failure message and code when the render completes", () => {
    const doc = authoritativeTimelineDoc();
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-browser",
      name: "Browser Cut",
      state: timelineState,
    });
    const requested = (timelineRender as any).requestTimelineRender(doc, {
      timelineId: "timeline-browser",
      actorUserId: "user-1",
      generateId: () => "render-browser-1",
    });
    const nodes = doc.getMap("nodes");
    const node = nodes.get(requested.renderNodeId) as any;
    nodes.set(requested.renderNodeId, {
      ...node,
      data: {
        ...node.data,
        status: "failed",
        error: "Remotion media fetch timed out",
        errorCode: "provider_unavailable",
      },
    });
    expect(
      (timelineRender as any).completeTimelineRenderNode(doc, {
        renderNodeId: requested.renderNodeId,
        assetId: "asset-browser-1",
      }),
    ).toMatchObject({ ok: true });
    const data = (nodes.get(requested.renderNodeId) as any).data;
    expect(data.status).toBe("completed");
    expect(data.error ?? null).toBeNull();
    expect(data.errorCode ?? null).toBeNull();
  });
});
