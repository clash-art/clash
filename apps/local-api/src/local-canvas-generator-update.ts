import type { LoroDoc } from "loro-crdt";
import { Canvas, canvasModelPlacementData, commitProjectMutation, createModelPromptEdit, createActionCardPromptEdit, readProjectGenerator, readGeneratorRevision, type GeneratorDefinition, type ExecutablePluginCardRegistration } from "@clash/shared-types";
import { resolveLocalCanvasActionCard } from "./local-canvas-action-contract.js";
import { advanceLocalGeneratorRevision } from "./local-generator-product.js";

export function isCanvasGeneratorAuthoringPatch(node: { type?: string; data?: Record<string, unknown> }, updates: Record<string, unknown>): boolean {
  const metadata = canvasModelPlacementData(updates);
  return node.type === "action-badge" && typeof node.data?.generatorId === "string" && Object.keys(updates).some((key) => !(key in metadata));
}

/** Shared by Canvas Host commands and REST after their read/placement guards. */
export function updateLocalCanvasGeneratorNode(doc: LoroDoc, nodeId: string, canvasId: string, updates: Record<string, unknown>, definitions: readonly GeneratorDefinition[] | undefined, actionCards: readonly ExecutablePluginCardRegistration[] = []): boolean {
  const canvas = new Canvas(doc, () => {}, canvasId);
  const node = canvas.readNode(nodeId);
  if (!node || !isCanvasGeneratorAuthoringPatch(node, updates)) return false;
  const metadata = canvasModelPlacementData(updates);
  const semanticKeys = Object.keys(updates).filter((key) => !(key in metadata));
  const actionCardId = typeof node.data.actionCardId === "string" ? node.data.actionCardId : undefined;
  const allowed = new Set(actionCardId ? ["content", "prompt", "customActionParams"] : ["content", "prompt", "model", "modelId", "modelParams", "lyrics"]);
  const unsupported = semanticKeys.filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported Model draft fields: ${unsupported.join(", ")}`);
  const source = readProjectGenerator(doc, node.data.generatorId as string);
  const current = source && readGeneratorRevision(doc, { generatorId: source.id, generatorRevisionId: source.headRevisionId });
  if (!current) throw new Error("Model Generator is unavailable. Read again.");
  const definition = definitions?.find((item) => item.pluginId === current.definitionRef.pluginId && item.definitionId === current.definitionRef.definitionId);
  if (!definition) throw new Error("Model Generator Definition is unavailable.");
  const card = actionCardId ? resolveLocalCanvasActionCard(actionCards, definition, actionCardId) : undefined;
  let state = { ...current.state };
  if (card && updates.customActionParams !== undefined) {
    const params = typeof updates.customActionParams === "string" ? JSON.parse(updates.customActionParams) : updates.customActionParams;
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Action parameters must be an object.");
    // The legacy form replaces its parameter object; prompt remains a separate authored field.
    state = { ...params, prompt: current.state.prompt };
  }
  for (const [field, alias] of [["modelId", "model"], ["prompt", "content"]] as const) {
    if (updates[field] !== undefined && updates[alias] !== undefined && updates[field] !== updates[alias]) throw new Error(`Conflicting ${field} and ${alias} updates.`);
    const value = updates[field] ?? updates[alias];
    if (value !== undefined) {
      if (typeof value !== "string") throw new Error(`${field} must be a string.`);
      state[field] = value;
    }
  }
  if (updates.lyrics !== undefined) {
    if (typeof updates.lyrics !== "string") throw new Error("Lyrics must be a string.");
    state.lyrics = updates.lyrics;
  }
  if (updates.modelParams !== undefined) state.params = typeof updates.modelParams === "string" ? JSON.parse(updates.modelParams) : updates.modelParams as typeof state.params;
  const next = updates.prompt !== undefined || updates.content !== undefined
    ? card ? createActionCardPromptEdit(state.prompt as string, card.generator!, (id) => canvas.readNode(id) ?? undefined)({ ...current, state }, definition)
      : createModelPromptEdit(state.prompt as string, (id) => canvas.readNode(id) ?? undefined)({ ...current, state })
    : { state, persistentInputRefs: current.persistentInputRefs };
  commitProjectMutation(doc, (draft) => {
    advanceLocalGeneratorRevision(draft, definition, current.generatorId, {
      expectedHeadRevisionId: current.id, generatorRevisionId: crypto.randomUUID(),
      state: next.state, persistentInputRefs: next.persistentInputRefs,
    });
    if (Object.keys(metadata).length) new Canvas(draft, () => {}, node.canvas_id).updateNode(nodeId, metadata);
    return { ok: true };
  });
  return true;
}
