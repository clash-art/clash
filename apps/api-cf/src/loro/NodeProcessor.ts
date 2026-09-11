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
import { getAssetById, getAssetsByIds } from '../services/assets';
import { signAssetPath } from '../services/asset-signing';

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

/** Convert ArrayBuffer to base64, chunked to avoid stack overflow. */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 8192;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(chunks.join(''));
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

function srcToStorageKey(src: string): string {
  if (!src) return src;

  if (src.startsWith('data:') || src.startsWith('blob:')) {
    return src;
  }

  const prefixes = ['/assets/', '/api/assets/view/', '/api/assets/'];
  const pathname = (() => {
    if (!src.startsWith('/') && !src.startsWith('http://') && !src.startsWith('https://')) {
      return src;
    }
    try {
      const url = src.startsWith('http')
        ? new URL(src)
        : new URL(src, 'http://placeholder.local');
      return url.pathname;
    } catch {
      return src;
    }
  })();

  for (const prefix of prefixes) {
    if (pathname.startsWith(prefix)) {
      return pathname.slice(prefix.length);
    }
  }

  return pathname.startsWith('/') ? pathname.slice(1) : pathname;
}

function findTimelineMediaItemsMissingSrc(timelineDsl: Record<string, any>): string[] {
  const missing: string[] = [];
  const mediaTypes = new Set(['image', 'video', 'audio', 'sticker']);

  for (const track of timelineDsl.tracks || []) {
    for (const item of track.items || []) {
      if (!mediaTypes.has(item?.type)) continue;
      if (typeof item.src === 'string' && item.src.trim().length > 0) continue;
      missing.push(`${track.id ?? 'track'}:${item?.id ?? 'item'}`);
    }
  }

  return missing;
}

/**
 * Resolve assetId references in timeline DSL items.
 * Populates src/type/naturalWidth/naturalHeight from the referenced asset nodes.
 *
 * Timeline items use a reference-based model. Modern items store sourceNodeId
 * for the canvas node and assetId for the D1 asset row; legacy items stored the
 * canvas node id in assetId.
 * The backend render service doesn't have access to Loro, so we must resolve
 * these references before submitting the render task.
 */
async function resolveTimelineDslReferences(
  timelineDsl: Record<string, any>,
  nodesMap: Map<string, any>,
  env: Env,
): Promise<Record<string, any>> {
  // Asset rows are the source of truth — match timeline items to canvas
  // nodes by `data.assetId`. Legacy src-based matching is gone (the field
  // is no longer maintained).
  const assetRowIdToNode = new Map<string, any>();
  for (const [nodeId, nodeData] of nodesMap.entries()) {
    const data = toPlainRecord(nodeData?.data || nodeData);
    const assetRowId = typeof data.assetId === 'string' ? data.assetId : undefined;
    if (assetRowId) {
      assetRowIdToNode.set(assetRowId, { nodeId, ...nodeData });
    }
  }

  const assetCache = new Map<string, Awaited<ReturnType<typeof getAssetById>>>();
  const getCachedAsset = async (assetRowId: string) => {
    if (!assetCache.has(assetRowId)) {
      assetCache.set(assetRowId, await getAssetById(env.DB, assetRowId));
    }
    return assetCache.get(assetRowId) ?? null;
  };

  const resolvedTracks = await Promise.all((timelineDsl.tracks || []).map(async (track: any) => {
    const resolvedItems = await Promise.all((track.items || []).map(async (item: any) => {
      let assetNode: any = null;

      // 1. Try explicit canvas node id, D1 asset id, then legacy assetId-as-node-id.
      for (const lookupId of getTimelineItemLookupIds(item)) {
        const nodeById = nodesMap.get(lookupId);
        if (nodeById) {
          assetNode = { nodeId: lookupId, ...nodeById };
          break;
        }

        const nodeByAssetRowId = assetRowIdToNode.get(lookupId);
        if (nodeByAssetRowId) {
          assetNode = nodeByAssetRowId;
          break;
        }
      }

      // (Legacy src-based fallback removed — timeline items must reference
      // canvas nodes by sourceNodeId or D1 assetId. node.data.src is no
      // longer maintained.)

      if (assetNode) {
        const assetData = toPlainRecord(assetNode.data || assetNode);
        const itemAssetId = typeof item.assetId === 'string' ? item.assetId : undefined;
        const itemAssetIdIsNodeId = itemAssetId ? nodesMap.get(itemAssetId) != null : false;
        const assetRowId = typeof assetData.assetId === 'string'
          ? assetData.assetId
          : itemAssetId && !itemAssetIdIsNodeId
            ? itemAssetId
            : undefined;
        const assetRow = assetRowId ? await getCachedAsset(assetRowId) : null;

        const assetType = assetNode.type || assetRow?.kind || assetData.type || item.type;

        let naturalWidth = assetRow?.metadata?.width ?? assetData.naturalWidth;
        let naturalHeight = assetRow?.metadata?.height ?? assetData.naturalHeight;

        if ((!naturalWidth || !naturalHeight) && assetData.aspectRatio) {
          const ar = assetData.aspectRatio;
          if (typeof ar === 'string' && ar.includes(':')) {
            const [w, h] = ar.split(':').map(Number);
            if (w && h) {
              naturalWidth = 1920;
              naturalHeight = Math.round(1920 * h / w);
            }
          }
        }

        return {
          ...item,
          src: assetRow?.srcR2Key || item.src,
          type: assetType || item.type,
          ...(naturalWidth != null && { naturalWidth }),
          ...(naturalHeight != null && { naturalHeight }),
          ...(assetData.aspectRatio && { aspectRatio: assetData.aspectRatio }),
        };
      }

      const itemAssetId = typeof item.assetId === 'string' ? item.assetId : undefined;
      if (itemAssetId) {
        const assetRow = await getCachedAsset(itemAssetId);
        if (assetRow) {
          return {
            ...item,
            src: assetRow.srcR2Key || item.src,
            type: assetRow.kind || item.type,
            ...(assetRow.metadata?.width != null && { naturalWidth: assetRow.metadata.width }),
            ...(assetRow.metadata?.height != null && { naturalHeight: assetRow.metadata.height }),
          };
        }
      }

      log.warn(`No asset found for item id=${item.id}, src=${item.src?.slice(0, 50) || 'none'}`);
      return item;
    }));

    return { ...track, items: resolvedItems };
  }));

  return { ...timelineDsl, tracks: resolvedTracks };
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
      const description = innerData.description;
      const pendingTask = innerData.pendingTask;
      const pendingTaskAt = typeof innerData.pendingTaskAt === 'number' ? innerData.pendingTaskAt : undefined;

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

        // Resolve assetId references in timelineDsl using current Loro state
        const nodesMap = doc.getMap('nodes');
        const resolvedDsl = await resolveTimelineDslReferences(innerData.timelineDsl, nodesMap as any, env);

        // Convert R2 keys in src to signed absolute HTTP URLs so render-server's
        // Chromium/ffmpeg can access the source media via the asset-serving route.
        const mediaBaseRaw = env.MEDIA_GATEWAY_URL || env.WORKER_PUBLIC_URL
          || (env.ENVIRONMENT === 'development' ? 'http://localhost:3000' : null);
        if (!mediaBaseRaw) {
          throw new Error('MEDIA_GATEWAY_URL or WORKER_PUBLIC_URL must be set — render-server cannot fetch media without an absolute origin');
        }
        const mediaBase = mediaBaseRaw.replace(/\/+$/, '');
        for (const track of resolvedDsl.tracks || []) {
          for (const item of track.items || []) {
            if (typeof item.src === 'string' && item.src && !item.src.startsWith('http') && !item.src.startsWith('data:') && !item.src.startsWith('blob:')) {
              const storageKey = srcToStorageKey(item.src);
              if (!storageKey || storageKey.startsWith('data:') || storageKey.startsWith('blob:')) {
                continue;
              }
              const signedPath = await signAssetPath(env, storageKey);
              item.src = `${mediaBase}${signedPath}`;
            }
          }
        }

        const missingMediaSrc = findTimelineMediaItemsMissingSrc(resolvedDsl);
        if (missingMediaSrc.length > 0) {
          const error = `Timeline render has media item(s) without src: ${missingMediaSrc.slice(0, 5).join(', ')}`;
          appendNodeLog(doc, nodeId, `FAILED: ${error}`, broadcast);
          updateNodeData(doc, nodeId, { pendingTask: undefined, pendingTaskAt: undefined, status: Status.Failed, error }, broadcast);
          continue;
        }

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

      // Executable plugins run through local-api's Host-scoped SDK and Durable Run Engine.
      // The hosted Cloud adapter was a second execution model: it retried an opaque HTTP submit and
      // could charge twice across the ambiguous-submit boundary. Cloud execution remains a designed
      // port until it can use the same journal, step graph, staging, and publication contracts.
      if (status === Status.Pending && !assetId && innerData.actionType?.startsWith('custom:')) {
        const error =
          'Cloud executable-plugin execution is unavailable; run this Action through local-api.';
        appendNodeLog(doc, nodeId, `FAILED: ${error}`, broadcast);
        updateNodeData(doc, nodeId, {
          pendingTask: undefined,
          status: Status.Failed,
          error,
        }, broadcast);
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
