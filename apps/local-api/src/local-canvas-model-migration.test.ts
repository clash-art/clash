import { readFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { Canvas, MODEL_CARDS, createProjectAsset, createProjectDocumentAsset, advanceProjectDocumentAssetHead, modelPromptParts, generatorDefinitionFromExecutablePluginRegistration, readGeneratorRevision, readProjectGenerator } from "@clash/shared-types";
import { resolveModelGenerationReferences } from "./local-model-generation.js";
import { migrateLegacyCanvasGeneratorDrafts } from "./local-canvas-generator-migration.js";

const definition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}`,
  document: JSON.parse(readFileSync(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")),
});
it("migrates a text Model draft while preserving its historical output and local ACP card", () => {
  const textDefinition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"b".repeat(64)}`,
    document: JSON.parse(readFileSync(new URL("../../../plugins/model-generation/generators/text.json", import.meta.url), "utf8")),
  });
  const doc = new LoroDoc();
  try {
    const canvas = new Canvas(doc, () => {});
    const card = MODEL_CARDS.find((candidate) => candidate.kind === "text")!;
    canvas.createNode("writer", "action-badge", { actionType: "text-gen", modelId: card.id, content: "Write a script", modelParams: card.defaultParams });
    canvas.createNode("old-output", "text", { status: "completed", content: "Historical text" });
    canvas.insertEdge("result", "writer", "old-output");
    canvas.createNode("agent", "action-badge", { actionType: "text-gen", modelId: "local-acp", content: "Agent task" });
    const output = canvas.readNode("old-output");
    const agent = canvas.readNode("agent");
    expect(migrateLegacyCanvasGeneratorDrafts(doc, [textDefinition], MODEL_CARDS)).toEqual({ ok: true, migratedNodeIds: ["writer"] });
    const projected = canvas.readNode("writer")!;
    expect(projected.data).toMatchObject({ actionType: "text-gen", modelId: card.id, content: "Write a script", generatorId: expect.any(String) });
    expect((doc.getMap("nodes").get("writer") as any).data).not.toHaveProperty("content");
    expect(canvas.readNode("old-output")).toEqual(output);
    expect(canvas.readNode("agent")).toEqual(agent);
  } finally { doc.free(); }
});
function fixture() {
  const doc = new LoroDoc();
  const canvas = new Canvas(doc, () => {});
  for (const id of ["first", "last"]) {
    expect(createProjectAsset(doc, { id, kind: "image", source: { kind: "owned", resourceId: id }, lifecycle: { state: "active" }, metadata: { contentType: "image/png" } }).ok).toBe(true);
    canvas.createNode(id, "image", { assetId: id });
  }
  canvas.createNode("draft", "action-badge", { actionType: "video-gen", modelId: "minimax-h3-startend", content: "", modelParams: { resolution: "768P", provider_id: "private-account" }, referenceImageOrder: ["last", "first"], label: "Scene" });
  canvas.insertEdge("first-draft", "first", "draft");
  canvas.insertEdge("last-draft", "last", "draft");
  return { doc, canvas };
}
it("migrates incomplete drafts atomically, preserving placement, frame order and downstream facts", () => {
  const { doc, canvas } = fixture();
  canvas.createNode("output", "video", { status: "completed", label: "Historical output" });
  canvas.insertEdge("draft-output", "draft", "output");
  const original = doc.getMap("nodes").get("draft") as Record<string, unknown>;
  const edges = canvas.listEdges();
  const output = canvas.readNode("output");
  const result = migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, migratedNodeIds: ["draft"] });
  const raw = doc.getMap("nodes").get("draft") as { data: Record<string, unknown> };
  expect(raw).toMatchObject({ ...original, data: { generatorId: expect.any(String), label: "Scene" } });
  expect(raw.data).not.toHaveProperty("content");
  expect(raw.data).not.toHaveProperty("modelParams");
  const generator = readProjectGenerator(doc, raw.data.generatorId as string)!;
  const revision = readGeneratorRevision(doc, { generatorId: generator.id, generatorRevisionId: generator.headRevisionId })!;
  expect(revision.state).toMatchObject({ modelId: "minimax-h3-startend", prompt: "", params: { resolution: "768P" } });
  expect(revision.state.params).not.toHaveProperty("provider_id");
  expect(Object.fromEntries(revision.persistentInputRefs.map((ref) => [ref.slot, ref.target]))).toEqual({
    startFrame: { kind: "media", projectAssetId: "last" },
    endFrame: { kind: "media", projectAssetId: "first" },
  });
  expect(canvas.listEdges()).toEqual(edges);
  expect(canvas.readNode("output")).toEqual(output);
  const migrated = doc.toJSON();
  expect(migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS)).toEqual({ ok: true, migratedNodeIds: [] });
  expect(doc.toJSON()).toEqual(migrated);
});
it("rolls back the whole migration if another draft names missing media", () => {
  const { doc, canvas } = fixture();
  canvas.createNode("broken", "action-badge", { actionType: "video-gen", modelId: "minimax-h3", content: "A scene", referenceImageAssetIds: ["missing"] });
  const before = doc.toJSON();
  expect(migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS)).toMatchObject({ ok: false, error: { nodeId: "broken" } });
  expect(doc.toJSON()).toEqual(before);
});

it("freezes mixed media placement and attached text in the same native revision", () => {
  const { doc, canvas } = fixture();
  canvas.updateNode("draft", { modelId: "minimax-h3", content: "Look @[first](node:first)" });
  canvas.createNode("brief", "text", { content: "Warm sunlight" });
  canvas.insertEdge("brief-draft", "brief", "draft");
  const migrated = migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS);
  expect(migrated, JSON.stringify(migrated)).toMatchObject({ ok: true });
  const data = canvas.readNode("draft")!.data;
  const revision = readGeneratorRevision(doc, { generatorId: data.generatorId as string, generatorRevisionId: data.generatorRevisionId as string })!;
  expect(revision.state.prompt).toBe("Look first\n\nWarm sunlight");
  const resolved = resolveModelGenerationReferences({ doc, revisionId: revision.id, inputRefs: revision.persistentInputRefs, prompt: revision.state.prompt as string, contentParts: revision.state.contentParts });
  expect(resolved.map((ref) => "text" in ref ? ref.text.value : "asset" in ref ? ref.asset.assetId : null)).toEqual(["Look ", "first", "\n\nWarm sunlight", "last"]);
  canvas.updateNode("brief", { content: "Changed after migration" });
  expect(readGeneratorRevision(doc, { generatorId: revision.generatorId, generatorRevisionId: revision.id })?.state).toEqual(revision.state);
});

it("migrates separate music Prompt and Lyrics without flattening either field", () => {
  const { doc, canvas } = fixture();
  const audioDefinition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"b".repeat(64)}`,
    document: JSON.parse(readFileSync(new URL("../../../plugins/model-generation/generators/audio.json", import.meta.url), "utf8")),
  });
  canvas.createNode("song", "action-badge", { actionType: "audio-gen", modelId: "minimax-music-3", content: "Gentle piano", lyrics: "Morning light", modelParams: {} });
  expect(migrateLegacyCanvasGeneratorDrafts(doc, [definition, audioDefinition], MODEL_CARDS)).toMatchObject({ ok: true, migratedNodeIds: ["draft", "song"] });
  const data = canvas.readNode("song")!.data;
  const revision = readGeneratorRevision(doc, { generatorId: data.generatorId as string, generatorRevisionId: data.generatorRevisionId as string })!;
  expect(revision.state).toMatchObject({ prompt: "Gentle piano", lyrics: "Morning light", params: {} });
  expect(revision.state.params).not.toHaveProperty("lyrics");
  expect(data).toMatchObject({ content: "Gentle piano", lyrics: "Morning light" });
  expect((doc.getMap("nodes").get("song") as { data: object }).data).not.toHaveProperty("lyrics");
});


it("captures mentioned authored text once when the same source also has an edge", () => {
  const doc = new LoroDoc();
  try {
    const canvas = new Canvas(doc, () => {});
    canvas.createNode("brief", "text", { content: "Warm sunlight" });
    canvas.createNode("draft", "action-badge", { actionType: "video-gen", modelId: "minimax-h3", content: "Animate @[brief](node:brief)" });
    canvas.insertEdge("brief-draft", "brief", "draft");
    const result = migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const data = canvas.readNode("draft")!.data;
    const revision = readGeneratorRevision(doc, { generatorId: data.generatorId as string, generatorRevisionId: data.generatorRevisionId as string })!;
    expect(revision.state.prompt).toBe("Animate Warm sunlight");
    expect(revision.persistentInputRefs).toEqual([]);
    canvas.updateNode("brief", { content: "Changed after migration" });
    expect(readGeneratorRevision(doc, { generatorId: revision.generatorId, generatorRevisionId: revision.id })?.state).toEqual(revision.state);
  } finally { doc.free(); }
});

it.each(["edge", "mention", "both", "missing"] as const)("migrates exact Document inputs without reading a Canvas shadow (%s)", (entry) => {
  const doc = new LoroDoc();
  try {
    const asset = { kind: "document" as const, documentAssetId: "script", revisionId: "saved" };
    const saved = { id: asset.revisionId, documentAssetId: asset.documentAssetId, documentKind: "text.plain", schemaVersion: 1, mutability: "versioned" as const,
      body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" }, producer: { kind: "actor" as const, actor: { kind: "user" as const } }, sourceRefs: [] };
    expect(createProjectDocumentAsset(doc, saved).ok).toBe(true);
    expect(advanceProjectDocumentAssetHead(doc, { documentAssetId: asset.documentAssetId, expectedHeadRevisionId: asset.revisionId, revision: { ...saved, id: "later", parentRevisionId: asset.revisionId, body: { ...saved.body, digest: `sha256:${"b".repeat(64)}` } } }).ok).toBe(true);
    const canvas = new Canvas(doc, () => {});
    canvas.createNode("script", "text", { documentRevision: entry === "missing" ? { ...asset, revisionId: "missing" } : asset, content: "Stale Canvas shadow", label: "Script" });
    canvas.createNode("draft", "action-badge", { actionType: "video-gen", modelId: "minimax-h3", content: entry === "edge" || entry === "missing" ? "Animate the source" : "Animate @[script](node:script)", modelParams: { resolution: "768P" } });
    if (entry !== "mention") canvas.insertEdge("script-draft", "script", "draft");
    canvas.createNode("historical", "video", { status: "completed", label: "Previous result" });
    canvas.insertEdge("old-result", "draft", "historical");
    const before = doc.toJSON();
    const originalSource = canvas.readNode("script");
    const output = canvas.readNode("historical");
    const edges = canvas.listEdges();
    const result = migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS);
    if (entry === "missing") {
      expect(result).toMatchObject({ ok: false, error: { nodeId: "draft" } });
      expect(doc.toJSON()).toEqual(before);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const data = canvas.readNode("draft")!.data;
    const revision = readGeneratorRevision(doc, { generatorId: data.generatorId as string, generatorRevisionId: data.generatorRevisionId as string })!;
    expect(revision.persistentInputRefs.map(ref => ref.target)).toEqual([asset]);
    expect(JSON.stringify(revision.state)).not.toContain("Stale Canvas shadow");
    expect(modelPromptParts(revision.state).filter(part => part.type === "input")).toEqual([expect.objectContaining({ slot: "text", itemKey: revision.persistentInputRefs[0]!.itemKey })]);
    expect(canvas.readNode("script")).toEqual(originalSource);
    expect(canvas.readNode("historical")).toEqual(output);
    expect(canvas.listEdges()).toEqual(edges);
    const migrated = doc.toJSON();
    expect(migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS)).toMatchObject({ ok: true, migratedNodeIds: [] });
    expect(doc.toJSON()).toEqual(migrated);
  } finally { doc.free(); }
});
