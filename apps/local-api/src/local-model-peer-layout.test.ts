import { LoroDoc } from "loro-crdt";
import { Canvas, createProjectGenerator } from "@clash/shared-types";
import { expect, it } from "vitest";
import { assertLocalPeerModelProjectionMutation } from "./local-model-peer-guard.js";

it("admits display layout for a referenced Model without admitting node edits", () => {
  const current = new LoroDoc();
  expect(
    createProjectGenerator(current, {
      head: { id: "generator", headRevisionId: "revision" },
      revision: {
        id: "revision",
        generatorId: "generator",
        definitionRef: {
          pluginId: "clash.model-generation",
          definitionId: "image",
          version: "1.0.0",
          schemaHash: `sha256:${"a".repeat(64)}`,
        },
        state: { modelId: "model", prompt: "A lamp", params: {} },
        persistentInputRefs: [],
      },
    }),
  ).toMatchObject({ ok: true });
  current
    .getMap("nodes")
    .set("model", {
      type: "action-badge",
      canvasId: "main",
      position: { x: 0, y: 0 },
      data: { generatorId: "generator" },
    });
  const canvas = new Canvas(current, () => {});
  canvas.createNode("output", "image", {
    status: "completed",
    assetId: "asset",
  });
  canvas.insertEdge("result", "model", "output");
  const candidate = LoroDoc.fromSnapshot(current.export({ mode: "snapshot" }));
  try {
    new Canvas(candidate, () => {}).updateNodeLayout("model", {
      position: { x: 120, y: 240 },
    });
    expect(() =>
      assertLocalPeerModelProjectionMutation(current, candidate),
    ).not.toThrow();
    candidate
      .getMap("nodes")
      .set("model", {
        ...(candidate.getMap("nodes").get("model") as object),
        position: { x: 120, y: 240 },
      });
    expect(() =>
      assertLocalPeerModelProjectionMutation(current, candidate),
    ).toThrow(/IMMUTABLE_NODE/);
  } finally {
    current.free();
    candidate.free();
  }
});

it.each([
  { data: { assetId: "replacement" } },
  { position: { x: Infinity, y: 0 } },
  { parentId: "elsewhere" },
])("rejects an invalid layout record: %j", (layout) => {
  const current = new LoroDoc();
  const candidate = new LoroDoc();
  candidate
    .getMap("nodes")
    .set("node", { type: "image", data: { assetId: "original" } });
  try {
    candidate.getMap("canvasNodeLayouts").set("node", layout);
    expect(() =>
      assertLocalPeerModelProjectionMutation(current, candidate),
    ).toThrow();
  } finally {
    current.free();
    candidate.free();
  }
});
