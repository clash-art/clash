import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { Canvas } from "./canvas-ops.js";
import { createProjectAsset } from "./project-assets.js";
import {
  createProjectGenerator,
  ensureActionRunRequest,
  ensureOutputCommit,
  commitActionRunOutcome,
} from "./project-generators.js";
import { resolveOutputCommitAssetType } from "./project-output-assets.js";

function fixture() {
  const doc = new LoroDoc();
  const definitionRef = {
    pluginId: "clash.model-generation",
    definitionId: "image",
    version: "1.0.0",
    schemaHash: `sha256:${"a".repeat(64)}`,
  };
  const asset = (id: string) => ({
    id,
    kind: "image" as const,
    source: { kind: "owned" as const, resourceId: `resource:${id}` },
    lifecycle: { state: "active" as const },
    metadata: { contentType: "image/png", width: 1024, height: 512 },
  });
  expect(createProjectAsset(doc, asset("reference"))).toMatchObject({
    ok: true,
  });
  expect(
    createProjectGenerator(doc, {
      head: { id: "generator", headRevisionId: "revision" },
      revision: {
        id: "revision",
        generatorId: "generator",
        definitionRef,
        state: { modelId: "model", prompt: "A lamp", params: {} },
        persistentInputRefs: [
          {
            slot: "image",
            target: { kind: "media", projectAssetId: "reference" },
          },
        ],
      },
    }),
  ).toMatchObject({ ok: true });
  const run = {
    actionRunId: "run",
    generatorRevision: {
      generatorId: "generator",
      generatorRevisionId: "revision",
    },
    actionId: "generate",
    executor: { ...definitionRef, exportId: "generate" },
    invocationFingerprint: `sha256:${"b".repeat(64)}`,
    parameters: {},
    invocationInputRefs: [],
    outputContract: [
      {
        slot: "image",
        assetType: { kind: "media" as const, mediaKind: "image" as const },
        cardinality: { minItems: 1, maxItems: 1 },
      },
    ],
  };
  // Executor references identify a Plugin export, not a Generator definition.
  const { definitionId: _, ...executor } = run.executor;
  expect(ensureActionRunRequest(doc, { ...run, executor })).toMatchObject({
    ok: true,
  });
  return { doc, canvas: new Canvas(doc, () => {}), asset };
}

describe("Generator Run Canvas projection", () => {
  it("resolves inputs by Asset identity instead of a coincidentally matching Canvas node id", () => {
    const { canvas } = fixture();
    canvas.createNode("reference", "text", { text: "An unrelated note" });
    canvas.placeGeneratorRun("run", { canvasId: "main", nodeId: "placement" });
    const input = canvas
      .listNodes()
      .find(
        (node) => node.type === "image" && node.data.assetId === "reference",
      )!;
    expect(input).toBeDefined();
    expect(canvas.listEdges()).toContainEqual(
      expect.objectContaining({ source: input.id, target: "placement" }),
    );
    expect(canvas.listEdges().some((edge) => edge.source === "reference")).toBe(
      false,
    );
    expect(canvas.readNode("reference")?.data.text).toBe("An unrelated note");
  });

  it("places the referenced input, generator and pending output with both edges; replay preserves layout", () => {
    const { canvas } = fixture();
    canvas.placeGeneratorRun("run", {
      canvasId: "main",
      nodeId: "placement",
      label: "Lamp",
    });
    const output = canvas
      .listNodes()
      .find((node) => node.data.generatorOutputSlot === "image")!;
    const input = canvas.findNode("reference")!;
    expect(input.width! / input.height!).toBe(1024 / 512);
    expect(output.data).toMatchObject({
      status: "generating",
      actionRunId: "run",
    });
    expect(output.data.assetId).toBeUndefined();
    expect(canvas.listEdges()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: input.id, target: "placement" }),
        expect.objectContaining({ source: "placement", target: output.id }),
      ]),
    );
    const before = canvas.listNodes();
    canvas.placeGeneratorRun("run", {
      canvasId: "main",
      nodeId: "placement",
      label: "Ignored replay label",
    });
    expect(canvas.listNodes()).toEqual(before);
  });

  it("resolves the pending placement to its committed asset and preserves the winner on replay", () => {
    const { doc, canvas, asset } = fixture();
    canvas.placeGeneratorRun("run", { canvasId: "main", nodeId: "placement" });
    const output = canvas
      .listNodes()
      .find((node) => node.data.generatorOutputSlot === "image")!;
    expect(createProjectAsset(doc, asset("result"))).toMatchObject({
      ok: true,
    });
    expect(
      ensureOutputCommit(
        doc,
        {
          actionRunId: "run",
          outputSlot: "image",
          asset: { kind: "media", projectAssetId: "result" },
        },
        resolveOutputCommitAssetType,
      ),
    ).toMatchObject({ ok: true });
    canvas.refreshGeneratorRun("run");
    expect(canvas.readNode(output.id)?.data).toMatchObject({
      status: "completed",
      assetId: "result",
    });
    const resolved = canvas.readNode(output.id)!;
    expect(resolved.width! / resolved.height!).toBe(1024 / 512);
    expect(canvas.refreshGeneratorRun("run")).toBe(false);
  });

  it("shows a failed run in its pending placement without inventing an asset", () => {
    const { doc, canvas } = fixture();
    canvas.placeGeneratorRun("run", { canvasId: "main", nodeId: "placement" });
    expect(
      commitActionRunOutcome(doc, { actionRunId: "run", status: "failed" }),
    ).toMatchObject({ ok: true });
    canvas.refreshGeneratorRun("run");
    const output = canvas
      .listNodes()
      .find((node) => node.data.generatorOutputSlot === "image")!;
    expect(output.data.status).toBe("failed");
    expect(output.data.assetId).toBeUndefined();
  });
});
