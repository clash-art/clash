import { LoroMap, type LoroDoc } from "loro-crdt";
import { agentReadToken } from "./agent-read-proof.js";
import { Canvas } from "./canvas-ops.js";
import { commitProjectMutation } from "./project-mutation.js";
import {
  ExecutablePluginJsonValueSchema,
  ExecutablePluginViewReferenceSchema,
  type ExecutablePluginViewReference,
} from "./executable-plugin.js";
import {
  validateTimelineDsl,
  type TimelineDslValidationIssue,
} from "./timeline-dsl-schema.js";
import { normalizeProjectTimelinePersistenceState } from "./timeline-persistence.js";
import {
  freezeDraftActionAssetInputBindings,
  listActionAssetBindingsForOwner,
  replaceDraftActionAssetInputBindings,
  type FreezeDraftActionAssetInputBindingsResult,
  type DraftActionAssetInput,
} from "./action-asset-bindings.js";
import {
  clearNodeUpstreamRefs,
  deleteNodeUpstreamRef,
  readNodeUpstreamRefs,
} from "./node-upstreams.js";

export const DEFAULT_CANVAS_ID = "main";

export interface ProjectCanvas {
  id: string;
  name: string;
  position: number;
}

export function projectCanvasReadToken(canvas: ProjectCanvas): string {
  return agentReadToken({
    namespace: "canvas",
    subject: {
      id: canvas.id,
      name: canvas.name,
      position: canvas.position,
    },
  });
}

export type ProjectCanvasMutationResult =
  | { ok: true; canvas: ProjectCanvas }
  | { ok: false; error: string };

export type ProjectCanvasDeleteResult =
  | { ok: true; canvasId: string }
  | { ok: false; error: string };

export type ProjectPluginViewMutationResult =
  | { ok: true; nodeId: string; canvasId: string }
  | { ok: false; error: string };

export type TimelineOwner =
  | { kind: "project" }
  | { kind: "canvas-action"; canvasId: string; actionNodeId: string };

export interface ProjectTimeline {
  id: string;
  name: string;
  owner: TimelineOwner;
  revisionId: string;
  state: unknown;
}

export function projectTimelineActionId(
  timelineId: string,
  owner: TimelineOwner,
): string {
  return owner.kind === "canvas-action"
    ? `node:${owner.actionNodeId}`
    : `timeline:${timelineId}`;
}

export function projectTimelineAssetInputs(
  state: unknown,
): DraftActionAssetInput[] {
  if (!isRecord(state) || !Array.isArray(state.tracks)) return [];
  const inputs: DraftActionAssetInput[] = [];
  for (const track of state.tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const item of track.items) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
        continue;
      }
      const projectAssetId =
        typeof item.assetId === "string" && item.assetId.trim()
          ? item.assetId.trim()
          : undefined;
      if (!projectAssetId) continue;
      inputs.push({
        slot: `timeline:item:${item.id.trim()}`,
        projectAssetId,
        role: "source",
      });
    }
  }
  return inputs;
}

export function projectTimelineRenderActionRunId(renderNodeId: string): string {
  return `timeline-render:${renderNodeId.trim()}`;
}

/**
 * Freezes the current authoritative Timeline item bindings for one render run.
 *
 * The Timeline state is checked only as an integrity projection: the binding collection remains
 * the usage authority. A missing, extra, or rewired draft binding means the Timeline mutation was
 * not atomic and render submission fails closed instead of inventing an input from item fields.
 */
export function freezeProjectTimelineRunAssetInputs(
  doc: LoroDoc,
  timeline: Pick<ProjectTimeline, "id" | "owner" | "revisionId" | "state">,
  actionRunIdInput: string,
): FreezeDraftActionAssetInputBindingsResult {
  const actionId = projectTimelineActionId(timeline.id, timeline.owner);
  const expected = projectTimelineAssetInputs(timeline.state).sort((left, right) =>
    left.slot.localeCompare(right.slot),
  );
  const current = listActionAssetBindingsForOwner(doc, {
    kind: "draft",
    actionId,
  })
    .filter((binding) => binding.direction === "input")
    .sort((left, right) => left.slot.localeCompare(right.slot));
  if (
    expected.length !== current.length ||
    expected.some((input, index) => {
      const binding = current[index];
      return (
        !binding ||
        binding.slot !== input.slot ||
        binding.projectAssetId !== input.projectAssetId ||
        binding.role !== input.role
      );
    })
  ) {
    return {
      ok: false,
      error: `Timeline ${timeline.id} item bindings do not match its current Project state`,
    };
  }
  return freezeDraftActionAssetInputBindings(doc, {
    actionId,
    actionRevisionId: timeline.revisionId,
    actionRunId: actionRunIdInput,
  });
}

function syncProjectTimelineAssetInputs(
  doc: LoroDoc,
  timeline: Pick<ProjectTimeline, "id" | "owner" | "state">,
): Extract<ProjectTimelineMutationResult, { ok: false }> | undefined {
  const synced = replaceDraftActionAssetInputBindings(
    doc,
    projectTimelineActionId(timeline.id, timeline.owner),
    projectTimelineAssetInputs(timeline.state),
  );
  return synced.ok ? undefined : { ok: false, error: synced.error };
}

function rehomeProjectTimelineAssetInputs(
  doc: LoroDoc,
  previous: Pick<ProjectTimeline, "id" | "owner" | "state">,
  next: Pick<ProjectTimeline, "id" | "owner" | "state">,
): Extract<ProjectTimelineMutationResult, { ok: false }> | undefined {
  const nextError = syncProjectTimelineAssetInputs(doc, next);
  if (nextError) return nextError;
  const previousActionId = projectTimelineActionId(previous.id, previous.owner);
  const nextActionId = projectTimelineActionId(next.id, next.owner);
  if (previousActionId === nextActionId) return undefined;
  const cleared = replaceDraftActionAssetInputBindings(
    doc,
    previousActionId,
    [],
  );
  return cleared.ok ? undefined : { ok: false, error: cleared.error };
}

interface ProjectTimelineRevision {
  state: unknown;
  revisionId: string;
}

export function projectTimelineRevisionId(timelineId: string, state: unknown): string {
  return agentReadToken({
    namespace: "timeline-revision",
    subject: { timelineId, state },
  });
}

export function projectTimelineReadToken(timeline: ProjectTimeline): string {
  return agentReadToken({
    namespace: "timeline",
    subject: {
      id: timeline.id,
      name: timeline.name,
      owner: timeline.owner,
      revisionId: timeline.revisionId,
      state: timeline.state,
    },
  });
}

export type ProjectTimelineMutationResult =
  | { ok: true; timeline: ProjectTimeline }
  | {
      ok: false;
      error: string;
      code?: undefined;
      issues?: undefined;
    }
  | ProjectTimelineDslValidationFailure;

type ProjectTimelineDslValidationFailure = {
  ok: false;
  error: string;
  code: "INVALID_TIMELINE_DSL";
  issues: TimelineDslValidationIssue[];
};

function validateProjectTimelineMutationState(
  state: unknown,
): ProjectTimelineDslValidationFailure | undefined {
  const validation = validateTimelineDsl(state);
  if (validation.ok) return undefined;
  return {
    ok: false,
    error: "Timeline DSL validation failed",
    code: "INVALID_TIMELINE_DSL",
    issues: validation.issues,
  };
}

export type ProjectTimelineDeleteResult =
  | { ok: true; timelineId: string }
  | { ok: false; error: string };

export type TimelineRenderTarget =
  | { kind: "project-assets" }
  | { kind: "canvas"; canvasId: string; actionNodeId: string };

function defaultCanvasName(canvasId: string): string {
  return canvasId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Untitled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoroMap(value: unknown): value is LoroMap {
  return value instanceof LoroMap || Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { get?: unknown }).get === "function" &&
    typeof (value as { set?: unknown }).set === "function" &&
    typeof (value as { entries?: unknown }).entries === "function" &&
    typeof (value as { delete?: unknown }).delete === "function",
  );
}

function timelineField(raw: unknown, field: string): unknown {
  if (isLoroMap(raw)) return raw.get(field);
  return isRecord(raw) ? raw[field] : undefined;
}

function timelineActionTimelineId(raw: unknown): string | null {
  if (!isRecord(raw) || raw.type !== "video-editor" || !isRecord(raw.data)) return null;
  return typeof raw.data.timelineId === "string" ? raw.data.timelineId : null;
}

function nodeCanvasId(raw: unknown): string {
  return isRecord(raw) && typeof raw.canvasId === "string"
    ? raw.canvasId
    : DEFAULT_CANVAS_ID;
}

function parseTimeline(id: string, raw: unknown): ProjectTimeline | null {
  if (!isRecord(raw) && !isLoroMap(raw)) return null;
  const nameValue = timelineField(raw, "name");
  const ownerField = timelineField(raw, "owner");
  const ownerValue = isRecord(ownerField) ? ownerField : {};
  const owner: TimelineOwner = ownerValue.kind === "canvas-action" &&
    typeof ownerValue.canvasId === "string" &&
    typeof ownerValue.actionNodeId === "string"
    ? {
        kind: "canvas-action",
        canvasId: ownerValue.canvasId,
        actionNodeId: ownerValue.actionNodeId,
      }
    : { kind: "project" };
  const revisionField = timelineField(raw, "revision");
  const revisionValue = isRecord(revisionField) ? revisionField : {};
  const state = "state" in revisionValue
    ? revisionValue.state
    : timelineField(raw, "state");
  const legacyRevisionId = timelineField(raw, "revisionId");
  return {
    id,
    name: typeof nameValue === "string" && nameValue.trim() ? nameValue : "Untitled Timeline",
    owner,
    revisionId: typeof revisionValue.revisionId === "string" && revisionValue.revisionId.trim()
      ? revisionValue.revisionId
      : typeof legacyRevisionId === "string" && legacyRevisionId.trim()
        ? legacyRevisionId
        : projectTimelineRevisionId(id, state),
    state,
  };
}

export function readProjectTimeline(
  doc: LoroDoc,
  timelineId: string,
): ProjectTimeline | null {
  return parseTimeline(timelineId, doc.getMap("timelines").get(timelineId));
}

function setTimelineFields(fields: LoroMap, timeline: ProjectTimeline): void {
  fields.set("name", timeline.name);
  fields.set("owner", timeline.owner);
  fields.set("revision", {
    state: timeline.state,
    revisionId: timeline.revisionId,
  } satisfies ProjectTimelineRevision);
}

function ensureTimelineFields(
  doc: LoroDoc,
  timelineId: string,
  parsedTimeline?: ProjectTimeline,
): LoroMap {
  const timelines = doc.getMap("timelines");
  const existing = timelines.get(timelineId);
  if (isLoroMap(existing)) return existing;

  const legacyTimeline = parsedTimeline ?? parseTimeline(timelineId, existing);
  if (existing !== undefined) timelines.delete(timelineId);
  const fields = timelines.ensureMergeableMap(timelineId);
  if (legacyTimeline) setTimelineFields(fields, legacyTimeline);
  return fields;
}

export function ensureProjectCanvas(
  doc: LoroDoc,
  canvasId = DEFAULT_CANVAS_ID,
  name = defaultCanvasName(canvasId),
): ProjectCanvas {
  const canvases = doc.getMap("canvases");
  const existing = canvases.get(canvasId) as ProjectCanvas | undefined;
  if (existing) return { ...existing, id: canvasId };

  const canvas: ProjectCanvas = {
    id: canvasId,
    name,
    position: canvases.size,
  };
  canvases.set(canvasId, canvas);
  return canvas;
}

export function listProjectCanvases(doc: LoroDoc): ProjectCanvas[] {
  const canvases: ProjectCanvas[] = [];
  for (const [id, raw] of doc.getMap("canvases").entries()) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as Partial<ProjectCanvas>;
    canvases.push({
      id,
      name: typeof value.name === "string" && value.name.trim()
        ? value.name
        : defaultCanvasName(id),
      position: typeof value.position === "number" ? value.position : Number.MAX_SAFE_INTEGER,
    });
  }
  return canvases.sort((left, right) =>
    left.position - right.position || left.id.localeCompare(right.id)
  );
}

export function createProjectCanvas(
  doc: LoroDoc,
  input: { id: string; name: string },
): ProjectCanvasMutationResult {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id) return { ok: false, error: "Canvas id is required" };
  if (!name) return { ok: false, error: "Canvas name is required" };
  const canvases = doc.getMap("canvases");
  if (canvases.size === 0 && id !== DEFAULT_CANVAS_ID) {
    ensureProjectCanvas(doc);
  }
  if (canvases.get(id)) return { ok: false, error: `Canvas ${id} already exists` };
  const existing = listProjectCanvases(doc);
  const canvas: ProjectCanvas = {
    id,
    name,
    position: existing.length === 0
      ? 0
      : Math.max(...existing.map((candidate) => candidate.position)) + 1,
  };
  canvases.set(id, canvas);
  return { ok: true, canvas };
}

/** Creates a declarative plugin View node. Direct Add always defaults to the implicit Main Canvas. */
export function createProjectPluginView(
  doc: LoroDoc,
  input: {
    nodeId: string;
    label: string;
    view: ExecutablePluginViewReference;
    state: unknown;
    canvasId?: string;
  },
): ProjectPluginViewMutationResult {
  const nodeId = input.nodeId.trim();
  const label = input.label.trim();
  const canvasId = input.canvasId?.trim() || DEFAULT_CANVAS_ID;
  if (!nodeId) return { ok: false, error: "View node id is required" };
  if (!label) return { ok: false, error: "View label is required" };
  const view = ExecutablePluginViewReferenceSchema.safeParse(input.view);
  if (!view.success) return { ok: false, error: view.error.message };
  const state = ExecutablePluginJsonValueSchema.safeParse(input.state);
  if (!state.success || state.data === null || Array.isArray(state.data)) {
    return { ok: false, error: "View state must be a JSON object" };
  }
  const canvases = doc.getMap("canvases");
  if (canvasId === DEFAULT_CANVAS_ID && canvases.size === 0) {
    ensureProjectCanvas(doc);
  }
  if (!canvases.get(canvasId)) {
    return { ok: false, error: `Canvas ${canvasId} not found` };
  }
  if (doc.getMap("nodes").get(nodeId)) {
    return { ok: false, error: `Node ${nodeId} already exists` };
  }
  const created = new Canvas(doc, () => {}, canvasId).createNode(
    nodeId,
    "plugin-view",
    { label, view: view.data, state: state.data },
  );
  if (created.error) return { ok: false, error: created.error };
  return { ok: true, nodeId, canvasId };
}

export function renameProjectCanvas(
  doc: LoroDoc,
  canvasId: string,
  name: string,
): ProjectCanvasMutationResult {
  const canvases = doc.getMap("canvases");
  const existing = canvases.get(canvasId) as ProjectCanvas | undefined;
  if (!existing) return { ok: false, error: `Canvas ${canvasId} not found` };
  const nextName = name.trim();
  if (!nextName) return { ok: false, error: "Canvas name is required" };
  const canvas = { ...existing, id: canvasId, name: nextName };
  canvases.set(canvasId, canvas);
  return { ok: true, canvas };
}

export function deleteProjectCanvas(
  doc: LoroDoc,
  canvasId: string,
): ProjectCanvasDeleteResult {
  const canvases = listProjectCanvases(doc);
  if (!canvases.some((canvas) => canvas.id === canvasId)) {
    return { ok: false, error: `Canvas ${canvasId} not found` };
  }
  if (canvases.length === 1) return { ok: false, error: "Cannot delete the last Canvas" };
  for (const [, raw] of doc.getMap("nodes").entries()) {
    if (!raw || typeof raw !== "object") continue;
    const value = raw as { canvasId?: unknown };
    const nodeCanvasId = typeof value.canvasId === "string" ? value.canvasId : DEFAULT_CANVAS_ID;
    if (nodeCanvasId === canvasId) return { ok: false, error: `Canvas ${canvasId} is not empty` };
  }
  doc.getMap("canvases").delete(canvasId);
  return { ok: true, canvasId };
}

export function listProjectTimelines(doc: LoroDoc): ProjectTimeline[] {
  const timelines: ProjectTimeline[] = [];
  for (const [id, raw] of doc.getMap("timelines").entries()) {
    const timeline = parseTimeline(id, raw);
    if (timeline) timelines.push(timeline);
  }
  return timelines.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function listStandaloneTimelines(doc: LoroDoc): ProjectTimeline[] {
  return listProjectTimelines(doc).filter((timeline) => timeline.owner.kind === "project");
}

export function createProjectTimeline(
  doc: LoroDoc,
  input: { id: string; name: string; state: unknown },
): ProjectTimelineMutationResult {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id) return { ok: false, error: "Timeline id is required" };
  if (!name) return { ok: false, error: "Timeline name is required" };
  const timelines = doc.getMap("timelines");
  if (timelines.get(id)) return { ok: false, error: `Timeline ${id} already exists` };
  const persisted = normalizeProjectTimelinePersistenceState(input.state);
  if (!persisted.ok) return persisted;
  const validationError = validateProjectTimelineMutationState(persisted.state);
  if (validationError) return validationError;
  const timeline: ProjectTimeline = {
    id,
    name,
    owner: { kind: "project" },
    revisionId: projectTimelineRevisionId(id, persisted.state),
    state: persisted.state,
  };
  const bindingError = syncProjectTimelineAssetInputs(doc, timeline);
  if (bindingError) return bindingError;
  setTimelineFields(timelines.ensureMergeableMap(id), timeline);
  return { ok: true, timeline };
}

export function updateProjectTimelineState(
  doc: LoroDoc,
  timelineId: string,
  state: unknown,
): ProjectTimelineMutationResult {
  const timeline = readProjectTimeline(doc, timelineId);
  if (!timeline) return { ok: false, error: `Timeline ${timelineId} not found` };
  const persisted = normalizeProjectTimelinePersistenceState(state);
  if (!persisted.ok) return persisted;
  const validationError = validateProjectTimelineMutationState(persisted.state);
  if (validationError) return validationError;
  const next: ProjectTimeline = {
    ...timeline,
    revisionId: projectTimelineRevisionId(timelineId, persisted.state),
    state: persisted.state,
  };
  const bindingError = syncProjectTimelineAssetInputs(doc, next);
  if (bindingError) return bindingError;
  ensureTimelineFields(doc, timelineId, timeline).set("revision", {
    state: next.state,
    revisionId: next.revisionId,
  } satisfies ProjectTimelineRevision);
  return { ok: true, timeline: next };
}

export function deleteProjectTimeline(
  doc: LoroDoc,
  timelineId: string,
  expectedReadToken?: string,
): ProjectTimelineDeleteResult {
  const timeline = readProjectTimeline(doc, timelineId);
  if (!timeline) return { ok: false, error: `Timeline ${timelineId} not found` };
  if (
    expectedReadToken
    && expectedReadToken !== projectTimelineReadToken(timeline)
  ) {
    return {
      ok: false,
      error: `STALE_READ: Timeline ${timelineId} changed after it was read`,
    };
  }

  const cleared = replaceDraftActionAssetInputBindings(
    doc,
    projectTimelineActionId(timeline.id, timeline.owner),
    [],
  );
  if (!cleared.ok) return { ok: false, error: cleared.error };

  const nodes = doc.getMap("nodes");
  for (const [nodeId, raw] of [...nodes.entries()]) {
    if (timelineActionTimelineId(raw) !== timelineId) continue;
    new Canvas(doc, () => {}, nodeCanvasId(raw)).deleteNode(nodeId);
  }
  doc.getMap("timelines").delete(timelineId);
  return { ok: true, timelineId };
}

export type CreateTimelineOnCanvasInput = {
  id: string;
  name: string;
  state: unknown;
  canvasId: string;
  actionNodeId: string;
  position?: { x: number; y: number };
};

export function createTimelineOnCanvas(doc: LoroDoc, input: CreateTimelineOnCanvasInput): ProjectTimelineMutationResult {
  return commitProjectMutation(doc, (draft) => {
    const created = createProjectTimeline(draft, input);
    if (!created.ok) return created;
    return attachTimelineInDraft(draft, {
      timelineId: input.id,
      canvasId: input.canvasId,
      actionNodeId: input.actionNodeId,
      position: input.position,
    });
  });
}

export function attachTimelineToCanvas(
  doc: LoroDoc,
  input: {
    timelineId: string;
    canvasId: string;
    actionNodeId: string;
    position?: { x: number; y: number };
  },
): ProjectTimelineMutationResult {
  return commitProjectMutation(doc, (draft) => attachTimelineInDraft(draft, input));
}

function attachTimelineInDraft(
  doc: LoroDoc,
  input: {
    timelineId: string;
    canvasId: string;
    actionNodeId: string;
    position?: { x: number; y: number };
  },
): ProjectTimelineMutationResult {
  const timelines = doc.getMap("timelines");
  const timeline = parseTimeline(input.timelineId, timelines.get(input.timelineId));
  if (!timeline) return { ok: false, error: `Timeline ${input.timelineId} not found` };
  if (timeline.owner.kind !== "project") {
    return { ok: false, error: `Timeline ${input.timelineId} is already owned by Canvas ${timeline.owner.canvasId}` };
  }
  const canvases = doc.getMap("canvases");
  if (input.canvasId === DEFAULT_CANVAS_ID && canvases.size === 0) {
    ensureProjectCanvas(doc);
  }
  if (!canvases.get(input.canvasId)) {
    return { ok: false, error: `Canvas ${input.canvasId} not found` };
  }
  if (doc.getMap("nodes").get(input.actionNodeId)) {
    return { ok: false, error: `Node ${input.actionNodeId} already exists` };
  }

  const next: ProjectTimeline = {
    ...timeline,
    owner: {
      kind: "canvas-action",
      canvasId: input.canvasId,
      actionNodeId: input.actionNodeId,
    },
  };
  const hostCanvas = new Canvas(doc, () => {}, input.canvasId);
  const view = hostCanvas.createNode(
    input.actionNodeId,
    "video-editor",
    { timelineId: input.timelineId, label: timeline.name },
    input.position,
  );
  if (view.error) return { ok: false, error: view.error };
  const bindingError = rehomeProjectTimelineAssetInputs(doc, timeline, next);
  if (bindingError) {
    hostCanvas.deleteNode(input.actionNodeId);
    return bindingError;
  }
  ensureTimelineFields(doc, input.timelineId, timeline).set("owner", next.owner);
  return { ok: true, timeline: next };
}

export function detachTimelineFromCanvas(
  doc: LoroDoc,
  timelineId: string,
): ProjectTimelineMutationResult {
  const timeline = readProjectTimeline(doc, timelineId);
  if (!timeline) return { ok: false, error: `Timeline ${timelineId} not found` };
  if (timeline.owner.kind !== "canvas-action") {
    return { ok: false, error: `Timeline ${timelineId} is already standalone` };
  }
  const actionNodeId = timeline.owner.actionNodeId;
  const rawAction = doc.getMap("nodes").get(actionNodeId);
  if (
    timelineActionTimelineId(rawAction) === timeline.id &&
    nodeCanvasId(rawAction) === timeline.owner.canvasId
  ) {
    new Canvas(doc, () => {}, timeline.owner.canvasId).deleteNode(actionNodeId);
  }
  const next: ProjectTimeline = { ...timeline, owner: { kind: "project" } };
  const bindingError = rehomeProjectTimelineAssetInputs(doc, timeline, next);
  if (bindingError) return bindingError;
  ensureTimelineFields(doc, timelineId, timeline).set("owner", next.owner);
  return { ok: true, timeline: next };
}

function cloneTimelineState<T>(state: T): T {
  return structuredClone(state);
}

export function copyTimelineActionToCanvas(
  doc: LoroDoc,
  input: {
    sourceTimelineId: string;
    targetCanvasId: string;
    newTimelineId: string;
    newActionNodeId: string;
    position: { x: number; y: number };
  },
): ProjectTimelineMutationResult {
  const timelines = doc.getMap("timelines");
  const source = parseTimeline(input.sourceTimelineId, timelines.get(input.sourceTimelineId));
  if (!source) return { ok: false, error: `Timeline ${input.sourceTimelineId} not found` };
  if (source.owner.kind !== "canvas-action") {
    return { ok: false, error: `Timeline ${input.sourceTimelineId} is standalone` };
  }
  const canvases = doc.getMap("canvases");
  if (input.targetCanvasId === DEFAULT_CANVAS_ID && canvases.size === 0) {
    ensureProjectCanvas(doc);
  }
  if (!canvases.get(input.targetCanvasId)) {
    return { ok: false, error: `Canvas ${input.targetCanvasId} not found` };
  }
  if (timelines.get(input.newTimelineId)) {
    return { ok: false, error: `Timeline ${input.newTimelineId} already exists` };
  }
  const nodes = doc.getMap("nodes");
  if (nodes.get(input.newActionNodeId)) {
    return { ok: false, error: `Node ${input.newActionNodeId} already exists` };
  }

  const sourceAction = nodes.get(source.owner.actionNodeId);
  const sourceActionData = isRecord(sourceAction) && isRecord(sourceAction.data)
    ? sourceAction.data
    : {};
  const timeline: ProjectTimeline = {
    id: input.newTimelineId,
    name: source.name,
    owner: {
      kind: "canvas-action",
      canvasId: input.targetCanvasId,
      actionNodeId: input.newActionNodeId,
    },
    revisionId: projectTimelineRevisionId(input.newTimelineId, source.state),
    state: cloneTimelineState(source.state),
  };
  const bindingError = syncProjectTimelineAssetInputs(doc, timeline);
  if (bindingError) return bindingError;
  setTimelineFields(timelines.ensureMergeableMap(input.newTimelineId), timeline);
  nodes.set(input.newActionNodeId, {
    canvasId: input.targetCanvasId,
    type: "video-editor",
    data: {
      ...sourceActionData,
      timelineId: input.newTimelineId,
      label: source.name,
    },
    position: input.position,
  });
  return { ok: true, timeline };
}

export function resolveTimelineRenderTarget(
  doc: LoroDoc,
  timelineId: string,
): TimelineRenderTarget | null {
  const timeline = readProjectTimeline(doc, timelineId);
  if (!timeline) return null;
  return timeline.owner.kind === "project"
    ? { kind: "project-assets" }
    : {
        kind: "canvas",
        canvasId: timeline.owner.canvasId,
        actionNodeId: timeline.owner.actionNodeId,
      };
}

export interface TimelineOwnershipReconciliation {
  removedActionNodeIds: string[];
  detachedTimelineIds: string[];
}

/**
 * Loro's map conflict resolution converges a concurrently assigned owner to
 * one value. The losing Action node is a separate CRDT object, so remove it
 * deterministically after imports and detach an owner whose winning node was
 * independently deleted.
 */
export function reconcileProjectTimelineOwnership(
  doc: LoroDoc,
): TimelineOwnershipReconciliation {
  const timelines = new Map(listProjectTimelines(doc).map((timeline) => [timeline.id, timeline]));
  const nodes = doc.getMap("nodes");
  const removedActionNodeIds: string[] = [];

  for (const [nodeId, raw] of [...nodes.entries()]) {
    const timelineId = timelineActionTimelineId(raw);
    if (!timelineId) continue;
    const timeline = timelines.get(timelineId);
    if (!timeline) continue;
    const canvasId = nodeCanvasId(raw);
    const isWinningAction = timeline.owner.kind === "canvas-action" &&
      timeline.owner.actionNodeId === nodeId &&
      timeline.owner.canvasId === canvasId;
    if (isWinningAction) continue;

    clearNodeUpstreamRefs(doc, nodeId, raw);
    for (const [targetId, targetRaw] of nodes.entries()) {
      for (const ref of readNodeUpstreamRefs(doc, targetId, targetRaw)) {
        if (ref.nodeId === nodeId) {
          deleteNodeUpstreamRef(doc, targetId, ref.edgeId, targetRaw);
        }
      }
    }
    nodes.delete(nodeId);
    removedActionNodeIds.push(nodeId);
  }

  const detachedTimelineIds: string[] = [];
  for (const timeline of timelines.values()) {
    if (timeline.owner.kind !== "canvas-action") continue;
    const rawOwner = nodes.get(timeline.owner.actionNodeId);
    const ownerMatches = timelineActionTimelineId(rawOwner) === timeline.id &&
      nodeCanvasId(rawOwner) === timeline.owner.canvasId;
    if (ownerMatches) continue;
    const detached: ProjectTimeline = {
      ...timeline,
      owner: { kind: "project" },
    };
    const bindingError = rehomeProjectTimelineAssetInputs(
      doc,
      timeline,
      detached,
    );
    if (bindingError) throw new Error(bindingError.error);
    ensureTimelineFields(doc, timeline.id, timeline).set("owner", { kind: "project" });
    detachedTimelineIds.push(timeline.id);
  }

  return {
    removedActionNodeIds: removedActionNodeIds.sort(),
    detachedTimelineIds: detachedTimelineIds.sort(),
  };
}
