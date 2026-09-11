import { randomUUID } from "node:crypto";
import { resolveLocalCanvasActionCard } from "./local-canvas-action-contract.js";
import type { LoroDoc } from "loro-crdt";
import {
  Canvas, buildGenerationPayload, canvasActionAssetInputs, canvasModelPlacementData,
  commitProjectMutation, createModelMediaInput, createProjectGenerator,
  createModelPromptEdit, createModelTextReferenceEdit, modelPromptPartsWithInputs,
  normalizeModelId, parsePromptParts, readProjectAsset, referenceAssetId, referenceModality,
  replaceDraftActionAssetInputBindings, appendActionCardInput, createActionCardPromptEdit, canvasAssetRevision, CustomActionDefinitionSchema,
  type GeneratorDefinition, type GeneratorRevision, type ModelCard, type ExecutablePluginCardRegistration,
} from "@clash/shared-types";
import { validateLocalGeneratorRevisionContract } from "./local-generator-contract.js";

type Result = { ok: true; migratedNodeIds: string[] } | { ok: false; error: { code: string; message: string; nodeId: string } };
const kinds = new Set(["image", "video", "audio", "model", "text"]);

function isLegacyAgent(data: Record<string, unknown>): boolean {
  return data.actionType === "text-gen" && (data.modelId ?? data.model) === "local-acp";
}

function legacyModelKind(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const node = raw as { type?: string; data?: Record<string, unknown> };
  const actionType = node.data?.actionType;
  // Local ACP owns agent execution rather than a Provider-backed Model route.
  // Its migration must retain that executor instead of inventing a Provider.
  if ((node.data?.modelId ?? node.data?.model) === "local-acp") return undefined;
  const kind = typeof actionType === "string" ? actionType.replace(/-gen$/, "") : "";
  return node.type === "action-badge" && node.data && node.data.generatorId === undefined && kinds.has(kind) && actionType === `${kind}-gen` ? kind : undefined;
}

function legacyActionId(raw: unknown): string | undefined {
  const node = raw as { type?: string; data?: Record<string, unknown> } | null;
  if (node?.type !== "action-badge" || !node.data || node.data.generatorId !== undefined) return undefined;
  if (isLegacyAgent(node.data)) return "agent-text";
  return typeof node.data.actionType === "string" && node.data.actionType.startsWith("custom:") ? node.data.actionType.slice(7) : undefined;
}

export function hasLegacyCanvasGeneratorDrafts(doc: LoroDoc, actionCards?: readonly ExecutablePluginCardRegistration[]): boolean {
  return [...doc.getMap("nodes").entries()].some(([, raw]) => legacyModelKind(raw) !== undefined || (legacyActionId(raw) !== undefined && (actionCards === undefined || actionCards.some((entry) => entry.document.kind === "action-card" && entry.document.spec.generator && entry.document.spec.id === legacyActionId(raw)))));
}

/** Host-only format migration, with no Run admission or rewrite of historical outputs. */
export function migrateLegacyCanvasGeneratorDrafts(doc: LoroDoc, definitions: readonly GeneratorDefinition[], cards: readonly ModelCard[], actionCards: readonly ExecutablePluginCardRegistration[] = []): Result {
  if (!hasLegacyCanvasGeneratorDrafts(doc, actionCards)) return { ok: true, migratedNodeIds: [] };
  return commitProjectMutation(doc, (draft): Result => {
    const migratedNodeIds: string[] = [];
    for (const [nodeId, raw] of draft.getMap("nodes").entries()) {
      const node = raw as { type?: string; canvasId?: string; data?: Record<string, unknown> };
      const data = node.data;
      const kind = legacyModelKind(raw);
      const actionId = legacyActionId(raw);
      const registration = actionCards.find((entry) => entry.document.kind === "action-card" && entry.document.spec.id === actionId && entry.document.spec.generator && (!data || !isLegacyAgent(data) || entry.pluginId === "clash.agent-text"));
      if ((!kind && !registration) || !data) continue;
      try {
        if (registration?.document.kind === "action-card") {
          const definitionId = registration.document.spec.generator?.definitionId;
          const definition = definitions.find((entry) => entry.pluginId === registration.pluginId && entry.definitionId === definitionId);
          if (!definition) throw new Error("Action Generator Definition is unavailable.");
          const legacyAgent = isLegacyAgent(data);
          const actionCard = resolveLocalCanvasActionCard(actionCards, definition, actionId!, legacyAgent ? undefined : data.pluginBinding);
          if (data.customActionParams !== undefined && (!data.customActionParams || typeof data.customActionParams !== "object" || Array.isArray(data.customActionParams))) throw new Error("Action parameters must be an object.");
          const canvas = new Canvas(draft, () => {}, node.canvasId ?? "main", cards);
          const source = canvas.readNode(nodeId)!;
          const edges = canvas.listEdges();
          const attached = edges.filter(edge => edge.target === nodeId && edge.type !== "copy-on-write").map(edge => canvas.readNode(edge.source));
          if (attached.some(entry => !entry || (referenceModality(entry) && referenceModality(entry) !== "text" && !referenceAssetId(entry)))) throw new Error("An incoming Action reference has no applied Asset.");
          let params = (data.customActionParams ?? {}) as Record<string, string | number | boolean>;
          if (legacyAgent) {
            if (data.modelParams !== undefined && (!data.modelParams || typeof data.modelParams !== "object" || Array.isArray(data.modelParams))) throw new Error("Legacy Agent settings must be an object.");
            const legacy = (data.modelParams ?? {}) as Record<string, unknown>;
            params = {
              ...(typeof data.actorAgentId === "string" && data.actorAgentId ? { agentId: data.actorAgentId } : {}),
              ...(typeof legacy.acp_model === "string" && legacy.acp_model.trim() ? { modelId: legacy.acp_model.trim() } : {}),
              ...(typeof legacy.system_prompt === "string" ? { systemPrompt: legacy.system_prompt } : {}),
            };
          }
          const textDocuments = attached.filter(entry => entry?.type === "text" && entry.data.documentRevision !== undefined);
          const rawPrompt = typeof data.content === "string" ? data.content : typeof data.prompt === "string" ? data.prompt : "";
          let authored: Pick<GeneratorRevision, "state" | "persistentInputRefs"> = createActionCardPromptEdit(rawPrompt, actionCard.generator!, id => canvas.readNode(id) ?? undefined)({ state: { ...params, prompt: rawPrompt }, persistentInputRefs: [] }, definition);
          const compiled = buildGenerationPayload({ prompt: authored.state.prompt as string,
            refNodes: attached.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && !textDocuments.includes(entry)), configId: actionCard.id,
            config: { kind: "custom", customDef: CustomActionDefinitionSchema.parse(actionCard), customActionParams: params }, actionType: `custom:${actionCard.id}` });
          authored = { ...authored, state: { ...authored.state, prompt: compiled.cleanedPrompt } };
          for (const sourceDocument of textDocuments) {
            const asset = canvasAssetRevision(sourceDocument);
            if (!asset) throw new Error("A connected Document revision is unavailable.");
            authored = appendActionCardInput(authored, actionCard.generator!, definition, asset, "text");
          }
          for (const legacy of canvasActionAssetInputs({ node: source, nodes: canvas.listNodes(), edges }) ?? []) {
            const asset = readProjectAsset(draft, legacy.projectAssetId);
            if (!asset || asset.lifecycle.state !== "active") throw new Error(`Project Asset ${legacy.projectAssetId} is unavailable.`);
            authored = appendActionCardInput(authored, actionCard.generator!, definition, { kind: "media", projectAssetId: asset.id }, asset.kind);
          }
          const generatorId = randomUUID();
          const revision = validateLocalGeneratorRevisionContract({ doc: draft, definition, revision: {
            id: randomUUID(), generatorId, definitionRef: { pluginId: definition.pluginId, definitionId: definition.definitionId, version: definition.version, schemaHash: definition.schemaHash }, ...authored,
          } });
          const created = createProjectGenerator(draft, { head: { id: generatorId, headRevisionId: revision.id }, revision });
          if (!created.ok) throw new Error(created.error.message);
          const retired = replaceDraftActionAssetInputBindings(draft, `node:${nodeId}`, []);
          if (!retired.ok) throw new Error(retired.error);
          draft.getMap("nodes").set(nodeId, { ...node, data: { ...canvasModelPlacementData(data), generatorId, actionCardId: actionCard.id } });
          migratedNodeIds.push(nodeId);
          continue;
        }
        const requested = typeof data.modelId === "string" ? data.modelId : typeof data.model === "string" ? data.model : "";
        const card = cards.find((candidate) => candidate.id === (normalizeModelId(requested) ?? requested));
        const definition = definitions.find((candidate) => candidate.pluginId === "clash.model-generation" && candidate.definitionId === kind);
        if (!card || card.kind !== kind || !definition) throw new Error(`Model ${requested || "(missing)"} or its ${kind} Generator Definition is unavailable.`);
        const canvas = new Canvas(draft, () => {}, node.canvasId ?? "main", cards);
        const source = canvas.readNode(nodeId)!;
        const nodes = canvas.listNodes();
        const edges = canvas.listEdges();
        const attached = edges.filter((edge) => edge.target === nodeId && edge.type !== "copy-on-write").map((edge) => canvas.readNode(edge.source));
        if (attached.some((entry) => !entry)) throw new Error("An incoming Canvas reference is missing.");
        for (const entry of attached) {
          if (entry && referenceModality(entry) && referenceModality(entry) !== "text" && !referenceAssetId(entry)) throw new Error(`Canvas reference ${entry.id} has no applied Asset.`);
        }
        if (data.modelParams !== undefined && (!data.modelParams || typeof data.modelParams !== "object" || Array.isArray(data.modelParams))) throw new Error("Legacy Model parameters must be an object.");
        const textDocuments = attached.filter(entry => entry?.type === "text" && entry.data.documentRevision !== undefined);
        const rawPrompt = typeof data.content === "string" ? data.content : typeof data.prompt === "string" ? data.prompt : "";
        const mentionedNodeIds = new Set(parsePromptParts(rawPrompt).flatMap(part => part.nodeId ? [part.nodeId] : []));
        // Reuse the shipped Canvas compiler for text snapshots, director context and music mapping.
        // Draft migration deliberately does not require Run-ready prompt/parameter values.
        const compiled = buildGenerationPayload({
          prompt: rawPrompt,
          // Lyrics remain authored state; map them only when admitting a Run.
          lyrics: undefined,
          // Applied Documents remain exact inputs. Mentioned authored text is frozen
          // by the shared editor below, so do not append a second text snapshot here.
          refNodes: attached.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && !textDocuments.includes(entry) && !(entry?.type === "text" && mentionedNodeIds.has(entry.id))),
          configId: card.id, config: { kind: "model", modelCard: card, modelParams: (data.modelParams ?? {}) as Record<string, string | number | boolean> },
          actionType: data.actionType as "image-gen" | "video-gen" | "audio-gen" | "model-gen" | "text-gen",
          label: typeof data.label === "string" ? data.label : undefined,
        });
        const persistentInputRefs: GeneratorRevision["persistentInputRefs"] = [];
        for (const legacy of canvasActionAssetInputs({ node: source, nodes, edges }) ?? []) {
          const asset = readProjectAsset(draft, legacy.projectAssetId);
          if (!asset || asset.lifecycle.state !== "active") throw new Error(`Project Asset ${legacy.projectAssetId} is unavailable.`);
          persistentInputRefs.push(createModelMediaInput({ modelId: card.id, model: card, inputs: persistentInputRefs, kind: asset.kind, projectAssetId: asset.id }));
        }
        const state: GeneratorRevision["state"] = { modelId: card.id, prompt: compiled.cleanedPrompt,
          params: Object.fromEntries(Object.entries(compiled.pendingInput.modelParams ?? {}).filter(([key]) => key !== "provider_id" && key !== "require_real_provider")),
        };
        if (card.musicInput) {
          const params = state.params as Record<string, import("@clash/shared-types").ExecutablePluginJsonValue>;
          const legacyParams = (data.modelParams ?? {}) as Record<string, unknown>;
          const lyricsParam = card.musicInput.lyricsParam;
          const legacyLyrics = lyricsParam ? legacyParams[lyricsParam] : undefined;
          state.lyrics = typeof data.lyrics === "string" ? data.lyrics : typeof legacyLyrics === "string" ? legacyLyrics : "";
          if (lyricsParam) delete params[lyricsParam];
          const titleParam = card.musicInput.titleParam;
          if (titleParam && !params[titleParam] && typeof data.label === "string") params[titleParam] = data.label;
        }
        if (["ordered-content-parts", "positional-tokens"].includes(card.input.referenceBinding?.type ?? "")) {
          state.contentParts = modelPromptPartsWithInputs(state, persistentInputRefs);
        }
        const generatorId = randomUUID();
        let authored: GeneratorRevision = {
          id: randomUUID(), generatorId, definitionRef: { pluginId: definition.pluginId, definitionId: definition.definitionId, version: definition.version, schemaHash: definition.schemaHash },
          state, persistentInputRefs,
        };
        authored = { ...authored, ...createModelPromptEdit(compiled.pendingInput.prompt, id => canvas.readNode(id) ?? undefined)(authored) };
        for (const sourceDocument of textDocuments) {
          if (!sourceDocument) continue;
          authored = { ...authored, ...createModelTextReferenceEdit(sourceDocument, typeof sourceDocument.data.label === "string" ? sourceDocument.data.label : "")(authored) };
        }
        const revision = validateLocalGeneratorRevisionContract({ doc: draft, definition, revision: authored });
        const created = createProjectGenerator(draft, { head: { id: generatorId, headRevisionId: revision.id }, revision });
        if (!created.ok) throw new Error(created.error.message);
        const retired = replaceDraftActionAssetInputBindings(draft, `node:${nodeId}`, []);
        if (!retired.ok) throw new Error(retired.error);
        // Format conversion preserves the node identity and edges even for immutable placements.
        draft.getMap("nodes").set(nodeId, { ...node, data: { ...canvasModelPlacementData(data), generatorId } });
        migratedNodeIds.push(nodeId);
      } catch (error) {
        return { ok: false, error: { code: "CANVAS_GENERATOR_MIGRATION_FAILED", message: error instanceof Error ? error.message : String(error), nodeId } };
      }
    }
    return { ok: true, migratedNodeIds };
  });
}
