import { readFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  MODEL_CARDS,
  createProjectAsset,
  generatorDefinitionFromExecutablePluginRegistration,
  type ModelCard,
} from "@clash/shared-types";
import { createMockExternalAigcService } from "./local-aigc.js";
import { createLocalModelExecutionPlanner, resolveModelGenerationReferences, modelGenerationRevisionFromReferences } from "./local-model-generation.js";

it("preserves mixed prompt order, repeated placements, and exact input identities", () => {
  const doc = new LoroDoc();
  for (const id of ["first", "second"]) {
    expect(createProjectAsset(doc, { id, kind: "image", source: { kind: "owned", resourceId: id },
      lifecycle: { state: "active" }, metadata: { contentType: "image/png", width: 1024, height: 1024 } }).ok).toBe(true);
  }
  const input = {
    doc, revisionId: "revision", prompt: "Compare B with A then B",
    inputRefs: [
      { slot: "image", itemKey: "a", target: { kind: "media" as const, projectAssetId: "first" } },
      { slot: "image", itemKey: "b", target: { kind: "media" as const, projectAssetId: "second" } },
    ],
    contentParts: [
      { type: "text", text: "Compare " }, { type: "input", slot: "image", itemKey: "b", label: "B" },
      { type: "text", text: " with " }, { type: "input", slot: "image", itemKey: "a", label: "A" },
      { type: "text", text: " then " }, { type: "input", slot: "image", itemKey: "b", label: "B" },
    ],
  };
  const references = resolveModelGenerationReferences(input);
  expect(resolveModelGenerationReferences({ ...input, orderedContent: false })).toMatchObject([
    { slot: "image", index: 0, asset: { assetId: "second" } },
    { slot: "image", index: 1, asset: { assetId: "first" } },
  ]);
  expect(() => resolveModelGenerationReferences({ ...input, orderedContent: false, prompt: "stale" })).toThrow(/prompt/i);
  expect(references.map((ref) => "text" in ref ? ref.text.value : "asset" in ref ? ref.asset.assetId : null))
    .toEqual(["Compare ", "second", " with ", "first", " then ", "second"]);
  expect(references.every((ref, index) => ref.slot === "content" && ref.index === index)).toBe(true);
  const projected = modelGenerationRevisionFromReferences({ modelId: "minimax-h3", prompt: input.prompt,
    params: { duration: 5, provider_id: "legacy-private-route" }, references,
    contentLabels: ["", "B", "", "A", "", "B"],
  });
  expect(resolveModelGenerationReferences({ doc, revisionId: input.revisionId, prompt: input.prompt,
    inputRefs: projected.persistentInputRefs, contentParts: projected.state.contentParts,
  })).toEqual(references);
  expect(projected.state.params).toEqual({ duration: 5 });
  expect(() => resolveModelGenerationReferences({ ...input, contentParts: [
    { type: "input", slot: "image", itemKey: "missing", label: input.prompt },
  ] })).toThrow(/input/i);
  expect(() => resolveModelGenerationReferences({ ...input, prompt: "different prompt" })).toThrow(/prompt/i);
  expect(() => resolveModelGenerationReferences({ ...input, contentParts: [{ type: "text", text: input.prompt }] }))
    .toThrow(/input/i);
});

describe("native model generation planning", () => {
  it("uses the chosen Card and freezes its Provider without submitting media or rewriting parameters", async () => {
    const original = MODEL_CARDS.find((card) => card.id === "minimax-h3")!;
    const binding = { pluginId: "test.provider", exportId: "execute", version: "1.0.0", schemaHash: `sha256:${"a".repeat(64)}` };
    const card: ModelCard = { ...original, providerImplementations: [{
      providerId: "test-provider", upstreamId: "test-provider", upstreamModel: "upstream-model",
      apiShape: "test-provider", priority: 1, executorPluginId: binding.pluginId, executorExportId: binding.exportId,
    }] };
    const aigc = createMockExternalAigcService({ modelCards: async () => [card],
      providerAccounts: async () => [{ id: "private-account", providerId: "test-provider", upstreamId: "test-provider", enabled: true }],
      resolveProviderPluginBinding: async () => binding,
      providerPluginExecutor: async () => { throw new Error("Planning must not call a Provider."); },
    });
    const definition = generatorDefinitionFromExecutablePluginRegistration({
      pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"b".repeat(64)}`,
      document: JSON.parse(readFileSync(new URL("../../../plugins/model-generation/generators/video.json", import.meta.url), "utf8")),
    });
    const params = { duration: 5, resolution: "768P", aspect_ratio: "16:9" };
    const prepared = {
      definition, action: definition.actions[0]!, outputContract: definition.actions[0]!.outputs,
      invocationInputRefs: [],
      revision: { id: "rev", generatorId: "gen", definitionRef: {
        pluginId: definition.pluginId, definitionId: definition.definitionId, version: definition.version, schemaHash: definition.schemaHash,
      }, state: { modelId: card.id, prompt: "A quiet courtyard", params }, persistentInputRefs: [] },
    };
    const planner = createLocalModelExecutionPlanner({ aigc, modelCards: async () => [card] });
    const planned = await planner({ projectId: "project", doc: new LoroDoc(), prepared });
    expect(planned.selection.modelId).toBe(card.id);
    expect(planned.selection.route.executorBinding).toEqual(binding);
    expect(planned.execution.accountId).toBe("private-account");
    expect(planned.execution.input.values.modelParams).toMatchObject(params);
    expect(planned.execution.input.values.upstreamModel).toBe("upstream-model");
    expect(JSON.stringify(planned.selection)).not.toContain("private-account");
    const recovered = await planner({ projectId: "project", doc: new LoroDoc(), prepared, pinnedSelection: planned.selection });
    expect(recovered.selection).toEqual(planned.selection);
    await expect(planner({ projectId: "project", doc: new LoroDoc(), prepared: {
      ...prepared, revision: { ...prepared.revision, state: {
        ...prepared.revision.state, params: { ...params, provider_id: "private-account" },
      } },
    } })).rejects.toThrow(/providerAccountId/);
    const doc = new LoroDoc();
    expect(createProjectAsset(doc, { id: "too-small", kind: "image", source: { kind: "owned", resourceId: "small" },
      lifecycle: { state: "active" }, metadata: { contentType: "image/png", width: 1, height: 1 } }).ok).toBe(true);
    await expect(planner({ projectId: "project", doc, prepared: {
      ...prepared, revision: { ...prepared.revision, persistentInputRefs: [
        { slot: "image", itemKey: "first", target: { kind: "media", projectAssetId: "too-small" } },
      ] },
    } })).rejects.toThrow();
    const frameCard = { ...MODEL_CARDS.find((candidate) => candidate.id === "minimax-h3-startend")!, providerImplementations: card.providerImplementations };
    const framePlanner = createLocalModelExecutionPlanner({ aigc: createMockExternalAigcService({
      modelCards: async () => [frameCard],
      providerAccounts: async () => [{ id: "private-account", providerId: "test-provider", upstreamId: "test-provider", enabled: true }],
      resolveProviderPluginBinding: async () => binding,
      providerPluginExecutor: async () => { throw new Error("Planning must not call a Provider."); },
    }), modelCards: async () => [frameCard] });
    expect(createProjectAsset(doc, { id: "frame", kind: "image", source: { kind: "owned", resourceId: "frame" },
      lifecycle: { state: "active" }, metadata: { contentType: "image/png", width: 1024, height: 1024 } }).ok).toBe(true);
    const framePlan = await framePlanner({ projectId: "project", doc, prepared: {
      ...prepared, revision: { ...prepared.revision,
        state: { modelId: frameCard.id, prompt: "Animate frame", params: { duration: 5, resolution: "768P" },
          contentParts: [{ type: "text", text: "Animate " }, { type: "input", slot: "startFrame", label: "frame" }] },
        persistentInputRefs: [{ slot: "startFrame", target: { kind: "media", projectAssetId: "frame" } }],
      },
    } });
    expect(framePlan.execution.input.references).toMatchObject([{ slot: "startFrame", index: 0, asset: { assetId: "frame" } }]);
    expect(framePlan.execution.input.values.prompt).toBe("Animate frame");

  });
});

it.each(MODEL_CARDS.filter((card) => card.musicInput))("maps authored Lyrics using $id's published music contract without changing its Revision", async (original) => {
  const binding = { pluginId: "test.provider", exportId: "execute", version: "1.0.0", schemaHash: `sha256:${"a".repeat(64)}` };
  const card: ModelCard = { ...original, providerImplementations: [{ providerId: "test-provider", upstreamId: "test-provider", upstreamModel: "music", apiShape: "test-provider", priority: 1, executorPluginId: binding.pluginId, executorExportId: binding.exportId }] };
  const aigc = createMockExternalAigcService({ modelCards: async () => [card], providerAccounts: async () => [{ id: "account", providerId: "test-provider", upstreamId: "test-provider", enabled: true }], resolveProviderPluginBinding: async () => binding,
    providerPluginExecutor: async () => { throw new Error("Do not generate during planning."); },
  });
  const definition = generatorDefinitionFromExecutablePluginRegistration({ pluginId: "clash.model-generation", version: "0.1.0", schemaHash: `sha256:${"b".repeat(64)}`, document: JSON.parse(readFileSync(new URL("../../../plugins/model-generation/generators/audio.json", import.meta.url), "utf8")) });
  const revision = { id: "music", generatorId: "song", definitionRef: { pluginId: definition.pluginId, definitionId: definition.definitionId, version: definition.version, schemaHash: definition.schemaHash },
    state: { modelId: card.id, prompt: "Gentle piano", lyrics: "[Verse]\nMorning light", params: { ...card.defaultParams } }, persistentInputRefs: [],
  };
  const before = structuredClone(revision);
  const planner = createLocalModelExecutionPlanner({ aigc, modelCards: async () => [card] });
  const planned = await planner({ projectId: "project", doc: new LoroDoc(), prepared: { definition, action: definition.actions[0]!, outputContract: definition.actions[0]!.outputs, invocationInputRefs: [], revision } });
  const mapping = card.musicInput!;
  if (mapping.lyricsTarget === "prompt") {
    expect(planned.execution.input.values.prompt).toBe(revision.state.lyrics);
    expect(planned.execution.input.values.modelParams).toMatchObject({ [mapping.descriptionParam!]: revision.state.prompt });
  } else {
    expect(planned.execution.input.values.prompt).toBe(revision.state.prompt);
    expect(planned.execution.input.values.modelParams).toMatchObject({ [mapping.lyricsParam!]: revision.state.lyrics });
  }
  expect(revision).toEqual(before);
});
