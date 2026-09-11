import { expect, it, vi } from "vitest";
import { AdvanceProjectGeneratorRequestSchema, modelInputRefsInPromptOrder, type GeneratorRevision } from "@clash/shared-types";
import { connectNativeModelInput } from "./connectNativeModelInput";

it("freezes a Document connection before waiting, then removes the exact input and content part", async () => {
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  let revision: GeneratorRevision = { id: "initial", generatorId: "draft", definitionRef, state: { modelId: "minimax-h3", prompt: "Rewrite" }, persistentInputRefs: [] };
  const client = {
    getGenerator: vi.fn(async () => ({ generator: { id: "draft", headRevisionId: revision.id, definitionRef }, revision })),
    advanceGenerator: vi.fn(async (_project, _id, input: any) => {
      revision = { ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs };
      return { generator: { id: "draft", headRevisionId: revision.id, definitionRef }, revision };
    }),
  };
  const asset = { kind: "document" as const, documentAssetId: "script", revisionId: "saved" };
  const expected = { ...asset };
  const connection = { client, projectId: "project", generatorId: "draft", canvasId: "main", sourceNodeId: "script", targetNodeId: "placement", asset, kind: "text" as const };
  const pending = connectNativeModelInput(connection);
  asset.revisionId = "later";
  await pending;
  expect(revision.persistentInputRefs.map(ref => ref.target)).toEqual([expected]);
  expect(client.advanceGenerator.mock.lastCall?.[2].canvasInputConnections[0].asset).toEqual(expected);
  await connectNativeModelInput({ ...connection, asset: expected, disconnect: true });
  expect(revision.persistentInputRefs).toEqual([]);
  expect((revision.state.contentParts as any[]).some(part => part.type === "input")).toBe(false);
});

it("updates keyframe timing and sequence in the same connection revision", async () => {
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  const refs = ["opening", "closing"].map(itemKey => ({ slot: "image", itemKey, target: { kind: "media" as const, projectAssetId: itemKey } }));
  let revision: GeneratorRevision = { id: "initial", generatorId: "generator", definitionRef,
    state: { modelId: "flux-3-video-keyframes", prompt: "Animate", params: { duration: 5, keyframe_frame_indices: "[0,120]", keyframe_timing_customized: true }, contentParts: refs.map(ref => ({ type: "input", slot: ref.slot, itemKey: ref.itemKey, label: "" })) }, persistentInputRefs: refs };
  const client = {
    getGenerator: async () => ({ generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision }),
    advanceGenerator: vi.fn(async (_project: string, _generator: string, raw: unknown) => {
      const request = AdvanceProjectGeneratorRequestSchema.parse(raw);
      revision = { ...revision, state: request.state, persistentInputRefs: request.persistentInputRefs, id: request.generatorRevisionId, parentRevisionId: revision.id };
      return { generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision };
    }),
  };
  const connection = { client, projectId: "project", generatorId: "generator", canvasId: "main", sourceNodeId: "middle", targetNodeId: "draft", asset: { kind: "media" as const, projectAssetId: "middle" }, kind: "image" as const };
  await connectNativeModelInput(connection);
  expect(modelInputRefsInPromptOrder(revision.state, revision.persistentInputRefs).map(ref => ref.target)).toEqual(
    ["opening", "middle", "closing"].map(projectAssetId => ({ kind: "media", projectAssetId })),
  );
  expect(revision.state.params).toMatchObject({ keyframe_frame_indices: "[0,60,120]" });
  expect(client.advanceGenerator).toHaveBeenCalledTimes(1);
  await connectNativeModelInput({ ...connection, disconnect: true });
  expect(revision.state.params).toMatchObject({ keyframe_frame_indices: "[0,120]" });
  expect(revision.persistentInputRefs).toEqual(refs);
  expect(client.advanceGenerator).toHaveBeenCalledTimes(2);
});

it("retains append order when a plain prompt's inputs return in normalized identity order", async () => {
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  let revision: GeneratorRevision = { id: "initial", generatorId: "generator", definitionRef,
    state: { modelId: "model", prompt: "Keep this prompt" }, persistentInputRefs: [] };
  const client = {
    getGenerator: async () => ({ generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision }),
    advanceGenerator: async (_project: string, _generator: string, raw: unknown) => {
      const request = AdvanceProjectGeneratorRequestSchema.parse(raw);
      revision = { ...revision, state: request.state, persistentInputRefs: [...request.persistentInputRefs].reverse(), id: request.generatorRevisionId, parentRevisionId: revision.id };
      return { generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision };
    },
  };
  for (const asset of ["first", "second", "third"]) {
    await connectNativeModelInput({ client, projectId: "project", generatorId: "generator", canvasId: "main", sourceNodeId: asset, targetNodeId: "draft", asset: { kind: "media" as const, projectAssetId: asset }, kind: "image" });
  }
  expect(modelInputRefsInPromptOrder(revision.state, revision.persistentInputRefs).map(ref => ref.target)).toEqual(
    ["first", "second", "third"].map(projectAssetId => ({ kind: "media", projectAssetId })),
  );
  expect(revision.state.prompt).toBe("Keep this prompt");
});

it("serializes connections against fresh Host heads and disconnects inputs with their prompt labels", async () => {
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  let current = { generator: { id: "generator", headRevisionId: "before", definitionRef }, revision: {
    id: "before", generatorId: "generator", definitionRef, state: { modelId: "model", prompt: "Show", contentParts: [{ type: "text", text: "Show" }] }, persistentInputRefs: [] as any[],
  } };
  const advanceGenerator = vi.fn(async (_project: string, _generator: string, raw: unknown) => {
    const input = raw as any;
    expect(input.expectedHeadRevisionId).toBe(current.revision.id);
    current = { generator: { ...current.generator, headRevisionId: input.generatorRevisionId }, revision: { ...current.revision,
      id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs } } as typeof current;
    return structuredClone(current);
  });
  const client = { getGenerator: vi.fn(async () => structuredClone(current)), advanceGenerator };
  const common = { client, projectId: "project", generatorId: "generator", canvasId: "main", targetNodeId: "target", kind: "image" as const };
  await Promise.all([
    connectNativeModelInput({ ...common, sourceNodeId: "one", asset: { kind: "media" as const, projectAssetId: "first" } }),
    connectNativeModelInput({ ...common, sourceNodeId: "two", asset: { kind: "media" as const, projectAssetId: "second" } }),
  ]);
  expect(current.revision.persistentInputRefs.map((ref) => ref.target.projectAssetId)).toEqual(["first", "second"]);
  await connectNativeModelInput({ ...common, sourceNodeId: "one", asset: { kind: "media" as const, projectAssetId: "first" }, disconnect: true });
  expect(current.revision.persistentInputRefs.map((ref) => ref.target.projectAssetId)).toEqual(["second"]);
  const last = advanceGenerator.mock.calls.at(-1)![2] as any;
  expect(last.canvasInputConnections).toEqual([{ canvasId: "main", sourceNodeId: "one", targetNodeId: "target", asset: { kind: "media" as const, projectAssetId: "first" }, disconnect: true }]);
  expect(last.state.contentParts.filter((part: any) => part.type === "input").map((part: any) => part.itemKey)).toEqual(current.revision.persistentInputRefs.map((ref) => ref.itemKey));
});

it("fills the declared frame roles without overflowing or overwriting existing inputs", async () => {
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  let revision: GeneratorRevision = { id: "initial", generatorId: "generator", definitionRef, state: { modelId: "minimax-h3-startend", prompt: "Animate" }, persistentInputRefs: [] as import("@clash/shared-types").GeneratorInputRef[] };
  const client = {
    getGenerator: vi.fn(async () => ({ generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision })),
    advanceGenerator: vi.fn(async (_project: string, _generator: string, raw: unknown) => {
      const request = AdvanceProjectGeneratorRequestSchema.parse(raw);
      revision = { ...revision, state: request.state, persistentInputRefs: request.persistentInputRefs, id: request.generatorRevisionId, parentRevisionId: revision.id };
      return { generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision };
    }),
  };
  const connect = (asset: string) => connectNativeModelInput({ client, projectId: "project", generatorId: "generator", canvasId: "main", sourceNodeId: asset, targetNodeId: "draft", asset: { kind: "media" as const, projectAssetId: asset }, kind: "image" });
  await connect("first");
  await connect("last");
  // The shipped MiniMax adapter consumes these two singleton roles.
  expect(revision.persistentInputRefs).toEqual([
    { slot: "startFrame", target: { kind: "media", projectAssetId: "first" } },
    { slot: "endFrame", target: { kind: "media", projectAssetId: "last" } },
  ]);
  const previous = structuredClone(revision);
  await expect(connect("extra")).rejects.toThrow(/frame/i);
  expect(revision).toEqual(previous);
});

it.each(["media", "document"] as const)("connects and removes Action Card %s inputs without interpreting its state as a Model", async (inputKind) => {
  const definitionRef = { pluginId: "test.paint", definitionId: "paint", version: "1", schemaHash: `sha256:${"a".repeat(64)}` };
  const kind = inputKind === "document" ? "text" as const : "image" as const;
  const asset = inputKind === "document" ? { kind: "document" as const, documentAssetId: "script", revisionId: "saved" } : { kind: "media" as const, projectAssetId: "reference" };
  const actionCard = { definitionId: "paint", actionId: "generate", inputSlots: { [kind]: "source" } };
  // A plugin may use the same field name/value for its own purposes.
  const state = { prompt: "Paint", modelId: "flux-3-video-keyframes" };
  const definition = { ...definitionRef, stateSchema: { type: "object" }, editPolicy: "fork-when-materialized", persistentInputs: [{ slot: "source", accepts: [inputKind === "document" ? { kind: "document", documentKind: "text.plain", schemaVersion: 1 } : { kind: "media", mediaKind: "image" }], cardinality: { minItems: 0, maxItems: 5 } }], actions: [{ id: "generate", executorExportId: "paint", parametersSchema: { type: "object" }, invocationInputs: [], outputs: [{ slot: "image", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 1, maxItems: 1 } }] }] };
  let revision: GeneratorRevision = { id: "initial", generatorId: "generator", definitionRef, state, persistentInputRefs: [] };
  const client = {
    getDefinition: vi.fn(async () => ({ definition })),
    getGenerator: async () => ({ generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision }),
    advanceGenerator: vi.fn(async (_project: string, _generator: string, raw: unknown) => {
      const request = AdvanceProjectGeneratorRequestSchema.parse(raw);
      expect(request.expectedHeadRevisionId).toBe(revision.id);
      revision = { ...revision, state: request.state, persistentInputRefs: request.persistentInputRefs, id: request.generatorRevisionId, parentRevisionId: revision.id };
      return { generator: { id: "generator", headRevisionId: revision.id, definitionRef }, revision };
    }),
  };
  const connection = { client, actionCard, projectId: "project", generatorId: "generator", canvasId: "main", sourceNodeId: "reference", targetNodeId: "draft", asset, kind };
  await connectNativeModelInput(connection);
  expect(client.getDefinition).toHaveBeenCalledWith(definitionRef.pluginId, definitionRef.definitionId);
  expect(revision.state).toEqual(state);
  expect(revision.persistentInputRefs).toEqual([expect.objectContaining({ slot: "source", target: asset })]);
  await connectNativeModelInput({ ...connection, disconnect: true });
  expect(revision.state).toEqual(state);
  expect(revision.persistentInputRefs).toEqual([]);
  const sent = AdvanceProjectGeneratorRequestSchema.parse(client.advanceGenerator.mock.calls.at(-1)![2]);
  expect(sent.canvasInputConnections).toEqual([{ canvasId: connection.canvasId, sourceNodeId: connection.sourceNodeId, targetNodeId: connection.targetNodeId, asset, disconnect: true }]);
});
