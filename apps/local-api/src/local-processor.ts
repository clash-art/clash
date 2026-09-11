import { coerceModelParameterInput } from "@clash/shared-types";
import { createLocalGeneratorProductService } from "./local-generator-product.js";
import { createLocalModelExecutionPlanner, modelGenerationRevisionFromReferences } from "./local-model-generation.js";
import { createHash, randomUUID } from "node:crypto";
import type { LoroDoc } from "loro-crdt";
import {
  canonicalMetadataBody,
  createBoundedRetryPolicy,
  durableRunIdempotencyKey,
  readMetadataBody,
  storeMetadataBody,
} from "@clash/shared-runtime";
import {
  DocumentAssetRevisionSchema,
  MODEL_TEXT_DOCUMENT_KIND,
  MODEL_TEXT_DOCUMENT_SCHEMA_VERSION,
  GeneratorRevisionRefSchema,
  extractPromptText,
  ActionBindingOwnerSchema,
  ensureActionAssetBinding,
  ExecutablePluginBindingSchema,
  ExecutablePluginJsonValueSchema,
  getDocumentKindDefinition,
  hostMutationSucceeded,
  listActionAssetBindingsForOwner,
  listProjectAssets,
  MODEL_CARDS,
  normalizeModelId,
  parseDocumentBody,
  parsePromptParts,
  ProjectAssetEntrySchema,
  ProjectTimelineEnvelopeSchema,
  readProjectAsset,
  Canvas,
  readProjectActionRun,
  resolveExecutableActionCardGenerator,
  replaceDraftActionAssetInputBindings,
  readOutputCommit,
  readGeneratorRevision,
  readProjectTimeline,
  validateReferenceMedia,
  validateRefs,
  MEDIA_REFERENCE_FIELDS,
  MEDIA_REFERENCE_MODALITIES,
} from "@clash/shared-types";
import { expectedProviderReceiptOwner } from "./local-provider-receipt-ownership.js";
import type {
  ExecutablePluginJsonValue,
  ExecutablePluginReference,
  ExecutablePluginResult,
  ActionBindingOwner,
  ActionAssetBinding,
  ModelCard,
  ProjectAssetEntry,
  ProjectTimelineEnvelope,
  ReferenceMediaMetadata,
  TextAppliedRevision,
  DocumentAssetRevision,
  MediaReferenceModality,
} from "@clash/shared-types";
import type { AssetKind } from "@clash/shared-types/assets";
import {
  createMockExternalAigcService,
  ProviderPluginHostUnavailableError,
  type ExternalAigcService,
  type ProviderPluginExecutor,
} from "./local-aigc.js";
import {
  createLocalDurableRunCoordinator,
  DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS,
  pluginOutputSlotsForDurableRun,
  type FrozenLocalProviderExecutorInput,
} from "./durable-run-coordinator.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { createProviderExecutionHandoffStore } from "./provider-execution-handoff.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import {
  createLocalProjectAssetService,
  publishLocalProjectAssetWithBindings,
} from "./local-project-assets.js";
import { createLocalPluginAssetStagingStore } from "./local-plugin-asset-staging.js";
import { createLocalDurableOutputStagingStore } from "./local-durable-output-staging.js";
import { createLocalGeneratorRunBridge } from "./local-generator-run-bridge.js";
import type { LocalAssetInspectionService } from "./local-asset-inspections.js";
import type { LocalAssetRepresentationService } from "./local-asset-representations.js";
import { storeTextRevisionContentBlob } from "./text-revision-content.js";
import type {
  ExecutablePluginActionInvoker,
  ExecutablePluginActionRequest,
} from "./plugin-action-runtime.js";

export interface LocalWorkflowProcessorInput {
  doc: LoroDoc;
  projectId: string;
  broadcastJson?: (msg: Record<string, unknown>) => void;
  /** Persist mutations that must survive before an external side effect starts. */
  checkpoint?: () => Promise<void>;
}

/** Static/rigid vs. rigged/deformable 3-D output models, by provider model id. `0` is
 *  static/rigid, `1` is rigged/deformable -- a normalized rig/deform capability, not a bone
 *  count or physical degree of freedom. Only meaningful for the `model` asset kind. */
const STATIC_RIGID_MODEL_IDS = new Set(["meshy-6", "meshy-7", "tripo-h3.1"]);
const RIGGED_DEFORMABLE_MODEL_IDS = new Set([
  "meshy-auto-rig",
  "tripo-auto-rig",
  "move-ai-s2",
]);

export function modelOutputFlexibility(
  kind: string,
  modelId: unknown,
): 0 | 1 | undefined {
  if (kind !== "model" || typeof modelId !== "string") return undefined;
  if (STATIC_RIGID_MODEL_IDS.has(modelId)) return 0;
  if (RIGGED_DEFORMABLE_MODEL_IDS.has(modelId)) return 1;
  return undefined;
}

export interface LocalWorkflowProcessor {
  process(input: LocalWorkflowProcessorInput): Promise<boolean>;
  /** Earliest owner-private durable wake time; Project Loro is never scanned for scheduling. */
  nextWakeAt?(projectId?: string): Promise<number | undefined>;
  /** Test replay override; production rooms retain their one-second busy-loop floor. */
  minimumPollDelayMs?: number;
}

export interface LocalWorkflowProcessorOptions {
  dataDir: string;
  /** Process-owned Resource inspection registry shared with Asset HTTP reads. */
  assetInspection?: LocalAssetInspectionService;
  /** Process-owned derived representation consumer shared with Asset HTTP reads. */
  assetRepresentations?: Pick<
    LocalAssetRepresentationService,
    "schedule" | "read"
  >;
  userId?: string;
  mediaBaseUrl?: string | (() => string);
  aigc?: ExternalAigcService;
  modelCards?: () => Promise<ModelCard[]>;
  /** Activated Action Cards can explicitly project a native Generator Action. */
  listPluginCards?: () => Promise<import("@clash/shared-types").ExecutablePluginCardRegistration[]>;
  /** Production Model execution uses native Generator definitions. */
  resolveGeneratorDefinition?: (pluginId: string, definitionId: string) => Promise<import("@clash/shared-types").GeneratorDefinition>;
  executablePluginAction?: ExecutablePluginActionInvoker;
  /** Resolve one active, schema-pinned Action before a durable run is frozen. */
  resolvePluginBinding?: (
    pluginId: string,
    exportId: string,
    kind: "action",
  ) => Promise<ReturnType<typeof ExecutablePluginBindingSchema.parse>>;
  /**
   * Resolve the exact Provider executor binding a frozen `modelRoute` names.
   *
   * Used only to verify a generic model-consumer Action's staged media receipt was produced by
   * the same Provider executor plugin/version the Host froze at Run submission -- never to widen
   * ownership to an arbitrary cross-plugin handle.
   */
  resolveProviderExecutorBinding?: (
    pluginId: string,
    exportId: string,
  ) => Promise<ReturnType<typeof ExecutablePluginBindingSchema.parse>>;
  durableProviderRuns?: {
    ownerId: string;
    providerPluginExecutor: ProviderPluginExecutor;
    now?: () => number;
  };
  /** Host-owned lifetime for the whole generation run, never a plugin HTTP-call timeout. */
  providerGenerationDeadlineMs?: number;
  /** Replay harness only: compress wall-clock waits while preserving provider responses and deadline. */
  providerPollDelayCapMs?: number;
  textAgent?: {
    generate(input: {
      projectId: string;
      prompt: string;
      modelId?: string;
      modelParams?: Record<string, unknown>;
      actorAgentId?: string;
    }): Promise<{ text: string; provider?: string; modelEndpoint?: string }>;
  };
}

const LOCAL_EXECUTOR_BINDING = ExecutablePluginBindingSchema.parse({
  pluginId: "clash.local-executor",
  version: "1.0.0",
  exportId: "execute",
  schemaHash: `sha256:${createHash("sha256")
    .update("clash.local-executor/v1")
    .digest("hex")}`,
});

const REMOTION_RENDER_PLUGIN_ID = "clash.remotion";
const REMOTION_RENDER_EXPORT_ID = "render-timeline";

function jsonSnapshot(value: unknown): ExecutablePluginJsonValue {
  return ExecutablePluginJsonValueSchema.parse(
    JSON.parse(JSON.stringify(value)) as unknown,
  );
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
  if (serialized === undefined) {
    throw new TypeError("Action revision input must be JSON-serializable.");
  }
  return serialized;
}

type ProcessableKind = Extract<AssetKind, "image" | "video" | "audio" | "model">;
type ProcessableNodeKind = ProcessableKind | "text";

function sanitizeStorageSegment(value: string): string {
  return (
    value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "item"
  );
}

function modelParams(
  data: Record<string, unknown>,
): Record<string, string | number | boolean | undefined> {
  const params = data.modelParams;
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const projectVisibleParams = {
    ...(params as Record<string, string | number | boolean | undefined>),
  };
  // Concrete provider/account routing is owner-private execution state. A legacy replica may still
  // contain this field, but it must never regain authority over a new run.
  delete projectVisibleParams.provider_id;
  return projectVisibleParams;
}

function stringParam(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key] ?? modelParams(data)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParam(
  data: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = data[key] ?? modelParams(data)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/s$/i, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function authoredPromptFromData(
  data: Record<string, unknown>,
  fallback: string,
): string {
  return typeof data.prompt === "string" && data.prompt.trim()
    ? data.prompt
    : typeof data.label === "string" && data.label.trim()
      ? data.label
      : fallback;
}

/** Flat local adapters consume plain text plus separate reference arrays. Keep
 * authored @-mentions on the node and collapse them only at this boundary. */
function providerPromptFromData(
  data: Record<string, unknown>,
  fallback: string,
): string {
  const authoredPrompt = authoredPromptFromData(data, fallback);
  return extractPromptText(parsePromptParts(authoredPrompt));
}

function modelFromData(
  data: Record<string, unknown>,
  fallback: string,
): string {
  return typeof data.modelId === "string" && data.modelId.trim()
    ? data.modelId
    : typeof data.model === "string" && data.model.trim()
      ? data.model
      : fallback;
}

function aspectRatioFromData(
  data: Record<string, unknown>,
): string | undefined {
  return stringParam(data, "aspectRatio") ?? stringParam(data, "aspect_ratio");
}

/**
 * The duration to use when nothing asked for one.
 *
 * Reads the Card rather than naming a number: `defaultParams` first, then the parameter's
 * own `defaultValue`, then the first candidate on the menu. A house constant looks safe
 * because most models accept it, but any model whose menu omits it fails validation before
 * a request is ever made -- `seedance-2-fast-startend` offers [auto, 4, 6, 8, 10, 15] and
 * was handed 5.
 */
/** Submit, provider wait, and ordinary polls share this one absolute budget. */
function providerGenerationDeadlineMs(value: number | undefined): number {
  const deadlineMs = value ?? DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new TypeError(
      "providerGenerationDeadlineMs must be a positive safe integer",
    );
  }
  return deadlineMs;
}

function providerGenerationTimeoutMessage(deadlineMs: number): string {
  return `Provider did not reach a final state within ${deadlineMs}ms after submission.`;
}

/** One-way cleanup for replicas authored by the pre-journal implementation. */
const LEGACY_PRIVATE_PROVIDER_NODE_FIELDS = [
  "providerPollState",
  "providerPollAt",
  "providerAcceptedAt",
  "providerStartedAt",
  "providerDeadlineAt",
  "providerFinalPolledAt",
  "providerAccountId",
  "provider_id",
] as const;

function durableProviderNodeData(
  data: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...data, ...updates };
  for (const field of LEGACY_PRIVATE_PROVIDER_NODE_FIELDS) delete next[field];
  if (
    next.modelParams &&
    typeof next.modelParams === "object" &&
    !Array.isArray(next.modelParams)
  ) {
    const params = { ...(next.modelParams as Record<string, unknown>) };
    delete params.provider_id;
    next.modelParams = params;
  }
  delete next.pendingTask;
  delete next.pendingTaskAt;
  if (updates.documentRevision !== undefined) {
    delete next.content;
    delete next.textRevision;
  }
  if (updates.status !== "failed") {
    delete next.error;
    delete next.failureCode;
  }
  return next;
}

function canvasNodeProjectionRevisionId(input: {
  projectId: string;
  nodeId: string;
  kind: ProcessableNodeKind;
  nodeData: Record<string, unknown>;
  targetKind?: "generation" | "action";
  executionPrompt?: string;
  resolveMention: (
    nodeId: string,
  ) => { assetId: string; kind: ProcessableKind } | undefined;
}): string {
  if (input.nodeData.generatorRevision !== undefined) {
    // Native requests are identified by their pinned revision. View-only fields
    // cannot change execution; rewiring the revision must invalidate publication.
    // Validate inside per-node admission so a malformed reference fails that node only.
    const generatorRevision = input.nodeData.generatorRevision;
    return `sha256:${createHash("sha256").update(canonicalJson({
      projectId: input.projectId, nodeId: input.nodeId, kind: input.kind, generatorRevision,
      ...(input.nodeData.generatorActionId === undefined ? {} : { generatorActionId: input.nodeData.generatorActionId }),
    })).digest("hex")}`;
  }
  const targetKind = input.targetKind ?? (
    typeof input.nodeData.actionType === "string" && input.nodeData.actionType.startsWith("custom:")
      ? "action" : "generation"
  );
  const prompt = input.executionPrompt ?? (targetKind === "action"
    ? customActionPromptFromData(input.nodeData)
    : authoredPromptFromData(input.nodeData, `Mock ${input.kind}`));
  const mentions: Array<
    | {
        index: number;
        nodeId: string;
        assetId: string;
        kind: ProcessableKind;
      }
    | { index: number; nodeId: string; missing: true }
  > = [];
  for (const [index, part] of parsePromptParts(prompt).entries()) {
    if (part.type !== "asset_ref" || !part.nodeId) continue;
    const resolved = input.resolveMention(part.nodeId);
    mentions.push(
      resolved
        ? { index, nodeId: part.nodeId, ...resolved }
        : { index, nodeId: part.nodeId, missing: true },
    );
  }
  const parsedBinding = ExecutablePluginBindingSchema.safeParse(
    input.nodeData.pluginBinding,
  );
  const commonProjection = {
    schemaVersion: 1,
    projectId: input.projectId,
    nodeId: input.nodeId,
    kind: input.kind,
    actionType: input.nodeData.actionType,
    prompt,
    // One projected field per `MEDIA_REFERENCE_FIELDS` registry entry
    // (image / video / audio / model today) so a new reference modality
    // only needs a registry entry, not a new field here.
    ...Object.fromEntries(
      MEDIA_REFERENCE_FIELDS.map((field) => [
        field.pendingField,
        stringList(input.nodeData[field.pendingField]),
      ]),
    ),
    mentions,
    ...(parsedBinding.success ? { pluginBinding: parsedBinding.data } : {}),
  };
  const semanticProjection =
    targetKind === "action"
      ? {
          ...commonProjection,
          customActionId: input.nodeData.customActionId,
          customActionParams: input.nodeData.customActionParams,
          outputType: input.nodeData.outputType,
        }
      : {
          ...commonProjection,
          model: modelFromData(input.nodeData, `mock-${input.kind}`),
          modelParams: modelParams(input.nodeData),
          aspectRatio: aspectRatioFromData(input.nodeData),
          duration:
            input.nodeData.duration ?? modelParams(input.nodeData).duration,
          referenceMode: input.nodeData.referenceMode,
        };
  const digest = createHash("sha256")
    .update(canonicalJson(semanticProjection))
    .digest("hex");
  return `sha256:${digest}`;
}

function canvasExecutorActionRevisionId(
  executor: Omit<FrozenLocalProviderExecutorInput, "schemaVersion">,
): string {
  let semanticInput = executor.input;
  if (
    executor.targetKind === "local-executor" &&
    executor.input.values.localExecutor === "generation"
  ) {
    const generationInput = executor.input.values.generationInput;
    if (
      generationInput &&
      typeof generationInput === "object" &&
      !Array.isArray(generationInput)
    ) {
      const {
        taskId: _taskId,
        projectId: _projectId,
        nodeId: _nodeId,
        actorType: _actorType,
        actorUserId: _actorUserId,
        actorAgentId: _actorAgentId,
        providerAccountId: _providerAccountId,
        ...semanticGenerationInput
      } = generationInput;
      semanticInput = {
        ...executor.input,
        values: {
          ...executor.input.values,
          generationInput: semanticGenerationInput,
        },
      };
    }
  }
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: 1,
        targetKind: executor.targetKind ?? "provider-executor",
        binding: executor.binding,
        ...(executor.actionId ? { actionId: executor.actionId } : {}),
        kind: executor.kind,
        projectId: executor.projectId,
        ...(executor.nodeId ? { nodeId: executor.nodeId } : {}),
        assetInputs: executor.assetInputs ?? [],
        ...(executor.delivery ? { delivery: executor.delivery } : {}),
        ...(executor.provider ? { provider: executor.provider } : {}),
        ...(executor.modelEndpoint
          ? { modelEndpoint: executor.modelEndpoint }
          : {}),
        ...(executor.nodeProjectionRevisionId
          ? { nodeProjectionRevisionId: executor.nodeProjectionRevisionId }
          : {}),
        input: semanticInput,
      }),
    )
    .digest("hex");
  return `sha256:${digest}`;
}

function durableProviderIdentity(input: {
  projectId: string;
  nodeId: string;
  kind: ProcessableNodeKind;
  actionRevisionId: string;
}): { actionRunId: string; outputSlot: string } {
  return {
    actionRunId:
      `project:${input.projectId}:node:${input.nodeId}:revision:` +
      input.actionRevisionId.slice("sha256:".length),
    outputSlot: input.kind === "text" ? "text" : "media",
  };
}

function durableActionOwner(
  frozen: FrozenLocalProviderExecutorInput,
  actionRunId: string,
): {
  kind: "run";
  actionId: string;
  actionRevisionId: string;
  actionRunId: string;
} {
  if (frozen.publicOwner) {
    return {
      kind: "run",
      ...frozen.publicOwner,
      actionRunId,
    };
  }
  const actionId =
    frozen.delivery?.actionId ?? `node:${frozen.nodeId ?? "project"}`;
  const publicRevision = {
    targetKind: frozen.targetKind ?? "provider-executor",
    binding: frozen.binding,
    ...(frozen.actionId ? { actionId: frozen.actionId } : {}),
    kind: frozen.kind,
    projectId: frozen.projectId,
    ...(frozen.nodeId ? { nodeId: frozen.nodeId } : {}),
    ...(frozen.delivery ? { delivery: frozen.delivery } : {}),
    ...(frozen.provider ? { provider: frozen.provider } : {}),
    ...(frozen.modelEndpoint ? { modelEndpoint: frozen.modelEndpoint } : {}),
    input: frozen.input,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(publicRevision))
    .digest("hex");
  return {
    kind: "run",
    actionId,
    actionRevisionId: `sha256:${digest}`,
    actionRunId,
  };
}

function isCurrentProviderNodeRevision(input: {
  frozen: FrozenLocalProviderExecutorInput;
  actionRunId: string;
  nodeData: Record<string, unknown>;
  currentProjectionRevisionId: string;
}): boolean {
  const { frozen } = input;
  if (!frozen.nodeId) return true;
  if (frozen.publicOwner) {
    const owner = timelineRenderInputOwner(input.nodeData);
    if (owner) {
      return (
        owner.actionId === frozen.publicOwner.actionId &&
        owner.actionRevisionId === frozen.publicOwner.actionRevisionId
      );
    }
  }
  if (frozen.nodeProjectionRevisionId) {
    return (
      frozen.nodeProjectionRevisionId === input.currentProjectionRevisionId
    );
  }
  // Pre-guard legacy records may still finish consumer-CAS publication, but they cannot prove
  // authority to project an outcome onto the current mutable Canvas node.
  return false;
}

function frozenExecutorInput(run: {
  executorInput: unknown;
}): FrozenLocalProviderExecutorInput {
  return run.executorInput as FrozenLocalProviderExecutorInput;
}

async function beforeProviderGenerationDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error(providerGenerationTimeoutMessage(deadlineMs));
  }
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(providerGenerationTimeoutMessage(deadlineMs))),
      remainingMs,
    );
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function cardDurationFallback(
  card: ModelCard,
): number | string | undefined {
  const declared = card.defaultParams?.duration;
  if (declared !== undefined) return declared as number | string;
  const parameter = card.parameters.find(
    (candidate) => candidate.id === "duration",
  );
  if (!parameter) return undefined;
  if (parameter.defaultValue !== undefined)
    return parameter.defaultValue as number | string;
  return parameter.options?.[0]?.value as number | string | undefined;
}

export function durationFromData(
  data: Record<string, unknown>,
  card: ModelCard | undefined,
): number | string | undefined {
  const requested = numberParam(data, "duration");
  if (requested !== undefined) return Math.max(1, Math.min(30, requested));
  return card ? cardDurationFallback(card) : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function assetReference(
  asset: ProjectAssetEntry,
  slot: string,
  index: number,
): ExecutablePluginReference {
  return {
    slot,
    index,
    asset: {
      assetId: asset.id,
      uri: `clash-asset://${asset.id}`,
      kind: asset.kind,
      ...(asset.metadata.contentType
        ? { mediaType: asset.metadata.contentType }
        : {}),
    },
  };
}

type ProviderMediaReference = {
  asset: ProjectAssetEntry;
  kind: ProcessableKind;
};

/**
 * Preserve authored mixed-content order while treating the global reference arrays as a
 * multiset. One inline placement consumes one matching global occurrence; duplicate global
 * occurrences remain visible, and duplicate inline placements of the same immutable Asset remain
 * distinct positions as well.
 */
function mixedContentReferences(input: {
  nodeId: string;
  promptParts: ReturnType<typeof parsePromptParts>;
  globalReferences: ProviderMediaReference[];
  resolveMention(
    nodeId: string,
  ): { assetId: string; kind: ProcessableKind } | undefined;
}): { references: ExecutablePluginReference[]; labels: string[] } {
  const keyOf = (kind: ProcessableKind, assetId: string) =>
    `${kind}\u0000${assetId}`;
  const firstAssetByKey = new Map<string, ProjectAssetEntry>();
  const globalCountByKey = new Map<string, number>();
  for (const reference of input.globalReferences) {
    const key = keyOf(reference.kind, reference.asset.id);
    if (!firstAssetByKey.has(key)) firstAssetByKey.set(key, reference.asset);
    globalCountByKey.set(key, (globalCountByKey.get(key) ?? 0) + 1);
  }

  const consumedGlobalByKey = new Map<string, number>();
  const ordered: Array<
    { text: { nodeId: string; value: string } } | { asset: ProjectAssetEntry; label?: string }
  > = [];
  for (const [partIndex, part] of input.promptParts.entries()) {
    if (part.type === "text") {
      if (part.text) {
        ordered.push({
          text: {
            nodeId: `${input.nodeId}:prompt:${partIndex}`,
            value: part.text,
          },
        });
      }
      continue;
    }
    if (!part.nodeId) continue;
    const mention = input.resolveMention(part.nodeId);
    if (!mention) continue;
    const key = keyOf(mention.kind, mention.assetId);
    const asset = firstAssetByKey.get(key);
    if (!asset) continue;
    ordered.push({ asset, label: part.label });
    const globallyAvailable = globalCountByKey.get(key) ?? 0;
    const alreadyConsumed = consumedGlobalByKey.get(key) ?? 0;
    if (alreadyConsumed < globallyAvailable) {
      consumedGlobalByKey.set(key, alreadyConsumed + 1);
    }
  }

  const remainingInlineConsumption = new Map(consumedGlobalByKey);
  for (const reference of input.globalReferences) {
    const key = keyOf(reference.kind, reference.asset.id);
    const consume = remainingInlineConsumption.get(key) ?? 0;
    if (consume > 0) {
      remainingInlineConsumption.set(key, consume - 1);
      continue;
    }
    ordered.push({ asset: reference.asset });
  }

  return { labels: ordered.map((entry) => "asset" in entry ? entry.label ?? "" : ""), references: ordered.map((entry, index) =>
    "text" in entry
      ? { slot: "content", index, text: entry.text }
      : assetReference(entry.asset, "content", index),
  ) };
}

function textHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function textRevisionActor(
  nodeData: Record<string, unknown>,
  userId: string,
): TextAppliedRevision["actor"] | undefined {
  if (nodeData.actorType !== "user" && nodeData.actorType !== "agent")
    return undefined;
  return {
    actorType: nodeData.actorType,
    actorUserId:
      typeof nodeData.actorUserId === "string" && nodeData.actorUserId
        ? nodeData.actorUserId
        : userId,
    ...(typeof nodeData.actorAgentId === "string" && nodeData.actorAgentId
      ? { actorAgentId: nodeData.actorAgentId }
      : {}),
  };
}

function generatedTextRevision(options: {
  projectId: string;
  nodeId: string;
  content: string;
  nodeData: Record<string, unknown>;
  userId: string;
  createdAt?: string;
}): TextAppliedRevision {
  const contentHash = textHash(options.content);
  const createdAt = options.createdAt ?? new Date().toISOString();
  const actor = textRevisionActor(options.nodeData, options.userId);
  const textId = `text:${options.projectId}:${options.nodeId}`;
  const sourceFilePath = `workflow/${sanitizeStorageSegment(options.nodeId)}.md`;
  const seed = JSON.stringify({
    textId,
    contentHash,
    createdAt,
    actor: actor ?? null,
  });
  const suffix = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return {
    schemaVersion: 1,
    kind: "clash.text.revision",
    textId,
    revisionId: `txrev-${contentHash}-${suffix}`,
    projectId: options.projectId,
    nodeId: options.nodeId,
    createdAt,
    contentHash,
    hashAlgorithm: "sha256-64",
    sourceFilePath,
    sourceFileHash: contentHash,
    ...(actor ? { actor } : {}),
  };
}

async function recordGeneratedTextRevision(options: {
  dataDir: string;
  userId: string;
  projectId: string;
  nodeId: string;
  nodeData: Record<string, unknown>;
  content: string;
  createdAt?: string;
  auditId?: string;
}): Promise<TextAppliedRevision> {
  const revision = generatedTextRevision(options);
  const metadataStore = createLocalMetadataStore(options.dataDir);
  const existing = await metadataStore.getTextRevision(
    options.projectId,
    revision.revisionId,
  );
  if (existing) return existing;
  const mutation = hostMutationSucceeded(
    {
      operation: "text_generate",
      entity: { kind: "text-revision", id: revision.revisionId },
    },
    { resultEntityId: revision.revisionId },
  );
  await storeTextRevisionContentBlob(
    options.dataDir,
    revision,
    options.content,
  );
  await metadataStore.upsertTextRevision(revision, {
    id: options.auditId ?? randomUUID(),
    createdAt: Date.now(),
    operation: mutation.operation,
    entity: mutation.entity,
    actorClientType: options.nodeData.actorType === "agent" ? "agent" : null,
    accepted: mutation.accepted,
    reason: "workflow generated text",
    resultEntityId: mutation.resultEntityId ?? null,
    error: mutation.error ?? null,
    mutation,
  });
  return revision;
}

function pendingCustomNode(node: Record<string, any>): {
  actionId: string;
  outputType: ProcessableKind | "text";
} | null {
  const data = node.data;
  if (!data || typeof data !== "object") return null;
  if (
    typeof data.actionType !== "string" ||
    !data.actionType.startsWith("custom:")
  )
    return null;
  if (data.status !== "pending" && data.status !== "generating") return null;
  if (data.pendingTask) return null;
  const actionId =
    typeof data.customActionId === "string" && data.customActionId
      ? data.customActionId
      : data.actionType.slice("custom:".length);
  const outputType =
    data.outputType === "video" ||
    data.outputType === "audio" ||
    data.outputType === "text"
      ? data.outputType
      : "image";
  return { actionId, outputType };
}

function customActionPromptFromData(data: Record<string, unknown>): string {
  return extractPromptText(
    parsePromptParts(
      typeof data.prompt === "string"
        ? data.prompt
        : typeof data.content === "string"
          ? data.content
          : "",
    ),
  );
}

function pendingKindForNode(
  node: Record<string, any>,
): ProcessableNodeKind | null {
  if (
    node.type !== "image" &&
    node.type !== "video" &&
    node.type !== "audio" &&
    node.type !== "model" &&
    node.type !== "text"
  )
    return null;
  const data = node.data;
  if (!data || typeof data !== "object") return null;
  if (data.assetId) return null;
  if (data.status !== "pending" && data.status !== "generating") return null;
  if (
    node.type === "video" &&
    ((data.timeline &&
      typeof data.timeline === "object" &&
      !Array.isArray(data.timeline)) ||
      (data.timelineDsl &&
        typeof data.timelineDsl === "object" &&
        !Array.isArray(data.timelineDsl)))
  ) {
    return null;
  }

  const kind = node.type as ProcessableNodeKind;
  const expectedActionType = `${kind}-gen`;
  if (data.actionType && data.actionType !== expectedActionType) return null;
  return kind;
}

function timelineRenderEnvelope(
  doc: LoroDoc,
  data: Record<string, unknown>,
): ProjectTimelineEnvelope | null {
  const direct = ProjectTimelineEnvelopeSchema.safeParse(data.timeline);
  if (direct.success) return direct.data;

  if (
    !data.timelineDsl ||
    typeof data.timelineDsl !== "object" ||
    Array.isArray(data.timelineDsl) ||
    typeof data.sourceTimelineId !== "string"
  ) {
    return null;
  }
  const timeline = readProjectTimeline(doc, data.sourceTimelineId);
  if (
    !timeline ||
    timeline.revisionId !== data.sourceTimelineRevisionId
  ) {
    return null;
  }
  const legacy = ProjectTimelineEnvelopeSchema.safeParse({
    name: timeline.name,
    owner: timeline.owner,
    state: data.timelineDsl,
  });
  return legacy.success ? legacy.data : null;
}

function timelineRenderInputOwner(
  data: Record<string, unknown>,
): Extract<ActionBindingOwner, { kind: "run" }> | null {
  const parsed = ActionBindingOwnerSchema.safeParse({
    kind: "run",
    actionId: data.sourceTimelineActionId,
    actionRevisionId: data.sourceTimelineRevisionId,
    actionRunId: data.sourceTimelineActionRunId,
  });
  return parsed.success && parsed.data.kind === "run" ? parsed.data : null;
}

function frozenRemotionTimelineInput(options: {
  doc: LoroDoc;
  timeline: ProjectTimelineEnvelope;
  inputOwner: Extract<ActionBindingOwner, { kind: "run" }>;
}): {
  timeline: ProjectTimelineEnvelope;
  references: ExecutablePluginReference[];
} {
  const timeline = ProjectTimelineEnvelopeSchema.parse(
    structuredClone(options.timeline),
  );
  const timelineDsl = timeline.state as Record<string, any>;
  const nodes = options.doc.getMap("nodes");
  const bindings = listActionAssetBindingsForOwner(
    options.doc,
    options.inputOwner,
  ).filter((binding) => binding.direction === "input");
  const bindingBySlot = new Map<string, ActionAssetBinding>();
  for (const binding of bindings) {
    if (bindingBySlot.has(binding.slot)) {
      throw new Error(
        `Timeline render run ${options.inputOwner.actionRunId} has duplicate input slot ${binding.slot}`,
      );
    }
    bindingBySlot.set(binding.slot, binding);
  }

  const references: ExecutablePluginReference[] = [];
  for (const track of timelineDsl.tracks ?? []) {
    for (const item of track?.items ?? []) {
      if (item?.type === "composition" && item.runtime === "remotion") {
        const sourceNodeId =
          typeof item.sourceNodeId === "string" ? item.sourceNodeId.trim() : "";
        if (!sourceNodeId) {
          throw new Error(
            `Timeline Remotion item ${String(item.id ?? "unknown")} requires sourceNodeId`,
          );
        }
        const sourceNode = nodes.get(sourceNodeId) as
          Record<string, any> | undefined;
        if (!sourceNode || sourceNode.type !== "remotion-component") {
          throw new Error(
            `Timeline Remotion item ${String(item.id ?? "unknown")} must reference a remotion-component Canvas node`,
          );
        }
        const sourceData =
          sourceNode.data && typeof sourceNode.data === "object"
            ? (sourceNode.data as Record<string, any>)
            : {};
        if (
          typeof sourceData.content !== "string" ||
          !sourceData.content.trim()
        ) {
          throw new Error(
            `Remotion Canvas node ${sourceNodeId} has no executable TSX content`,
          );
        }
        item.componentSource = sourceData.content;
        if (
          typeof sourceData.componentId === "string" &&
          sourceData.componentId.trim()
        ) {
          item.compositionId = sourceData.componentId.trim();
        }
        continue;
      }
      if (
        item?.type !== "video" &&
        item?.type !== "image" &&
        item?.type !== "audio"
      ) {
        continue;
      }
      const itemId = typeof item.id === "string" ? item.id.trim() : "";
      if (!itemId) {
        throw new Error("Timeline render media items require a stable item id");
      }
      const slot = `timeline:item:${itemId}`;
      const binding = bindingBySlot.get(slot);
      const asset = binding
        ? readProjectAsset(options.doc, binding.projectAssetId)
        : null;
      if (!asset || asset.lifecycle.state !== "active") {
        throw new Error(
          `Timeline render run ${options.inputOwner.actionRunId} has no active frozen input for ${slot}`,
        );
      }
      delete item.src;
      item.assetId = asset.id;
      references.push({
        slot,
        index: 0,
        asset: {
          assetId: asset.id,
          uri: `clash-asset://${asset.id}`,
          kind: asset.kind,
          ...(typeof asset.metadata?.contentType === "string"
            ? { mediaType: asset.metadata.contentType }
            : {}),
        },
      });
    }
  }
  return {
    timeline: ProjectTimelineEnvelopeSchema.parse({
      ...timeline,
      state: timelineDsl,
    }),
    references,
  };
}

export function createLocalWorkflowProcessor(
  options: LocalWorkflowProcessorOptions,
): LocalWorkflowProcessor {
  const generationDeadlineMs = providerGenerationDeadlineMs(
    options.providerGenerationDeadlineMs,
  );
  const aigc = options.aigc ?? createMockExternalAigcService();
  const userId = options.userId ?? "local-user";
  // Provider executors and custom executable Actions share one owner-private journal and graph.
  // Production supplies the explicit Provider owner; an isolated Action host keeps the same local
  // semantics without needing to invent a dummy Provider adapter.
  const durableOwnerId = options.durableProviderRuns?.ownerId ?? "local-api";
  const durableJournal = createSqliteDurableRunJournal(options.dataDir);
  const generatorRuns = createLocalGeneratorRunBridge({
    ownerId: durableOwnerId,
    journal: durableJournal,
  });
  const providerExecutionHandoffs = createProviderExecutionHandoffStore(
    options.dataDir,
  );
  const projectAssets = createLocalProjectAssetService({
    dataDir: options.dataDir,
    projectionOrigin: () => {
      if (!options.mediaBaseUrl) return "http://127.0.0.1";
      return typeof options.mediaBaseUrl === "function"
        ? options.mediaBaseUrl()
        : options.mediaBaseUrl;
    },
    ...(options.assetInspection
      ? { assetInspection: options.assetInspection }
      : {}),
    ...(options.assetRepresentations
      ? { assetRepresentations: options.assetRepresentations }
      : {}),
  });
  const pluginAssetStaging = createLocalPluginAssetStagingStore({
    dataDir: options.dataDir,
  });
  const localOutputStaging = createLocalDurableOutputStagingStore({
    dataDir: options.dataDir,
  });

  return {
    ...(options.providerPollDelayCapMs === undefined
      ? {}
      : { minimumPollDelayMs: options.providerPollDelayCapMs }),
    async nextWakeAt(projectId) {
      return durableJournal.nextWakeAt(durableOwnerId, projectId);
    },

    async process(input) {
      const { doc, projectId } = input;
      const nodes = doc.getMap("nodes");
      const modelCards = options.modelCards
        ? await options.modelCards()
        : MODEL_CARDS;
      let changed = await projectAssets.materializeDoc(projectId, doc);
      const nodeProjectionRevisionId = (
        nodeId: string,
        kind: ProcessableNodeKind,
        nodeData: Record<string, unknown>,
        executionPrompt?: string,
        targetKind?: "generation" | "action",
      ) =>
        canvasNodeProjectionRevisionId({
          projectId,
          nodeId,
          kind,
          nodeData,
          ...(targetKind === undefined ? {} : { targetKind }),
          ...(executionPrompt === undefined ? {} : { executionPrompt }),
          resolveMention(mentionedNodeId) {
            const referencedNode = nodes.get(mentionedNodeId) as
              Record<string, any> | undefined;
            const assetId =
              typeof referencedNode?.data?.assetId === "string"
                ? referencedNode.data.assetId
                : undefined;
            const modality = referencedNode?.type;
            return assetId &&
              (modality === "image" ||
                modality === "video" ||
                modality === "audio")
              ? { assetId, kind: modality }
              : undefined;
          },
        });
      // Terminal tasks no longer invoke publication when replayed. Restore the
      // Canvas view from the public Run/Commit, guarded by the frozen request,
      // rather than leaving an acknowledged result in "generating" state.
      const projectGeneratorRunToCanvas = async (identity: {
        actionRunId: string;
        outputSlot: string;
      }) => {
        const task = await durableJournal.load(identity);
        const run = readProjectActionRun(doc, identity.actionRunId);
        if (!task || !run) return;
        const frozen = frozenExecutorInput(task);
        if (frozen.targetKind !== "generator-action" || !frozen.nodeId) return;
        const target = nodes.get(frozen.nodeId) as
          | { type?: string; data?: Record<string, unknown> }
          | undefined;
        if (
          target?.type !== frozen.kind ||
          !target.data ||
          !isCurrentProviderNodeRevision({
            frozen,
            actionRunId: identity.actionRunId,
            nodeData: target.data,
            currentProjectionRevisionId: nodeProjectionRevisionId(
              frozen.nodeId,
              frozen.kind,
              target.data,
            ),
          })
        ) return;
        const commit = readOutputCommit(doc, identity);
        if (run.status === "succeeded" && !commit) {
          throw new Error("A succeeded Generator Run requires its Output Commit.");
        }
        const updates = run.status === "succeeded"
          ? {
              status: "completed",
              ...(commit?.asset.kind === "media"
                ? { assetId: commit.asset.projectAssetId }
                : commit?.asset.kind === "document"
                  ? { documentRevision: commit.asset }
                  : {}),
            }
          : run.status === "failed"
            ? { status: "failed", error: task.failure?.message ?? "Generation failed.", failureCode: task.failure?.code }
            : { status: "generating" };
        const data = durableProviderNodeData(target.data, {
          ...updates,
          generatorId: run.generatorRevision.generatorId,
          generatorRevisionId: run.generatorRevision.generatorRevisionId,
          actionRunId: run.actionRunId,
        });
        const hadLegacyInputs = listActionAssetBindingsForOwner(doc, {
          kind: "draft", actionId: `node:${frozen.nodeId}`,
        }).some((binding) => binding.direction === "input");
        const retired = replaceDraftActionAssetInputBindings(doc, `node:${frozen.nodeId}`, []);
        if (!retired.ok) throw new Error(retired.error);
        const dataChanged = canonicalJson(data) !== canonicalJson(target.data);
        if (!dataChanged && !hadLegacyInputs) return;
        if (dataChanged) nodes.set(frozen.nodeId, { ...target, data });
        changed = true;
        await input.checkpoint?.();
      };
      const durable = options.durableProviderRuns;
      const localExecutor: ExecutablePluginActionInvoker = async (request) => {
        const attemptBudgetMs = request.timeoutMs ?? generationDeadlineMs;
        const attemptDeadlineAt = Date.now() + attemptBudgetMs;
        const beforeAttemptDeadline = <T>(operation: Promise<T>) =>
          beforeProviderGenerationDeadline(
            operation,
            attemptDeadlineAt,
            attemptBudgetMs,
          );
        const mode = request.input.values.localExecutor;
        const outputSlot = request.input.values.outputSlot;
        if (typeof mode !== "string" || typeof outputSlot !== "string") {
          throw new Error("Frozen Host-local executor input is invalid.");
        }
        const invocationId = `${request.taskId}:${outputSlot}`;
        if (mode !== "generation") {
          throw new Error(`Host-local executor ${mode} is not recognized.`);
        }
        const generationKind = request.input.values.generationKind;
        const snapshot = request.input.values.generationInput;
        if (
          (generationKind !== "image" &&
            generationKind !== "video" &&
            generationKind !== "audio" &&
            generationKind !== "text") ||
          !snapshot ||
          typeof snapshot !== "object" ||
          Array.isArray(snapshot)
        ) {
          throw new Error("Frozen Host-local generation input is invalid.");
        }
        const generationInput = {
          ...(snapshot as Record<string, unknown>),
          taskId: request.taskId,
          projectId: request.projectId,
          ...(request.nodeId ? { nodeId: request.nodeId } : {}),
          references: request.input.references,
        } as Parameters<ExternalAigcService["generateText"]>[0];
        if (generationKind === "text") {
          let generated;
          if (request.input.values.useLocalTextAgent === true) {
            if (!options.textAgent) {
              throw new ProviderPluginHostUnavailableError(
                "The frozen local text executor is unavailable.",
              );
            }
            generated = await beforeAttemptDeadline(
              options.textAgent.generate({
                projectId: request.projectId,
                prompt: generationInput.prompt,
                modelId: generationInput.model,
                modelParams: generationInput.modelParams,
                actorAgentId: generationInput.actorAgentId,
              }),
            );
          } else {
            generated = await beforeAttemptDeadline(
              aigc.generateText(generationInput),
            );
          }
          return {
            protocol: "clash.plugin.result/v1",
            invocationId,
            status: "completed",
            outputs: [
              {
                slot: outputSlot,
                kind: "value",
                value: {
                  text: generated.text,
                  ...(generated.provider
                    ? { provider: generated.provider }
                    : {}),
                  ...(generated.modelEndpoint
                    ? { modelEndpoint: generated.modelEndpoint }
                    : {}),
                },
              },
            ],
          } satisfies ExecutablePluginResult;
        }
        const generated = await beforeAttemptDeadline(
          generationKind === "image"
            ? aigc.generateImage(generationInput)
            : generationKind === "video"
              ? aigc.generateVideo(generationInput)
              : aigc.generateAudio(generationInput),
        );
        if (generated.status === "accepted") {
          throw new Error(
            "An accepted Provider result requires the durable executable Provider path.",
          );
        }
        if (generated.status === "failed") {
          return {
            protocol: "clash.plugin.result/v1",
            invocationId,
            status: "failed",
            error: generated.error,
          } satisfies ExecutablePluginResult;
        }
        const staged = await localOutputStaging.stage({
          projectId: request.projectId,
          actionRunId: request.taskId,
          outputSlot,
          kind: generationKind,
          bytes: generated.bytes,
          contentType: generated.contentType,
          metadata: {
            ...(generated.width === undefined
              ? {}
              : { width: generated.width }),
            ...(generated.height === undefined
              ? {}
              : { height: generated.height }),
            ...(generated.durationMs === undefined
              ? {}
              : { durationMs: generated.durationMs }),
          },
          result: {
            ...(generated.provider ? { provider: generated.provider } : {}),
            ...(generated.modelEndpoint
              ? { modelEndpoint: generated.modelEndpoint }
              : {}),
            ...(generated.requestId ? { requestId: generated.requestId } : {}),
          },
        });
        return {
          protocol: "clash.plugin.result/v1",
          invocationId,
          status: "completed",
          outputs: [
            {
              slot: outputSlot,
              kind: "asset",
              asset: {
                assetId: staged.projectAssetId,
                uri: `clash-asset://${staged.projectAssetId}`,
                kind: generationKind,
                mediaType: staged.contentType,
              },
            },
          ],
        } satisfies ExecutablePluginResult;
      };
      const coordinator = createLocalDurableRunCoordinator({
        ownerId: durableOwnerId,
        journal: durableJournal,
        providerPluginExecutor: async (request) => {
          if (!durable) {
            throw new Error(
              "Durable Provider runtime is unavailable in this Action-only Host.",
            );
          }
          const response = await durable.providerPluginExecutor(request);
          if (
            response.status !== "accepted" ||
            options.providerPollDelayCapMs === undefined
          ) {
            return response;
          }
          return {
            ...response,
            retryAfterMs: Math.min(
              response.retryAfterMs ?? 5_000,
              Math.max(0, options.providerPollDelayCapMs),
            ),
          };
        },
        ...(options.executablePluginAction
          ? { executablePluginAction: options.executablePluginAction }
          : {}),
        localExecutor,
        outputStore: {
          async stage({ run, idempotencyKey, outputs }) {
            const frozen = frozenExecutorInput(run);
            const generatorDocumentPort =
              frozen.targetKind === "generator-action"
                ? frozen.generatorOutputContract?.find(
                    (candidate) =>
                      candidate.slot === run.outputSlot &&
                      candidate.assetType.kind === "document",
                  )
                : undefined;
            if (!frozen.nodeId && !frozen.delivery && !generatorDocumentPort) {
              throw new Error(
                "A durable Provider output requires a Canvas node or Project Asset delivery.",
              );
            }
            const rawTarget = frozen.nodeId
              ? (nodes.get(frozen.nodeId) as Record<string, any> | undefined)
              : undefined;
            if (
              frozen.nodeId && frozen.targetKind !== "generator-action" &&
              (!rawTarget?.data || typeof rawTarget.data !== "object")
            ) {
              throw new Error(
                `Durable Provider target node ${frozen.nodeId} is missing.`,
              );
            }
            const output = outputs.find(
              (candidate) => candidate.slot === run.outputSlot,
            );
            if (!output) {
              throw new Error(
                `Durable Provider output slot ${run.outputSlot} is missing.`,
              );
            }
            if (
              generatorDocumentPort &&
              generatorDocumentPort.assetType.kind === "document"
            ) {
              if (
                output.kind !== "document" ||
                output.document.documentKind !==
                  generatorDocumentPort.assetType.documentKind ||
                output.document.schemaVersion !==
                  generatorDocumentPort.assetType.schemaVersion
              ) {
                throw new Error(
                  `Generator document output slot ${run.outputSlot} does not match its frozen Document contract.`,
                );
              }
              const descriptor = getDocumentKindDefinition(
                generatorDocumentPort.assetType.documentKind,
                generatorDocumentPort.assetType.schemaVersion,
              );
              if (!descriptor) {
                throw new Error(
                  `Generator document output declares an unknown kind ${generatorDocumentPort.assetType.documentKind}@${generatorDocumentPort.assetType.schemaVersion}.`,
                );
              }
              const body = parseDocumentBody(
                descriptor.kind,
                descriptor.schemaVersion,
                output.document.body,
              );
              const stored = await storeMetadataBody({
                dataDir: options.dataDir,
                body,
              });
              const publicRun = readProjectActionRun(doc, run.actionRunId);
              const generatorRevision = publicRun
                ? readGeneratorRevision(doc, publicRun.generatorRevision)
                : null;
              if (!publicRun || !generatorRevision) {
                throw new Error(
                  `Generator Action Run ${run.actionRunId} is missing its immutable public revision.`,
                );
              }
              const revision = DocumentAssetRevisionSchema.parse({
                id: `document-revision:${run.actionRunId}:${run.outputSlot}`,
                documentAssetId: `document:${run.actionRunId}:${run.outputSlot}`,
                documentKind: descriptor.kind,
                schemaVersion: descriptor.schemaVersion,
                mutability: descriptor.mutability,
                body: {
                  digest: stored.contentHash,
                  byteLength: stored.bytes,
                  contentType: "application/json",
                },
                producer: {
                  kind: "action-run",
                  actionRunId: run.actionRunId,
                },
                sourceRefs: [
                  ...generatorRevision.persistentInputRefs,
                  ...publicRun.invocationInputRefs,
                ],
              } satisfies DocumentAssetRevision);
              return {
                kind: "document",
                revision,
              } as ExecutablePluginJsonValue;
            }
            if (frozen.kind === "text") {
              if (output.kind !== "value") {
                throw new Error(
                  `Durable Provider text output slot ${run.outputSlot} is not a value.`,
                );
              }
              if (!frozen.nodeId || !rawTarget?.data) {
                throw new Error(
                  "A durable Provider text output requires a target node.",
                );
              }
              const localValue =
                frozen.targetKind === "local-executor" &&
                output.value &&
                typeof output.value === "object" &&
                !Array.isArray(output.value)
                  ? (output.value as Record<string, unknown>)
                  : undefined;
              const content = localValue?.text ?? output.value;
              if (typeof content !== "string" || !content.trim()) {
                throw new Error(
                  "Durable Provider text output must be a non-empty string.",
                );
              }
              const revision = await recordGeneratedTextRevision({
                dataDir: options.dataDir,
                userId,
                projectId: frozen.projectId,
                nodeId: frozen.nodeId,
                nodeData:
                  frozen.targetKind === "action" ||
                  frozen.targetKind === "local-executor"
                    ? {
                        actorType: frozen.actor?.kind,
                        ...(frozen.actor?.kind === "agent" && frozen.actor.id
                          ? { actorAgentId: frozen.actor.id }
                          : {}),
                      }
                    : (rawTarget.data as Record<string, unknown>),
                content,
                createdAt: new Date(run.createdAt).toISOString(),
                auditId: `durable:${idempotencyKey}:text`,
              });
              return {
                kind: "text",
                content,
                revisionId: revision.revisionId,
                ...(typeof localValue?.provider === "string"
                  ? { provider: localValue.provider }
                  : {}),
                ...(typeof localValue?.modelEndpoint === "string"
                  ? { modelEndpoint: localValue.modelEndpoint }
                  : {}),
              } as ExecutablePluginJsonValue;
            }
            if (output.kind !== "asset") {
              throw new Error(
                "Durable Provider media output must be a canonical Asset handle.",
              );
            }
            const media = output.asset;
            if (frozen.targetKind === "local-executor") {
              const staged = await localOutputStaging.resolve({
                projectId: frozen.projectId,
                actionRunId: run.actionRunId,
                outputSlot: run.outputSlot,
              });
              if (!staged || staged.projectAssetId !== media.assetId) {
                throw new Error(
                  "Host-local durable media output requires its stable staging receipt.",
                );
              }
              if (staged.kind !== frozen.kind) {
                throw new Error(
                  `Host-local durable output is ${staged.kind}, not ${frozen.kind}.`,
                );
              }
              const prompt =
                typeof frozen.input.values.prompt === "string"
                  ? frozen.input.values.prompt
                  : `Generate ${frozen.kind}`;
              const projectAsset = await projectAssets.prepareStagedOwnedEntry({
                projectAssetId: staged.projectAssetId,
                kind: staged.kind,
                resourceId: staged.resourceId,
                metadata: staged.metadata,
                provenance: {
                  kind:
                    staged.result?.provider === "local-render"
                      ? "render"
                      : "generation",
                  actionRunId: run.actionRunId,
                  model:
                    staged.result?.modelEndpoint ??
                    frozen.modelEndpoint ??
                    staged.kind,
                  prompt,
                },
              });
              return {
                kind: "asset",
                projectAsset,
              } as ExecutablePluginJsonValue;
            }
            const staged = await pluginAssetStaging.resolve({
              projectId: frozen.projectId,
              projectAssetId: media.assetId,
            });
            if (staged && staged.kind !== frozen.kind) {
              throw new Error(
                `Durable Provider staged ${staged.kind} output for a ${frozen.kind} run.`,
              );
            }
            if (!staged) {
              throw new Error(
                "Durable Provider media output requires a Host staging receipt.",
              );
            }
            const expectedReceiptTaskId =
              frozen.targetKind === "action" ||
              (frozen.targetKind === "generator-action" && !frozen.providerExecution)
                ? run.actionRunId
                : idempotencyKey;
            const expectedOwner = await expectedProviderReceiptOwner({
              frozen,
              resolveProviderExecutorBinding:
                options.resolveProviderExecutorBinding,
            });
            const expectedReceiptSlots = pluginOutputSlotsForDurableRun(
              frozen,
              run.outputSlot,
            );
            if (
              staged.taskId !== expectedReceiptTaskId ||
              !expectedReceiptSlots.includes(staged.slot) ||
              staged.pluginId !== expectedOwner.pluginId ||
              staged.pluginVersion !== expectedOwner.pluginVersion ||
              (expectedOwner.accountId !== undefined &&
                staged.accountId !== expectedOwner.accountId)
            ) {
              throw new Error(
                "Durable Provider media output staging receipt is not owned by the frozen run and binding.",
              );
            }
            const assetId = staged.projectAssetId;
            const flexibility = modelOutputFlexibility(
              frozen.kind,
              frozen.input.values.modelId,
            );
            const projectAsset = await projectAssets.prepareStagedOwnedEntry({
              projectAssetId: assetId,
              kind: frozen.kind,
              resourceId: staged.resourceId,
              ...(frozen.delivery?.name ? { name: frozen.delivery.name } : {}),
              metadata: {
                ...(staged.mediaType ? { contentType: staged.mediaType } : {}),
                ...(flexibility !== undefined ? { flexibility } : {}),
              },
              provenance: {
                kind:
                  frozen.targetKind === "action" &&
                  frozen.binding.pluginId === REMOTION_RENDER_PLUGIN_ID &&
                  frozen.binding.exportId === REMOTION_RENDER_EXPORT_ID
                    ? "render"
                    : "generation",
                actionRunId: run.actionRunId,
                ...(frozen.modelEndpoint
                  ? { model: frozen.modelEndpoint }
                  : {}),
                ...((frozen.delivery?.prompt ??
                (typeof frozen.input.values.prompt === "string"
                  ? frozen.input.values.prompt
                  : undefined))
                  ? {
                      prompt:
                        frozen.delivery?.prompt ??
                        String(frozen.input.values.prompt),
                    }
                  : {}),
              },
            });
            return {
              kind: "asset",
              projectAsset,
            } as ExecutablePluginJsonValue;
          },
        },
        publisher: {
          async publish({ run, stagedOutput }) {
            const frozen = frozenExecutorInput(run);
            const target = frozen.nodeId
              ? (nodes.get(frozen.nodeId) as Record<string, any> | undefined)
              : undefined;
            if (
              frozen.nodeId && frozen.targetKind !== "generator-action" &&
              (!target?.data || typeof target.data !== "object")
            ) {
              throw new Error(
                `Durable Provider target node ${frozen.nodeId} is missing.`,
              );
            }
            if (
              !stagedOutput ||
              typeof stagedOutput !== "object" ||
              Array.isArray(stagedOutput)
            ) {
              throw new Error("Durable Provider staged output is invalid.");
            }
            const staged = stagedOutput as Record<string, unknown>;
            if (
              !frozen.nodeId &&
              !frozen.delivery &&
              !(
                frozen.targetKind === "generator-action" &&
                staged.kind === "document"
              )
            ) {
              throw new Error(
                "A durable Provider publication requires a Canvas node, Project Asset delivery, or Generator Document output.",
              );
            }
            if (
              frozen.targetKind === "generator-action" &&
              staged.kind === "document"
            ) {
              const revision = DocumentAssetRevisionSchema.parse(
                staged.revision,
              );
              const descriptor = getDocumentKindDefinition(
                revision.documentKind,
                revision.schemaVersion,
              );
              if (
                !descriptor ||
                descriptor.mutability !== revision.mutability ||
                revision.body.contentType !== "application/json"
              ) {
                throw new Error(
                  "Generator staged Document no longer matches its declared kind contract.",
                );
              }
              const body = await readMetadataBody({
                dataDir: options.dataDir,
                contentHash: revision.body.digest,
              });
              if (
                Buffer.byteLength(canonicalMetadataBody(body)) !==
                revision.body.byteLength
              ) {
                throw new Error(
                  "Generator staged Document body length does not match its immutable revision.",
                );
              }
              parseDocumentBody(
                descriptor.kind,
                descriptor.schemaVersion,
                body,
              );
              const publicRun = readProjectActionRun(doc, run.actionRunId);
              if (!publicRun) {
                throw new Error(
                  `Generator Action Run ${run.actionRunId} is missing.`,
                );
              }
              if (publicRun.outputContract.length > 1) {
                const batchOutputs: Array<{
                  outputSlot: string;
                  revision: DocumentAssetRevision;
                }> = [];
                for (const port of publicRun.outputContract) {
                  if (port.cardinality.minItems === 0) continue;
                  const sibling = await durableJournal.load({
                    actionRunId: run.actionRunId,
                    outputSlot: port.slot,
                  });
                  const siblingStaged = sibling?.stagedOutput;
                  if (
                    !siblingStaged ||
                    typeof siblingStaged !== "object" ||
                    Array.isArray(siblingStaged) ||
                    siblingStaged.kind !== "document"
                  ) {
                    // Publication is deliberately deferred. This private task
                    // may finish, but no public metadata exists until the last
                    // required slot has staged successfully.
                    return;
                  }
                  batchOutputs.push({
                    outputSlot: port.slot,
                    revision: DocumentAssetRevisionSchema.parse(
                      siblingStaged.revision,
                    ),
                  });
                }
                const batch = await generatorRuns.publishDocumentBatchSuccess({
                  doc,
                  actionRunId: run.actionRunId,
                  outputs: batchOutputs,
                  checkpoint: async () => {
                    if (!input.checkpoint) {
                      throw new Error(
                        "Generator Document batch publication requires a Project checkpoint.",
                      );
                    }
                    await input.checkpoint();
                  },
                });
                changed = batch.changed || changed;
                return;
              }
              const publication = await generatorRuns.publishDocumentSuccess({
                doc,
                actionRunId: run.actionRunId,
                outputSlot: run.outputSlot,
                revision,
                checkpoint: async () => {
                  if (!input.checkpoint) {
                    throw new Error(
                      "Generator Document publication requires a Project checkpoint.",
                    );
                  }
                  await input.checkpoint();
                },
              });
              changed = publication.changed || changed;
              if (frozen.nodeId && revision.documentKind === MODEL_TEXT_DOCUMENT_KIND && revision.schemaVersion === MODEL_TEXT_DOCUMENT_SCHEMA_VERSION) {
                const target = nodes.get(frozen.nodeId) as { type?: string; data?: Record<string, unknown> } | undefined;
                if (target?.type === "text" && target.data && isCurrentProviderNodeRevision({
                  frozen, actionRunId: run.actionRunId, nodeData: target.data,
                  currentProjectionRevisionId: nodeProjectionRevisionId(frozen.nodeId, frozen.kind, target.data),
                })) {
                  nodes.set(frozen.nodeId, { ...target, data: durableProviderNodeData(target.data, {
                    status: "completed", documentRevision: publication.commit.asset,
                  }) });
                  changed = true;
                  await input.checkpoint?.();
                }
              }
              return;
            }
            let publishedAsset: ProjectAssetEntry | undefined;
            if (staged.kind === "asset") {
              const parsed = ProjectAssetEntrySchema.safeParse(
                staged.projectAsset,
              );
              if (!parsed.success) {
                throw new Error(
                  `Durable Provider staged Project Asset is invalid: ${parsed.error.issues[0]?.message ?? "invalid entry"}`,
                );
              }
              if (parsed.data.source.kind !== "owned") {
                throw new Error(
                  "Durable Provider staged output must own its verified Resource.",
                );
              }
              // `stagedOutput` survives upgrades and process restarts. Treat it
              // as an immutable candidate, not publication authority: reopen
              // the Resource and require the current versioned Host inspection
              // before any Project mutation. This prevents a pre-v4 journal
              // record from bypassing the common L0/L1 finalization boundary.
              const verified = await projectAssets.prepareStagedOwnedEntry({
                projectAssetId: parsed.data.id,
                kind: parsed.data.kind,
                resourceId: parsed.data.source.resourceId,
                ...(parsed.data.name ? { name: parsed.data.name } : {}),
                metadata: parsed.data.metadata,
                ...(parsed.data.provenance
                  ? { provenance: parsed.data.provenance }
                  : {}),
              });
              const outputBinding = {
                id: `action-asset:${durableRunIdempotencyKey(run)}:output`,
                owner: durableActionOwner(frozen, run.actionRunId),
                direction: "output" as const,
                slot: run.outputSlot,
                projectAssetId: verified.id,
              };
              const publication =
                frozen.targetKind === "generator-action"
                  ? await generatorRuns.publishMediaSuccess({
                      doc,
                      actionRunId: run.actionRunId,
                      outputSlot: run.outputSlot,
                      entry: verified,
                      checkpoint: async () => {
                        if (!input.checkpoint) {
                          throw new Error(
                            "Generator Action publication requires a Project checkpoint.",
                          );
                        }
                        await input.checkpoint();
                      },
                    })
                  : publishLocalProjectAssetWithBindings(doc, verified, [
                      outputBinding,
                    ]);
              publishedAsset = publication.entry;
              changed = publication.changed || changed;
              options.assetRepresentations?.schedule(
                verified.source.resourceId,
              );
            }
            if (frozen.delivery && (!frozen.nodeId || !target?.data)) {
              if (!publishedAsset) {
                throw new Error(
                  "Direct Project Asset delivery requires a staged Asset output.",
                );
              }
              // Project Asset + Action binding are the complete public projection for a
              // node-less run. Checkpoint them before the journal records publication so a
              // crash can replay this idempotent pair without regenerating the model.
              await input.checkpoint?.();
              return;
            }
            const updates = publishedAsset
              ? { status: "completed", assetId: publishedAsset.id }
              : staged.kind === "text" && typeof staged.content === "string"
                ? {
                    status: "completed",
                    content: staged.content,
                    ...(typeof staged.provider === "string"
                      ? { provider: staged.provider }
                      : {}),
                    ...(typeof staged.modelEndpoint === "string"
                      ? { modelEndpoint: staged.modelEndpoint }
                      : {}),
                  }
                : undefined;
            if (!updates)
              throw new Error("Durable Provider staged output is incomplete.");
            if (!frozen.nodeId || !target?.data) {
              throw new Error(
                "A Canvas Provider publication requires a target node.",
              );
            }
            const current = target.data as Record<string, unknown>;
            if (
              !isCurrentProviderNodeRevision({
                frozen,
                actionRunId: run.actionRunId,
                nodeData: current,
                currentProjectionRevisionId: nodeProjectionRevisionId(
                  frozen.nodeId,
                  frozen.kind,
                  current,
                  frozen.targetKind === "action"
                    ? customActionPromptFromData(current)
                    : undefined,
                  frozen.targetKind === "action" ? "action" : undefined,
                ),
              })
            ) {
              // Asset + binding publication is the durable consumer-CAS boundary. A stale
              // run still owns that immutable result, but it cannot replace the coarse
              // outcome of a Canvas node that now represents another Action revision.
              await input.checkpoint?.();
              return;
            }
            if (
              current.status === updates.status &&
              ("assetId" in updates
                ? current.assetId === updates.assetId
                : current.content === updates.content)
            ) {
              // A previous publication may have mutated the in-memory Loro doc and then lost
              // its persistence acknowledgement. Re-checkpoint before the journal records
              // success; equality alone is not evidence that the snapshot survived.
              await input.checkpoint?.();
              return;
            }
            nodes.set(frozen.nodeId, {
              ...target,
              data: durableProviderNodeData(current, updates),
            });
            changed = true;
            await input.checkpoint?.();
          },
          async publishFailure({ run, failure }) {
            const frozen = frozenExecutorInput(run);
            if (frozen.targetKind === "generator-action") {
              const publication = await generatorRuns.publishFailure({
                doc,
                actionRunId: run.actionRunId,
                checkpoint: async () => {
                  if (!input.checkpoint) {
                    throw new Error(
                      "Generator Action failure projection requires a Project checkpoint.",
                    );
                  }
                  await input.checkpoint();
                },
              });
              changed = publication.changed || changed;
              if (!frozen.nodeId) return;
            }
            if (!frozen.nodeId) return;
            const target = nodes.get(frozen.nodeId) as
              Record<string, any> | undefined;
            if (!target?.data || typeof target.data !== "object") return;
            const current = target.data as Record<string, unknown>;
            if (
              !isCurrentProviderNodeRevision({
                frozen,
                actionRunId: run.actionRunId,
                nodeData: current,
                currentProjectionRevisionId: nodeProjectionRevisionId(
                  frozen.nodeId,
                  frozen.kind,
                  current,
                  frozen.targetKind === "action"
                    ? customActionPromptFromData(current)
                    : undefined,
                  frozen.targetKind === "action" ? "action" : undefined,
                ),
              })
            ) {
              await input.checkpoint?.();
              return;
            }
            if (
              current.status === "failed" &&
              current.failureCode === failure.code &&
              current.error === failure.message
            ) {
              await input.checkpoint?.();
              return;
            }
            nodes.set(frozen.nodeId, {
              ...target,
              data: durableProviderNodeData(current, {
                status: "failed",
                failureCode: failure.code,
                error: failure.message,
              }),
            });
            changed = true;
            await input.checkpoint?.();
          },
        },
        retryPolicy: createBoundedRetryPolicy({
          maxFailures: { submit: 3, poll: 3, stage: 3, publish: 3 },
          baseDelayMs: 1_000,
          maxDelayMs: 60_000,
        }),
        ...(durable?.now ? { clock: { now: durable.now } } : {}),
      });

      const driveDurableRun = async (identity: {
        actionRunId: string;
        outputSlot: string;
      }): Promise<void> => {
        if (!coordinator) return;
        for (let step = 0; step < 12; step += 1) {
          const result = await coordinator.coordinate({
            type: "advance",
            identity,
          });
          if (
            result.kind === "waiting" ||
            result.kind === "terminal" ||
            result.kind === "contended"
          )
            return;
        }
        // A replay may compress many accepted/poll checkpoints into one turn. Yield the room after
        // a bounded batch and let its durable next-wake scheduler resume the still-journaled run;
        // reaching this fairness bound is not a Provider failure.
      };

      /**
       * Project input bindings are the synchronized provenance for the frozen owner-private run.
       * Rebuild them from the journal before every possible advance so a crash after journal
       * creation cannot submit a Provider request whose inputs were never checkpointed in Loro.
       */
      const ensureDurableInputBindings = async (identity: {
        actionRunId: string;
        outputSlot: string;
      }) => {
        if (!durableJournal) return undefined;
        const run = await durableJournal.load(identity);
        if (!run) return undefined;
        const frozen = frozenExecutorInput(run);
        if (frozen.targetKind === "generator-action") {
          if (!input.checkpoint) {
            throw new Error(
              "Generator Action recovery requires a Project checkpoint.",
            );
          }
          const before = readProjectActionRun(doc, identity.actionRunId);
          await generatorRuns.projectRunning({
            doc,
            identity,
            checkpoint: input.checkpoint,
          });
          changed = before?.status === "pending" || changed;
          return run;
        }
        const owner = durableActionOwner(frozen, identity.actionRunId);
        const frozenAssetReferences = frozen.input.references.filter(
          (
            reference,
          ): reference is Extract<
            ExecutablePluginReference,
            { asset: unknown }
          > => "asset" in reference,
        );
        const frozenReferenceCountBySlot = new Map<string, number>();
        for (const reference of frozenAssetReferences) {
          frozenReferenceCountBySlot.set(
            reference.slot,
            (frozenReferenceCountBySlot.get(reference.slot) ?? 0) + 1,
          );
        }
        const publishedInputBindings = listActionAssetBindingsForOwner(
          doc,
          owner,
        ).filter((binding) => binding.direction === "input");
        let bindingsChanged = false;
        for (const reference of frozenAssetReferences) {
          const exactPublishedSlot = publishedInputBindings.filter(
            (binding) => binding.slot === reference.slot,
          );
          if (
            frozenReferenceCountBySlot.get(reference.slot) === 1 &&
            exactPublishedSlot.length > 0
          ) {
            if (
              exactPublishedSlot.length !== 1 ||
              exactPublishedSlot[0]!.projectAssetId !== reference.asset.assetId
            ) {
              throw new Error(
                `Frozen Asset reference ${reference.slot} conflicts with its synchronized run binding`,
              );
            }
            continue;
          }
          const ensured = ensureActionAssetBinding(doc, {
            id: `action-asset:${identity.actionRunId}:${reference.slot}:${reference.index}:input`,
            owner,
            direction: "input",
            slot: `${reference.slot}:${reference.index}`,
            projectAssetId: reference.asset.assetId,
            role: "reference",
          });
          if (!ensured.ok) {
            throw new Error(`${ensured.error.code}: ${ensured.error.message}`);
          }
          bindingsChanged = ensured.changed || bindingsChanged;
        }
        if (bindingsChanged) {
          changed = true;
          await input.checkpoint?.();
        }
        return run;
      };

      const resumeCanvasDurableRun = async (options: {
        identity: { actionRunId: string; outputSlot: string };
        node: Record<string, any>;
        nodeId: string;
        kind: ProcessableNodeKind;
        nodeData: Record<string, unknown>;
        projectionRevisionId: string;
      }): Promise<boolean> => {
        if (!durableJournal) return false;
        const existing = await durableJournal.load(options.identity);
        if (!existing) return false;
        await ensureDurableInputBindings(options.identity);
        await providerExecutionHandoffs.remove(projectId, options.nodeId);
        const ownsCurrentRevision = isCurrentProviderNodeRevision({
          frozen: frozenExecutorInput(existing),
          actionRunId: options.identity.actionRunId,
          nodeData: options.nodeData,
          currentProjectionRevisionId: options.projectionRevisionId,
        });
        if (ownsCurrentRevision && options.nodeData.status !== "generating") {
          nodes.set(options.nodeId, {
            ...options.node,
            data: durableProviderNodeData(options.nodeData, {
              status: "generating",
            }),
          });
          changed = true;
          await input.checkpoint?.();
        }
        await driveDurableRun(options.identity);
        return true;
      };

      if (coordinator && durableJournal) {
        const recovery = await coordinator.coordinate({ type: "recoverable" });
        if (recovery.kind === "recoverable") {
          for (const identity of recovery.identities) {
            const run = await durableJournal.load(identity);
            if (run && frozenExecutorInput(run).projectId === projectId) {
              await ensureDurableInputBindings(identity);
              await driveDurableRun(identity);
            }
          }
        }
      }

      for (const [nodeId, rawNode] of nodes.entries()) {
        const node = rawNode as Record<string, any>;
        const custom = pendingCustomNode(node);
        if (custom) {
          const data = node.data as Record<string, unknown>;
          const parsedBinding = ExecutablePluginBindingSchema.safeParse(
            data.pluginBinding,
          );
          if (
            parsedBinding.success &&
            options.executablePluginAction &&
            coordinator &&
            durableJournal
          ) {
            try {
              // One reference slot per `MEDIA_REFERENCE_FIELDS` registry
              // entry (image / video / audio / model today) so a new
              // modality only needs a registry entry, not a new branch here.
              const references = MEDIA_REFERENCE_FIELDS.flatMap((field) =>
                stringList(data[field.pendingField]).map((assetId, index) => ({
                  slot: field.modality,
                  index,
                  asset: {
                    assetId,
                    uri: `clash-asset://${assetId}`,
                    kind: field.modality,
                  },
                })),
              );
              const prompt = customActionPromptFromData(data);
              const params =
                data.customActionParams &&
                typeof data.customActionParams === "object" &&
                !Array.isArray(data.customActionParams)
                  ? (data.customActionParams as Record<string, any>)
                  : {};
              const outputSlot =
                custom.outputType === "text" ? "text" : "media";
              const actor =
                data.actorType === "agent"
                  ? {
                      kind: "agent" as const,
                      ...(typeof data.actorAgentId === "string"
                        ? { id: data.actorAgentId }
                        : {}),
                    }
                  : {
                      kind: "user" as const,
                      ...(typeof data.actorUserId === "string"
                        ? { id: data.actorUserId }
                        : {}),
                    };
              const projectionRevisionId = nodeProjectionRevisionId(
                nodeId,
                custom.outputType,
                data,
                prompt,
                "action",
              );
              const executorCandidate = {
                targetKind: "action" as const,
                binding: parsedBinding.data,
                actionId: custom.actionId,
                actor,
                kind: custom.outputType,
                projectId,
                nodeId,
                provider: `plugin:${parsedBinding.data.pluginId}`,
                modelEndpoint: custom.actionId,
                nodeProjectionRevisionId: projectionRevisionId,
                input: {
                  values: { prompt, ...params },
                  references,
                },
              } satisfies Omit<
                FrozenLocalProviderExecutorInput,
                "schemaVersion"
              >;
              const actionRevisionId =
                canvasExecutorActionRevisionId(executorCandidate);
              const identity = durableProviderIdentity({
                projectId,
                nodeId,
                kind: custom.outputType,
                actionRevisionId,
              });
              if (
                await resumeCanvasDurableRun({
                  identity,
                  node,
                  nodeId,
                  kind: custom.outputType,
                  nodeData: data,
                  projectionRevisionId,
                })
              ) {
                continue;
              }
              // Restore an admitted native Run without consulting the active
              // catalogue. Its archived Definition and frozen Task own replay.
              const cachedRun = typeof data.actionRunId === "string"
                ? readProjectActionRun(doc, data.actionRunId) : undefined;
              const cachedSlot = cachedRun?.outputContract.length === 1
                ? cachedRun.outputContract[0]?.slot : undefined;
              if (cachedRun && cachedSlot) {
                const cachedIdentity = { actionRunId: cachedRun.actionRunId, outputSlot: cachedSlot };
                const cachedTask = await durableJournal.load(cachedIdentity);
                const frozen = cachedTask ? frozenExecutorInput(cachedTask) : undefined;
                if (frozen?.targetKind === "generator-action" && frozen.nodeId === nodeId &&
                    frozen.nodeProjectionRevisionId === projectionRevisionId) {
                  await driveDurableRun(cachedIdentity);
                  await projectGeneratorRunToCanvas(cachedIdentity);
                  continue;
                }
              }
              if (options.listPluginCards && options.resolveGeneratorDefinition) {
                const registration = (await options.listPluginCards()).find((entry) =>
                  entry.pluginId === parsedBinding.data.pluginId && entry.document.kind === "action-card" &&
                  entry.document.spec.id === custom.actionId);
                const card = registration?.document.kind === "action-card" ? registration.document.spec : undefined;
                if (card?.generator && registration) {
                  if (!input.checkpoint) throw new Error("Canvas Action admission requires a Project checkpoint.");
                  if (registration.version !== parsedBinding.data.version || registration.schemaHash !== parsedBinding.data.schemaHash ||
                      card.functionExportId !== parsedBinding.data.exportId) {
                    throw new Error("The Action Card changed since this request was authored. Read the updated Card and recreate the request.");
                  }
                  if (card.outputType !== custom.outputType || node.type !== custom.outputType) {
                    throw new Error("The Canvas output does not match the Action Card's declared output kind.");
                  }
                  const definition = await options.resolveGeneratorDefinition(registration.pluginId, card.generator.definitionId);
                  if (definition.pluginId !== registration.pluginId || definition.version !== registration.version ||
                      definition.schemaHash !== registration.schemaHash) {
                    throw new Error("The Action Card and Generator Definition must belong to the same immutable plugin package.");
                  }
                  const { action, output } = resolveExecutableActionCardGenerator(card, definition);
                  const persistentInputRefs = MEDIA_REFERENCE_FIELDS.flatMap((field) => {
                    const ids = stringList(data[field.pendingField]);
                    const slot = field.modality === "model" ? undefined : card.generator!.inputSlots[field.modality];
                    if (ids.length && !slot) throw new Error(`The Action Card has no native input mapping for ${field.modality}.`);
                    const port = definition.persistentInputs.find((entry) => entry.slot === slot);
                    return slot ? ids.map((projectAssetId, index) => ({
                      slot, ...(port?.cardinality.maxItems !== 1 ? { itemKey: String(index).padStart(10, "0") } : {}),
                      target: { kind: "media" as const, projectAssetId },
                    })) : [];
                  });
                  const revisionInput = {
                    state: { ...params, ...(card.input.promptModalities.includes("text") ? { prompt } : {}) },
                    persistentInputRefs,
                  };
                  const canvas = new Canvas(doc, () => {}, typeof node.canvasId === "string" ? node.canvasId : "main", modelCards);
                  const sources = [...new Set(canvas.listEdges().filter((edge) => edge.target === nodeId)
                    .map((edge) => edge.source).filter((sourceId) => canvas.readNode(sourceId)?.type === "action-badge"))];
                  if (sources.length > 1) throw new Error("Canvas output has multiple source Actions; its Generator owner is ambiguous.");
                  const revisionDigest = createHash("sha256").update(canonicalJson({
                    definitionRef: { pluginId: definition.pluginId, definitionId: definition.definitionId,
                      version: definition.version, schemaHash: definition.schemaHash }, ...revisionInput,
                  })).digest("hex");
                  const generatorId = `canvas-action:${sources[0] ?? nodeId}:${revisionDigest}`;
                  const generatorRevisionId = `${generatorId}:revision`;
                  const actionRunId = `${generatorId}:output:${nodeId}:${action.id}`;
                  const nativeIdentity = { actionRunId, outputSlot: output.slot };
                  const product = createLocalGeneratorProductService({
                    authority: {
                      inspect: async (_projectId, read) => read(doc),
                      mutate: async (_projectId, mutate) => mutate(doc, async () => { changed = true; await input.checkpoint!(); }),
                    },
                    resolveDefinition: async (pluginId, definitionId) => pluginId === definition.pluginId && definitionId === definition.definitionId
                      ? definition : options.resolveGeneratorDefinition!(pluginId, definitionId),
                    ownerId: durableOwnerId, journal: durableJournal, deadlineMs: generationDeadlineMs, actor,
                    canvasProjection: { nodeId, nodeProjectionRevisionId: projectionRevisionId },
                    ...(durable?.now ? { now: durable.now } : {}),
                  });
                  await product.create(projectId, { generatorId, generatorRevisionId,
                    pluginId: definition.pluginId, definitionId: definition.definitionId, ...revisionInput,
                  });
                  await product.submit(projectId, generatorId, action.id, {
                    actionRunId, generatorRevisionId, parameters: {}, invocationInputRefs: [],
                  });
                  const retired = replaceDraftActionAssetInputBindings(doc, `node:${nodeId}`, []);
                  if (!retired.ok) throw new Error(retired.error);
                  nodes.set(nodeId, { ...node, data: durableProviderNodeData(data, {
                    status: "generating", generatorId, generatorRevisionId, actionRunId,
                  }) });
                  changed = true;
                  await input.checkpoint();
                  await driveDurableRun(nativeIdentity);
                  await projectGeneratorRunToCanvas(nativeIdentity);
                  continue;
                }
              }
              const createdAt = durable?.now?.() ?? Date.now();
              await coordinator.coordinate({
                type: "create",
                ...identity,
                deadlineAt: createdAt + generationDeadlineMs,
                executor: {
                  ...executorCandidate,
                  publicOwner: {
                    actionId: custom.actionId,
                    actionRevisionId,
                  },
                },
              });
              await ensureDurableInputBindings(identity);
              nodes.set(nodeId, {
                ...node,
                data: durableProviderNodeData(data, { status: "generating" }),
              });
              changed = true;
              // The frozen journal, synchronized input bindings, and coarse run state all survive
              // before the custom plugin receives its first invocation.
              await input.checkpoint?.();
              await driveDurableRun(identity);
            } catch (error) {
              const nextData: Record<string, unknown> = {
                ...data,
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
              };
              delete nextData.pendingTask;
              delete nextData.pendingTaskAt;
              nodes.set(nodeId, { ...node, data: nextData });
            }
            changed = true;
            continue;
          }
          const failureCode = parsedBinding.success
            ? "PLUGIN_ACTION_RUNTIME_UNAVAILABLE"
            : "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED";
          const error = parsedBinding.success
            ? `Executable plugin runtime is unavailable for action ${custom.actionId}.`
            : `Legacy custom action ${custom.actionId} has no executable plugin binding. Install a clash.plugin/v1 plugin and recreate the Action.`;
          nodes.set(nodeId, {
            ...node,
            data: {
              ...data,
              status: "failed",
              failureCode,
              error,
            },
          });
          changed = true;
          continue;
        }

        const renderData =
          node.data && typeof node.data === "object"
            ? (node.data as Record<string, any>)
            : {};
        const hasTimelineRenderPayload =
          node.type === "video" &&
          (renderData.status === "pending" ||
            renderData.status === "generating") &&
          !renderData.assetId &&
          ((renderData.timeline &&
            typeof renderData.timeline === "object" &&
            !Array.isArray(renderData.timeline)) ||
            (renderData.timelineDsl &&
              typeof renderData.timelineDsl === "object" &&
              !Array.isArray(renderData.timelineDsl)));
        if (hasTimelineRenderPayload && !timelineRenderInputOwner(renderData)) {
          nodes.set(nodeId, {
            ...node,
            data: {
              ...renderData,
              status: "failed",
              failureCode: "TIMELINE_RENDER_INPUT_INVALID",
              error:
                "Timeline render is missing its frozen Action input owner.",
            },
          });
          changed = true;
          continue;
        }
        const frozenTimeline = hasTimelineRenderPayload
          ? timelineRenderEnvelope(doc, renderData)
          : null;
        if (hasTimelineRenderPayload && !frozenTimeline) {
          nodes.set(nodeId, {
            ...node,
            data: {
              ...renderData,
              status: "failed",
              failureCode: "TIMELINE_RENDER_INPUT_INVALID",
              error:
                "Timeline render is missing its shared frozen Timeline envelope.",
            },
          });
          changed = true;
          continue;
        }
        const isTimelineRender =
          frozenTimeline !== null &&
          renderData.status === "pending" &&
          !renderData.pendingTask &&
          !renderData.assetId;
        if (isTimelineRender) {
          try {
            const inputOwner = timelineRenderInputOwner(renderData);
            if (!inputOwner) {
              throw new Error(
                "Timeline render is missing its frozen Action input owner",
              );
            }
            const identity = {
              actionRunId: inputOwner.actionRunId,
              outputSlot: "render:output",
            };
            if (
              !options.executablePluginAction ||
              !options.resolvePluginBinding
            ) {
              throw new Error(
                "Timeline rendering requires the clash.remotion bundled Action binding.",
              );
            }
            const pluginExecution = {
              binding: await options.resolvePluginBinding(
                REMOTION_RENDER_PLUGIN_ID,
                REMOTION_RENDER_EXPORT_ID,
                "action",
              ),
              input: frozenRemotionTimelineInput({
                doc,
                timeline: frozenTimeline,
                inputOwner,
              }),
            };
            const createdAt = durable?.now?.() ?? Date.now();
            await coordinator.coordinate({
              type: "create",
              ...identity,
              deadlineAt: createdAt + generationDeadlineMs,
              executor: {
                targetKind: "action",
                binding: pluginExecution.binding,
                actionId: inputOwner.actionId,
                actor: {
                  kind: renderData.actorType === "agent" ? "agent" : "user",
                  ...(renderData.actorType === "agent" &&
                  typeof renderData.actorAgentId === "string"
                    ? { id: renderData.actorAgentId }
                    : typeof renderData.actorUserId === "string"
                      ? { id: renderData.actorUserId }
                      : {}),
                },
                publicOwner: {
                  actionId: inputOwner.actionId,
                  actionRevisionId: inputOwner.actionRevisionId,
                },
                pluginOutputSlot: identity.outputSlot,
                kind: "video",
                projectId,
                nodeId,
                provider: `plugin:${REMOTION_RENDER_PLUGIN_ID}`,
                modelEndpoint: "remotion-render",
                input: {
                  values: {
                    outputSlot: identity.outputSlot,
                    timeline: jsonSnapshot(
                      pluginExecution.input.timeline,
                    ),
                    inputOwner: jsonSnapshot(inputOwner),
                    prompt: `Render Timeline ${String(renderData.sourceTimelineId ?? nodeId)}`,
                  },
                  references: pluginExecution.input.references,
                },
              },
            });
            nodes.set(nodeId, {
              ...node,
              data: durableProviderNodeData(renderData, {
                status: "generating",
              }),
            });
            changed = true;
            await input.checkpoint?.();
            await driveDurableRun(identity);
          } catch (error) {
            const nextData: Record<string, any> = {
              ...renderData,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
            delete nextData.pendingTask;
            delete nextData.pendingTaskAt;
            nodes.set(nodeId, { ...node, data: nextData });
          }
          changed = true;
          continue;
        }

        const kind = pendingKindForNode(node);
        if (!kind) continue;

        const currentNodeData = node.data as Record<string, unknown>;
        const currentNodeProjectionRevisionId = nodeProjectionRevisionId(
          nodeId,
          kind,
          currentNodeData,
        );
        // Base-key runs from the pre-ActionRevision journal are advanced only by the recovery
        // scan above. They have no complete projection guard and therefore never reserve or
        // project onto this mutable node; the current revision receives its own scoped run below.

        const taskId = `local-gen-${sanitizeStorageSegment(nodeId)}`;
        let data = node.data as Record<string, unknown>;
        let selectedProviderAccountId: string | undefined;
        try {
          selectedProviderAccountId = (
            await providerExecutionHandoffs.load(projectId, nodeId)
          )?.accountId;
          if (data.generatorRevision !== undefined) {
            if (!input.checkpoint || !options.resolveGeneratorDefinition) {
              throw new Error("Canvas Generator execution requires the native Project Host authority.");
            }
            const ref = GeneratorRevisionRefSchema.parse(data.generatorRevision);
            const revision = readGeneratorRevision(doc, ref);
            if (!revision) {
              throw new Error("Canvas Generator revision is missing or does not match the output kind.");
            }
            if (data.generatorActionId !== undefined && (typeof data.generatorActionId !== "string" || !data.generatorActionId.trim())) throw new Error("Canvas Generator Action identity is invalid.");
            const actionId = typeof data.generatorActionId === "string" ? data.generatorActionId : "generate";
            const definition = await durableJournal.readGeneratorDefinition?.(revision.definitionRef) ??
              await options.resolveGeneratorDefinition(revision.definitionRef.pluginId, revision.definitionRef.definitionId);
            const action = definition.actions.find((entry) => entry.id === actionId);
            const output = action?.outputs[0];
            if (definition.pluginId !== revision.definitionRef.pluginId || definition.definitionId !== revision.definitionRef.definitionId ||
                definition.version !== revision.definitionRef.version || definition.schemaHash !== revision.definitionRef.schemaHash ||
                action?.outputs.length !== 1 || !output || output.cardinality.minItems !== 1 ||
                (output.assetType.kind === "media" ? output.assetType.mediaKind !== kind
                  : kind !== "text" || output.assetType.documentKind !== MODEL_TEXT_DOCUMENT_KIND || output.assetType.schemaVersion !== MODEL_TEXT_DOCUMENT_SCHEMA_VERSION)) {
              throw new Error("Canvas Generator Action does not match its pinned Definition or output kind.");
            }
            const actionRunId = `canvas-output:${nodeId}:${ref.generatorId}:${ref.generatorRevisionId}:${actionId}`;
            const identity = { actionRunId, outputSlot: output.slot };
            const product = createLocalGeneratorProductService({
              authority: {
                inspect: async (_projectId, read) => read(doc),
                mutate: async (_projectId, mutate) => mutate(doc, async () => { changed = true; await input.checkpoint!(); }),
              },
              resolveDefinition: options.resolveGeneratorDefinition,
              resolveModelExecution: createLocalModelExecutionPlanner({ aigc, modelCards: async () => modelCards, dataDir: options.dataDir }),
              ownerId: durableOwnerId, journal: durableJournal, deadlineMs: generationDeadlineMs,
              actor: data.actorType === "agent"
                ? { kind: "agent", ...(typeof data.actorAgentId === "string" ? { id: data.actorAgentId } : {}) }
                : { kind: "user", id: typeof data.actorUserId === "string" ? data.actorUserId : userId },
              canvasProjection: { nodeId, nodeProjectionRevisionId: currentNodeProjectionRevisionId },
              ...(durable?.now ? { now: durable.now } : {}),
            });
            await product.submit(projectId, ref.generatorId, actionId, {
              actionRunId, generatorRevisionId: ref.generatorRevisionId, parameters: {}, invocationInputRefs: [],
              ...(selectedProviderAccountId ? { providerAccountId: selectedProviderAccountId } : {}),
            });
            await providerExecutionHandoffs.remove(projectId, nodeId);
            nodes.set(nodeId, { ...node, data: durableProviderNodeData(data, {
              status: "generating", generatorId: ref.generatorId, generatorRevisionId: ref.generatorRevisionId, actionRunId,
            }) });
            changed = true;
            await input.checkpoint();
            await driveDurableRun(identity);
            await projectGeneratorRunToCanvas(identity);
            continue;
          }
          const authoredPrompt = authoredPromptFromData(data, `Mock ${kind}`);
          const parsedPromptParts = parsePromptParts(authoredPrompt);
          const prompt = extractPromptText(parsedPromptParts);
          const model = modelFromData(data, `mock-${kind}`);
          const normalizedModel = normalizeModelId(model) ?? model;
          const modelCard = modelCards.find(
            (card) => card.id === normalizedModel,
          );
          const effectiveModelParams = modelParams(data);
          const isStartEnd = !!modelCard?.input.inputMode.startEnd;
          // One asset-id bucket per `MEDIA_REFERENCE_FIELDS` registry entry
          // (image / video / audio / model today) so a new reference
          // modality only needs a registry entry, not a new branch here.
          const referenceAssetIdsByModality = Object.fromEntries(
            MEDIA_REFERENCE_FIELDS.map((field) => [
              field.modality,
              stringList(data[field.pendingField]),
            ]),
          ) as Record<MediaReferenceModality, string[]>;
          if (modelCard) {
            const referenceError = validateRefs(
              modelCard,
              Object.fromEntries(
                MEDIA_REFERENCE_MODALITIES.map((modality) => [
                  modality,
                  referenceAssetIdsByModality[modality].length,
                ]),
              ),
              { prompt, modelParams: effectiveModelParams },
            );
            if (referenceError) throw new Error(referenceError);
          }
          const projectAssetById = new Map(
            listProjectAssets(doc).map((asset) => [asset.id, asset]),
          );
          const referenceEntries = (
            ids: string[],
            kind: ProcessableKind,
          ): ProjectAssetEntry[] =>
            ids.map((assetId) => {
              const asset = projectAssetById.get(assetId);
              if (!asset || asset.lifecycle.state !== "active") {
                throw new Error(
                  `Reference Project Asset ${assetId} is not available in Project ${projectId}.`,
                );
              }
              if (asset.kind !== kind) {
                throw new Error(
                  `Reference Project Asset ${assetId} is ${asset.kind}, not ${kind}.`,
                );
              }
              return asset;
            });
          const referenceEntriesByModality = Object.fromEntries(
            MEDIA_REFERENCE_MODALITIES.map((modality) => [
              modality,
              referenceEntries(
                referenceAssetIdsByModality[modality],
                modality as ProcessableKind,
              ),
            ]),
          ) as Record<MediaReferenceModality, ProjectAssetEntry[]>;
          if (modelCard) {
            const mediaReferences: ReferenceMediaMetadata[] =
              MEDIA_REFERENCE_MODALITIES.flatMap((modality) =>
                referenceEntriesByModality[modality].map((asset) => ({
                  modality,
                  contentType: asset.metadata.contentType,
                  fileName: asset.metadata.originalName ?? asset.name,
                  bytes: asset.metadata.bytes,
                  width: asset.metadata.width,
                  height: asset.metadata.height,
                  durationMs: asset.metadata.durationMs,
                  frameRate: asset.metadata.frameRate,
                  videoCodec: asset.metadata.videoCodec,
                  audioCodec: asset.metadata.audioCodec,
                  embedded: !!options.mediaBaseUrl,
                })),
              );
            const mediaError = validateReferenceMedia(
              modelCard,
              mediaReferences,
              { modelParams: effectiveModelParams },
            );
            if (mediaError) throw new Error(mediaError);
          }
          const globalReferences: ProviderMediaReference[] =
            MEDIA_REFERENCE_MODALITIES.flatMap((modality) =>
              referenceEntriesByModality[modality].map((asset) => ({
                asset,
                kind: modality as ProcessableKind,
              })),
            );
          let references: ExecutablePluginReference[];
          let contentLabels: string[] | undefined;
          const referenceBindingType = modelCard?.input.referenceBinding?.type;
          // Image is the one modality with a structural exception in
          // start/end-frame models (first ref -> startFrame, second ->
          // endFrame); every other modality binds positionally regardless
          // of whether the card uses start/end frames.
          const buildPositionalReferences = (): ExecutablePluginReference[] =>
            MEDIA_REFERENCE_MODALITIES.flatMap((modality) => {
              const entries = referenceEntriesByModality[modality];
              if (isStartEnd && modality === "image") {
                return entries.flatMap((asset, index) =>
                  index === 0
                    ? [assetReference(asset, "startFrame", 0)]
                    : index === 1
                      ? [assetReference(asset, "endFrame", 0)]
                      : [assetReference(asset, "image", index - 2)],
                );
              }
              return entries.map((asset, index) =>
                assetReference(asset, modality, index),
              );
            });
          if (
            !isStartEnd &&
            (referenceBindingType === "ordered-content-parts" ||
              referenceBindingType === "positional-tokens")
          ) {
            const mixed = mixedContentReferences({
              nodeId,
              promptParts: parsedPromptParts,
              globalReferences,
              resolveMention(mentionedNodeId) {
                const referencedNode = nodes.get(mentionedNodeId) as
                  Record<string, any> | undefined;
                const assetId =
                  typeof referencedNode?.data?.assetId === "string"
                    ? referencedNode.data.assetId
                    : undefined;
                const modality = referencedNode?.type;
                if (
                  !assetId ||
                  !(MEDIA_REFERENCE_MODALITIES as readonly string[]).includes(
                    modality,
                  )
                ) {
                  return undefined;
                }
                return {
                  assetId,
                  kind: modality as ProcessableKind,
                };
              },
            });
            references = mixed.references;
            contentLabels = mixed.labels;
          } else {
            references = buildPositionalReferences();
          }
          const requestedAspectRatio =
            kind === "image" || kind === "video"
              ? aspectRatioFromData(data)
              : undefined;
          const requestedDuration =
            kind === "video" || kind === "audio"
              ? durationFromData(data, modelCard)
              : undefined;
          const commonInput = {
            taskId,
            projectId,
            nodeId,
            actorType:
              data.actorType === "agent"
                ? ("agent" as const)
                : ("user" as const),
            actorUserId:
              typeof data.actorUserId === "string" ? data.actorUserId : userId,
            ...(typeof data.actorAgentId === "string"
              ? { actorAgentId: data.actorAgentId }
              : {}),
            prompt,
            model,
            ...(requestedAspectRatio
              ? { aspectRatio: requestedAspectRatio }
              : {}),
            ...(requestedDuration !== undefined
              ? { duration: requestedDuration }
              : {}),
            modelParams: effectiveModelParams,
            // Host-private command handoff. The selected account survives restart in SQLite and
            // is frozen into the durable run before Provider submit; it never enters Loro or the
            // plugin-visible values bag.
            ...(selectedProviderAccountId
              ? { providerAccountId: selectedProviderAccountId }
              : {}),
            references,
            ...(ExecutablePluginBindingSchema.safeParse(data.pluginBinding)
              .success
              ? {
                  pluginBinding: ExecutablePluginBindingSchema.parse(
                    data.pluginBinding,
                  ),
                }
              : {}),
          };
          if (options.resolveGeneratorDefinition) {
            const isLocalAgentText = kind === "text" && model === "local-acp";
            const generatorPluginId = isLocalAgentText ? "clash.agent-text" : "clash.model-generation";
            const outputSlot = kind === "text" ? "text" : "media";
            if (!input.checkpoint) throw new Error("Canvas Model admission requires a Project checkpoint.");
            const revisionInput = isLocalAgentText ? {
              state: {
                prompt,
                ...(commonInput.actorAgentId ? { agentId: commonInput.actorAgentId } : {}),
                ...(typeof effectiveModelParams.acp_model === "string" && effectiveModelParams.acp_model.trim()
                  ? { modelId: effectiveModelParams.acp_model.trim() } : {}),
                ...(typeof effectiveModelParams.system_prompt === "string"
                  ? { systemPrompt: effectiveModelParams.system_prompt } : {}),
              },
              persistentInputRefs: [],
            } : modelGenerationRevisionFromReferences({
              modelId: normalizedModel, prompt,
              params: { ...effectiveModelParams,
                ...(requestedAspectRatio ? { aspect_ratio: requestedAspectRatio } : {}),
                ...(requestedDuration !== undefined && modelCard &&
                  (modelCard.parameters.some((parameter) => parameter.id === "duration") || modelCard.defaultParams.duration !== undefined)
                  ? { duration: coerceModelParameterInput(modelCard, "duration", requestedDuration) } : {}),
              }, references, contentLabels,
            });
            // A persisted projection may name a Run from an older adapter version.
            // Reuse it only when the Host-private target guard proves the same request.
            const cachedRunId = typeof data.actionRunId === "string" ? data.actionRunId : undefined;
            const cachedTask = cachedRunId ? await durableJournal.load({ actionRunId: cachedRunId, outputSlot }) : undefined;
            const cachedRun = cachedRunId ? readProjectActionRun(doc, cachedRunId) : undefined;
            const cachedExecutor = cachedTask ? frozenExecutorInput(cachedTask) : undefined;
            const reuseCached = cachedRun && cachedExecutor?.targetKind === "generator-action" &&
              cachedExecutor.nodeId === nodeId && cachedExecutor.nodeProjectionRevisionId === currentNodeProjectionRevisionId;
            let definition: import("@clash/shared-types").GeneratorDefinition | undefined;
            let generatorId: string;
            let generatorRevisionId: string;
            let actionRunId: string;
            if (reuseCached) {
              generatorId = cachedRun.generatorRevision.generatorId;
              generatorRevisionId = cachedRun.generatorRevision.generatorRevisionId;
              actionRunId = cachedRun.actionRunId;
            } else {
              definition = await options.resolveGeneratorDefinition(generatorPluginId, kind);
              const canvas = new Canvas(doc, () => {}, typeof node.canvasId === "string" ? node.canvasId : "main", modelCards);
              const sources = [...new Set(canvas.listEdges().filter((edge) => edge.target === nodeId)
                .map((edge) => edge.source).filter((sourceId) => canvas.readNode(sourceId)?.type === "action-badge"))];
              if (sources.length > 1) throw new Error("Canvas Model output has multiple source Actions; its Generator owner is ambiguous.");
              const sourceId = sources[0] ?? nodeId;
              const revisionDigest = createHash("sha256").update(canonicalJson({
                definitionRef: { pluginId: definition.pluginId, definitionId: definition.definitionId,
                  version: definition.version, schemaHash: definition.schemaHash },
                ...revisionInput,
              })).digest("hex");
              generatorId = `${isLocalAgentText ? "canvas-agent-text" : "canvas-model"}:${sourceId}:${revisionDigest}`;
              generatorRevisionId = `${generatorId}:revision`;
              actionRunId = `${generatorId}:output:${nodeId}:generate`;
            }
            const identity = { actionRunId, outputSlot };
            const existingTask = reuseCached ? cachedTask : await durableJournal.load(identity);
            if (existingTask && readProjectActionRun(doc, actionRunId)) {
              const frozen = frozenExecutorInput(existingTask);
              if (selectedProviderAccountId && frozen.providerExecution?.accountId !== selectedProviderAccountId) {
                throw new Error("The existing Run uses a different frozen Provider account.");
              }
              await ensureDurableInputBindings(identity);
              await driveDurableRun(identity);
              await projectGeneratorRunToCanvas(identity);
              await providerExecutionHandoffs.remove(projectId, nodeId);
              continue;
            }
            const product = createLocalGeneratorProductService({
              authority: {
                inspect: async (_projectId, read) => read(doc),
                mutate: async (_projectId, mutate) => mutate(doc, async () => { changed = true; await input.checkpoint!(); }),
              },
              resolveDefinition: async (pluginId, definitionId) =>
                definition?.pluginId === pluginId && definition.definitionId === definitionId
                  ? definition : options.resolveGeneratorDefinition!(pluginId, definitionId),
              resolveModelExecution: createLocalModelExecutionPlanner({ aigc, modelCards: async () => modelCards, dataDir: options.dataDir }),
              ownerId: durableOwnerId, journal: durableJournal, deadlineMs: generationDeadlineMs,
              actor: { kind: data.actorType === "agent" ? "agent" : "user",
                ...(data.actorType === "agent"
                  ? (commonInput.actorAgentId ? { id: commonInput.actorAgentId } : {})
                  : { id: commonInput.actorUserId }),
              },
              canvasProjection: { nodeId, nodeProjectionRevisionId: currentNodeProjectionRevisionId },
              ...(durable?.now ? { now: durable.now } : {}),
            });
            await product.create(projectId, { generatorId, generatorRevisionId,
              pluginId: generatorPluginId, definitionId: kind, ...revisionInput,
            });
            await product.submit(projectId, generatorId, "generate", { actionRunId, generatorRevisionId,
              parameters: {}, invocationInputRefs: [],
              ...(selectedProviderAccountId ? { providerAccountId: selectedProviderAccountId } : {}),
            });
            await providerExecutionHandoffs.remove(projectId, nodeId);
            data = durableProviderNodeData(data, { status: "generating", generatorId, generatorRevisionId, actionRunId });
            nodes.set(nodeId, { ...node, data });
            changed = true;
            await input.checkpoint();
            await driveDurableRun({ actionRunId, outputSlot });
            continue;
          }
          const usesLocalTextAgent =
            kind === "text" && model === "local-acp" && !!options.textAgent;
          if (!usesLocalTextAgent && aigc.planProviderPlugin) {
            const plan = await aigc.planProviderPlugin(commonInput, kind);
            if (plan) {
              if (!durable || !coordinator) {
                throw new Error(
                  "Provider-backed generation requires the Host durable run coordinator before submit.",
                );
              }
              const executor: Omit<
                FrozenLocalProviderExecutorInput,
                "schemaVersion"
              > = {
                binding: plan.binding,
                nodeProjectionRevisionId: currentNodeProjectionRevisionId,
                ...(plan.accountId ? { accountId: plan.accountId } : {}),
                kind: plan.kind,
                projectId: plan.projectId,
                ...(plan.nodeId ? { nodeId: plan.nodeId } : {}),
                provider: plan.provider,
                modelEndpoint: plan.modelEndpoint,
                assetInputs: plan.assetInputs,
                input: plan.input as FrozenLocalProviderExecutorInput["input"],
              };
              const actionRevisionId = canvasExecutorActionRevisionId(executor);
              executor.publicOwner = {
                actionId: `node:${nodeId}`,
                actionRevisionId,
              };
              const durableIdentity = durableProviderIdentity({
                projectId,
                nodeId,
                kind,
                actionRevisionId,
              });
              if (
                await resumeCanvasDurableRun({
                  identity: durableIdentity,
                  node,
                  nodeId,
                  kind,
                  nodeData: data,
                  projectionRevisionId: currentNodeProjectionRevisionId,
                })
              ) {
                continue;
              }
              const createdAt = durable?.now?.() ?? Date.now();
              await coordinator.coordinate({
                type: "create",
                ...durableIdentity,
                deadlineAt: createdAt + generationDeadlineMs,
                executor,
              });
              await ensureDurableInputBindings(durableIdentity);
              await providerExecutionHandoffs.remove(projectId, nodeId);
              data = durableProviderNodeData(data, { status: "generating" });
              nodes.set(nodeId, { ...node, data });
              changed = true;
              // The SQLite journal and coarse Project state both survive before Provider submit.
              await input.checkpoint?.();
              await driveDurableRun(durableIdentity);
              continue;
            }
          }
          const outputSlot = kind === "text" ? "text" : "media";
          const localExecutorCandidate: Omit<
            FrozenLocalProviderExecutorInput,
            "schemaVersion"
          > = {
            targetKind: "local-executor",
            binding: LOCAL_EXECUTOR_BINDING,
            actionId: `node:${nodeId}`,
            nodeProjectionRevisionId: currentNodeProjectionRevisionId,
            actor: {
              kind: data.actorType === "agent" ? "agent" : "user",
              ...(data.actorType === "agent" &&
              typeof data.actorAgentId === "string"
                ? { id: data.actorAgentId }
                : typeof data.actorUserId === "string"
                  ? { id: data.actorUserId }
                  : {}),
            },
            kind,
            projectId,
            nodeId,
            provider: "local-executor",
            modelEndpoint: model,
            input: {
              values: {
                localExecutor: "generation",
                outputSlot,
                generationKind: kind,
                generationInput: jsonSnapshot(commonInput),
                useLocalTextAgent: usesLocalTextAgent,
                prompt,
              },
              references,
            },
          };
          const actionRevisionId = canvasExecutorActionRevisionId(
            localExecutorCandidate,
          );
          localExecutorCandidate.publicOwner = {
            actionId: `node:${nodeId}`,
            actionRevisionId,
          };
          const durableIdentity = durableProviderIdentity({
            projectId,
            nodeId,
            kind,
            actionRevisionId,
          });
          if (
            await resumeCanvasDurableRun({
              identity: durableIdentity,
              node,
              nodeId,
              kind,
              nodeData: data,
              projectionRevisionId: currentNodeProjectionRevisionId,
            })
          ) {
            continue;
          }
          const createdAt = durable?.now?.() ?? Date.now();
          await coordinator.coordinate({
            type: "create",
            ...durableIdentity,
            deadlineAt: createdAt + generationDeadlineMs,
            executor: localExecutorCandidate,
          });
          await ensureDurableInputBindings(durableIdentity);
          data = durableProviderNodeData(data, { status: "generating" });
          nodes.set(nodeId, { ...node, data });
          changed = true;
          if (selectedProviderAccountId) {
            await providerExecutionHandoffs.remove(projectId, nodeId);
          }
          await input.checkpoint?.();
          await driveDurableRun(durableIdentity);
          continue;
        } catch (error) {
          if (selectedProviderAccountId) {
            await providerExecutionHandoffs.remove(projectId, nodeId);
          }
          const nextData = durableProviderNodeData(data, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          nodes.set(nodeId, { ...node, data: nextData });
          changed = true;
        }
      }

      return changed;
    },
  };
}
