import { expect, it, vi } from "vitest";
import { createCanvasModelDraft } from "./createCanvasModelDraft";

it("creates native state and placement in one Host request without submitting a Run", async () => {
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "image", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  const createGenerator = vi.fn(async (_project: string, input: any) => ({
    generator: { id: input.generatorId, headRevisionId: input.generatorRevisionId, definitionRef },
    revision: { id: input.generatorRevisionId, generatorId: input.generatorId, definitionRef, state: input.state, persistentInputRefs: input.persistentInputRefs },
  }));
  const input = { projectId: "project", kind: "image" as const, modelId: "test-model", prompt: "A scene", params: { resolution: "provider-value" },
    placement: { canvasId: "canvas", nodeId: "node", parentId: "group", label: "Scene", position: { x: 5, y: 8 } } };
  const accepted = await createCanvasModelDraft({ ...input, client: { createGenerator } });
  const sent = createGenerator.mock.calls[0]![1];
  expect(sent.state).toEqual({ modelId: input.modelId, prompt: input.prompt, params: input.params });
  expect(sent.placement).toEqual(input.placement);
  expect(accepted.generator.id).toBe(sent.generatorId);
  expect(accepted.revision.id).toBe(sent.generatorRevisionId);
  expect(sent.persistentInputRefs).toEqual([]);
});

it("propagates Host rejection instead of manufacturing a placement acknowledgement", async () => {
  await expect(createCanvasModelDraft({ projectId: "project", kind: "video", modelId: "model", prompt: "", params: {},
    placement: { canvasId: "main", nodeId: "node" }, client: { createGenerator: async () => { throw new Error("Placement conflict"); } } }))
    .rejects.toThrow("Placement conflict");
});
