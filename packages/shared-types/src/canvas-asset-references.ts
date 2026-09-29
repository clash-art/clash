import type { LoroDoc } from "loro-crdt";
import { listActionAssetBindings } from "./action-asset-bindings.js";
import {
  isViewAssetReferenceEdge,
  listViewAssetReferenceEdges,
} from "./canvas-view-references.js";
import type { NodeOwnedEdge } from "./node-upstreams.js";
import { readGeneratorRevision, readProjectGenerator } from "./project-generators.js";
import {
  readProjectTimeline,
  projectTimelineActionId,
} from "./project-workspace.js";

const TIMELINE_PREFIX = "timeline-asset-reference:";
export function isCanvasAssetReferenceEdge(id: string): boolean {
  return isViewAssetReferenceEdge(id) || id.startsWith(TIMELINE_PREFIX);
}

type Placement = {
  type?: string;
  canvasId?: string;
  data?: Record<string, unknown>;
};

/** Material connections follow their owning domain; graph reads never persist them. */
export function listCanvasAssetReferenceEdges(
  doc: LoroDoc,
  scope: { canvasId?: string; nodeId?: string } = {},
): NodeOwnedEdge[] {
  const edges = listViewAssetReferenceEdges(doc, scope);
  const entries = [...doc.getMap("nodes").entries()] as Array<
    [string, Placement]
  >;
  const editors = entries.filter(
    ([id, node]) =>
      node?.type === "video-editor" &&
      (!scope.nodeId || scope.nodeId === id) &&
      (!scope.canvasId || (node.canvasId ?? "main") === scope.canvasId),
  );
  if (!editors.length) return edges;
  const bindings = listActionAssetBindings(doc);
  for (const [target, node] of editors) {
    const id = node.data?.timelineId;
    if (typeof id !== "string") continue;
    const canvasId = node.canvasId ?? "main";
    const head = readProjectGenerator(doc, id);
    let assets: Set<string>;
    if (head) {
      // Native Timeline placements point at a Generator. Its immutable head
      // revision owns material consumption; legacy draft bindings are unrelated.
      const revision = readGeneratorRevision(doc, { generatorId: id, generatorRevisionId: head.headRevisionId });
      if (!revision) continue;
      assets = new Set(revision.persistentInputRefs.flatMap(ref =>
        "kind" in ref.target && ref.target.kind === "media" ? [ref.target.projectAssetId] : [],
      ));
    } else {
      const timeline = readProjectTimeline(doc, id);
      if (!timeline || timeline.owner.kind !== "canvas-action" ||
          timeline.owner.actionNodeId !== target || timeline.owner.canvasId !== canvasId) continue;
      const actionId = projectTimelineActionId(id, timeline.owner);
      assets = new Set(bindings
        .filter(
          (binding) =>
            binding.owner.kind === "draft" &&
            binding.owner.actionId === actionId &&
            binding.direction === "input",
        )
        .map((binding) => binding.projectAssetId));
    }
    for (const [source, placement] of entries) {
      if (
        (placement?.canvasId ?? "main") !== canvasId ||
        !["image", "video", "audio", "model"].includes(placement?.type ?? "")
      )
        continue;
      if (
        typeof placement.data?.assetId !== "string" ||
        !assets.has(placement.data.assetId)
      )
        continue;
      edges.push({
        id: `${TIMELINE_PREFIX}${encodeURIComponent(target)}:${encodeURIComponent(source)}`,
        source,
        target,
        type: "reference",
      });
    }
  }
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}
