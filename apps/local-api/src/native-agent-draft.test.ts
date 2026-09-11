import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { Canvas, createProjectDocumentAsset, MODEL_CARDS, CustomActionDefinitionSchema, ExecutablePluginCardRegistrationSchema, generatorDefinitionFromExecutablePluginRegistration, readGeneratorRevision, readProjectGenerator } from "@clash/shared-types";
import { createLocalGeneratorProductService } from "./local-generator-product.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { mutateLocalCanvasGeneratorEdges } from "./local-canvas-generator-edges.js";
import { migrateLegacyCanvasGeneratorDrafts } from "./local-canvas-generator-migration.js";

function fixture() {
  const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../plugins/agent-text/${path}`, import.meta.url), "utf8"));
  const manifest = read("manifest.json");
  const provenance = { pluginId: manifest.id, version: manifest.version, schemaHash: `sha256:${"a".repeat(64)}` };
  const definition = generatorDefinitionFromExecutablePluginRegistration({ ...provenance, document: read("generators/text.json") });
  const cardContribution = manifest.contributes.cards?.find((entry: { kind: string }) => entry.kind === "action-card");
  expect(cardContribution, "Agent Text needs a real Canvas authoring entry point").toBeDefined();
  const registration = ExecutablePluginCardRegistrationSchema.parse({ ...provenance, runtime: manifest.runtime, document: read(cardContribution.path) });
  if (registration.document.kind !== "action-card") throw new Error("Expected Action Card");
  const card = registration.document.spec;
  const custom = CustomActionDefinitionSchema.parse({ ...card, pluginBinding: { ...provenance, exportId: card.functionExportId } });
  return { definition, registration, card, custom };
}

it("creates and edits an empty native Agent draft, then pins the selected harness settings for execution", async () => {
  const { definition, registration, card, custom } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "clash-agent-draft-"));
  const doc = new LoroDoc();
  try {
    const service = createLocalGeneratorProductService({ authority: { inspect: async (_id, read) => read(doc), mutate: async (_id, write) => write(doc, async () => {}) },
      resolveDefinition: async () => definition, listPluginCards: async () => [registration], ownerId: "host", journal: createSqliteDurableRunJournal(directory), actor: { kind: "user" } });
    await service.create("project", { generatorId: "agent-draft", generatorRevisionId: "initial", pluginId: definition.pluginId, definitionId: definition.definitionId,
      state: { prompt: "", agentId: "", modelId: "", systemPrompt: "" }, persistentInputRefs: [], placement: { canvasId: "main", nodeId: "card", actionCardId: card.id } });
    const edited = await service.advance("project", "agent-draft", { expectedHeadRevisionId: "initial", generatorRevisionId: "edited",
      state: { prompt: "Write a scene", agentId: "chosen-harness", modelId: "chosen-agent-model", systemPrompt: "Keep the exact line breaks.\nBe concise." }, persistentInputRefs: [] });
    const canvas = new Canvas(doc, () => {});
    expect(canvas.readNode("card")?.data.customActionParams).toEqual({ agentId: "chosen-harness", modelId: "chosen-agent-model", systemPrompt: "Keep the exact line breaks.\nBe concise." });
    const executed = canvas.executeGeneration("card", () => "output", undefined, custom);
    expect(executed.error).toBeNull();
    expect(canvas.readNode("output")?.data).toMatchObject({ generatorRevision: { generatorId: edited.generator.id, generatorRevisionId: edited.revision.id }, generatorActionId: card.generator!.actionId });
    expect((doc.getMap("nodes").get("card") as any).data).not.toHaveProperty("modelId");
    expect(edited.revision.definitionRef.pluginId).toBe(definition.pluginId);
  } finally { doc.free(); await rm(directory, { recursive: true, force: true }); }
});

it.each([false, true])("migrates legacy local-acp text inputs without changing historical output (Document=%s)", (applied) => {
  const { definition, registration, card } = fixture();
  const doc = new LoroDoc();
  try {
    const canvas = new Canvas(doc, () => {});
    const asset = { kind: "document" as const, documentAssetId: "brief", revisionId: "saved" };
    if (applied) expect(createProjectDocumentAsset(doc, { id: asset.revisionId, documentAssetId: asset.documentAssetId, documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
      body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" }, producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [] }).ok).toBe(true);
    canvas.createNode("brief", "text", { content: "Warm light", ...(applied ? { documentRevision: asset } : {}) });
    canvas.createNode("agent", "action-badge", { actionType: "text-gen", modelId: "local-acp", actorAgentId: "chosen-harness", content: "Write a scene",
      modelParams: { acp_model: "chosen-agent-model", system_prompt: "Be concise." } });
    canvas.insertEdge("brief-agent", "brief", "agent");
    canvas.createNode("historical", "text", { content: "The old scene", status: "completed" });
    canvas.insertEdge("old-output", "agent", "historical");
    const historical = canvas.readNode("historical");
    const edges = canvas.listEdges();
    expect(migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS, [registration])).toMatchObject({ ok: true, migratedNodeIds: ["agent"] });
    const projected = canvas.readNode("agent")!.data;
    expect(projected.actionCardId).toBe(card.id);
    const revision = readGeneratorRevision(doc, { generatorId: projected.generatorId as string, generatorRevisionId: projected.generatorRevisionId as string })!;
    expect(revision.state).toEqual({ prompt: applied ? "Write a scene" : "Write a scene\n\nWarm light", agentId: "chosen-harness", modelId: "chosen-agent-model", systemPrompt: "Be concise." });
    expect(revision.persistentInputRefs.map(ref => ref.target)).toEqual(applied ? [asset] : []);
    expect(canvas.readNode("historical")).toEqual(historical);
    expect(canvas.listEdges()).toEqual(edges);
  } finally { doc.free(); }
});


it("copies connected Agent Documents and removes only the copy input through the Host graph compiler", async () => {
  const { definition, registration, card } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "clash-agent-document-graph-"));
  const doc = new LoroDoc();
  try {
    const service = createLocalGeneratorProductService({ authority: { inspect: async (_id, read) => read(doc), mutate: async (_id, write) => write(doc, async () => {}) },
      resolveDefinition: async () => definition, listPluginCards: async () => [registration], ownerId: "host", journal: createSqliteDurableRunJournal(directory), actor: { kind: "user" } });
    const state = { prompt: "Read the source", modelId: "flux-3-video-keyframes", systemPrompt: "Keep the meaning." };
    await service.create("project", { generatorId: "agent", generatorRevisionId: "initial", pluginId: definition.pluginId, definitionId: definition.definitionId, state, persistentInputRefs: [], placement: { canvasId: "main", nodeId: "card", actionCardId: card.id } });
    const asset = { kind: "document" as const, documentAssetId: "brief", revisionId: "saved" };
    expect(createProjectDocumentAsset(doc, { id: asset.revisionId, documentAssetId: asset.documentAssetId, documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
      body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" }, producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [] }).ok).toBe(true);
    const canvas = new Canvas(doc, () => {});
    canvas.createNode("brief", "text", { documentRevision: asset });
    const revision = (id: string) => readGeneratorRevision(doc, { generatorId: id, generatorRevisionId: readProjectGenerator(doc, id)!.headRevisionId })!;
    await mutateLocalCanvasGeneratorEdges({ doc, endpoints: [{ source: "brief", target: "card" }], resolveDefinition: async () => definition, listActionCards: async () => [registration],
      mutate: draft => { new Canvas(draft, () => {}).insertEdge("brief-card", "brief", "card"); } });
    const connected = revision("agent");
    expect(connected.state).toEqual(state);
    expect(connected.persistentInputRefs.map(ref => ref.target)).toEqual([asset]);
    await service.create("project", { generatorId: "copy", generatorRevisionId: "copy:r1", pluginId: definition.pluginId, definitionId: definition.definitionId, state, persistentInputRefs: connected.persistentInputRefs,
      forkedFrom: { generatorId: "agent", generatorRevisionId: connected.id }, placement: { canvasId: "main", nodeId: "copy", sourceNodeId: "card", actionCardId: card.id } });
    const copiedEdge = canvas.listEdges().find(edge => edge.source === "brief" && edge.target === "copy");
    expect(copiedEdge).toBeDefined();
    await mutateLocalCanvasGeneratorEdges({ doc, endpoints: [{ source: "brief", target: "copy" }], resolveDefinition: async () => definition, listActionCards: async () => [registration],
      mutate: draft => { new Canvas(draft, () => {}).deleteEdge(copiedEdge!.id); } });
    expect(revision("copy").persistentInputRefs).toEqual([]);
    expect(revision("copy").state).toEqual(state);
    expect(revision("agent")).toEqual(connected);
    expect(canvas.listEdges()).toContainEqual(expect.objectContaining({ id: "brief-card" }));
  } finally { doc.free(); await rm(directory, { recursive: true, force: true }); }
});
