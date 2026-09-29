import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LoroDoc } from "loro-crdt";
import { afterEach, expect, it } from "vitest";
import {
  Canvas,
  createProjectAsset,
  createProjectGenerator,
  ensureActionRunRequest,
  type DocumentAssetRevision,
} from "@clash/shared-types";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalGeneratorRunBridge } from "./local-generator-run-bridge.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "clash-document-placement-"));
  directories.push(directory);
  const doc = new LoroDoc();
  const definitionRef = {
    pluginId: "clash.media-analysis",
    definitionId: "media-analysis",
    version: "1.0.0",
    schemaHash: `sha256:${"a".repeat(64)}` as const,
  };
  expect(
    createProjectAsset(doc, {
      id: "source",
      kind: "image",
      source: { kind: "owned", resourceId: "resource" },
      lifecycle: { state: "active" },
      metadata: {},
    }).ok,
  ).toBe(true);
  expect(
    createProjectGenerator(doc, {
      head: { id: "analysis", headRevisionId: "analysis:r1" },
      revision: {
        id: "analysis:r1",
        generatorId: "analysis",
        definitionRef,
        state: {},
        persistentInputRefs: [],
      },
    }).ok,
  ).toBe(true);
  const outputs = ["description", "tags"].map((slot) => ({
    slot,
    assetType: {
      kind: "document" as const,
      documentKind: `media.analysis.${slot}`,
      schemaVersion: 1,
    },
    cardinality: { minItems: 1, maxItems: 1 },
  }));
  const { definitionId: _, ...executor } = definitionRef;
  expect(
    ensureActionRunRequest(doc, {
      actionRunId: "run",
      generatorRevision: {
        generatorId: "analysis",
        generatorRevisionId: "analysis:r1",
      },
      actionId: "analyze",
      executor: { ...executor, exportId: "analyze" },
      invocationFingerprint: `sha256:${"b".repeat(64)}`,
      parameters: { categories: ["description", "tags"] },
      invocationInputRefs: [
        { slot: "source", target: { kind: "media", projectAssetId: "source" } },
      ],
      outputContract: outputs,
    }).ok,
  ).toBe(true);
  const canvas = new Canvas(doc, () => {});
  const bridge = createLocalGeneratorRunBridge({
    ownerId: "local",
    journal: createSqliteDurableRunJournal(directory),
  });
  const revision = (slot: string): DocumentAssetRevision => ({
    id: `${slot}:r1`,
    documentAssetId: slot,
    documentKind: `media.analysis.${slot}`,
    schemaVersion: 1,
    mutability: "versioned",
    body: {
      digest: `sha256:${"c".repeat(64)}`,
      byteLength: 16,
      contentType: "application/json",
    },
    producer: { kind: "action-run", actionRunId: "run" },
    sourceRefs: [
      { slot: "source", target: { kind: "media", projectAssetId: "source" } },
    ],
  });
  return { doc, canvas, bridge, revision };
}

it("shows typed analysis outputs while pending and resolves each exact revision at publication", async () => {
  const { doc, canvas, bridge, revision } = await fixture();
  const placement = { canvasId: "main", nodeId: "analysis-operation" };
  canvas.placeGeneratorRun("run", placement);
  for (const slot of ["description", "tags"]) {
    const node = canvas
      .listNodes()
      .find((node) => node.data.generatorOutputSlot === slot)!;
    expect(node).toMatchObject({
      type: "text",
      data: {
        actionRunId: "run",
        status: "generating",
        documentKind: `media.analysis.${slot}`,
      },
    });
    expect(node.data.documentRevision).toBeUndefined();
  }
  const snapshots: unknown[] = [];
  await bridge.publishDocumentBatchSuccess({
    doc,
    actionRunId: "run",
    outputs: ["description", "tags"].map((slot) => ({
      outputSlot: slot,
      revision: revision(slot),
    })),
    checkpoint: async () => {
      snapshots.push(canvas.listNodes());
    },
  });
  for (const slot of ["description", "tags"]) {
    const node = canvas
      .listNodes()
      .find((node) => node.data.generatorOutputSlot === slot)!;
    expect(node.data).toMatchObject({
      status: "completed",
      documentRevision: {
        kind: "document",
        documentAssetId: slot,
        revisionId: `${slot}:r1`,
      },
    });
    expect(node.data).not.toHaveProperty("content");
    expect(snapshots).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: node.id,
          data: expect.objectContaining({ status: "completed" }),
        }),
      ]),
    );
  }
  const before = doc.toJSON();
  canvas.placeGeneratorRun("run", placement);
  expect(doc.toJSON()).toEqual(before);
});

it("keeps failed Document outputs attached to their operation without inventing revisions", async () => {
  const { doc, canvas, bridge } = await fixture();
  canvas.placeGeneratorRun("run", {
    canvasId: "main",
    nodeId: "analysis-operation",
  });
  await bridge.publishFailure({
    doc,
    actionRunId: "run",
    checkpoint: async () => undefined,
  });
  for (const node of canvas
    .listNodes()
    .filter((node) => node.data.generatorOutputSlot)) {
    expect(node.data.status).toBe("failed");
    expect(node.data.documentRevision).toBeUndefined();
  }
});

it("resolves an individually published Document while other declared outputs remain pending", async () => {
  const { doc, canvas, bridge, revision } = await fixture();
  canvas.placeGeneratorRun("run", {
    canvasId: "main",
    nodeId: "analysis-operation",
  });
  await bridge.publishDocumentSuccess({
    doc,
    actionRunId: "run",
    outputSlot: "description",
    revision: revision("description"),
    checkpoint: async () => undefined,
  });
  expect(
    canvas
      .listNodes()
      .find((node) => node.data.generatorOutputSlot === "description")?.data,
  ).toMatchObject({
    status: "completed",
    documentRevision: {
      kind: "document",
      documentAssetId: "description",
      revisionId: "description:r1",
    },
  });
  expect(
    canvas.listNodes().find((node) => node.data.generatorOutputSlot === "tags")
      ?.data,
  ).toMatchObject({ status: "generating" });
});
