import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { Canvas } from "./canvas-ops.js";
import {
  listPluginViewAssetReferences,
  type StoryboardViewState,
} from "./executable-plugin.js";
import { isCanvasNodeImmutable } from "./canvas-update-guardrails.js";
import { isViewAssetReferenceEdge } from "./canvas-view-references.js";
import { reconcileCanvasGraph } from "./node-upstreams.js";
import { ensureProjectCanvas } from "./project-workspace.js";

function resource(assetId: string) {
  return {
    id: `candidate:${assetId}`,
    projectAssetId: assetId,
    mediaKind: "image" as const,
  };
}
function fixture() {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => {});
  const state: StoryboardViewState = {
    keyElements: [
      {
        id: "lamp",
        description: [],
        materials: [
          {
            id: "images",
            mediaKind: "image",
            candidates: [resource("lamp-a"), resource("lamp-b")],
            selectedCandidateId: "candidate:lamp-b",
          },
        ],
      },
    ],
    shots: [],
    audioLayers: [],
    uncategorized: [resource("loose")],
  };
  canvas.createNode("view", "plugin-view", { state });
  canvas.createNode("a", "image", { assetId: "lamp-a" });
  canvas.createNode("b", "image", { assetId: "lamp-b" });
  canvas.createNode("loose", "image", { assetId: "loose" });
  canvas.createNode("unrelated", "image", { assetId: "other" });
  doc.commit();
  return { doc, canvas, state };
}
const pairs = (canvas: Canvas) =>
  canvas
    .listEdges()
    .map(({ source, target }) => [source, target])
    .sort();

describe("Storyboard Asset references on Canvas", () => {
  it("uses the protocol references independently of selection, order, prompts and pending runs", () => {
    const { canvas, state } = fixture();
    const material = state.keyElements[0].materials[0];
    material.pendingOutputs = [
      {
        generatorId: "g",
        generatorRevisionId: "r",
        actionRunId: "pending",
        outputSlot: "image",
        mediaKind: "image",
      },
    ];
    material.promptDraft = { id: "prompt", text: "other" };
    state.keyElements[0].description = [
      { type: "entity-reference", entityId: "other" },
    ];
    state.shots = [
      {
        id: "shot",
        description: [],
        materials: [
          {
            id: "shot-image",
            mediaKind: "image",
            candidates: [resource("lamp-a")],
          },
        ],
      },
    ];
    state.audioLayers = [
      {
        id: "sound",
        description: [],
        materials: [
          {
            id: "audio",
            mediaKind: "audio",
            candidates: [
              { id: "sound-ref", projectAssetId: "sound", mediaKind: "audio" },
            ],
          },
        ],
      },
    ];
    canvas.createNode("sound", "audio", { assetId: "sound" });
    canvas.updateNode("view", { state });
    const refs = listPluginViewAssetReferences(state);
    expect(
      new Set(
        canvas
          .listEdges()
          .map((edge) => canvas.readNode(edge.source)?.data.assetId),
      ),
    ).toEqual(new Set(refs.map((ref) => ref.resource.projectAssetId)));
    expect(
      refs
        .filter((ref) => ref.resource.projectAssetId === "lamp-a")
        .map((ref) => ref.location),
    ).toEqual([
      {
        section: "keyElements",
        itemId: state.keyElements[0].id,
        materialId: material.id,
        resourceId: material.candidates[0].id,
      },
      {
        section: "shots",
        itemId: state.shots[0].id,
        materialId: state.shots[0].materials[0].id,
        resourceId: state.shots[0].materials[0].candidates[0].id,
      },
    ]);
    const before = canvas.listEdges();
    material.selectedCandidateId = material.candidates[0].id;
    material.candidates.reverse();
    state.keyElements[0].label = "Renamed";
    canvas.updateNode("view", { state });
    expect(canvas.listEdges()).toEqual(before);
    expect(listPluginViewAssetReferences(state)).toEqual(
      expect.arrayContaining(refs),
    );
    expect(
      refs.some((ref) =>
        ["pending", "other"].includes(ref.resource.projectAssetId),
      ),
    ).toBe(false);
  });

  it("rejects invalid View state before replacing references or creating any node", () => {
    const { doc, canvas, state } = fixture();
    const before = doc.toJSON();
    const malformed = {
      ...state,
      uncategorized: [{ id: "missing-asset", mediaKind: "image" }],
    };
    expect(() => canvas.updateNode("view", { state: malformed })).toThrow();
    expect(doc.toJSON()).toEqual(before);
    expect(
      canvas.createNode("invalid", "plugin-view", { state: malformed }).error,
    ).toBeTruthy();
    expect(doc.toJSON()).toEqual(before);
    expect(pairs(canvas)).toEqual([
      ["a", "view"],
      ["b", "view"],
      ["loose", "view"],
    ]);
  });

  it("reads every existing candidate and loose Asset reference without rewriting the project", () => {
    const { doc, canvas } = fixture();
    const before = doc.toJSON();
    expect(pairs(canvas)).toEqual([
      ["a", "view"],
      ["b", "view"],
      ["loose", "view"],
    ]);
    expect(
      canvas
        .readNode("view")
        ?.upstream.map((ref) => ref.nodeId)
        .sort(),
    ).toEqual(["a", "b", "loose"]);
    expect(
      isCanvasNodeImmutable({ nodeId: "a", edges: canvas.listEdges() }),
    ).toBe(true);
    expect(doc.toJSON()).toEqual(before);
    const reopened = new LoroDoc();
    reopened.import(doc.export({ mode: "snapshot" }));
    reconcileCanvasGraph(reopened);
    expect(pairs(new Canvas(reopened, () => {}))).toEqual(pairs(canvas));
  });

  it("follows add/remove, deduplicates repeated uses and resolves only actual same-Canvas placements", () => {
    const { doc, canvas, state } = fixture();
    state.keyElements[0].materials[0].candidates = [
      resource("lamp-b"),
      resource("unplaced"),
    ];
    state.keyElements[0].materials[0].selectedCandidateId = "candidate:lamp-b";
    state.uncategorized = [resource("lamp-b"), resource("cross-canvas")];
    ensureProjectCanvas(doc, "elsewhere");
    const remote = new Canvas(doc, () => {}, "elsewhere").createNode(
      "remote",
      "image",
      {
        assetId: "cross-canvas",
      },
    );
    expect(remote.node_id).toBe("remote");
    canvas.updateNode("view", { state });
    expect(pairs(canvas)).toEqual([["b", "view"]]);
    canvas.createNode("later", "image", { assetId: "unplaced" });
    expect(pairs(canvas)).toEqual([
      ["b", "view"],
      ["later", "view"],
    ]);
    canvas.deleteNode("view");
    expect(pairs(canvas)).toEqual([]);
  });

  it("keeps generation edges, never persists projections and refuses an edge-only detach", () => {
    const { doc, canvas } = fixture();
    canvas.createNode("generator", "action-badge", {});
    canvas.insertEdge("generation", "generator", "a");
    const edge = canvas
      .listEdges()
      .find((edge) => edge.source === "a" && edge.target === "view")!;
    expect(isViewAssetReferenceEdge(edge.id)).toBe(true);
    expect(() => canvas.deleteEdge(edge.id)).toThrow(/View.*reference/);
    expect(() => canvas.updateEdge(edge.id, { source: "unrelated" })).toThrow(
      /View.*reference/,
    );
    expect(() => canvas.insertEdge(edge.id, "unrelated", "view")).toThrow(
      /View.*reference/,
    );
    expect(doc.getMap("edgeIdentity").get(edge.id)).toBeUndefined();
    expect(canvas.listEdges()).toContainEqual(
      expect.objectContaining({
        id: "generation",
        source: "generator",
        target: "a",
      }),
    );
    expect(canvas.listEdges()).toContainEqual(edge);
  });

  it("does not duplicate an existing explicit connection or let its removal hide the Asset reference", () => {
    const { canvas } = fixture();
    canvas.insertEdge("explicit", "a", "view", "reference");
    expect(canvas.listEdges().filter((edge) => edge.source === "a")).toEqual([
      expect.objectContaining({ id: "explicit", source: "a", target: "view" }),
    ]);
    canvas.deleteEdge("explicit");
    expect(canvas.listEdges().filter((edge) => edge.source === "a")).toEqual([
      expect.objectContaining({
        source: "a",
        target: "view",
        type: "reference",
      }),
    ]);
  });
});
