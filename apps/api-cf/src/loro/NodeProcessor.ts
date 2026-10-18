import { hostedGenerationStatus } from "../generation/status";
/**
 * Node Processor - Task Submission via Cloudflare Workflows
 *
 * Scans Loro nodes for pending work and submits generation/description
 * tasks as Workflow instances. Uses `pendingTask` field as an optimistic
 * lock — set synchronously before any async work.
 */

import { LoroDoc } from 'loro-crdt';
import type { Env } from '../config';
import { startGeneration } from '../generation/start';
import { log } from '../logger';
import { updateNodeData, appendNodeLog } from './NodeUpdater';
import { Status } from '../domain/canvas';
import type { GenerationParams } from '../agents/generation';
import { getAssetsByIds } from '../services/assets';
import type { ProjectAssetReferenceResolver } from '@clash/shared-runtime/cloud-project-host/project-asset-references';
import {
  canvasMentionResolver,
  pendingCustomActionNode,
} from '@clash/shared-runtime/canvas-executable-node';

import {
  MODEL_CARDS,
  normalizeModelId,
  parsePromptParts,
  extractPromptText,
  validateRefs,
  validateReferenceMedia,
  type ReferenceMediaMetadata,
} from '@clash/shared-types';

const defaultImageModel = MODEL_CARDS.find((card) => card.kind === 'image')?.id ?? 'nano-banana-2';
const defaultVideoModel = MODEL_CARDS.find((card) => card.kind === 'video')?.id ?? 'sora-2';
const defaultAudioModel = MODEL_CARDS.find((card) => card.kind === 'audio')?.id ?? 'gemini-3.1-flash-tts';
const defaultTextModel = MODEL_CARDS.find((card) => card.kind === 'text')?.id ?? 'gpt-5.4';

const getModelCard = (modelId?: string) => {
  const canonicalId = normalizeModelId(modelId) ?? modelId;
  return MODEL_CARDS.find((card) => card.id === canonicalId);
};

type NodeType = 'image' | 'video' | 'audio' | 'text' | 'video_render';

// Fallback upper-bound wall time per node kind. Used when the selected model card
// doesn't specify its own `maxRuntimeMs`. Set generously above the 99th-percentile
// run so we never misclassify a legitimately slow task.
const DEFAULT_RUNNING_ORPHAN_MS: Record<string, number> = {
  image: 15 * 60 * 1000,
  video: 30 * 60 * 1000,
  audio: 10 * 60 * 1000,
  text: 5 * 60 * 1000,
  video_render: 30 * 60 * 1000,
};

function resolveMaxRuntimeMs(nodeType: string, modelId?: string): number {
  const card = getModelCard(modelId);
  return card?.maxRuntimeMs ?? DEFAULT_RUNNING_ORPHAN_MS[nodeType] ?? 30 * 60 * 1000;
}

/**
 * Pick which workflow binding owns a given taskId.
 * All our generation tasks currently use GENERATION_WORKFLOW.
 */
function getWorkflowBinding(env: Env): Workflow | undefined {
  return env.GENERATION_WORKFLOW as Workflow | undefined;
}

function stringifyWorkflowError(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['message', 'error', 'cause']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String() below.
    }
  }

  return String(error);
}

/**
 * Check the workflow engine's view of a task. Returns a terminal status if the
 * workflow is effectively dead (errored / terminated / instance missing), or null
 * if it's still legitimately in-flight or unknown.
 *
 * Needed because miniflare's workflow engine doesn't resume after worker hot-reload
 * (no alarm() method on Engine; scheduler.wait is in-memory only). Stuck workflows
 * sit in "running" forever locally — for us that's indistinguishable from normal
 * running, so we additionally trust "complete" / "errored" / "terminated".
 */
/** Hard timeout — miniflare wf.get/status can hang on certain instances and pin the DO loop. */
const WF_STATUS_TIMEOUT_MS = 1500;

async function inspectWorkflowStatus(
  env: Env,
  taskId: string
): Promise<{ status: string; error?: string } | null> {
  try {
    const durable = await hostedGenerationStatus(env, taskId);
    if (durable) return { status: "journal-managed" };
  } catch (error) {
    log.warn("Durable generation status unavailable", { taskId, error: String(error) });
    return null;
  }
  const wf = getWorkflowBinding(env);
  if (!wf) return null;

  const probe = (async () => {
    try {
      const inst = await wf.get(taskId);
      const s = await inst.status();
      return { status: String(s.status ?? ''), error: stringifyWorkflowError(s.error) };
    } catch (e) {
      const msg = String(e);
      if (/not\s*found|Error 3001|doesn't exist/i.test(msg)) return { status: 'missing' };
      log.warn('inspectWorkflowStatus error', { taskId, error: msg });
      return null;
    }
  })();

  const timeout = new Promise<{ status: string }>((resolve) =>
    setTimeout(() => resolve({ status: 'timeout' }), WF_STATUS_TIMEOUT_MS),
  );

  const result = await Promise.race([probe, timeout]);
  // 'timeout' is treated as 'unknown' upstream — caller should not act on it.
  if (result && (result as { status: string }).status === 'timeout') {
    log.warn('inspectWorkflowStatus timed out — treating as unknown', { taskId });
    return null;
  }
  return result;
}


function toPlainRecord(value: unknown): Record<string, any> {
  if (typeof (value as { toJSON?: () => unknown } | null)?.toJSON === 'function') {
    const json = (value as { toJSON: () => unknown }).toJSON();
    return json && typeof json === 'object' ? { ...(json as Record<string, unknown>) } : {};
  }
  return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
}

function getTimelineItemLookupIds(item: Record<string, any>): string[] {
  const ids = [item.sourceNodeId, item.assetId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return Array.from(new Set(ids));
}

/**
 * How a Timeline item names its Project Asset on this Canvas: a canvas node
 * (`sourceNodeId`, or a legacy node id in `assetId`) whose `data.assetId` is
 * the Asset, or the Asset id directly in `assetId`. The node also supplies the
 * natural size render-server lays the clip out with.
 */
function timelineItemAssets(nodesMap: Map<string, any>) {
  const nodeByAssetId = new Map<string, any>();
  for (const [nodeId, nodeData] of nodesMap.entries()) {
    const data = toPlainRecord(nodeData?.data || nodeData);
    if (typeof data.assetId === 'string') nodeByAssetId.set(data.assetId, { nodeId, ...nodeData });
  }
  const nodeOf = (item: Record<string, any>) => {
    for (const lookupId of getTimelineItemLookupIds(item)) {
      const node = nodesMap.get(lookupId);
      if (node) return { nodeId: lookupId, ...node };
      const byAsset = nodeByAssetId.get(lookupId);
      if (byAsset) return byAsset;
    }
    return undefined;
  };
  return {
    typeOf: (item: Record<string, any>): unknown => item.type ?? nodeOf(item)?.type,
    assetIdOf(item: Record<string, any>): string | undefined {
      const data = toPlainRecord(nodeOf(item)?.data);
      if (typeof data.assetId === 'string') return data.assetId;
      return typeof item.assetId === 'string' && !nodesMap.get(item.assetId) ? item.assetId : undefined;
    },
    decorate(item: Record<string, any>, reference: { width?: number; height?: number }) {
      const node = nodeOf(item);
      const data = toPlainRecord(node?.data);
      let naturalWidth = reference.width ?? data.naturalWidth;
      let naturalHeight = reference.height ?? data.naturalHeight;
      if ((!naturalWidth || !naturalHeight) && typeof data.aspectRatio === 'string' && data.aspectRatio.includes(':')) {
        const [w, h] = data.aspectRatio.split(':').map(Number);
        if (w && h) {
          naturalWidth = 1920;
          naturalHeight = Math.round(1920 * h / w);
        }
      }
      return {
        type: node?.type || item.type,
        ...(naturalWidth != null && { naturalWidth }),
        ...(naturalHeight != null && { naturalHeight }),
        ...(data.aspectRatio && { aspectRatio: data.aspectRatio }),
      };
    },
  };
}

/**
 * Recover orphaned tasks — scan nodes with `pendingTask` and mark Failed any
 * whose backing workflow is errored / terminated / missing, or whose runtime
 * has exceeded the per-kind cap (covers miniflare's lost-timer hibernation).
 *
 * SLOW PATH: each pending node triggers a workflow status RPC (timeboxed).
 * Caller must NOT run this from the WebSocket message-processing critical
 * section — it's reserved for the alarm timer to keep WS handling responsive.
 * Per-task probes run in parallel so total cost is max-of-N rather than sum.
 */
export async function recoverOrphanedTasks(
  doc: LoroDoc,
  env: Env,
  broadcast: (data: Uint8Array) => void,
): Promise<void> {
  const nodesMap = doc.getMap('nodes');
  const candidates: Array<{ nodeId: string; nodeType: NodeType; pendingTask: string; pendingTaskAt?: number; modelId?: string }> = [];

  for (const [nodeId, nodeData] of nodesMap.entries()) {
    const data = nodeData as Record<string, any>;
    const nodeType = data?.type as NodeType;
    if (!['image', 'video', 'audio', 'video_render'].includes(nodeType)) continue;
    const innerData = data?.data || {};
    const pendingTask = innerData.pendingTask as string | undefined;
    if (!pendingTask) continue;
    // Executable Actions are owned by the Durable Run journal and its cron scan;
    // a Workflow status probe cannot see their output slot and must not clear the
    // optimistic lock while the frozen row is still recoverable.
    if (
      typeof innerData.actionType === 'string' &&
      innerData.actionType.startsWith('custom:')
    )
      continue;
    candidates.push({
      nodeId,
      nodeType,
      pendingTask,
      pendingTaskAt: typeof innerData.pendingTaskAt === 'number' ? innerData.pendingTaskAt : undefined,
      modelId: (innerData.modelId || innerData.model) as string | undefined,
    });
  }

  if (candidates.length === 0) return;

  await Promise.allSettled(
    candidates.map(async ({ nodeId, nodeType, pendingTask, pendingTaskAt, modelId }) => {
      const info = await inspectWorkflowStatus(env, pendingTask);
      const current = doc.getMap('nodes').get(nodeId) as { data?: { pendingTask?: string } } | undefined;
      if (current?.data?.pendingTask !== pendingTask || info?.status === 'journal-managed') return;
      const age = pendingTaskAt ? Date.now() - pendingTaskAt : undefined;
      const runningTooLong = info?.status === 'running'
        && age !== undefined
        && age > resolveMaxRuntimeMs(nodeType, modelId);

      if (info && ['errored', 'terminated', 'missing'].includes(info.status)) {
        const reason = `orphan task: workflow status=${info.status}${info.error ? ` (${info.error})` : ''}`;
        log.warn('Orphan pendingTask (terminal status), marking node Failed', { nodeId, nodeType, taskId: pendingTask, status: info.status });
        appendNodeLog(doc, nodeId, `FAILED: ${reason}`, broadcast);
        updateNodeData(doc, nodeId, { pendingTask: undefined, pendingTaskAt: undefined, status: Status.Failed, error: reason }, broadcast);
      } else if (runningTooLong) {
        const ageSec = Math.round((age ?? 0) / 1000);
        const reason = `orphan task: workflow still "running" after ${ageSec}s (presumed dead — miniflare hot-reload kills in-memory timers)`;
        log.warn('Orphan pendingTask (running-too-long), marking node Failed', { nodeId, nodeType, taskId: pendingTask, ageSec });
        appendNodeLog(doc, nodeId, `FAILED: ${reason}`, broadcast);
        updateNodeData(doc, nodeId, { pendingTask: undefined, pendingTaskAt: undefined, status: Status.Failed, error: reason }, broadcast);
      }
    }),
  );
}

/**
 * Process pending nodes — submit tasks via Workflow.
 *
 * FAST PATH: only handles nodes WITHOUT pendingTask (new submissions).
 * Nodes already in flight are skipped here; their failures are caught by
 * `recoverOrphanedTasks` from the alarm timer. This separation keeps the
 * WebSocket message handler off the slow workflow.status() critical path.
 *
 * Uses `pendingTask` as optimistic lock: set synchronously before any
 * async work so concurrent invocations (via event loop interleaving) skip.
 */
export async function processPendingNodes(
  doc: LoroDoc,
  env: Env,
  projectId: string,
  broadcast: (data: Uint8Array) => void,
  triggerPolling: () => Promise<void>,
): Promise<void> {
  try {
    const nodesMap = doc.getMap('nodes');
    let submitted = false;

    for (const [nodeId, nodeData] of nodesMap.entries()) {
      const data = nodeData as Record<string, any>;
      const nodeType = data?.type as NodeType;
      const innerData = data?.data || {};

      if (!['image', 'video', 'audio', 'text', 'video_render'].includes(nodeType)) continue;

      const status = innerData.status as string;
      const assetId = typeof innerData.assetId === 'string' ? innerData.assetId : undefined;
      const pendingTask = innerData.pendingTask;

      // Optimistic lock — skip nodes already in flight. Orphan recovery is the
      // alarm's job (see recoverOrphanedTasks) so this hot path stays fast.
      if (pendingTask) continue;

      const hasTimelineDsl = innerData.timelineDsl != null;
      const shouldRenderVideo = nodeType === 'video_render' || (nodeType === 'video' && hasTimelineDsl);

      // Case 0: video_render with timelineDsl → submit render task
      if (shouldRenderVideo && status === Status.Pending) {
        // Phase 0 attribution gate (same shape as other cases below).
        // Render nodes also need an actor — the resulting asset row
        // attributes to whomever pressed Render.
        const renderActorUserId = typeof innerData.actorUserId === 'string' ? innerData.actorUserId : undefined;
        const renderActorType: 'user' | 'agent' = innerData.actorType === 'agent' ? 'agent' : 'user';
        const renderActorAgentId = typeof innerData.actorAgentId === 'string' ? innerData.actorAgentId : undefined;
        if (!renderActorUserId) {
          const error = 'Missing actor attribution — node created before Phase 0 attribution rollout';
          log.warn('attribution.missing.render', { nodeId });
          updateNodeData(doc, nodeId, {
            pendingTask: undefined,
            status: Status.Failed,
            error,
          }, broadcast);
          continue;
        }

        const taskId = crypto.randomUUID();
        updateNodeData(doc, nodeId, { status: Status.Generating, pendingTask: taskId, pendingTaskAt: Date.now() }, broadcast);
        appendNodeLog(doc, nodeId, `task=${taskId.slice(0, 8)} type=video_render`, broadcast);

        // render-server has no Project access: every media item gets its Asset's
        // signed src now, or the node fails with the code and nothing is submitted.
        const { resolveCloudTimelineMedia } = await import('../services/project-asset-references');
        const resolved = await resolveCloudTimelineMedia(env, {
          doc,
          projectId,
          actorUserId: renderActorUserId,
          timelineDsl: innerData.timelineDsl,
          ...timelineItemAssets(doc.getMap('nodes') as unknown as Map<string, any>),
        });
        if (!resolved.ok) {
          const { code, message } = resolved.failure;
          appendNodeLog(doc, nodeId, `FAILED: ${message}`, broadcast);
          updateNodeData(doc, nodeId, { pendingTask: undefined, pendingTaskAt: undefined, status: Status.Failed, error: message, errorCode: code }, broadcast);
          continue;
        }
        const resolvedDsl = resolved.timelineDsl;

        const genParams: GenerationParams = {
          taskId,
          nodeId,
          type: 'video_render',
          projectId,
          timelineDsl: resolvedDsl,
          actorType: renderActorType,
          actorUserId: renderActorUserId,
          actorAgentId: renderActorAgentId,
        };

        try {
          await startGeneration(env, taskId, genParams);
          appendNodeLog(doc, nodeId, `submitted`, broadcast);
          submitted = true;
        } catch (e: any) {
          if (String(e).includes('already exists')) {
            appendNodeLog(doc, nodeId, `already running`, broadcast);
          } else {
            appendNodeLog(doc, nodeId, `FAILED: ${String(e)}`, broadcast);
            updateNodeData(doc, nodeId, { pendingTask: undefined, status: Status.Failed, error: String(e) }, broadcast);
          }
        }
        continue;
      }

      // Executable plugin Actions use the same Durable Run journal, step graph, staging and
      // publication contracts as local-api. The admission module is loaded on first use so
      // plugin code and the executable runtime stay out of ProjectRoom's cold start.
      if (!assetId && typeof innerData.actionType === 'string' && innerData.actionType.startsWith('custom:')) {
        const custom = pendingCustomActionNode({ type: nodeType, data: innerData });
        if (!custom) continue;
        const actionActorUserId = typeof innerData.actorUserId === 'string' ? innerData.actorUserId : undefined;
        if (!actionActorUserId) {
          const error = 'Missing actor attribution — node created before Phase 0 attribution rollout';
          log.warn('attribution.missing.action', { nodeId });
          updateNodeData(doc, nodeId, {
            pendingTask: undefined,
            status: Status.Failed,
            error,
          }, broadcast);
          continue;
        }
        try {
          const { submitExecutableAction } = await import('../generation/executable-admission');
          await submitExecutableAction(env, {
            projectId,
            nodeId,
            data: innerData,
            userId: actionActorUserId,
            custom,
            resolveMention: canvasMentionResolver(nodesMap),
            onFrozen: ({ identity }) => {
              // Optimistic lock installed before the admission self-request, so
              // ProjectRoom persists it instead of waiting on its own queue.
              appendNodeLog(doc, nodeId, `task=${identity.actionRunId.slice(0, 8)} type=custom-action`, broadcast);
              updateNodeData(doc, nodeId, {
                status: Status.Generating,
                pendingTask: identity.actionRunId,
                pendingTaskAt: Date.now(),
              }, broadcast);
            },
          });
          submitted = true;
        } catch (e: any) {
          const error = e instanceof Error ? e.message : String(e);
          appendNodeLog(doc, nodeId, `FAILED: ${error}`, broadcast);
          updateNodeData(doc, nodeId, {
            pendingTask: undefined,
            pendingTaskAt: undefined,
            status: Status.Failed,
            error,
          }, broadcast);
        }
        continue;
      }
      // Case 1: pending + no asset yet -> submit generation task
      if (status === Status.Pending && !assetId) {
        // Phase 0 attribution gate. Legacy nodes get a single warning + a failed status; we don't
        // crash the whole loop on one bad row.
        const nodeActorUserId = typeof innerData.actorUserId === 'string' ? innerData.actorUserId : undefined;
        const nodeActorType: 'user' | 'agent' = innerData.actorType === 'agent' ? 'agent' : 'user';
        const nodeActorAgentId = typeof innerData.actorAgentId === 'string' ? innerData.actorAgentId : undefined;
        if (!nodeActorUserId) {
          const error = 'Missing actor attribution — node created before Phase 0 attribution rollout';
          log.warn('attribution.missing.gen', { nodeId, nodeType });
          updateNodeData(doc, nodeId, {
            pendingTask: undefined,
            status: Status.Failed,
            error,
          }, broadcast);
          continue;
        }

        // Deterministic taskId: same nodeId always maps to the same workflow ID,
        // so duplicate submissions (Loro race, alarm + queue, etc.) are idempotent.
        const taskId = `${projectId}-gen-${nodeId}`;
        const taskType =
          nodeType === 'image'
            ? 'image_gen'
            : nodeType === 'video'
              ? 'video_gen'
              : nodeType === 'audio'
                ? 'audio_gen'
                : 'text_gen';
        // Set status=generating + pendingTask synchronously (optimistic lock) before any await
        updateNodeData(doc, nodeId, { status: Status.Generating, pendingTask: taskId, pendingTaskAt: Date.now() }, broadcast);
        appendNodeLog(doc, nodeId, `task=${taskId.slice(0, 8)} type=${taskType} model=${(innerData.modelId || innerData.model) ?? 'default'}`, broadcast);

        const selectedModelId = (innerData.modelId || innerData.model) ??
          (nodeType === 'video' ? defaultVideoModel : nodeType === 'audio' ? defaultAudioModel : nodeType === 'text' ? defaultTextModel : defaultImageModel);
        const modelParams = (innerData.modelParams || {}) as Record<string, any>;
        // Frontend writes asset IDs only (never URLs). Server resolves IDs
        // to R2 keys via D1 — single source of truth, no schema drift.
        const referenceImageAssetIds: string[] = (Array.isArray(innerData.referenceImageAssetIds) ? innerData.referenceImageAssetIds : [])
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
        const referenceVideoAssetIds: string[] = (Array.isArray(innerData.referenceVideoAssetIds) ? innerData.referenceVideoAssetIds : [])
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
        const referenceAudioAssetIds: string[] = (Array.isArray(innerData.referenceAudioAssetIds) ? innerData.referenceAudioAssetIds : [])
          .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0);
        const modelCard = getModelCard(selectedModelId);
        const inputMode = modelCard?.input.inputMode ?? {};
        const rawPrompt = innerData.prompt || innerData.label || '';

        const tag = { nodeId, taskId, projectId, type: taskType, model: selectedModelId, nodeType };
        log.info('gen.classify', { ...tag, refs: { images: referenceImageAssetIds.length, videos: referenceVideoAssetIds.length, audios: referenceAudioAssetIds.length }, prompt: (innerData.prompt || innerData.label || '').slice(0, 80) });

        // Count, companion-modality, total-reference, prompt, and start/end
        // rules all come from the same Card capability contract used by UI.
        if (modelCard) {
          const msg = validateRefs(modelCard, {
            image: referenceImageAssetIds.length,
            video: referenceVideoAssetIds.length,
            audio: referenceAudioAssetIds.length,
          }, { prompt: rawPrompt, modelParams });
          if (msg) {
            log.warn('gen.preflight_failed', { ...tag, reason: msg });
            updateNodeData(doc, nodeId, { pendingTask: undefined, status: Status.Failed, error: msg }, broadcast);
            continue;
          }
        }

        // Parse prompt for @-mention parts (mixed-modality)
        const parts = parsePromptParts(rawPrompt);
        const cleanPrompt = extractPromptText(parts);

        // Resolve all asset IDs in one batch — image/video/audio refs +
        // any @-mentioned nodes from promptParts. One D1 query, no N+1.
        const mentionAssetIds: string[] = [];
        for (const part of parts) {
          if (part.type === 'asset_ref' && part.nodeId) {
            const refNode = nodesMap.get(part.nodeId) as Record<string, any> | undefined;
            const aid = typeof refNode?.data?.assetId === 'string' ? refNode.data.assetId : undefined;
            if (aid) mentionAssetIds.push(aid);
          }
        }

        const allAssetIds = [
          ...referenceImageAssetIds,
          ...referenceVideoAssetIds,
          ...referenceAudioAssetIds,
          ...mentionAssetIds,
        ];

        let assetById = new Map<string, {
          srcR2Key: string;
          coverR2Key: string | null;
          metadata: Awaited<ReturnType<typeof getAssetsByIds>>[number]['metadata'];
        }>();
        if (allAssetIds.length > 0) {
          // Resolve refs against the actor's assets, not the project
          // owner's. In single-user mode these are the same row;
          // multi-actor will diverge once Phase 1 lands project_member.
          const ownerId = nodeActorUserId;
          const assets = await getAssetsByIds(env.DB, allAssetIds, ownerId);
          assetById = new Map(assets.map((a) => [a.id, {
            srcR2Key: a.srcR2Key,
            coverR2Key: a.coverR2Key,
            metadata: a.metadata,
          }]));

          const missing = allAssetIds.filter((id) => !assetById.has(id));
          if (missing.length > 0) {
            log.warn('gen.assets_missing', { ...tag, missingCount: missing.length, missing: missing.slice(0, 5) });
          }
        }

        if (modelCard) {
          const mediaReferences: ReferenceMediaMetadata[] = [
            ...referenceImageAssetIds.map((assetId) => ({ assetId, modality: 'image' as const })),
            ...referenceVideoAssetIds.map((assetId) => ({ assetId, modality: 'video' as const })),
            ...referenceAudioAssetIds.map((assetId) => ({ assetId, modality: 'audio' as const })),
          ].flatMap(({ assetId, modality }) => {
            const metadata = assetById.get(assetId)?.metadata;
            if (!metadata) return [];
            return [{
              modality,
              contentType: metadata.contentType,
              fileName: metadata.originalName,
              bytes: metadata.bytes,
              width: metadata.width,
              height: metadata.height,
              durationMs: metadata.durationMs,
              frameRate: metadata.frameRate,
              videoCodec: metadata.videoCodec,
              audioCodec: metadata.audioCodec,
            }];
          });
          const mediaError = validateReferenceMedia(modelCard, mediaReferences, {
            modelParams,
          });
          if (mediaError) {
            log.warn('gen.preflight_failed', { ...tag, reason: mediaError });
            updateNodeData(doc, nodeId, { pendingTask: undefined, status: Status.Failed, error: mediaError }, broadcast);
            continue;
          }
        }

        const resolveImageKey = (aid: string): string | undefined => assetById.get(aid)?.srcR2Key;
        const resolveVideoKey = (aid: string): string | undefined => assetById.get(aid)?.srcR2Key;
        const resolveAudioKey = (aid: string): string | undefined => assetById.get(aid)?.srcR2Key;

        // Resolve @-mention parts now that we have the asset map
        const resolvedParts = parts.map((part) => {
          if (part.type === 'asset_ref' && part.nodeId) {
            const refNode = nodesMap.get(part.nodeId) as Record<string, any> | undefined;
            const aid = typeof refNode?.data?.assetId === 'string' ? refNode.data.assetId : undefined;
            const modality = refNode?.type === 'image' || refNode?.type === 'video' || refNode?.type === 'audio'
              ? refNode.type as 'image' | 'video' | 'audio'
              : undefined;
            const r2Key = aid
              ? modality === 'video'
                ? resolveVideoKey(aid)
                : modality === 'audio'
                  ? resolveAudioKey(aid)
                  : resolveImageKey(aid)
              : undefined;
            return { type: 'asset_ref', nodeId: part.nodeId, r2Key, modality };
          }
          return { type: 'text', text: part.text || '' };
        });

        // Map Loro ref arrays into the 4 orthogonal resource slots driven
        // by inputMode shape. NodeProcessor is a pure schema translator —
        // wire-shape decisions (e.g. Vertex `inst.image` vs `inst.referenceImages`,
        // fal `image_url` vs `image_urls[]`) are the provider's job.
        //   - startEnd       → ref[0] = startFrame, ref[1] = endFrame
        //   - images         → flat referenceImageR2Keys (any max)
        //   - videos/audios  → flat lists, analogously
        const isStartEnd = !!inputMode.startEnd;
        const imageR2Keys = referenceImageAssetIds
          .map(resolveImageKey)
          .filter((k): k is string => !!k);
        const videoR2Keys = referenceVideoAssetIds
          .map(resolveVideoKey)
          .filter((k): k is string => !!k);
        const audioR2Keys = referenceAudioAssetIds
          .map(resolveAudioKey)
          .filter((k): k is string => !!k);

        const startFrameKey = isStartEnd ? imageR2Keys[0] : undefined;
        const endFrameKey = isStartEnd ? imageR2Keys[1] : undefined;
        const flatRefImageKeys = !isStartEnd && !!inputMode.images ? imageR2Keys : [];

        log.info('gen.refs_resolved', { ...tag, resolved: { images: imageR2Keys.length, videos: videoR2Keys.length, audios: audioR2Keys.length, startEnd: isStartEnd } });

        // Lineage `sources` rows. The startEnd first frame is the only
        // "primary" anchor (it's the keyframe the generation pivots around).
        // Everything else is a plain reference.
        const sources: { assetId: string; role: 'primary' | 'reference' }[] = [];
        const seen = new Set<string>();
        const pushSource = (id: string | undefined, role: 'primary' | 'reference') => {
          if (!id || seen.has(id)) return;
          seen.add(id);
          sources.push({ assetId: id, role });
        };
        if (isStartEnd) {
          pushSource(referenceImageAssetIds[0], 'primary');
          pushSource(referenceImageAssetIds[1], 'reference');
        } else {
          for (const id of referenceImageAssetIds) pushSource(id, 'reference');
        }
        for (const id of referenceVideoAssetIds) pushSource(id, 'reference');
        for (const id of referenceAudioAssetIds) pushSource(id, 'reference');

        const result = await submitGenTask(env, taskType as GenerationParams['type'], projectId, nodeId, taskId, {
          prompt: cleanPrompt,
          promptParts: resolvedParts,
          model: selectedModelId,
          modelParams,
          referenceImageR2Keys: flatRefImageKeys,
          referenceVideoR2Keys: videoR2Keys,
          referenceAudioR2Keys: audioR2Keys,
          aspectRatio: modelParams.aspect_ratio || innerData.aspectRatio || '16:9',
          duration: modelParams.duration ?? innerData.duration ?? 5,
          negativPrompt: modelParams.negative_prompt,
          cfgScale: modelParams.cfg_scale,
          resolution: modelParams.resolution,
          startFrameR2Key: startFrameKey,
          endFrameR2Key: endFrameKey,
          sources: sources.length ? sources : undefined,
          actorType: nodeActorType,
          actorUserId: nodeActorUserId,
          actorAgentId: nodeActorAgentId,
        });

        if (result.error) {
          appendNodeLog(doc, nodeId, `FAILED: ${result.error}`, broadcast);
          updateNodeData(doc, nodeId, { pendingTask: undefined, status: Status.Failed, error: result.error }, broadcast);
        } else {
          appendNodeLog(doc, nodeId, `submitted`, broadcast);
          submitted = true;
        }
      }


    }

    if (submitted) {
      await triggerPolling();
    }
  } catch (error) {
    log.error('Error:', error);
  }
}

/**
 * Submit a generation task (image_gen/video_gen) via Workflow.
 */
async function submitGenTask(
  env: Env,
  taskType: GenerationParams['type'],
  projectId: string,
  nodeId: string,
  taskId: string,
  params: {
    prompt: string;
    promptParts?: Array<{
      type: string;
      text?: string;
      nodeId?: string;
      r2Key?: string;
      modality?: 'image' | 'video' | 'audio';
    }>;
    model: string;
    modelParams: Record<string, any>;
    /** Pre-resolved R2 keys (NodeProcessor turned assetIds into these). */
    referenceImageR2Keys: string[];
    referenceVideoR2Keys: string[];
    referenceAudioR2Keys: string[];
    aspectRatio: string;
    duration: number;
    negativPrompt?: string;
    cfgScale?: number;
    resolution?: string;
    startFrameR2Key?: string;
    endFrameR2Key?: string;
    sources?: { assetId: string; role: 'primary' | 'reference' }[];
    actorType: 'user' | 'agent';
    actorUserId: string;
    actorAgentId?: string;
  },
): Promise<{ error?: string }> {
  const tag = { nodeId, taskId, projectId, type: taskType, model: params.model };
  try {
    const genParams: GenerationParams = {
      taskId,
      nodeId,
      type: taskType,
      projectId,
      prompt: params.prompt,
      promptParts: params.promptParts,
      aspectRatio: params.aspectRatio,
      modelName: params.model,
      modelParams: params.modelParams as Record<string, unknown>,
      referenceImageR2Keys: params.referenceImageR2Keys.length ? params.referenceImageR2Keys : undefined,
      referenceVideoR2Keys: params.referenceVideoR2Keys.length ? params.referenceVideoR2Keys : undefined,
      referenceAudioR2Keys: params.referenceAudioR2Keys.length ? params.referenceAudioR2Keys : undefined,
      startFrameR2Key: params.startFrameR2Key,
      endFrameR2Key: params.endFrameR2Key,
      duration: params.duration,
      cfgScale: params.cfgScale,
      videoModel: params.model,
      sources: params.sources,
      actorType: params.actorType,
      actorUserId: params.actorUserId,
      actorAgentId: params.actorAgentId,
    };

    log.info('gen.submit', { ...tag });
    await startGeneration(env, taskId, genParams);
    return {};
  } catch (e: any) {
    if (String(e).includes('already exists')) {
      log.info('gen.submit_dedup', { ...tag, note: 'workflow already exists, skipping duplicate' });
      return {};
    }
    log.error('gen.submit_failed', { ...tag, error: String(e) });
    return { error: String(e) };
  }
}
