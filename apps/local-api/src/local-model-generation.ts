import { modelInputRefsInPromptOrder, type GeneratorRevision } from "@clash/shared-types";
import type { LoroDoc } from "loro-crdt";
import { canonicalMetadataBody, readMetadataBody } from "@clash/shared-runtime";
import {
  applyModelProviderImplementation,
  isModelGenerationOutputType,
  buildGenerationPayload,
  ExecutablePluginJsonValueSchema,
  MEDIA_REFERENCE_FIELDS,
  readProjectAsset,
  readDocumentAssetRevision,
  MODEL_TEXT_DOCUMENT_KIND,
  MODEL_TEXT_DOCUMENT_SCHEMA_VERSION,
  parseDocumentBody,
  validateGenerationInput,
  validateReferenceMedia,
  type ReferenceMediaMetadata,
  type ActionRunModelRoute,
  type ExecutablePluginReference,
  type ModelCard,
  type GeneratorInputRef,
} from "@clash/shared-types";
import type { ExternalAigcService } from "./local-aigc.js";
import type { createLocalGeneratorProductService } from "./local-generator-product.js";

type ModelExecutionPlanner = NonNullable<Parameters<typeof createLocalGeneratorProductService>[0]["resolveModelExecution"]>;

/** Model Cards own capability validation; Providers only plan the chosen execution route. */
export function createLocalModelExecutionPlanner(options: {
  aigc: ExternalAigcService;
  modelCards: () => Promise<ModelCard[]>;
  dataDir?: string;
}): ModelExecutionPlanner {
  return async ({ projectId, doc, prepared, pinnedSelection, providerAccountId }) => {
    const { modelId, prompt, params = {} } = prepared.revision.state;
    if (typeof modelId !== "string" || typeof prompt !== "string" ||
      !params || typeof params !== "object" || Array.isArray(params)) {
      throw new Error("Model generation state requires modelId, prompt, and an optional params object.");
    }
    if ("provider_id" in params || "require_real_provider" in params) {
      throw new Error("Provider routing is private execution state; use submission providerAccountId instead of revision params.");
    }
    const card = (await options.modelCards()).find((candidate) => candidate.id === modelId);
    const output = prepared.outputContract[0];
    if (!card || !output || !isModelGenerationOutputType(output.assetType) ||
      card.kind !== (output.assetType.kind === "media" ? output.assetType.mediaKind : "text")) {
      throw new Error(`Model ${modelId} does not match the Generator's output kind.`);
    }
    if (pinnedSelection && pinnedSelection.modelId !== modelId) {
      throw new Error("Recovery must retain the model frozen with this Run.");
    }
    const inputRefs = [...prepared.revision.persistentInputRefs, ...prepared.invocationInputRefs];
    const textDocuments = new Map<string, string>();
    for (const ref of inputRefs) {
      if (!("kind" in ref.target) || ref.target.kind !== "document") continue;
      const revision = readDocumentAssetRevision(doc, ref.target);
      if (!revision || revision.documentKind !== MODEL_TEXT_DOCUMENT_KIND || revision.schemaVersion !== MODEL_TEXT_DOCUMENT_SCHEMA_VERSION) {
        throw new Error(`Model input ${ref.slot} requires an exact plain-text Document revision.`);
      }
      if (!options.dataDir) throw new Error("The Host Document body store is unavailable.");
      const body = await readMetadataBody({ dataDir: options.dataDir, contentHash: revision.body.digest });
      if (Buffer.byteLength(canonicalMetadataBody(body)) !== revision.body.byteLength) throw new Error("Text Document body length does not match its revision.");
      const text = parseDocumentBody(revision.documentKind, revision.schemaVersion, body);
      if (typeof text !== "string") throw new Error("Model text Document body must be a string.");
      textDocuments.set(JSON.stringify([ref.target.documentAssetId, ref.target.revisionId]), text);
    }
    const references = resolveModelGenerationReferences({
      doc, revisionId: prepared.revision.id, prompt,
      inputRefs, textDocuments,
      contentParts: prepared.revision.state.contentParts,
      orderedContent: ["ordered-content-parts", "positional-tokens"].includes(card.input.referenceBinding?.type ?? ""),
    });
    const authoredLyrics = prepared.revision.state.lyrics;
    if (authoredLyrics !== undefined && typeof authoredLyrics !== "string") throw new Error("Model Lyrics must be text.");
    let executionPrompt = prompt;
    let executionParams = params;
    if (card.musicInput && typeof authoredLyrics === "string") {
      const compiled = buildGenerationPayload({ prompt, lyrics: authoredLyrics, refNodes: [], configId: card.id,
        config: { kind: "model", modelCard: card, modelParams: params as Record<string, string | number | boolean> }, actionType: "audio-gen",
      });
      if (compiled.validationError) throw new Error(compiled.validationError);
      executionPrompt = compiled.cleanedPrompt;
      executionParams = compiled.pendingInput.modelParams ?? {};
    }
    const plan = await options.aigc.planProviderPlugin?.({
      taskId: prepared.revision.id, projectId, model: modelId, prompt: executionPrompt, modelParams: executionParams,
      ...(providerAccountId ? { providerAccountId } : {}),
      references, ...(pinnedSelection ? { providerRoute: pinnedSelection.route } : {}),
    }, card.kind);
    if (!plan?.route) throw new Error(`Model ${modelId} requires a resolvable Provider executor.`);
    const effectiveCard = applyModelProviderImplementation(card, plan.route);
    const mediaReferences: ReferenceMediaMetadata[] = references.flatMap((ref) => {
      if (!("asset" in ref)) return [];
      const asset = readProjectAsset(doc, ref.asset.assetId)!;
      return [{ modality: asset.kind, contentType: asset.metadata.contentType,
        fileName: asset.metadata.originalName ?? asset.name,
        bytes: asset.metadata.bytes, width: asset.metadata.width, height: asset.metadata.height,
        durationMs: asset.metadata.durationMs, frameRate: asset.metadata.frameRate,
        videoCodec: asset.metadata.videoCodec, audioCodec: asset.metadata.audioCodec }];
    });
    const mediaError = validateReferenceMedia(effectiveCard, mediaReferences, { modelParams: executionParams as Record<string, string | number | boolean> });
    if (mediaError) throw new Error(mediaError);
    const referenceIds = Object.fromEntries(MEDIA_REFERENCE_FIELDS.map((field) => [field.pendingField,
      references.flatMap((ref) => "asset" in ref && ref.asset.kind === field.modality ? [ref.asset.assetId] : []),
    ]));
    const error = validateGenerationInput({ prompt: executionPrompt, modelCard: effectiveCard,
      modelParams: executionParams as Record<string, string | number | boolean>, ...referenceIds,
    });
    if (error) throw new Error(error);
    const route: ActionRunModelRoute = {
      providerId: plan.provider, upstreamId: plan.route.upstreamId,
      upstreamModel: plan.route.upstreamModel, apiShape: plan.route.apiShape,
      ...(plan.route.region ? { region: plan.route.region } : {}),
      executorPluginId: plan.binding.pluginId, executorExportId: plan.binding.exportId,
      executorBinding: plan.binding, assetInputs: plan.assetInputs,
    };
    return {
      selection: { semanticShape: card.semanticShape ?? `${card.kind}_generation`, modelId, route },
      execution: { binding: plan.binding, ...(plan.accountId ? { accountId: plan.accountId } : {}),
        assetInputs: plan.assetInputs,
        input: { values: Object.fromEntries(Object.entries(plan.input.values).map(([key, value]) =>
          [key, ExecutablePluginJsonValueSchema.parse(value)])), references: plan.input.references },
      },
    };
  };
}

/** Resolve immutable native inputs without consulting mutable Canvas nodes. */
export function resolveModelGenerationReferences(input: {
  doc: LoroDoc;
  revisionId: string;
  prompt: string;
  inputRefs: GeneratorInputRef[];
  contentParts?: unknown;
  /** Model wire contract. Authored sections are validated in either mode. */
  orderedContent?: boolean;
  /** Exact revision bodies resolved and verified by the Host before compilation. */
  textDocuments?: ReadonlyMap<string, string>;
}): ExecutablePluginReference[] {
  const key = (slot: string, itemKey?: string) => JSON.stringify([slot, itemKey ?? null]);
  const indexes = new Map<string, number>();
  const byKey = new Map<string, ExecutablePluginReference>();
  const references = input.inputRefs.map((ref) => {
    const index = indexes.get(ref.slot) ?? 0;
    indexes.set(ref.slot, index + 1);
    const identity = key(ref.slot, ref.itemKey);
    if (byKey.has(identity)) throw new Error(`Duplicate Model input identity ${identity}.`);
    if ("kind" in ref.target && ref.target.kind === "document") {
      const revisionKey = JSON.stringify([ref.target.documentAssetId, ref.target.revisionId]);
      const value = input.textDocuments?.get(revisionKey);
      if (value === undefined) throw new Error(`Model text input ${ref.slot} has no verified revision body.`);
      const reference = { slot: ref.slot, index, text: { nodeId: revisionKey, value } };
      byKey.set(identity, reference);
      return reference;
    }
    const asset = "kind" in ref.target && ref.target.kind === "media"
      ? readProjectAsset(input.doc, ref.target.projectAssetId) : null;
    if (!asset || asset.lifecycle.state !== "active") {
      throw new Error(`Model input ${ref.slot} requires an active immutable media Asset.`);
    }
    const reference = { slot: ref.slot, index, asset: {
      assetId: asset.id, uri: `clash-asset://${asset.id}`, kind: asset.kind,
      ...(asset.metadata.contentType ? { mediaType: asset.metadata.contentType } : {}),
    } };
    byKey.set(identity, reference);
    return reference;
  });
  if (input.contentParts === undefined) return references;
  if (!Array.isArray(input.contentParts)) throw new Error("Model contentParts must be an array.");
  const used = new Set<string>();
  let prompt = "";
  const ordered: ExecutablePluginReference[] = input.contentParts.map((part: unknown, index: number) => {
    if (!part || typeof part !== "object") throw new Error("Invalid Model content part.");
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      prompt += p.text;
      return { slot: "content", index, text: { nodeId: `${input.revisionId}:prompt:${index}`, value: p.text } };
    }
    if (p.type !== "input" || typeof p.slot !== "string" ||
      (p.itemKey !== undefined && typeof p.itemKey !== "string") ||
      (p.label !== undefined && typeof p.label !== "string")) throw new Error("Invalid Model input content part.");
    const identity = key(p.slot, p.itemKey as string | undefined);
    const reference = byKey.get(identity);
    if (!reference) throw new Error(`Model content part references missing input ${identity}.`);
    used.add(identity);
    prompt += p.label ?? "";
    return { ...reference, slot: "content", index };
  });
  if (used.size !== byKey.size) throw new Error("Model contentParts must place every input; unplaced inputs cannot be silently dropped.");
  if (prompt !== input.prompt) throw new Error("Model prompt must match its contentParts text and input labels.");
  if (input.orderedContent !== false) return ordered;
  const positionalIndexes = new Map<string, number>();
  return modelInputRefsInPromptOrder({ prompt: input.prompt, contentParts: input.contentParts as GeneratorRevision["state"][string] }, input.inputRefs).map(ref => {
    const reference = byKey.get(key(ref.slot, ref.itemKey))!;
    const index = positionalIndexes.get(ref.slot) ?? 0;
    positionalIndexes.set(ref.slot, index + 1);
    return { ...reference, index };
  });
}

/** Freeze a Canvas compatibility request into the same authored native input model. */
export function modelGenerationRevisionFromReferences(input: {
  modelId: string;
  prompt: string;
  params: Record<string, unknown>;
  references: ExecutablePluginReference[];
  contentLabels?: string[];
}): { state: Record<string, import("@clash/shared-types").ExecutablePluginJsonValue>; persistentInputRefs: GeneratorInputRef[] } {
  const persistentInputRefs: GeneratorInputRef[] = [];
  const contentParts: import("@clash/shared-types").ExecutablePluginJsonValue[] = [];
  const mixed = input.references.some((ref) => ref.slot === "content");
  for (const [index, reference] of input.references.entries()) {
    if ("text" in reference) {
      if (!mixed) throw new Error("Model text inputs require an ordered content sequence.");
      contentParts.push({ type: "text", text: reference.text.value });
      continue;
    }
    if (!("asset" in reference)) throw new Error("Model generation requires immutable media inputs.");
    const slot = mixed ? reference.asset.kind : reference.slot;
    const itemKey = slot === "startFrame" || slot === "endFrame" ? undefined : `input-${String(index).padStart(8, "0")}`;
    persistentInputRefs.push({ slot, ...(itemKey ? { itemKey } : {}),
      target: { kind: "media", projectAssetId: reference.asset.assetId },
    });
    if (mixed) contentParts.push({ type: "input", slot, ...(itemKey ? { itemKey } : {}), label: input.contentLabels?.[index] ?? "" });
  }
  return {
    state: { modelId: input.modelId, prompt: input.prompt,
      // Legacy Canvas fields never gain routing authority by being migrated.
      params: Object.fromEntries(Object.entries(input.params)
        .filter(([key, value]) => value !== undefined && key !== "provider_id" && key !== "require_real_provider")
        .map(([key, value]) => [key, ExecutablePluginJsonValueSchema.parse(value)])),
      ...(mixed ? { contentParts } : {}),
    },
    persistentInputRefs,
  };
}
