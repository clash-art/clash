import type { LoroDoc } from "loro-crdt";
import { z } from "zod";
import { Canvas } from "./canvas-ops.js";
import { PROJECT_ASSET_RENDER_CANVAS_ID } from "./timeline-contract.js";
import { ProjectTimelineEnvelopeSchema } from "./timeline-envelope.js";
import {
  freezeProjectTimelineRunAssetInputs,
  projectTimelineActionId,
  projectTimelineRenderActionRunId,
  readProjectTimeline,
  resolveTimelineRenderTarget,
  type ProjectTimeline,
  type TimelineRenderTarget,
} from "./project-workspace.js";

export { PROJECT_ASSET_RENDER_CANVAS_ID } from "./timeline-contract.js";

export interface TimelineRenderRequestInput {
  timelineId: string;
  actorUserId: string;
  actorAgentId?: string;
  generateId: () => string;
}

export type TimelineRenderRequestResult =
  | {
      ok: true;
      renderNodeId: string;
      target: TimelineRenderTarget;
      position: { x: number; y: number };
    }
  | { ok: false; error: string };

export type RenderableTimelineDsl = {
  tracks?: Array<{
    items?: Array<{ from?: number; durationInFrames?: number }>;
  }>;
  compositionWidth?: number;
  compositionHeight?: number;
  fps?: number;
  durationInFrames?: number;
  [key: string]: unknown;
};

export const TimelineExportProgressSchema = z
  .object({
    renderNodeId: z.string().min(1),
    timelineId: z.string().min(1),
    timelineRevisionId: z.string().min(1),
    status: z.enum(["queued", "rendering", "completed", "failed"]),
    progress: z.number().min(0).max(1).optional(),
    error: z.string().min(1).optional(),
  })
  .strict();

export type TimelineExportProgress = z.infer<
  typeof TimelineExportProgressSchema
>;

/**
 * Projects a persisted render node into the framework-neutral export state
 * consumed by Timeline hosts and UI packages. Numeric progress is optional:
 * the durable renderer currently guarantees lifecycle state, not a percentage.
 */
export function timelineExportProgressFromRenderNode(
  renderNodeId: string,
  node: unknown,
): TimelineExportProgress | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  if (record.type !== "video") return null;
  const data = record.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const renderData = data as Record<string, unknown>;
  if (
    typeof renderData.sourceTimelineId !== "string" ||
    !renderData.sourceTimelineId ||
    typeof renderData.sourceTimelineRevisionId !== "string" ||
    !renderData.sourceTimelineRevisionId
  ) {
    return null;
  }

  const status =
    renderData.status === "pending"
      ? "queued"
      : renderData.status === "generating"
        ? "rendering"
        : renderData.status === "completed"
          ? "completed"
          : renderData.status === "failed"
            ? "failed"
            : null;
  if (!status) return null;

  const progress =
    typeof renderData.progress === "number" &&
    Number.isFinite(renderData.progress) &&
    renderData.progress >= 0 &&
    renderData.progress <= 1
      ? renderData.progress
      : undefined;
  const error =
    status === "failed" &&
    typeof renderData.error === "string" &&
    renderData.error.trim()
      ? renderData.error.trim()
      : undefined;

  return TimelineExportProgressSchema.parse({
    renderNodeId,
    timelineId: renderData.sourceTimelineId,
    timelineRevisionId: renderData.sourceTimelineRevisionId,
    status,
    ...(progress === undefined ? {} : { progress }),
    ...(error === undefined ? {} : { error }),
  });
}

export function listTimelineExportProgress(
  doc: LoroDoc,
  timelineId: string,
): TimelineExportProgress[] {
  const progress: TimelineExportProgress[] = [];
  for (const [renderNodeId, node] of doc.getMap("nodes").entries()) {
    const entry = timelineExportProgressFromRenderNode(renderNodeId, node);
    if (entry?.timelineId === timelineId) progress.push(entry);
  }
  return progress;
}

export function canonicalTimelineRenderDsl(
  state: unknown,
): RenderableTimelineDsl | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  const timelineDsl = state as RenderableTimelineDsl;
  const tracks = Array.isArray(timelineDsl.tracks) ? timelineDsl.tracks : [];
  const totalItems = tracks.reduce(
    (count, track) =>
      count + (Array.isArray(track.items) ? track.items.length : 0),
    0,
  );
  if (totalItems === 0) return null;

  let maxEnd = 0;
  for (const track of tracks) {
    for (const item of track.items ?? []) {
      const from = typeof item.from === "number" ? item.from : 0;
      const duration =
        typeof item.durationInFrames === "number" ? item.durationInFrames : 0;
      maxEnd = Math.max(maxEnd, from + duration);
    }
  }
  const declaredDuration =
    typeof timelineDsl.durationInFrames === "number"
      ? timelineDsl.durationInFrames
      : 0;
  return {
    ...timelineDsl,
    durationInFrames: Math.max(maxEnd, declaredDuration, 1),
  };
}

/** Data of a pending render node, whichever request path created it. */
function pendingTimelineRenderNodeData(input: {
  timeline: ProjectTimeline;
  timelineDsl: RenderableTimelineDsl;
  sourceTimelineActionId: string;
  actionRunId: string;
  actorUserId: string;
  actorAgentId?: string;
  target: TimelineRenderTarget;
}): Record<string, unknown> {
  const { timeline, timelineDsl } = input;
  const naturalWidth =
    typeof timelineDsl.compositionWidth === "number" &&
    timelineDsl.compositionWidth > 0
      ? timelineDsl.compositionWidth
      : 1920;
  const naturalHeight =
    typeof timelineDsl.compositionHeight === "number" &&
    timelineDsl.compositionHeight > 0
      ? timelineDsl.compositionHeight
      : 1080;
  return {
    label: "Rendered Video",
    status: "pending",
    timeline: ProjectTimelineEnvelopeSchema.parse({
      name: timeline.name,
      owner: timeline.owner,
      state: timelineDsl,
    }),
    timelineDsl,
    sourceTimelineId: timeline.id,
    sourceTimelineActionId: input.sourceTimelineActionId,
    sourceTimelineRevisionId: timeline.revisionId,
    sourceTimelineActionRunId: input.actionRunId,
    pendingTask: null,
    naturalWidth,
    naturalHeight,
    aspectRatio: `${naturalWidth}:${naturalHeight}`,
    actorType: input.actorAgentId ? "agent" : "user",
    actorUserId: input.actorUserId,
    ...(input.actorAgentId ? { actorAgentId: input.actorAgentId } : {}),
    renderTarget: input.target,
  };
}

/**
 * Creates the durable backend work item used by both Timeline Export and the
 * Canvas Timeline Action Render button. Canvas-owned outputs are linked into
 * their parent Canvas; standalone outputs live in an internal render scope and
 * surface through the project asset created by the backend processor.
 */
export function requestTimelineRender(
  doc: LoroDoc,
  input: TimelineRenderRequestInput,
): TimelineRenderRequestResult {
  const timeline = readProjectTimeline(doc, input.timelineId);
  if (!timeline)
    return { ok: false, error: `Timeline ${input.timelineId} not found` };
  const target = resolveTimelineRenderTarget(doc, input.timelineId);
  if (!target)
    return {
      ok: false,
      error: `Timeline ${input.timelineId} has no render target`,
    };

  if (target.kind === "canvas") {
    const result = new Canvas(doc, () => {}, target.canvasId).executeRender(
      target.actionNodeId,
      input.generateId,
    );
    if (result.error) return { ok: false, error: result.error };
    const nodes = doc.getMap("nodes");
    const raw = nodes.get(result.renderNodeId) as
      Record<string, any> | undefined;
    if (!raw)
      return {
        ok: false,
        error: `Render node ${result.renderNodeId} was not created`,
      };
    nodes.set(result.renderNodeId, {
      ...raw,
      data: {
        ...(raw.data ?? {}),
        actorType: input.actorAgentId ? "agent" : "user",
        actorUserId: input.actorUserId,
        ...(input.actorAgentId ? { actorAgentId: input.actorAgentId } : {}),
        renderTarget: target,
      },
    });
    return {
      ok: true,
      renderNodeId: result.renderNodeId,
      target,
      position: result.position,
    };
  }

  const timelineDsl = canonicalTimelineRenderDsl(timeline.state);
  if (!timelineDsl) {
    return {
      ok: false,
      error: `Timeline ${input.timelineId} has no items — nothing to render.`,
    };
  }
  const renderNodeId = input.generateId();
  const nodes = doc.getMap("nodes");
  if (nodes.get(renderNodeId) !== undefined) {
    return { ok: false, error: `Node ${renderNodeId} already exists` };
  }
  const actionRunId = projectTimelineRenderActionRunId(renderNodeId);
  const frozenPreflight = freezeProjectTimelineRunAssetInputs(
    doc.fork(),
    timeline,
    actionRunId,
  );
  if (!frozenPreflight.ok) {
    return { ok: false, error: frozenPreflight.error };
  }
  nodes.set(renderNodeId, {
    canvasId: PROJECT_ASSET_RENDER_CANVAS_ID,
    type: "video",
    position: { x: 0, y: 0 },
    data: pendingTimelineRenderNodeData({
      timeline,
      timelineDsl,
      sourceTimelineActionId: frozenPreflight.owner.actionId,
      actionRunId,
      actorUserId: input.actorUserId,
      actorAgentId: input.actorAgentId,
      target,
    }),
  });
  const frozen = freezeProjectTimelineRunAssetInputs(
    doc,
    timeline,
    actionRunId,
  );
  if (!frozen.ok) {
    throw new Error(
      `Timeline ${timeline.id} input freeze changed after preflight: ${frozen.error}`,
    );
  }
  return {
    ok: true,
    renderNodeId,
    target,
    position: { x: 0, y: 0 },
  };
}

/**
 * The same pending render node for a Timeline revision the caller has already
 * read, e.g. a Generator-backed Timeline on a cloud adapter. Generator
 * revisions are immutable and pin their own inputs, so there are no draft
 * bindings to freeze here.
 */
export function requestTimelineRevisionRender(
  doc: LoroDoc,
  input: Omit<TimelineRenderRequestInput, "timelineId"> & {
    timeline: ProjectTimeline;
  },
): TimelineRenderRequestResult {
  const { timeline } = input;
  const timelineDsl = canonicalTimelineRenderDsl(timeline.state);
  if (!timelineDsl)
    return {
      ok: false,
      error: `Timeline ${timeline.id} has no items — nothing to render.`,
    };
  const renderNodeId = input.generateId();
  if (doc.getMap("nodes").get(renderNodeId) !== undefined)
    return { ok: false, error: `Node ${renderNodeId} already exists` };
  const target: TimelineRenderTarget =
    timeline.owner.kind === "canvas-action"
      ? {
          kind: "canvas",
          canvasId: timeline.owner.canvasId,
          actionNodeId: timeline.owner.actionNodeId,
        }
      : { kind: "project-assets" };
  const data = pendingTimelineRenderNodeData({
    timeline,
    timelineDsl,
    sourceTimelineActionId: projectTimelineActionId(timeline.id, timeline.owner),
    actionRunId: projectTimelineRenderActionRunId(renderNodeId),
    actorUserId: input.actorUserId,
    actorAgentId: input.actorAgentId,
    target,
  });
  if (target.kind === "project-assets") {
    doc.getMap("nodes").set(renderNodeId, {
      canvasId: PROJECT_ASSET_RENDER_CANVAS_ID,
      type: "video",
      position: { x: 0, y: 0 },
      data,
    });
    return { ok: true, renderNodeId, target, position: { x: 0, y: 0 } };
  }
  const canvas = new Canvas(doc, () => {}, target.canvasId);
  const action = canvas.readNode(target.actionNodeId);
  if (!action)
    return {
      ok: false,
      error: `Timeline Action ${target.actionNodeId} not found`,
    };
  const linked = canvas.createLinkedNode({
    nodeId: renderNodeId,
    nodeType: "video",
    data,
    parentId: action.parent_id,
    sourceNodeId: target.actionNodeId,
  });
  return { ok: true, renderNodeId, target, position: linked.position };
}

export type TimelineRenderCompletion =
  | { ok: true; renderNodeId: string; assetId: string }
  | { ok: false; error: string };

/**
 * Projects finished bytes that a render adapter produced itself into the
 * same node shape the container pipeline's TaskPolling writes when a task
 * completes (`status: "completed"`, `assetId`, no pending task). Both paths
 * therefore surface through `listTimelineExportProgress` and the renders
 * list; the adapter that uploaded the bytes must not invent a second
 * publication model.
 */
export function completeTimelineRenderNode(
  doc: LoroDoc,
  input: { renderNodeId: string; assetId: string },
): TimelineRenderCompletion {
  const renderNodeId = input.renderNodeId.trim();
  const assetId = input.assetId.trim();
  if (!renderNodeId || !assetId)
    return { ok: false, error: "A render node and Asset are required" };
  const nodes = doc.getMap("nodes");
  const raw = nodes.get(renderNodeId) as Record<string, unknown> | undefined;
  if (!raw || raw.type !== "video")
    return { ok: false, error: `Render node ${renderNodeId} was not found` };
  const data = raw.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, error: `Render node ${renderNodeId} has no data` };
  const renderData = data as Record<string, unknown>;
  if (
    typeof renderData.sourceTimelineId !== "string" ||
    typeof renderData.sourceTimelineRevisionId !== "string"
  )
    return {
      ok: false,
      error: `Render node ${renderNodeId} is not a Timeline render`,
    };
  if (renderData.status === "completed" && renderData.assetId !== assetId)
    return {
      ok: false,
      error: `Render node ${renderNodeId} already published another Asset`,
    };
  nodes.set(renderNodeId, {
    ...raw,
    data: {
      ...renderData,
      status: "completed",
      assetId,
      progress: 1,
      pendingTask: undefined,
      pendingTaskAt: undefined,
      error: undefined,
      errorCode: undefined,
    },
  });
  return { ok: true, renderNodeId, assetId };
}
