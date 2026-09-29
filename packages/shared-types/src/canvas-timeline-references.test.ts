import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { isCanvasNodeImmutable } from "./canvas-update-guardrails.js";
import { Canvas } from "./canvas-ops.js";
import { createProjectAsset } from "./project-assets.js";
import { markActionAssetBindingAuthority } from "./action-asset-bindings.js";
import {
  attachTimelineToCanvas,
  createProjectTimeline,
  ensureProjectCanvas,
  updateProjectTimelineState,
  copyTimelineActionToCanvas,
} from "./project-workspace.js";

const state = (...assets: string[]) => ({
  tracks: [
    {
      id: "media",
      items: assets.map((assetId, index) => ({
        id: `clip-${index}`,
        type: "video",
        assetId,
        from: index * 30,
        durationInFrames: 30,
      })),
    },
  ],
});
function fixture() {
  const doc = new LoroDoc();
  ensureProjectCanvas(doc);
  for (const id of ["a", "b"]) {
    expect(
      createProjectAsset(doc, {
        id,
        kind: "video",
        source: { kind: "owned", resourceId: `resource-${id}` },
        lifecycle: { state: "active" },
        metadata: { originalName: `${id}.mp4` },
      }).ok,
    ).toBe(true);
  }
  markActionAssetBindingAuthority(doc);
  expect(
    createProjectTimeline(doc, {
      id: "edit",
      name: "Edit",
      state: state("a", "a"),
    }).ok,
  ).toBe(true);
  return { doc, canvas: new Canvas(doc, () => {}) };
}
const inputs = (canvas: Canvas, target: string) =>
  canvas
    .listEdges()
    .filter((edge) => edge.target === target)
    .map((edge) => canvas.readNode(edge.source)?.data.assetId)
    .sort();

describe("Timeline media on Canvas", () => {
  it("places actual media when attaching a standalone Timeline and deduplicates repeated clips", () => {
    const { doc, canvas } = fixture();
    expect(canvas.listNodes()).toEqual([]);
    expect(
      attachTimelineToCanvas(doc, {
        timelineId: "edit",
        canvasId: "main",
        actionNodeId: "editor",
      }).ok,
    ).toBe(true);
    expect(inputs(canvas, "editor")).toEqual(["a"]);
    expect(
      canvas.readNode("editor")?.upstream.map((ref) => ref.nodeId),
    ).toEqual(canvas.listNodes("video").map((node) => node.id));
    expect(doc.getMap("edgeIdentity").size).toBe(0);
  });

  it("reuses same-Canvas placements, follows clip replacement/removal and keeps reusable media", () => {
    const { doc, canvas } = fixture();
    canvas.createNode("existing", "video", { assetId: "a" });
    attachTimelineToCanvas(doc, {
      timelineId: "edit",
      canvasId: "main",
      actionNodeId: "editor",
    });
    expect(canvas.listEdges().map((edge) => edge.source)).toEqual(["existing"]);
    expect(updateProjectTimelineState(doc, "edit", state("b")).ok).toBe(true);
    expect(inputs(canvas, "editor")).toEqual(["b"]);
    expect(canvas.readNode("existing")).not.toBeNull();
    expect(updateProjectTimelineState(doc, "edit", state()).ok).toBe(true);
    expect(inputs(canvas, "editor")).toEqual([]);
    expect(
      canvas
        .listNodes("video")
        .map((node) => node.data.assetId)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("projects protected references after reload without persisting independent graph edges", () => {
    const { doc } = fixture();
    attachTimelineToCanvas(doc, {
      timelineId: "edit",
      canvasId: "main",
      actionNodeId: "editor",
    });
    const reopened = new LoroDoc();
    reopened.import(doc.export({ mode: "snapshot" }));
    const canvas = new Canvas(reopened, () => {});
    const edge = canvas.listEdges()[0];
    expect(edge).toBeDefined();
    expect(() => canvas.deleteEdge(edge.id)).toThrow(/reference/i);
    expect(
      isCanvasNodeImmutable({ nodeId: edge.source, edges: canvas.listEdges() }),
    ).toBe(true);
    expect(inputs(canvas, "editor")).toEqual(["a"]);
  });

  it("creates target-Canvas placements on copy, with no cross-Canvas edges", () => {
    const { doc, canvas } = fixture();
    attachTimelineToCanvas(doc, {
      timelineId: "edit",
      canvasId: "main",
      actionNodeId: "editor",
    });
    ensureProjectCanvas(doc, "other", "Other");
    expect(
      copyTimelineActionToCanvas(doc, {
        sourceTimelineId: "edit",
        targetCanvasId: "other",
        newTimelineId: "copy",
        newActionNodeId: "copy-editor",
        position: { x: 0, y: 0 },
      }).ok,
    ).toBe(true);
    const other = new Canvas(doc, () => {}, "other");
    expect(inputs(other, "copy-editor")).toEqual(["a"]);
    expect(inputs(canvas, "editor")).toEqual(["a"]);
    expect(
      other
        .listEdges()
        .every(
          (edge) => other.readNode(edge.source) && other.readNode(edge.target),
        ),
    ).toBe(true);
  });
});
