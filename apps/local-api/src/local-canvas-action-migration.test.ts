import { readFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { Canvas, MODEL_CARDS, createProjectAsset, readGeneratorRevision, readProjectGenerator, generatorDefinitionFromExecutablePluginRegistration, ExecutablePluginCardRegistrationSchema } from "@clash/shared-types";
import { migrateLegacyCanvasGeneratorDrafts } from "./local-canvas-generator-migration.js";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../../plugins/codex-imagegen/${file}`, import.meta.url), "utf8"));
const manifest = read("manifest.json");
const provenance = { pluginId: manifest.id, version: manifest.version, schemaHash: `sha256:${"a".repeat(64)}` };
const registration = ExecutablePluginCardRegistrationSchema.parse({ ...provenance, runtime: manifest.runtime, document: read("cards/codex-imagegen.json") });
const definition = generatorDefinitionFromExecutablePluginRegistration({ ...provenance, document: read("generators/codex-imagegen.json") });
const card = registration.document.kind === "action-card" ? registration.document.spec : undefined;
if (!card) throw new Error("Expected shipped Action Card");

it.each([false, true])("migrates mapped legacy drafts atomically and preserves historical outputs (broken reference: %s)", (broken) => {
  const doc = new LoroDoc();
  try {
    const canvas = new Canvas(doc, () => {});
    for (const id of ["first", "last"]) {
      createProjectAsset(doc, { id, kind: "image", source: { kind: "owned", resourceId: id }, lifecycle: { state: "active" }, metadata: {} });
      canvas.createNode(id, "image", { assetId: id });
    }
    canvas.createNode("brief", "text", { content: "Warm light" });
    canvas.createNode("draft", "action-badge", { actionType: `custom:${card.id}`, customActionId: card.id,
      customActionParams: { aspect_ratio: "16:9" }, content: "A courtyard", referenceImageOrder: ["last", "first"],
      pluginBinding: { ...provenance, exportId: card.functionExportId } });
    for (const id of ["first", "last", "brief"]) canvas.insertEdge(`${id}-draft`, id, "draft");
    canvas.createNode("historical", "image", { status: "completed", label: "Old output" });
    canvas.insertEdge("old-result", "draft", "historical");
    if (broken) canvas.createNode("broken", "action-badge", { actionType: `custom:${card.id}`, content: "Missing", referenceImageAssetIds: ["missing"] });
    const before = doc.toJSON();
    const edges = canvas.listEdges();
    const historical = canvas.readNode("historical");
    const result = migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS, [registration]);
    if (broken) {
      expect(result).toMatchObject({ ok: false, error: { nodeId: "broken" } });
      expect(doc.toJSON()).toEqual(before);
      return;
    }
    expect(result).toMatchObject({ ok: true, migratedNodeIds: ["draft"] });
    const node = canvas.readNode("draft")!;
    const generator = readProjectGenerator(doc, node.data.generatorId as string)!;
    const revision = readGeneratorRevision(doc, { generatorId: generator.id, generatorRevisionId: generator.headRevisionId })!;
    expect(revision.state).toEqual({ prompt: "A courtyard\n\nWarm light", aspect_ratio: "16:9" });
    expect(revision.persistentInputRefs.map(ref => ref.target)).toEqual(["last", "first"].map(projectAssetId => ({ kind: "media", projectAssetId })));
    expect((doc.getMap("nodes").get("draft") as any).data).toMatchObject({ generatorId: generator.id, actionCardId: card.id });
    expect((doc.getMap("nodes").get("draft") as any).data).not.toHaveProperty("customActionParams");
    expect(canvas.listEdges()).toEqual(edges);
    expect(canvas.readNode("historical")).toEqual(historical);
    const after = doc.toJSON();
    expect(migrateLegacyCanvasGeneratorDrafts(doc, [definition], MODEL_CARDS, [registration])).toMatchObject({ ok: true, migratedNodeIds: [] });
    expect(doc.toJSON()).toEqual(after);
  } finally { doc.free(); }
});
