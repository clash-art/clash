import type { LoroDoc } from "loro-crdt";
import type { ActionAssetBinding, ActionBindingOwner } from "./assets.js";
import type { CanvasNode } from "./canvas.js";
import { Canvas } from "./canvas-ops.js";
import {
  listProjectDirectorStages,
  type ProjectDirectorStage,
} from "./director-stage.js";
import {
  DEFAULT_CANVAS_ID,
  listProjectCanvases,
  listProjectTimelines,
  type ProjectTimeline,
} from "./project-workspace.js";
import { canvasActionAssetInputs } from "./canvas-action-asset-inputs.js";

export type LegacyActionAssetBindingConflictCode =
  "PROJECT_ASSET_NOT_FOUND" | "ACTION_ASSET_SLOT_CONFLICT";

export interface LegacyActionAssetBindingConflict {
  code: LegacyActionAssetBindingConflictCode;
  source: "canvas" | "timeline" | "director";
  sourceId: string;
  actionId: string;
  slot: string;
  projectAssetId: string;
  message: string;
}

export interface LegacyActionAssetBindingMaterializationInput {
  projectAssetIds: readonly string[];
  canvasNodes?: readonly Pick<
    CanvasNode,
    "id" | "type" | "data" | "upstream"
  >[];
  timelines?: readonly ProjectTimeline[];
  directorStages?: readonly ProjectDirectorStage[];
}

export interface LegacyActionAssetBindingMaterializationPlan {
  bindings: ActionAssetBinding[];
  conflicts: LegacyActionAssetBindingConflict[];
}

type BindingSource = LegacyActionAssetBindingConflict["source"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const normalized = nonEmptyString(candidate);
    return normalized ? [normalized] : [];
  });
}

function ownerKey(owner: ActionBindingOwner): string {
  if (owner.kind === "draft") return `draft:${owner.actionId}`;
  if (owner.kind === "revision") {
    return `revision:${owner.actionId}:${owner.actionRevisionId}`;
  }
  return `run:${owner.actionId}:${owner.actionRevisionId}:${owner.actionRunId}`;
}

function legacyBindingId(
  owner: ActionBindingOwner,
  direction: "input" | "output",
  slot: string,
): string {
  return [
    "action-asset",
    "legacy",
    encodeURIComponent(ownerKey(owner)),
    direction,
    encodeURIComponent(slot),
  ].join(":");
}

function draftOwner(actionId: string): ActionBindingOwner {
  return { kind: "draft", actionId };
}

function actionIdForCanvasNode(nodeId: string): string {
  return `node:${nodeId}`;
}

function actionIdForTimeline(timeline: ProjectTimeline): string {
  return timeline.owner.kind === "canvas-action"
    ? actionIdForCanvasNode(timeline.owner.actionNodeId)
    : `timeline:${timeline.id}`;
}

function actionIdForDirectorStage(stage: ProjectDirectorStage): string {
  return stage.owner.kind === "canvas-action"
    ? actionIdForCanvasNode(stage.owner.actionNodeId)
    : `director:${stage.id}`;
}

function timelineItems(state: unknown): Array<{
  id: string;
  projectAssetId: string;
}> {
  if (!isRecord(state)) return [];
  const catalog = new Map<string, string>();
  if (Array.isArray(state.assets)) {
    for (const candidate of state.assets) {
      if (!isRecord(candidate)) continue;
      const id = nonEmptyString(candidate.id);
      if (!id) continue;
      catalog.set(id, nonEmptyString(candidate.backingAssetId) ?? id);
    }
  }

  if (!Array.isArray(state.tracks)) return [];
  const result: Array<{ id: string; projectAssetId: string }> = [];
  for (const track of state.tracks) {
    if (!isRecord(track) || !Array.isArray(track.items)) continue;
    for (const candidate of track.items) {
      if (!isRecord(candidate)) continue;
      const id = nonEmptyString(candidate.id);
      const direct = nonEmptyString(candidate.backingAssetId);
      const itemAssetId = nonEmptyString(candidate.assetId);
      const projectAssetId =
        direct ??
        (itemAssetId ? (catalog.get(itemAssetId) ?? itemAssetId) : undefined);
      if (id && projectAssetId) result.push({ id, projectAssetId });
    }
  }
  return result;
}

/**
 * Produces the deterministic binding set needed to cut a legacy Project over to
 * ActionAssetBinding authority. This function never mutates Loro or storage.
 * Callers must reject every conflict before committing the returned bindings
 * and the authority marker in one Project checkpoint.
 */
export function planLegacyActionAssetBindingMaterialization(
  input: LegacyActionAssetBindingMaterializationInput,
): LegacyActionAssetBindingMaterializationPlan {
  const projectAssetIds = new Set(
    input.projectAssetIds.map((id) => id.trim()).filter(Boolean),
  );
  const bindings = new Map<string, ActionAssetBinding>();
  const conflicts = new Map<string, LegacyActionAssetBindingConflict>();

  const addBinding = (options: {
    source: BindingSource;
    sourceId: string;
    owner: ActionBindingOwner;
    direction: "input" | "output";
    slot: string;
    projectAssetId: string;
    role?: ActionAssetBinding["role"];
  }): void => {
    const projectAssetId = options.projectAssetId.trim();
    if (!projectAssetId) return;
    const actionId = options.owner.actionId;
    if (!projectAssetIds.has(projectAssetId)) {
      // Built-in Director media remains catalog-owned until first-use admission.
      // It is not a deletable ProjectAsset and therefore is outside this cutover.
      if (projectAssetId.startsWith("builtin:")) return;
      const key = [
        options.source,
        options.sourceId,
        actionId,
        options.slot,
        projectAssetId,
      ].join("\u0000");
      conflicts.set(key, {
        code: "PROJECT_ASSET_NOT_FOUND",
        source: options.source,
        sourceId: options.sourceId,
        actionId,
        slot: options.slot,
        projectAssetId,
        message: `${options.source} ${options.sourceId} uses missing Project Asset ${projectAssetId} at ${options.slot}.`,
      });
      return;
    }

    const id = legacyBindingId(options.owner, options.direction, options.slot);
    const binding: ActionAssetBinding = {
      id,
      owner: options.owner,
      direction: options.direction,
      slot: options.slot,
      projectAssetId,
      ...(options.role ? { role: options.role } : {}),
    };
    const existing = bindings.get(id);
    if (!existing) {
      bindings.set(id, binding);
      return;
    }
    if (JSON.stringify(existing) === JSON.stringify(binding)) return;
    const key = [
      options.source,
      options.sourceId,
      actionId,
      options.slot,
      projectAssetId,
    ].join("\u0000");
    conflicts.set(key, {
      code: "ACTION_ASSET_SLOT_CONFLICT",
      source: options.source,
      sourceId: options.sourceId,
      actionId,
      slot: options.slot,
      projectAssetId,
      message: `Action ${actionId} has conflicting legacy Assets for stable slot ${options.slot}.`,
    });
  };

  const canvasNodes = input.canvasNodes ?? [];
  const canvasEdges = canvasNodes.flatMap((target) =>
    target.upstream.map((reference) => ({
      source: reference.nodeId,
      target: target.id,
    })),
  );
  for (const node of canvasNodes) {
    const owner = draftOwner(actionIdForCanvasNode(node.id));
    const desiredInputs = canvasActionAssetInputs({
      node,
      nodes: canvasNodes,
      edges: canvasEdges,
    });
    if (desiredInputs === null) continue;
    for (const desired of desiredInputs) {
      addBinding({
        source: "canvas",
        sourceId: node.id,
        owner,
        direction: "input",
        slot: desired.slot,
        projectAssetId: desired.projectAssetId,
        role: desired.role,
      });
    }
  }

  for (const timeline of input.timelines ?? []) {
    const owner = draftOwner(actionIdForTimeline(timeline));
    for (const item of timelineItems(timeline.state)) {
      addBinding({
        source: "timeline",
        sourceId: timeline.id,
        owner,
        direction: "input",
        slot: `timeline:item:${item.id}`,
        projectAssetId: item.projectAssetId,
        role: "source",
      });
    }
  }

  for (const stage of input.directorStages ?? []) {
    const actionId = actionIdForDirectorStage(stage);
    const owner = draftOwner(actionId);
    if (stage.state.scene.environmentAssetId) {
      addBinding({
        source: "director",
        sourceId: stage.id,
        owner,
        direction: "input",
        slot: "director:environment",
        projectAssetId: stage.state.scene.environmentAssetId,
        role: "source",
      });
    }
    for (const object of stage.state.objects) {
      if (object.kind !== "model") continue;
      addBinding({
        source: "director",
        sourceId: stage.id,
        owner,
        direction: "input",
        slot: `director:model:${object.id}`,
        projectAssetId: object.model.assetId,
        role: "source",
      });
    }

    const motionById = new Map(
      (stage.state.motionAssets ?? []).map((motion) => [motion.id, motion]),
    );
    for (const clip of stage.state.animation?.actionClips ?? []) {
      if (!clip.motionAssetId) continue;
      const motion = motionById.get(clip.motionAssetId);
      if (!motion) continue;
      addBinding({
        source: "director",
        sourceId: stage.id,
        owner,
        direction: "input",
        slot: `director:action:${clip.id}:motion`,
        projectAssetId: motion.assetId,
        role: "source",
      });
    }

    for (const shot of stage.state.shots) {
      addBinding({
        source: "director",
        sourceId: stage.id,
        owner: {
          kind: "run",
          actionId,
          actionRevisionId: shot.stageRevisionId,
          actionRunId: `legacy-director-shot:${shot.id}`,
        },
        direction: "output",
        slot: `director:shot:${shot.id}`,
        projectAssetId: shot.assetId,
        role: "primary",
      });
    }
  }

  return {
    bindings: [...bindings.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    conflicts: [...conflicts.values()].sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.sourceId.localeCompare(right.sourceId) ||
        left.slot.localeCompare(right.slot) ||
        left.projectAssetId.localeCompare(right.projectAssetId),
    ),
  };
}

/**
 * Plans the cutover for every Action a Project document holds. Legacy Projects
 * predate the Canvas registry: their nodes live on the implicit default Canvas
 * with no `canvases` entry, so it is always read. Otherwise its Actions, a
 * pending one included, would get no binding and their Assets could be trashed.
 */
export function planLegacyActionAssetBindingMaterializationForDoc(
  doc: LoroDoc,
  projectAssetIds: readonly string[],
): LegacyActionAssetBindingMaterializationPlan {
  const canvasIds = new Set([
    DEFAULT_CANVAS_ID,
    ...listProjectCanvases(doc).map((canvas) => canvas.id),
  ]);
  return planLegacyActionAssetBindingMaterialization({
    projectAssetIds,
    canvasNodes: [...canvasIds].flatMap((canvasId) =>
      new Canvas(doc, () => undefined, canvasId).listNodes(),
    ),
    timelines: listProjectTimelines(doc),
    directorStages: listProjectDirectorStages(doc),
  });
}
