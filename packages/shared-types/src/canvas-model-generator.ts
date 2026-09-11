import type { GeneratorRevision } from "./generator-v2.js";
import type { LoroDoc } from "loro-crdt";
import { readGeneratorRevision, readProjectGenerator } from "./project-generators.js";

const actionTypes: Record<string, string> = {
  image: "image-gen", video: "video-gen", audio: "audio-gen", model: "model-gen", text: "text-gen",
};
const semanticFields = new Set([
  "content", "prompt", "model", "modelId", "modelParams", "actionType",
  "pluginBinding", "generatorRevisionId", "referenceImageOrder", "referenceMode",
  "referenceImageAssetIds", "referenceVideoAssetIds", "referenceAudioAssetIds",
  "referenceModelAssetIds", "referenceTextSnippets", "lyrics", "modelName",
  "customActionId", "customActionParams",
]);

/** Remove legacy authoring shadows at the Host format-migration boundary. */
export function canvasModelPlacementData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !semanticFields.has(key)));
}

/** A Canvas placement refers to a native draft; semantic fields are read projections only. */
export function projectCanvasModelGeneratorData(
  doc: LoroDoc, nodeType: string, data: Record<string, unknown>,
): Record<string, unknown> {
  if (nodeType !== "action-badge" || data.generatorId === undefined) return data;
  if (typeof data.generatorId !== "string") throw new Error("Canvas Model Generator identity is invalid.");
  const generator = readProjectGenerator(doc, data.generatorId);
  const revision = generator && readGeneratorRevision(doc, {
    generatorId: generator.id, generatorRevisionId: generator.headRevisionId,
  });
  if (!revision) {
    throw new Error(`Canvas Model Generator ${data.generatorId} is missing or has an incompatible Definition.`);
  }
  return canvasModelGeneratorRevisionData(data, revision);
}

export function canvasModelGeneratorRevisionData(data: Record<string, unknown>, revision: GeneratorRevision): Record<string, unknown> {
  if (typeof data.actionCardId === "string") {
    const { prompt = "", ...params } = revision.state;
    if (typeof prompt !== "string") throw new Error("Action Card prompt state is invalid.");
    return { ...canvasModelPlacementData(data), generatorRevisionId: revision.id,
      actionType: `custom:${data.actionCardId}`, content: prompt, customActionParams: params };
  }
  if (revision.definitionRef.pluginId !== "clash.model-generation" || !actionTypes[revision.definitionRef.definitionId]) {
    throw new Error("Canvas placement requires a Model Generator revision.");
  }
  const { modelId, prompt, params = {} } = revision.state;
  if (typeof modelId !== "string" || typeof prompt !== "string" || !params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`Canvas Model Generator ${data.generatorId} has invalid draft state.`);
  }
  return {
    ...canvasModelPlacementData(data),
    generatorRevisionId: revision.id,
    actionType: actionTypes[revision.definitionRef.definitionId],
    modelId, model: modelId, content: prompt, modelParams: params,
    ...(revision.definitionRef.definitionId === "audio" ? { lyrics: typeof revision.state.lyrics === "string" ? revision.state.lyrics : "" } : {}),
  };
}

export function assertCanvasModelGeneratorPatch(
  nodeType: string, current: Record<string, unknown>, patch: Record<string, unknown>,
): void {
  if (nodeType !== "action-badge" || (current.generatorId === undefined && patch.generatorId === undefined)) return;
  if (Object.keys(patch).some((key) => semanticFields.has(key) || key === "actionCardId")) {
    throw new Error("Edit state through the referenced Project Generator; Canvas stores placement metadata only.");
  }
}
