import type { LoroDoc } from "loro-crdt";
import {
  ExecutablePluginViewStateSchema,
  listPluginViewAssetReferences,
} from "./executable-plugin.js";
import type { NodeOwnedEdge } from "./node-upstreams.js";

const VIEW_ASSET_EDGE_PREFIX = "view-asset-reference:";

export function isViewAssetReferenceEdge(edgeId: string): boolean {
  return edgeId.startsWith(VIEW_ASSET_EDGE_PREFIX);
}

type Placement = {
  type?: string;
  canvasId?: string;
  data?: Record<string, unknown>;
};

/** The View owns Asset refs; Canvas edges are a read-only projection of those facts. */
export function listViewAssetReferenceEdges(
  doc: LoroDoc,
  scope: { canvasId?: string; nodeId?: string } = {},
): NodeOwnedEdge[] {
  const nodes = doc.getMap("nodes");
  if (
    scope.nodeId &&
    (nodes.get(scope.nodeId) as Placement | undefined)?.type !== "plugin-view"
  ) {
    return [];
  }
  const entries = [...nodes.entries()] as Array<[string, Placement]>;
  const views = entries.filter(
    ([id, node]) =>
      node?.type === "plugin-view" &&
      (!scope.nodeId || scope.nodeId === id) &&
      (!scope.canvasId || (node.canvasId ?? "main") === scope.canvasId),
  );
  if (!views.length) return [];

  // Build once per read, rather than searching every node for every candidate.
  const placements = new Map<string, Map<string, string[]>>();
  for (const [id, node] of entries) {
    if (
      !node ||
      !["image", "video", "audio", "model"].includes(node.type ?? "")
    )
      continue;
    const assetId = node.data?.assetId;
    if (typeof assetId !== "string" || !assetId) continue;
    const canvasId = node.canvasId ?? "main";
    const assets = placements.get(canvasId) ?? new Map<string, string[]>();
    const ids = assets.get(assetId) ?? [];
    ids.push(id);
    assets.set(assetId, ids);
    placements.set(canvasId, assets);
  }

  const edges: NodeOwnedEdge[] = [];
  for (const [target, node] of views) {
    const parsed = ExecutablePluginViewStateSchema.safeParse(node.data?.state);
    if (!parsed.success) continue;
    const assetIds = new Set(
      listPluginViewAssetReferences(parsed.data).map(
        ({ resource }) => resource.projectAssetId,
      ),
    );
    const assets = placements.get(node.canvasId ?? "main");
    for (const assetId of assetIds) {
      for (const source of assets?.get(assetId) ?? []) {
        edges.push({
          id: `${VIEW_ASSET_EDGE_PREFIX}${encodeURIComponent(target)}:${encodeURIComponent(source)}`,
          source,
          target,
          type: "reference",
        });
      }
    }
  }
  return edges.sort((left, right) => left.id.localeCompare(right.id));
}
