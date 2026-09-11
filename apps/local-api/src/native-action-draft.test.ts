import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { Canvas, CustomActionDefinitionSchema, ExecutablePluginCardRegistrationSchema, generatorDefinitionFromExecutablePluginRegistration } from "@clash/shared-types";
import { createLocalGeneratorProductService } from "./local-generator-product.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";

it("creates, edits, executes, and copies an Action Card as one native draft without Canvas state shadows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clash-action-draft-"));
  const doc = new LoroDoc();
  try {
    const read = async (file: string) => JSON.parse(await readFile(new URL(`../../../plugins/codex-imagegen/${file}`, import.meta.url), "utf8"));
    const [manifest, card, document] = await Promise.all([read("manifest.json"), read("cards/codex-imagegen.json"), read("generators/codex-imagegen.json")]);
    const provenance = { pluginId: manifest.id, version: manifest.version, schemaHash: `sha256:${"a".repeat(64)}` };
    const definition = generatorDefinitionFromExecutablePluginRegistration({ ...provenance, document });
    const registration = ExecutablePluginCardRegistrationSchema.parse({ ...provenance, document: card, runtime: manifest.runtime });
    const custom = CustomActionDefinitionSchema.parse({ ...card.spec, pluginBinding: { ...provenance, exportId: card.spec.functionExportId } });
    const service = createLocalGeneratorProductService({
      authority: { inspect: async (_id, read) => read(doc), mutate: async (_id, write) => write(doc, async () => {}) },
      resolveDefinition: async () => definition, listPluginCards: async () => [registration],
      ownerId: "host", journal: createSqliteDurableRunJournal(directory), actor: { kind: "user" },
    });
    const created = await service.create("project", {
      generatorId: "draft", generatorRevisionId: "draft:r1", pluginId: definition.pluginId, definitionId: definition.definitionId,
      state: { prompt: "", aspect_ratio: "1:1" }, persistentInputRefs: [],
      placement: { canvasId: "main", nodeId: "card", actionCardId: custom.id },
    });
    const canvas = new Canvas(doc, () => {});
    expect(canvas.readNode("card")?.data).toMatchObject({ generatorId: created.generator.id, content: "", customActionParams: { aspect_ratio: "1:1" } });
    let updated = await service.advance("project", "draft", {
      expectedHeadRevisionId: "draft:r1", generatorRevisionId: "draft:r2", state: { prompt: "A courtyard", aspect_ratio: "16:9" }, persistentInputRefs: [],
    });
    expect(canvas.readNode("card")?.data).toMatchObject({ content: "A courtyard", customActionParams: { aspect_ratio: "16:9" } });
    expect(doc.getMap("nodes").get("card")).toMatchObject({ data: { generatorId: "draft", actionCardId: custom.id } });
    const raw = doc.getMap("nodes").get("card") as { data: Record<string, unknown> };
    expect(raw.data).not.toHaveProperty("content");
    expect(raw.data).not.toHaveProperty("customActionParams");
    // Preparing an editable Card after a package update adopts the validated
    // current Definition while historical revisions retain their provenance.
    definition.schemaHash = `sha256:${"b".repeat(64)}`;
    registration.schemaHash = definition.schemaHash;
    custom.pluginBinding!.schemaHash = definition.schemaHash;
    updated = await service.advance("project", "draft", {
      expectedHeadRevisionId: updated.revision.id, generatorRevisionId: "draft:r3",
      state: updated.revision.state, persistentInputRefs: [],
    });
    expect(updated.revision.definitionRef.schemaHash).toBe(definition.schemaHash);
    expect(() => canvas.updateNode("card", { customActionParams: { aspect_ratio: "4:3" } })).toThrow(/Generator/);
    const output = canvas.executeGeneration("card", () => "output", undefined, custom);
    expect(output.error).toBeNull();
    expect(canvas.readNode(output.assetNodeId)?.data).toMatchObject({ generatorRevision: { generatorId: "draft", generatorRevisionId: updated.revision.id }, generatorActionId: custom.generator!.actionId });
    await expect(service.advance("project", "draft", {
      expectedHeadRevisionId: updated.revision.id, generatorRevisionId: "rejected", state: { prompt: "Changed" }, persistentInputRefs: [],
    })).rejects.toThrow(/Copy/);
    await service.create("project", {
      generatorId: "copy", generatorRevisionId: "copy:r1", pluginId: definition.pluginId, definitionId: definition.definitionId,
      state: { prompt: "Another courtyard", aspect_ratio: "16:9" }, persistentInputRefs: [],
      forkedFrom: { generatorId: "draft", generatorRevisionId: updated.revision.id },
      placement: { canvasId: "main", nodeId: "copy-card", sourceNodeId: "card", actionCardId: custom.id },
    });
    expect(canvas.readNode("card")?.data.content).toBe("A courtyard");
    expect(canvas.readNode("copy-card")?.data.content).toBe("Another courtyard");
    expect(canvas.listEdges()).toEqual(expect.arrayContaining([expect.objectContaining({ source: "card", target: "copy-card", type: "copy-on-write" })]));
  } finally { doc.free(); await rm(directory, { recursive: true, force: true }); }
});
