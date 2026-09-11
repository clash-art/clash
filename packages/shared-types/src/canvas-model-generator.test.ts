import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { Canvas } from "./canvas-ops.js";
import { createProjectGenerator, advanceProjectGeneratorHead } from "./project-generators.js";

const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
function setup() {
  const doc = new LoroDoc();
  const revision = { id: "draft-before", generatorId: "draft", definitionRef,
    state: { modelId: "minimax-h3", prompt: "A paper city", params: { resolution: "768P" } }, persistentInputRefs: [] };
  const created = createProjectGenerator(doc, { head: { id: "draft", headRevisionId: revision.id }, revision });
  if (!created.ok) throw new Error(created.error.message);
  const canvas = new Canvas(doc, () => {});
  canvas.createNode("placement", "action-badge", { generatorId: "draft", label: "Scene" });
  return { doc, canvas, revision };
}

describe("Canvas Model Generator projection", () => {
  it("reads the native revision and follows its head without writing model state into Canvas", () => {
    const { doc, canvas, revision } = setup();
    expect(canvas.readNode("placement")?.data).toMatchObject({ generatorId: revision.generatorId,
      generatorRevisionId: revision.id, modelId: revision.state.modelId, content: revision.state.prompt, modelParams: revision.state.params });
    const advanced = advanceProjectGeneratorHead(doc, { generatorId: "draft", expectedHeadRevisionId: revision.id,
      revision: { ...revision, id: "draft-after", parentRevisionId: revision.id, state: { ...revision.state, prompt: "A glass city" } }, editPolicy: "advance-head" });
    if (!advanced.ok) throw new Error(advanced.error.message);
    expect(canvas.listNodes()[0]?.data.content).toBe("A glass city");
    const stored = doc.getMap("nodes").get("placement") as { data: Record<string, unknown> };
    expect(stored.data).toEqual({ generatorId: "draft", label: "Scene" });
  });

  it("executes a placement by pinning its native revision without copying authoring fields", () => {
    const { canvas, revision } = setup();
    const result = canvas.executeGeneration("placement", () => "output");
    expect(result.error).toBeNull();
    const pending = canvas.readNode("output");
    expect(pending?.type).toBe("video");
    expect(pending?.data.generatorRevision).toEqual({ generatorId: revision.generatorId, generatorRevisionId: revision.id });
    expect(pending?.data).not.toHaveProperty("prompt");
    expect(pending?.data).not.toHaveProperty("modelParams");
  });

  it("rejects semantic Canvas writes to a referenced Generator but allows placement metadata", () => {
    const { canvas } = setup();
    expect(() => canvas.updateNode("placement", { content: "shadow draft" })).toThrow(/Generator/);
    expect(canvas.updateNode("placement", { label: "Renamed" })).toBe(true);
    expect(canvas.readNode("placement")?.data.content).toBe("A paper city");
  });

  it("does not use stale Canvas fields when the native Generator is missing", () => {
    const doc = new LoroDoc();
    doc.getMap("nodes").set("broken", { type: "action-badge", data: { generatorId: "missing", content: "stale" } });
    expect(() => new Canvas(doc, () => {}).readNode("broken")).toThrow(/Generator/);
  });
});
