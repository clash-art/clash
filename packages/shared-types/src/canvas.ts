/**
 * Canvas Types - Zod schemas for canvas nodes and edges
 * 
 * These are the canonical type definitions used across:
 * - TypeScript frontend (apps/web)
 * - TypeScript replica hosts (local-api and api-cf)
 * - Python API (via generated types)
 */

import { z } from 'zod';
import {
  MODEL_CARDS,
  ModelConstraintRuleSchema,
  ModelInputRuleSchema,
  ModelParameterSchema,
  normalizeModelId,
  resolveAspectRatio,
  resolveAspectRatioParameter,
  type ModelCard,
} from './models.js';
import {
  validateModelCardConfiguration,
  validateParameterContractConfiguration,
} from './model-constraints.js';
import {
  validateRefs,
  partitionRefs,
  referenceModality,
  capability as capabilityFromCard,
  capabilityFromCustom,
  directorReferencePacket,
  hasDirectorReferenceOutput,
  MEDIA_REFERENCE_FIELDS,
  mediaReferencePendingFields,
  mediaReferenceCounts,
  type Capability,
  type RefNodeLike,
  type RefPartition,
  type MediaReferencePendingFields,
} from './model-capabilities.js';
import {
  DirectorReferencePacketSchema,
  directorReferencePromptContext,
  type DirectorReferencePacket,
} from './director-reference.js';
import {
  composePromptWithTextRefs,
  extractPromptText,
  parsePromptParts,
} from './prompt.js';
import {
  ExecutablePluginBindingSchema,
  ExecutableActionPresentationSchema,
  ExecutableActionCardGeneratorSchema,
  type ExecutablePluginBinding,
} from './executable-plugin.js';

// === Position ===
export const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

// === ReactFlow Node Types ===
// These are the node type strings used in Loro and ReactFlow.
// Both frontend and backend must agree on these values.

/** Content node types that agents can create via create_canvas_node */
export const RF_NODE_TYPE = {
  /** Text / markdown content */
  Text: 'text',
  /** Container group */
  Group: 'group',
  /** Image asset (completed generation or upload) */
  Image: 'image',
  /** Video asset (completed generation or upload) */
  Video: 'video',
  /** Audio asset (completed generation or upload) */
  Audio: 'audio',
  /** 3D model asset (completed generation or upload) */
  Model: 'model',
  /** Agent-authored Remotion TSX component with live Canvas/Timeline preview */
  RemotionComponent: 'remotion-component',
  /** Generation node — renders as ActionBadge */
  ActionBadge: 'action-badge',
} as const;

/** Subtypes for action-badge nodes, stored in node.data.actionType */
export const ACTION_TYPE = {
  ImageGen: 'image-gen',
  VideoGen: 'video-gen',
  AudioGen: 'audio-gen',
  TextGen: 'text-gen',
  /** 3D model generation (mesh generation, auto-rig, etc.) */
  ModelGen: 'model-gen',
  /** Custom actions provided by local agents. Full actionType: "custom:<action-id>" */
  Custom: 'custom',
} as const;

export {
  ASSET_ACTION_ID,
  EDIT_KIND,
  CropRectSchema,
  ImageEditParamsSchema,
  VideoClipParamsSchema,
  type AssetActionId,
  type EditKind,
  type CropRect,
  type ImageEditParams,
  type VideoClipParams,
} from './actions/asset-edit.js';

/**
 * Map from agent-facing node type names to the ReactFlow type + actionType
 * used in Loro and the frontend.
 */
export const AGENT_NODE_TYPE_MAP = {
  text:      { rfType: RF_NODE_TYPE.Text },
  group:     { rfType: RF_NODE_TYPE.Group },
  image:     { rfType: RF_NODE_TYPE.Image },
  video:     { rfType: RF_NODE_TYPE.Video },
  audio:     { rfType: RF_NODE_TYPE.Audio },
  model:     { rfType: RF_NODE_TYPE.Model },
  remotion:  { rfType: RF_NODE_TYPE.RemotionComponent },
  image_gen: { rfType: RF_NODE_TYPE.ActionBadge, actionType: ACTION_TYPE.ImageGen },
  video_gen: { rfType: RF_NODE_TYPE.ActionBadge, actionType: ACTION_TYPE.VideoGen },
  audio_gen: { rfType: RF_NODE_TYPE.ActionBadge, actionType: ACTION_TYPE.AudioGen },
  text_gen:  { rfType: RF_NODE_TYPE.ActionBadge, actionType: ACTION_TYPE.TextGen },
  model_gen: { rfType: RF_NODE_TYPE.ActionBadge, actionType: ACTION_TYPE.ModelGen },
} as const;

// === Node Status ===
export const NodeStatusSchema = z.enum([
  'idle',
  'pending',
  'generating',
  'completed',
  'failed',
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

// === Node Data ===
export const NodeDataSchema = z.object({
  label: z.string().optional(),
  content: z.string().optional(),
  /** Stable component export id for a remotion-component Canvas node. */
  componentId: z.string().min(1).optional(),
  /** Product-scaffold preview/render width for a remotion-component node. */
  compositionWidth: z.number().int().positive().optional(),
  /** Product-scaffold preview/render height for a remotion-component node. */
  compositionHeight: z.number().int().positive().optional(),
  /** Product-scaffold frame rate for a remotion-component node. */
  fps: z.number().positive().optional(),
  /** Product-scaffold duration for a remotion-component node. */
  durationInFrames: z.number().int().positive().optional(),
  /** Direct text entered in a music action's dedicated Lyrics input. */
  lyrics: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
  src: z.string().optional(),
  url: z.string().optional(),
  thumbnail: z.string().optional(),
  poster: z.string().optional(),
  status: NodeStatusSchema.optional(),
  assetId: z.string().optional(),
  stageId: z.string().optional(),
  /** Latest registered reference-video output from a Director Stage node. */
  outputVideoAssetId: z.string().optional(),
  outputVideoDurationSeconds: z.number().optional(),
  outputVideoFps: z.number().optional(),
  outputVideoStageRevisionId: z.string().optional(),
  /** Canonical, revision-pinned Director output for downstream generation. */
  directorReferencePacket: DirectorReferencePacketSchema.optional(),
  /** Ordered, individually rendered Shot packets selected for batch generation. */
  directorShotReferencePackets: z.array(DirectorReferencePacketSchema).optional(),
  selectedDirectorShotIds: z.array(z.string().min(1)).optional(),
  /** Per-output lineage back to the exact Stage revision and Shot. */
  sourceDirectorStageId: z.string().min(1).optional(),
  sourceDirectorStageRevisionId: z.string().min(1).optional(),
  sourceDirectorStageShotId: z.string().min(1).optional(),
  sourceDirectorStageShotIds: z.array(z.string().min(1)).optional(),
  sourceDirectorStageCameraId: z.string().min(1).optional(),
  /** Shared Canvas group identity for independently regeneratable Shot outputs. */
  directorShotGroupId: z.string().min(1).optional(),
  taskId: z.string().optional(),
  actionType: z.string().optional(),
  upstreamNodeIds: z.array(z.string()).optional(),
  duration: z.number().optional(),
  model: z.string().optional(),
  modelId: z.string().optional(),
  modelParams: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  referenceImageUrls: z.array(z.string()).optional(),
  error: z.string().optional(),
  sourceNodeId: z.string().optional(),
  /** Custom action ID (e.g. "style-transfer") for custom:* action types */
  customActionId: z.string().optional(),
  /** User-configured parameters for custom actions */
  customActionParams: z.record(z.unknown()).optional(),
  /** Immutable plugin export/version/schema used by this node. */
  pluginBinding: ExecutablePluginBindingSchema.optional(),
  // ─── Actor attribution (Phase 0 multi-actor billing) ────────
  // Stamped by the creation site (web UI / ACP tool / CLI). For
  // legacy nodes created before this rollout these are absent —
  // NodeProcessor surfaces missing attribution as a clear node
  // failure rather than silently falling back to the project owner.
  /** 'user' or 'agent' — who placed this node on the canvas. */
  actorType: z.enum(['user', 'agent']).optional(),
  /** The accountable human user id. Always set for new nodes; for
   *  actorType='agent' this is the agent's owner / claimer. */
  actorUserId: z.string().optional(),
  /** agent member id when actorType='agent'. */
  actorAgentId: z.string().optional(),
  /** Structured understanding results (ASR transcription, visual analysis, etc.).
   *  Keys are overwritten, not merged — each key is independently owned. */
  understanding: z.object({
    transcription: z.object({
      text: z.string(),
      segments: z.array(z.object({
        start: z.number(),
        end: z.number(),
        text: z.string(),
      })),
    }).optional(),
    visual: z.object({
      description: z.string().optional(),
      shots: z.array(z.object({
        start: z.number(),
        end: z.number(),
        description: z.string(),
      })).optional(),
      tags: z.array(z.string()).optional(),
    }).optional(),
  }).passthrough().optional(),
}).passthrough(); // Allow additional fields

export type NodeData = z.infer<typeof NodeDataSchema>;

export const UpstreamRefSchema = z.object({
  nodeId: z.string(),
  edgeId: z.string(),
  type: z.string().default('default'),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});
export type UpstreamRef = z.infer<typeof UpstreamRefSchema>;

// === Canvas Node ===
export const CanvasNodeSchema = z.object({
  id: z.string(),
  canvasId: z.string(),
  type: z.string(),
  position: PositionSchema,
  data: NodeDataSchema,
  upstream: z.array(UpstreamRefSchema).default([]),
  parentId: z.string().optional(),
  extent: z.literal('parent').optional(),
});
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;

// === Canvas Edge ===
export const CanvasEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  type: z.string().default('default'),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
});
export type CanvasEdge = z.infer<typeof CanvasEdgeSchema>;

// === Loro Document State ===
export const LoroDocumentStateSchema = z.object({
  canvases: z.record(z.string(), z.object({
    id: z.string(),
    name: z.string(),
    position: z.number(),
  })),
  nodes: z.record(z.string(), CanvasNodeSchema),
  tasks: z.record(z.string(), z.any()),
});
export type LoroDocumentState = z.infer<typeof LoroDocumentStateSchema>;

// === Generation Pre-validation ===

export type ValidateGenerationInput = MediaReferencePendingFields & {
  prompt: string;
  referenceTextSnippets?: string[];
  modelParams?: Record<string, string | number | boolean | undefined>;
  /** Either supply the raw ModelCard (legacy) or a pre-derived
   *  Capability (the new unified path that covers custom actions too). */
  modelCard?: ModelCard;
  capability?: import("./model-capabilities.js").Capability;
};

/**
 * Validate generation inputs against the bound's capability. Returns
 * null if valid, or an error message string if invalid.
 *
 * Thin wrapper around `validateRefs` (model-capabilities.ts). Pre-
 * computed `capability` wins over `modelCard` so the same call works
 * for model-backed and custom-action gens.
 */
export function validateGenerationInput(input: ValidateGenerationInput): string | null {
  const {
    prompt,
    referenceTextSnippets = [],
    modelParams,
    modelCard,
    capability,
  } = input;
  const cardOrCap = capability ?? modelCard;
  if (!cardOrCap) return null;
  const counts: Partial<Record<string, number>> = { text: referenceTextSnippets.length };
  for (const field of MEDIA_REFERENCE_FIELDS) {
    const ids = input[field.pendingField];
    counts[field.modality] = ids?.length ?? 0;
  }
  return validateRefs(
    cardOrCap,
    counts,
    { prompt, modelParams },
  );
}

// === Pending Asset Node Builder ===
// Shared logic for creating a pending image/video node from generation params.
// Used by both frontend (ActionBadge) and backend (run_generation_node tool).

export type BuildPendingAssetNodeInput = MediaReferencePendingFields & {
  nodeId: string;
  prompt: string;
  /** For built-in models: the Clash modelId (`nano-banana-2`, etc.).
   *  For custom actions: empty string (the action id lives in
   *  `customActionId` instead). NodeProcessor switches by
   *  `actionType.startsWith('custom:')`. */
  modelId: string;
  modelParams: Record<string, string | number | boolean>;
  /** Either a built-in actionType or `custom:<id>`. NodeProcessor
   *  uses this discriminator to pick the dispatch path. */
  actionType:
    | typeof ACTION_TYPE.ImageGen
    | typeof ACTION_TYPE.VideoGen
    | typeof ACTION_TYPE.AudioGen
    | typeof ACTION_TYPE.TextGen
    | typeof ACTION_TYPE.ModelGen
    | `custom:${string}`;
  label?: string;
  referenceMode?: string;
  /** Pipeline status to stamp on the node. The default `'pending'`
   *  fits the executor / Run flow (NodeProcessor picks these up). The
   *  web's lazy-draft path stamps `'draft'` instead — a placeholder
   *  slot the user can fill before submit. */
  status?: 'pending' | 'draft';
  /** Custom-action only: the marketplace action id. NodeProcessor
   *  reads this to fetch the runtime / workerUrl manifest. */
  customActionId?: string;
  /** Custom-action only: the declarative param values from the form
   *  the user filled in. Forwarded verbatim to the action runtime. */
  customActionParams?: Record<string, string | number | boolean>;
  /** Custom-action only: the action's declared output modality
   *  (image / video / audio / text). Overrides what we'd otherwise
   *  derive from actionType. */
  outputType?: 'image' | 'video' | 'audio' | 'text';
  /** Exact executable implementation selected when this node was created. */
  pluginBinding?: ExecutablePluginBinding;
  /** Canonical W:H used to size pending media independently of provider aliases. */
  aspectRatio?: string;
};

export interface PendingAssetNode {
  id: string;
  type: typeof RF_NODE_TYPE.Image | typeof RF_NODE_TYPE.Video | typeof RF_NODE_TYPE.Audio | typeof RF_NODE_TYPE.Text | typeof RF_NODE_TYPE.Model;
  data: Record<string, unknown>;
}

/** Extract a short label from prompt text. Skips markdown heading
 *  prefixes and trims to 60 chars so it fits on the node chip. Shared
 *  between server `executeGeneration` and web `useSpawnPendingAsset`
 *  so both paths produce the same label. */
export function extractLabelFromPrompt(promptText: string, fallback: string): string {
  if (!promptText || promptText.trim() === '') return fallback;
  const lines = promptText.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).filter(Boolean);
  const first = lines[0] || fallback;
  return first.length > 60 ? first.slice(0, 57) + '...' : first;
}

/**
 * Build a pending asset node ready to be inserted into Loro.
 * NodeProcessor picks up `status:"pending"` (no src field — assets live on
 * D1, server resolves via assetId).
 */
/**
 * The duration a pending video node should carry when nothing asked for one.
 *
 * Reads the Card: `defaultParams` first, then the parameter's own default, then the first
 * candidate. Returns undefined for an unknown model so the field is simply omitted rather
 * than filled with a guess.
 */
function pendingDurationFallback(modelId: string | undefined): number | string | undefined {
  if (!modelId) return undefined;
  const card = MODEL_CARDS.find(candidate => candidate.id === normalizeModelId(modelId) || candidate.id === modelId);
  if (!card) return undefined;
  const declared = card.defaultParams?.duration;
  if (declared !== undefined) return declared as number | string;
  const parameter = card.parameters.find(candidate => candidate.id === 'duration');
  if (!parameter) return undefined;
  if (parameter.defaultValue !== undefined) return parameter.defaultValue as number | string;
  return parameter.options?.[0]?.value as number | string | undefined;
}

export function buildPendingAssetNode(input: BuildPendingAssetNodeInput): PendingAssetNode {
  const {
    nodeId, prompt, modelId, modelParams, actionType, aspectRatio,
    referenceMode, customActionId, customActionParams, outputType, pluginBinding,
  } = input;

  // Custom-action flag drives a few small divergences: we don't pin
  // `count: 1`, we carry customActionId + customActionParams as the
  // dispatch payload, and the output modality comes from the action's
  // declared `outputType` rather than the built-in actionType enum.
  const isCustom = typeof actionType === 'string' && actionType.startsWith('custom:');
  const effectiveOutputKind: 'image' | 'video' | 'audio' | 'text' | 'model' = isCustom
    ? (outputType ?? 'image')
    : actionType === ACTION_TYPE.VideoGen
      ? 'video'
      : actionType === ACTION_TYPE.AudioGen
        ? 'audio'
        : actionType === ACTION_TYPE.TextGen
          ? 'text'
          : actionType === ACTION_TYPE.ModelGen
            ? 'model'
            : 'image';

  const isImage = effectiveOutputKind === 'image';
  const isVideo = effectiveOutputKind === 'video';
  const isAudio = effectiveOutputKind === 'audio';
  const isText = effectiveOutputKind === 'text';
  const isModel = effectiveOutputKind === 'model';
  const rfType = isVideo
    ? RF_NODE_TYPE.Video
    : isAudio
      ? RF_NODE_TYPE.Audio
      : isText
        ? RF_NODE_TYPE.Text
        : isModel
          ? RF_NODE_TYPE.Model
          : RF_NODE_TYPE.Image;
  const defaultLabel = isVideo
    ? 'Generated Video'
    : isAudio
      ? 'Generated Audio'
      : isText
        ? 'Generated Text'
        : isModel
          ? 'Generated Model'
          : 'Generated Image';
  const label = input.label || extractLabelFromPrompt(prompt, defaultLabel);

  // image-gen (built-in only) pins `count: 1` on its modelParams the
  // way the web's useSpawnPendingAsset does so downstream batch-size
  // logic doesn't assume a missing count means "use the action-badge's
  // count". Custom actions follow their own param schema.
  const effectiveModelParams: Record<string, string | number | boolean> = isImage && !isCustom
    ? { ...modelParams, count: 1 }
    : modelParams;

  const data: Record<string, unknown> = {
    label,
    status: input.status ?? 'pending',
    prompt,
    actionType,
  };
  if (pluginBinding) data.pluginBinding = ExecutablePluginBindingSchema.parse(pluginBinding);

  if (isCustom) {
    if (customActionId) data.customActionId = customActionId;
    if (customActionParams) data.customActionParams = customActionParams;
    if (outputType) data.outputType = outputType;
  } else {
    data.model = modelId;
    data.modelId = modelId;
    data.modelParams = effectiveModelParams;
  }

  if (isText) {
    data.content = '';
  } else {
    const resolvedAspectRatio = aspectRatio
      ?? (!isCustom ? resolveAspectRatio(modelId, modelParams) : undefined);
    if (resolvedAspectRatio) data.aspectRatio = resolvedAspectRatio;
    data.referenceMode = referenceMode || 'none';
  }

  // Ref arrays. The pending child carries whichever buckets came out
  // of partitionRefs — for custom this fixes the pre-unification bug
  // where the manifest's `promptModalities` declared (say) image
  // input but the pending node dropped all refs, leaving the action
  // unable to consume canvas assets. One field per `MEDIA_REFERENCE_FIELDS`
  // entry (image / video / audio / model) so a new modality only needs an
  // entry there, not a new `if` here.
  for (const field of MEDIA_REFERENCE_FIELDS) {
    const ids = input[field.pendingField];
    if (ids && ids.length > 0) data[field.pendingField] = ids;
  }

  if (isVideo && !isCustom) {
    // Carry what the Card offers, not a number of our own.
    //
    // A duration menu may list a sentinel next to the seconds -- `auto` means the provider
    // picks -- so coercing to a number destroyed it twice: `parseInt('auto')` is NaN, and
    // `NaN || 5` is 5. Five is absent from several menus, and the generation then failed its
    // own validator before any request went out. `seedance-2-fast-startend` offers
    // ["auto", 4, 6, 8, 10, 15].
    const declared = modelParams.duration ?? pendingDurationFallback(modelId);
    if (declared !== undefined) {
      const numeric = typeof declared === 'number' ? declared : Number(declared);
      data.duration = Number.isFinite(numeric) ? numeric : declared;
    }
  }

  return { id: nodeId, type: rfType, data };
}

// === Unified generation payload pipeline ===
//
// `buildGenerationPayload` is the single staging step that turns the
// raw inputs an action-badge carries (a markdown prompt with
// `@[Label](node:id)` mentions, a list of attached ref nodes, the
// chosen model card, and modelParams) into the validated, normalized
// shape the executor feeds to `buildPendingAssetNode`.
//
// Two call sites: the web UI's `useSpawnPendingAsset.buildShape`
// (browser side, executes when the user clicks Run on an
// action-badge) and the server-side `Canvas.executeGeneration` (used
// by `clash canvas execute`, agent tools, automation). Before this
// helper they re-implemented overlapping logic in parallel and
// diverged on three things:
//   1. partitionRefs / model-card filtering (web honored max +
//      modality, executor ignored both)
//   2. composing text-ref content into the prompt
//   3. stripping `@[Label](node:id)` markdown back to plain text
//      before sending it to the model
// Pulling them into one helper means new modalities / new model
// constraints land in exactly one place.

/**
 * Either a built-in model (`{ modelCard, modelParams }`) or a
 * marketplace custom action (`{ customDef, customActionParams }`).
 * Both flow through the same payload builder — they're two surfaces
 * for the same concept: declarative generation config + per-modality
 * ref capability.
 */
export type GenerationConfig =
  | {
      kind: 'model';
      modelCard?: ModelCard;
      modelParams: Record<string, string | number | boolean>;
    }
  | {
      kind: 'custom';
      customDef: CustomActionDefinition;
      customActionParams: Record<string, string | number | boolean>;
    };

export interface BuildGenerationPayloadInput {
  /** Raw prompt as the user typed it (with `@[Label](node:id)` mentions). */
  prompt: string;
  /** Direct text entered in the dedicated Lyrics slot for music models. */
  lyrics?: string;
  /** All canvas nodes the action-badge has incoming edges from. The
   *  helper does NOT walk edges itself — the caller supplies the
   *  resolved nodes (web reads from React Flow state, server from
   *  Canvas's edges + node lookup). */
  refNodes: ReadonlyArray<RefNodeLike>;
  /** Stable id of the gen config (modelId for built-in, customActionId
   *  for custom). The pending child node persists it so the executor
   *  / NodeProcessor knows what to dispatch to. */
  configId: string;
  /** The full gen config — `kind` discriminates which set of params is
   *  authoritative. The helper uses this to derive a Capability so
   *  partitionRefs / validateRefs / extractPromptText all work the
   *  same way regardless of model vs custom. */
  config: GenerationConfig;
  /** Output modality of the gen. Required for custom (the action
   *  declares it on the def); for built-in models it must match the
   *  card's `kind`. */
  actionType:
    | typeof ACTION_TYPE.ImageGen
    | typeof ACTION_TYPE.VideoGen
    | typeof ACTION_TYPE.AudioGen
    | typeof ACTION_TYPE.TextGen
    | typeof ACTION_TYPE.ModelGen
    | `custom:${string}`;
  label?: string;
  referenceMode?: string;
  /** Exact plugin implementation selected on the Action Badge. */
  pluginBinding?: ExecutablePluginBinding;
}

export interface BuildGenerationPayloadResult {
  /** Ready-to-feed input for `buildPendingAssetNode`. The `nodeId`
   *  field is left empty so the caller can mint it however it wants
   *  (generateSemanticId on the web, Canvas.generateId on the
   *  server). */
  pendingInput: BuildPendingAssetNodeInput;
  /** First validation error against the model card, or null when the
   *  payload is acceptable / no model card supplied. Caller decides
   *  whether to throw, surface the message, or fall through. */
  validationError: string | null;
  /** The partition that was computed, kept for callers that want to
   *  log "wired 2 image refs / 1 video ref" without re-walking the
   *  buckets themselves. */
  partition: RefPartition;
  /** The cleaned, plain-text prompt that ends up in
   *  provider adapters after they choose how to encode references. The
   *  pending input itself preserves authored @-mention ordering. */
  cleanedPrompt: string;
}

export function buildGenerationPayload(input: BuildGenerationPayloadInput): BuildGenerationPayloadResult {
  // 1. Derive the Capability from whichever config the caller passed.
  //    Both built-in models and custom actions go through the same
  //    `Capability` shape so partitionRefs / validateRefs / the
  //    helpers downstream don't branch on config kind.
  const cap: Capability | undefined =
    input.config.kind === 'model'
      ? input.config.modelCard
        ? capabilityFromCard(input.config.modelCard)
        : undefined
      : capabilityFromCustom(input.config.customDef);
  const referenceValidationModelParams = input.config.kind === 'model'
    ? input.config.modelParams
    : input.config.customActionParams;

  // Validate the graph edges before partitioning. partitionRefs intentionally
  // omits unsupported modalities from provider payloads, but treating that as
  // success would preserve a misleading lineage edge (for example image ->
  // text-only TTS) while silently sending no image to the model.
  const attachedRefCounts = input.refNodes.reduce(
    (counts, node) => {
      if (directorReferencePacket(node) && cap) {
        const adapted = partitionRefs([node], cap);
        const adaptedCount =
          adapted.imageAssetIds.length
          + adapted.videoAssetIds.length
          + adapted.audioAssetIds.length;
        if (adaptedCount > 0) {
          counts.image += adapted.imageAssetIds.length;
          counts.video += adapted.videoAssetIds.length;
          counts.audio += adapted.audioAssetIds.length;
          return counts;
        }
      }
      const modality = referenceModality(node);
      if (modality) {
        counts[modality] += 1;
      }
      return counts;
    },
    { text: 0, image: 0, video: 0, audio: 0, model: 0 },
  );
  const attachedRefValidationError = cap
    ? validateRefs(cap, attachedRefCounts, {
        modelParams: referenceValidationModelParams,
      })
    : null;
  const unexportedDirectorStageError = input.refNodes.some(
    (node) =>
      node.type === 'director-stage'
      && !hasDirectorReferenceOutput(node),
  )
    ? 'Director Stage has no reference video yet. Export the shot before running generation.'
    : null;

  // 2. Partition refs by modality. Without a capability the caller is
  //    deliberately running unconstrained (e.g. a model card hasn't
  //    loaded yet, or a custom def is mid-install) — bucket nothing.
  const partition: RefPartition = cap
    ? partitionRefs(input.refNodes, cap)
    : { texts: [], imageAssetIds: [], videoAssetIds: [], audioAssetIds: [], modelAssetIds: [] };

  // Music providers expose the same two product inputs with different wire
  // shapes. Prompt may consume model-supported references; Lyrics is direct
  // text only. MiniMax has a `lyrics` field; Suno custom mode puts lyrics in
  // `prompt` and uses style/title alongside it.
  const musicInput = input.config.kind === 'model'
    ? input.config.modelCard?.musicInput
    : undefined;
  const musicLyrics = musicInput
    ? (input.lyrics ?? '').trim()
    : '';
  const hasMappedLyrics = Boolean(musicInput && musicLyrics);
  const lyricsUsePrompt = hasMappedLyrics && musicInput?.lyricsTarget === 'prompt';
  const promptWithTextReferences = composePromptWithTextRefs(input.prompt, partition.texts);
  const composedPrompt = lyricsUsePrompt ? musicLyrics : promptWithTextReferences;
  const cleanedEditorPrompt = extractPromptText(parsePromptParts(promptWithTextReferences));
  const directorPromptContexts = cap?.promptModalities.includes('text')
    ? [...new Map(
        input.refNodes
          .map((node) => directorReferencePacket(node))
          .filter((packet): packet is DirectorReferencePacket =>
            Boolean(packet && packet.shotSpec.shots.length > 0),
          )
          .map((packet) => [
            `${packet.stageId}:${packet.stageRevisionId}`,
            directorReferencePromptContext(packet),
          ]),
      ).values()]
    : [];
  const promptWithDirectorPlan = [
    composedPrompt,
    ...directorPromptContexts,
  ].filter((part) => part.trim()).join('\n\n');

  // 4. Strip the `@[Label](node:id)` markdown markers and replace with
  //    just the label. Models don't speak our mention syntax; sending
  //    them the raw markdown confuses prompt adherence ("the user
  //    mentioned @[..] is that important?").
  const cleanedPrompt = extractPromptText(parsePromptParts(promptWithDirectorPlan));

  // 5. Validate against the capability. Skipped when we don't have
  //    one (custom mid-install / model card not loaded).
  const modelConfigurationError = input.config.kind === 'model' && input.config.modelCard
    ? validateModelCardConfiguration(input.config.modelCard, {
        prompt: cleanedPrompt,
        lyrics: musicLyrics,
        modelParams: input.config.modelParams,
      }, {
        rejectUnknownParameters: true,
        allowedParameterIds: [
          'keyframe_frame_indices',
          'keyframe_timing_customized',
          'provider_id',
          'require_real_provider',
          ...(input.config.modelCard.providerImplementations?.flatMap((implementation) => [
            ...(implementation.parameterOverrides?.map((parameter) => parameter.id) ?? []),
            ...Object.keys(implementation.defaultParamOverrides ?? {}),
          ]) ?? []),
        ],
      })
    : null;
  const customConfigurationError = input.config.kind === 'custom'
    ? validateParameterContractConfiguration({
        parameters: input.config.customDef.parameters,
        defaultParams: customActionDefaultParams(input.config.customDef),
        constraints: input.config.customDef.constraints,
      }, {
        prompt: cleanedPrompt,
        modelParams: input.config.customActionParams,
      })
    : null;
  const validationError = unexportedDirectorStageError
    ?? attachedRefValidationError
    ?? modelConfigurationError
    ?? customConfigurationError
    ?? (cap
    ? validateGenerationInput({
        prompt: cleanedPrompt,
        referenceTextSnippets: partition.texts,
        ...mediaReferencePendingFields(partition),
        modelParams: referenceValidationModelParams,
        capability: cap,
      })
    : null);

  const totalAssetRefs = Object.values(mediaReferenceCounts(partition)).reduce(
    (total, count) => total + count,
    0,
  );
  const modelParams: Record<string, string | number | boolean> = input.config.kind === 'model'
    ? { ...input.config.modelParams }
    : {};
  // Provider/account selection belongs to the owner-private execution handoff. Accept legacy
  // authored input during validation, but never project it into the pending Loro node.
  delete modelParams.provider_id;
  if (musicInput?.lyricsTarget === 'modelParam' && musicInput.lyricsParam) {
    modelParams[musicInput.lyricsParam] = musicLyrics;
  }
  if (lyricsUsePrompt && musicInput?.descriptionParam) {
    const currentDescription = modelParams[musicInput.descriptionParam];
    if (typeof currentDescription !== 'string' || !currentDescription.trim()) {
      modelParams[musicInput.descriptionParam] = cleanedEditorPrompt;
    }
  }
  if (lyricsUsePrompt && musicInput?.titleParam) {
    const currentTitle = modelParams[musicInput.titleParam];
    if (typeof currentTitle !== 'string' || !currentTitle.trim()) {
      modelParams[musicInput.titleParam] = input.label
        || extractLabelFromPrompt(cleanedEditorPrompt, 'Untitled');
    }
  }

  // 6. Pending-asset input. Both branches write the SAME ref fields —
  //    custom actions previously dropped them (so a marketplace
  //    action couldn't consume canvas assets even though its manifest
  //    declared it could); writing them here fixes that.
  const pendingInput: BuildPendingAssetNodeInput =
    input.config.kind === 'model'
      ? {
          nodeId: '', // caller fills in
          prompt: promptWithDirectorPlan,
          modelId: input.configId,
          modelParams,
          actionType: input.actionType as
            | typeof ACTION_TYPE.ImageGen
            | typeof ACTION_TYPE.VideoGen
            | typeof ACTION_TYPE.AudioGen
            | typeof ACTION_TYPE.TextGen
            | typeof ACTION_TYPE.ModelGen,
          label: input.label,
          ...mediaReferencePendingFields(partition),
          referenceMode:
            input.referenceMode ?? (totalAssetRefs > 0 ? 'image-and-prompt' : undefined),
          pluginBinding: input.pluginBinding,
        }
      : {
          nodeId: '',
          prompt: promptWithDirectorPlan,
          // Custom actions don't have a modelId, but the pending node
          // schema still needs *something* to disambiguate the
          // dispatch path. We stash `custom:<actionId>` in the modelId
          // field (mirrors what NodeProcessor already reads via
          // `innerData.actionType.startsWith('custom:')`) and also
          // expose customActionId + customActionParams via the
          // pending input's extra fields below.
          modelId: '',
          modelParams: {},
          actionType: input.actionType as `custom:${string}`,
          label: input.label,
          customActionId: input.config.customDef.id,
          customActionParams: input.config.customActionParams,
          aspectRatio: resolveAspectRatioParameter(
            input.config.customDef.parameters.find(
              (parameter) => parameter.id === 'aspect_ratio',
            ),
            input.config.customActionParams.aspect_ratio,
          ),
          ...mediaReferencePendingFields(partition),
          referenceMode:
            input.referenceMode ?? (totalAssetRefs > 0 ? 'image-and-prompt' : undefined),
          outputType: input.config.customDef.outputType,
          pluginBinding: input.pluginBinding,
        };

  return { pendingInput, validationError, partition, cleanedPrompt };
}

// ─── Legacy / Agent-facing Constants ──────────────────────
// Used by agents, CLI, and backend code that speaks in "image_gen"/"video_gen"
// style names rather than ReactFlow action-badge types.
// rather than the ReactFlow types above.

/** Agent-facing node type names */
export const NodeType = {
  Text: "text",
  Group: "group",
  Image: "image",
  Video: "video",
  Audio: "audio",
  Model: "model",
  ImageGen: "image_gen",
  VideoGen: "video_gen",
  AudioGen: "audio_gen",
  TextGen: "text_gen",
  ModelGen: "model_gen",
} as const;

export const ALL_NODE_TYPES = Object.values(NodeType) as [string, ...string[]];
export const CONTENT_NODE_TYPES = [NodeType.Text, NodeType.Group] as const;
export type ContentNodeType = (typeof CONTENT_NODE_TYPES)[number];
export const GENERATION_NODE_TYPES = [NodeType.ImageGen, NodeType.VideoGen, NodeType.AudioGen, NodeType.TextGen, NodeType.ModelGen] as const;
export type GenerationNodeType = (typeof GENERATION_NODE_TYPES)[number];

export function isGenerationNodeType(t: string): boolean {
  return (GENERATION_NODE_TYPES as readonly string[]).includes(t);
}

/** @deprecated Use RF_NODE_TYPE.ActionBadge + ACTION_TYPE */
export const FrontendNodeType = {
  ImageGen: "action-badge",
  VideoGen: "action-badge",
  AudioGen: "action-badge",
  TextGen: "action-badge",
} as const;

export const ProposalType = {
  Simple: "simple",
  Generative: "generative",
  Group: "group",
} as const;

/** Node lifecycle status — matches NodeStatusSchema values */
export const TaskStatus = {
  Idle: "idle",
  Pending: "pending",
  Generating: "generating",
  Completed: "completed",
  Failed: "failed",
  NodeNotFound: "node_not_found",
} as const;

export const AssetStatus = {
  Pending: "pending",
  Processing: "processing",
  Completed: "completed",
  Failed: "failed",
} as const;

// ─── Custom Action Definitions ───────────────────────────
// Used by local agents (Python SDK) and deployed workers (CF Workers)
// to register custom actions on the canvas.

export const CustomActionParameterSchema = ModelParameterSchema;
export type CustomActionParameter = z.infer<typeof CustomActionParameterSchema>;

export const CustomActionSecretSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  required: z.boolean().default(true),
});
export type CustomActionSecret = z.infer<typeof CustomActionSecretSchema>;

export const ACTION_PROVIDER_IDS = [
  'fal',
  'replicate',
  'official',
  'openai',
  'google-ai-studio',
  'google-agent-platform',
  'anthropic',
  'elevenlabs',
] as const;
export type ActionProviderId = (typeof ACTION_PROVIDER_IDS)[number];

const ACTION_PROVIDER_ALIASES: Record<string, ActionProviderId> = {
  fal: 'fal',
  'fal.ai': 'fal',
  falai: 'fal',
  replicate: 'replicate',
  replica: 'replicate',
  'replicate.com': 'replicate',
  official: 'official',
  native: 'official',
  openai: 'openai',
  'openai.com': 'openai',
  'google-ai-studio': 'google-ai-studio',
  aistudio: 'google-ai-studio',
  'ai-studio': 'google-ai-studio',
  'google-agent-platform': 'google-agent-platform',
  'agent-platform': 'google-agent-platform',
  anthropic: 'anthropic',
  claude: 'anthropic',
  elevenlabs: 'elevenlabs',
  'eleven-labs': 'elevenlabs',
  'elevenlabs.io': 'elevenlabs',
};

export interface ActionProviderPreset {
  id: ActionProviderId;
  label: string;
  defaultSecretId: string;
  secretLabel: string;
  secretDescription: string;
  docsUrl?: string;
}

export const ACTION_PROVIDER_PRESETS: Record<ActionProviderId, ActionProviderPreset> = {
  fal: {
    id: 'fal',
    label: 'fal.ai',
    defaultSecretId: 'FAL_API_KEY',
    secretLabel: 'fal.ai API key',
    secretDescription: 'API key used to call the fal.ai model provider.',
    docsUrl: 'https://fal.ai/dashboard/keys',
  },
  replicate: {
    id: 'replicate',
    label: 'Replicate',
    defaultSecretId: 'REPLICATE_API_TOKEN',
    secretLabel: 'Replicate API token',
    secretDescription: 'API key used to call the Replicate model provider.',
    docsUrl: 'https://replicate.com/account/api-tokens',
  },
  official: {
    id: 'official',
    label: 'Official API',
    defaultSecretId: 'OFFICIAL_API_KEY',
    secretLabel: 'Official provider API key',
    secretDescription: 'API key used to call the official model provider.',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultSecretId: 'OPENAI_API_KEY',
    secretLabel: 'OpenAI API key',
    secretDescription: 'API key used to call the official OpenAI API.',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  'google-ai-studio': {
    id: 'google-ai-studio',
    label: 'Google AI Studio',
    defaultSecretId: 'GOOGLE_AI_STUDIO_API_KEY',
    secretLabel: 'Google AI Studio API key',
    secretDescription: 'API key used to call Google AI Studio models.',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  'google-agent-platform': {
    id: 'google-agent-platform',
    label: 'Google Cloud Agent Platform',
    defaultSecretId: 'GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON',
    secretLabel: 'Google Cloud service account JSON',
    secretDescription: 'Service account JSON used to call Google Cloud Agent Platform models.',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    defaultSecretId: 'ANTHROPIC_API_KEY',
    secretLabel: 'Anthropic API key',
    secretDescription: 'API key used to call the official Anthropic API.',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    defaultSecretId: 'ELEVENLABS_API_KEY',
    secretLabel: 'ElevenLabs API key',
    secretDescription: 'API key used to call the official ElevenLabs API.',
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
};

export function normalizeActionProviderId(value: unknown): ActionProviderId | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/^@/, '');
  return ACTION_PROVIDER_ALIASES[key] ?? null;
}

function normalizeActionProviderRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  return normalizeActionProviderId(raw) ??
    raw.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function providerLabel(provider: string): string {
  const preset = ACTION_PROVIDER_PRESETS[provider as ActionProviderId];
  if (preset) return preset.label;
  return provider
    .split(/[-_\s.]+/)
    .filter(Boolean)
    .map((part) => part.length <= 4 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export const ActionProviderIdSchema = z.preprocess(
  (value) => normalizeActionProviderId(value) ?? value,
  z.enum(ACTION_PROVIDER_IDS),
);

export const ActionProviderRefSchema = z.preprocess(
  (value) => normalizeActionProviderRef(value) ?? value,
  z.string().min(1),
);

export const CustomActionModelSchema = z.object({
  /** Provider-facing model id, e.g. `fal-ai/flux-pro` or `gpt-image-1`. */
  id: z.string(),
  /** Common MaaS / official provider preset, or a user-defined provider id. */
  provider: ActionProviderRefSchema,
  /** Optional display name when the provider id is too terse. */
  name: z.string().optional(),
  /** Override the provider preset key name, e.g. `OPENAI_API_KEY` for provider=`official`. */
  secretId: z.string().optional(),
  /** Optional provider base URL for action handlers that support configurable endpoints. */
  baseUrl: z.string().optional(),
  /** Optional provider endpoint/path for action handlers that route multiple models. */
  endpoint: z.string().optional(),
}).passthrough();
export type CustomActionModel = z.infer<typeof CustomActionModelSchema>;

export function mergeActionProviderSecrets<T extends { model?: CustomActionModel; secrets?: CustomActionSecret[] }>(
  def: T,
): T & { secrets: CustomActionSecret[] } {
  const secrets = [...(def.secrets ?? [])];
  const provider = def.model?.provider;
  if (provider) {
    const preset = ACTION_PROVIDER_PRESETS[provider as ActionProviderId];
    const id = def.model?.secretId || preset?.defaultSecretId;
    if (id && !secrets.some((secret) => secret.id === id)) {
      const label = providerLabel(provider);
      secrets.push({
        id,
        label: preset?.secretLabel ?? `${label} API key`,
        description: preset?.secretDescription ?? `API key used to call the ${label} model provider.`,
        required: true,
      });
    }
  }
  return { ...def, secrets };
}

const CustomActionDefinitionBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.array(CustomActionParameterSchema).default([]),
  outputType: z.enum(['image', 'video', 'audio', 'text']),
  input: ModelInputRuleSchema.optional(),
  constraints: z.array(ModelConstraintRuleSchema).default([]),
  presentation: ExecutableActionPresentationSchema.default({ type: 'form' }),
  maxRuntimeMs: z.number().int().positive().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  /** Execution runtime: 'local' = Python SDK via WebSocket, 'worker' = deployed CF Worker via HTTP */
  runtime: z.enum(['local', 'worker']).default('local'),
  /** Semver version */
  version: z.string().optional(),
  /** Action author name */
  author: z.string().optional(),
  /** Source repository (e.g. "github:user/repo") */
  repository: z.string().optional(),
  /** CF Worker URL for runtime='worker' actions */
  workerUrl: z.string().optional(),
  /** User variables this action needs (e.g. API keys). Platform injects at runtime. */
  secrets: z.array(CustomActionSecretSchema).default([]),
  /** Exact hosted/local executable plugin version represented by this action. */
  pluginBinding: ExecutablePluginBindingSchema.optional(),
  /** Explicit native Definition/Action behind this legacy form. */
  generator: ExecutableActionCardGeneratorSchema.optional(),
  /** Provider/model binding used by MaaS-compatible actions. */
  model: CustomActionModelSchema.optional(),
  /** Discovery tags */
  tags: z.array(z.string()).optional(),
  /** Modalities that can be @-mentioned inline in the prompt editor */
  promptModalities: z.array(z.enum(['text', 'image', 'video', 'audio'])).default(['text']),
  /**
   * runtime_id of the local runtime that registered this action. The server
   * stamps this from the connecting WS client's `x-runtime-id` header, which
   * the python SDK forwards from the CLASH_RUNTIME_ID env var (set by the
   * local-api host when it spawns each action subprocess).
   *
   * Custom actions are a property of THE USER'S MACHINE — when the runtime
   * is offline, NodeProcessor refuses to dispatch the action and the node
   * lands in `status: failed` with a clear error. This field is the link
   * back to the runtime row that the deriveRuntimeStatus check consults.
   */
  registeredByRuntime: z.string().optional(),
  /**
   * Project ids this action attaches to. `"*"` (the default) means every
   * project the user is in. This declaration lives in the manifest so the
   * install endpoint can echo the user's intent forward and the bridge can
   * spawn one subprocess per attached project.
   *
   * NOTE: As of this change the bridge still spawns a single subprocess per
   * action (no `CLASH_PROJECT_ID` pinning). The field is reserved — it will
   * be honored on the next bridge restart in a future change that wires
   * per-project spawning.
   */
  attachedProjects: z.array(z.string()).default(["*"]),
});
export const CustomActionDefinitionSchema = CustomActionDefinitionBaseSchema.transform((def) => {
  const input = def.input ?? ModelInputRuleSchema.parse({
    requiresPrompt: def.promptModalities.includes('text'),
    inputMode: Object.fromEntries(
      (['image', 'video', 'audio'] as const)
        .filter((modality) => def.promptModalities.includes(modality))
        .map((modality) => [
          modality === 'image' ? 'images' : modality === 'video' ? 'videos' : 'audios',
          { max: Number.MAX_SAFE_INTEGER },
        ]),
    ),
    promptModalities: def.promptModalities,
  });
  return mergeActionProviderSecrets({
    ...def,
    input,
    promptModalities: input.promptModalities,
  });
});
export type CustomActionDefinition = z.output<typeof CustomActionDefinitionSchema>;

export function customActionDefaultParams(
  def: Pick<CustomActionDefinition, 'parameters'>,
): Record<string, string | number | boolean> {
  return Object.fromEntries(
    def.parameters
      .filter((parameter) => parameter.defaultValue !== undefined)
      .map((parameter) => [parameter.id, parameter.defaultValue!]),
  );
}

/** Check if an actionType string represents a custom (local) action */
export function isCustomActionType(actionType: string): boolean {
  return actionType.startsWith('custom:');
}

/** Extract the action ID from a custom actionType string */
export function getCustomActionId(actionType: string): string {
  return actionType.replace('custom:', '');
}

// ─── Loro-compatible Schemas ──────────────────────────────

export const NodeInfoSchema = z.object({
  id: z.string(),
  type: z.string(),
  position: z.object({ x: z.number(), y: z.number() }),
  data: z.record(z.unknown()),
  parent_id: z.string().nullish(),
});

export const EdgeInfoSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  source_handle: z.string().nullish(),
  target_handle: z.string().nullish(),
});
export type EdgeInfo = z.infer<typeof EdgeInfoSchema>;

export const ProjectContextSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    type: z.string(),
    data: z.record(z.unknown()),
    position: z.object({ x: z.number().default(0), y: z.number().default(0) }),
    parentId: z.string().nullish(),
  })),
  edges: z.array(z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    type: z.string().nullish(),
  })),
});
export type ProjectContext = z.infer<typeof ProjectContextSchema>;
