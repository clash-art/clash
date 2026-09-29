import {
  projectTimelineActionId,
  type ActionAssetBinding,
  type ActionBindingOwner,
  type MediaAssetGeneration,
  type ProjectCanvas,
  type ProjectTimeline,
  type ResolvedAsset,
} from "@clash/shared-types";

export interface AssetRelationNode {
  id: string;
  canvasId: string;
  type?: string;
  data?: Record<string, unknown>;
}

export interface AssetRelationEdge {
  canvasId: string;
  source: string;
  target: string;
}

export interface AssetRelationGraph {
  nodes: AssetRelationNode[];
  edges: AssetRelationEdge[];
}

export interface AssetCanvasRelation {
  canvasId: string;
  canvasName: string;
  nodeId: string;
  nodeCount: number;
  role: "origin" | "placement" | "reference";
}

export interface AssetTimelineRelation {
  timelineId: string;
  timelineName: string;
  itemCount: number;
}

export interface UpstreamAssetRelation {
  assetId: string;
  role: "edit-source" | "reference" | "primary";
  label: string;
  asset?: ResolvedAsset;
  availableInProject: boolean;
}

export interface AssetPromptRelation {
  label: string;
  value: string;
}

export interface AssetRelationSummary {
  generation?: {
    actionRunId: string;
    producer?: {
      pluginId: string;
      actionId: string;
      timeline?: { id: string; name: string };
    };
  };
  origin?: Omit<AssetCanvasRelation, "nodeCount" | "role">;
  canvases: AssetCanvasRelation[];
  timelines: AssetTimelineRelation[];
  upstreamAssets: UpstreamAssetRelation[];
  prompts: AssetPromptRelation[];
  sourceModel?: string;
}

export interface BuildAssetRelationSummaryInput {
  assetId: string;
  asset?: ResolvedAsset;
  projectAssets: ResolvedAsset[];
  canvases: ProjectCanvas[];
  timelines: ProjectTimeline[];
  nodes: AssetRelationNode[];
  edges: AssetRelationEdge[];
  bindings: ActionAssetBinding[];
  generation?: MediaAssetGeneration | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Project relation reads must span the whole persisted workspace, not only the
 * currently mounted React Flow canvas. Keep the CRDT shape out of Preview by
 * normalizing map entries at the feature boundary.
 */
export function readAssetRelationGraph(
  rawNodes: Iterable<unknown>,
  rawEdges: Iterable<unknown>,
): AssetRelationGraph {
  const nodes: AssetRelationNode[] = [];
  const canvasByNodeId = new Map<string, string>();

  for (const entry of rawNodes) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [id, rawNode] = entry;
    if (typeof id !== "string" || !isRecord(rawNode)) continue;
    const canvasId =
      typeof rawNode.canvasId === "string" ? rawNode.canvasId : "";
    if (!canvasId) continue;
    const node: AssetRelationNode = {
      id,
      canvasId,
      ...(typeof rawNode.type === "string" ? { type: rawNode.type } : {}),
      ...(isRecord(rawNode.data) ? { data: rawNode.data } : {}),
    };
    nodes.push(node);
    canvasByNodeId.set(id, canvasId);
  }

  const edges: AssetRelationEdge[] = [];
  for (const entry of rawEdges) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const rawEdge = entry[1];
    if (!isRecord(rawEdge)) continue;
    const source = typeof rawEdge.source === "string" ? rawEdge.source : "";
    const target = typeof rawEdge.target === "string" ? rawEdge.target : "";
    if (!source || !target) continue;
    const canvasId =
      (typeof rawEdge.canvasId === "string" ? rawEdge.canvasId : "") ||
      canvasByNodeId.get(target) ||
      canvasByNodeId.get(source) ||
      "";
    if (!canvasId) continue;
    edges.push({ canvasId, source, target });
  }

  return { nodes, edges };
}

function assetLabel(assetId: string, asset?: ResolvedAsset): string {
  return asset?.name?.trim() || asset?.metadata.originalName?.trim() || assetId;
}

function actionNodeId(owner: ActionBindingOwner): string | undefined {
  if (!owner.actionId.startsWith("node:")) return undefined;
  const nodeId = owner.actionId.slice("node:".length).trim();
  return nodeId || undefined;
}

function sameBindingOwner(
  left: ActionBindingOwner,
  right: ActionBindingOwner,
): boolean {
  if (left.kind !== right.kind || left.actionId !== right.actionId)
    return false;
  if (left.kind === "draft" || right.kind === "draft")
    return left.kind === right.kind;
  if (left.actionRevisionId !== right.actionRevisionId) return false;
  if (left.kind === "revision" || right.kind === "revision")
    return left.kind === right.kind;
  return left.actionRunId === right.actionRunId;
}

function upstreamRole(
  role: ActionAssetBinding["role"],
): UpstreamAssetRelation["role"] {
  if (role === "source") return "edit-source";
  if (role === "reference") return "reference";
  return "primary";
}

function timelineItemId(slot: string): string | undefined {
  const prefix = "timeline:item:";
  if (!slot.startsWith(prefix)) return undefined;
  const itemId = slot.slice(prefix.length).trim();
  return itemId || undefined;
}

export function buildAssetRelationSummary(
  input: BuildAssetRelationSummaryInput,
): AssetRelationSummary {
  const canvasById = new Map(
    input.canvases.map((canvas) => [canvas.id, canvas]),
  );
  const nodeById = new Map(input.nodes.map((node) => [node.id, node]));
  const directNodes = input.nodes.filter(
    (node) => node.data?.assetId === input.assetId,
  );
  const directNodeIds = new Set(directNodes.map((node) => node.id));
  const targetOutputBindings = input.bindings.filter(
    (binding) =>
      binding.direction === "output" &&
      binding.projectAssetId === input.assetId,
  );
  const originActionNodes = targetOutputBindings.flatMap((binding) => {
    const nodeId = actionNodeId(binding.owner);
    const node = nodeId ? nodeById.get(nodeId) : undefined;
    return node ? [node] : [];
  });
  const originNode =
    originActionNodes.reduce<AssetRelationNode | undefined>(
      (found, actionNode) => {
        if (found) return found;
        const linkedOutput = input.edges.find(
          (edge) =>
            edge.canvasId === actionNode.canvasId &&
            edge.source === actionNode.id &&
            directNodeIds.has(edge.target),
        );
        return linkedOutput ? nodeById.get(linkedOutput.target) : undefined;
      },
      undefined,
    ) ?? originActionNodes[0];

  const referenceNodeById = new Map<string, AssetRelationNode>();
  for (const binding of input.bindings) {
    if (
      binding.direction !== "input" ||
      binding.projectAssetId !== input.assetId
    ) {
      continue;
    }
    const nodeId = actionNodeId(binding.owner);
    const node = nodeId ? nodeById.get(nodeId) : undefined;
    if (node && !directNodeIds.has(node.id))
      referenceNodeById.set(node.id, node);
  }
  const referenceNodes = [...referenceNodeById.values()];

  const originCanvas = originNode
    ? canvasById.get(originNode.canvasId)
    : undefined;
  const origin = originNode
    ? {
        canvasId: originNode.canvasId,
        canvasName: originCanvas?.name ?? originNode.canvasId,
        nodeId: originNode.id,
      }
    : undefined;

  const usesByCanvas = new Map<
    string,
    { direct: AssetRelationNode[]; references: AssetRelationNode[] }
  >();
  for (const node of directNodes) {
    const uses = usesByCanvas.get(node.canvasId) ?? {
      direct: [],
      references: [],
    };
    uses.direct.push(node);
    usesByCanvas.set(node.canvasId, uses);
  }
  for (const node of referenceNodes) {
    const uses = usesByCanvas.get(node.canvasId) ?? {
      direct: [],
      references: [],
    };
    uses.references.push(node);
    usesByCanvas.set(node.canvasId, uses);
  }
  if (
    originNode &&
    !directNodeIds.has(originNode.id) &&
    !referenceNodeById.has(originNode.id)
  ) {
    const uses = usesByCanvas.get(originNode.canvasId) ?? {
      direct: [],
      references: [],
    };
    uses.references.push(originNode);
    usesByCanvas.set(originNode.canvasId, uses);
  }

  const canvases = Array.from(usesByCanvas.entries())
    .map(([canvasId, uses]): AssetCanvasRelation => {
      const canvas = canvasById.get(canvasId);
      const isOrigin = origin?.canvasId === canvasId;
      const role = isOrigin
        ? "origin"
        : uses.direct.length > 0
          ? "placement"
          : "reference";
      const representative = isOrigin
        ? originNode
        : (uses.direct[0] ?? uses.references[0]);
      return {
        canvasId,
        canvasName: canvas?.name ?? canvasId,
        nodeId: representative?.id ?? "",
        nodeCount: new Set(
          [...uses.direct, ...uses.references].map((node) => node.id),
        ).size,
        role,
      };
    })
    .sort((left, right) => {
      const leftCanvas = canvasById.get(left.canvasId);
      const rightCanvas = canvasById.get(right.canvasId);
      return (
        (leftCanvas?.position ?? Number.MAX_SAFE_INTEGER) -
          (rightCanvas?.position ?? Number.MAX_SAFE_INTEGER) ||
        left.canvasName.localeCompare(right.canvasName)
      );
    });

  const timelines = input.timelines
    .map((timeline) => {
      const actionId = projectTimelineActionId(timeline.id, timeline.owner);
      const itemIds = new Set(
        input.bindings
          .filter(
            (binding) =>
              binding.owner.kind === "draft" &&
              binding.owner.actionId === actionId &&
              binding.direction === "input" &&
              binding.projectAssetId === input.assetId,
          )
          .flatMap((binding) => {
            const itemId = timelineItemId(binding.slot);
            return itemId ? [itemId] : [];
          }),
      );
      return {
        timelineId: timeline.id,
        timelineName: timeline.name,
        itemCount: itemIds.size,
      };
    })
    .filter((timeline) => timeline.itemCount > 0);

  const projectAssetById = new Map<string, ResolvedAsset>();
  for (const asset of input.projectAssets) {
    projectAssetById.set(asset.id, asset);
  }
  const generation = input.generation;
  const lineageSources = generation
    ? [
        ...generation.revision.persistentInputRefs,
        ...generation.run.invocationInputRefs,
      ].flatMap(({ target }) =>
        "kind" in target &&
        target.kind === "media" &&
        target.projectAssetId !== input.assetId
          ? [{ assetId: target.projectAssetId, role: "reference" as const }]
          : [],
      )
    : targetOutputBindings.flatMap((output) =>
        input.bindings
          .filter(
            (binding) =>
              binding.direction === "input" &&
              binding.projectAssetId !== input.assetId &&
              sameBindingOwner(binding.owner, output.owner),
          )
          .map((binding) => ({
            assetId: binding.projectAssetId,
            role: upstreamRole(binding.role),
          })),
      );
  const seenLineage = new Set<string>();
  const upstreamAssets = lineageSources.flatMap(
    (source): UpstreamAssetRelation[] => {
      if (seenLineage.has(source.assetId)) return [];
      seenLineage.add(source.assetId);
      const asset = projectAssetById.get(source.assetId);
      return [
        {
          assetId: source.assetId,
          role: source.role,
          label: assetLabel(source.assetId, asset),
          asset,
          availableInProject: Boolean(asset),
        },
      ];
    },
  );

  const prompt = input.asset?.provenance?.prompt?.trim();
  const prompts: AssetPromptRelation[] = prompt
    ? [{ label: "Prompt", value: prompt }]
    : [];
  const sourceModel =
    generation?.run.modelSelection?.modelId ||
    input.asset?.provenance?.model?.trim() ||
    undefined;
  const originTimeline = generation
    ? input.timelines.find(
        (timeline) => timeline.id === generation.revision.generatorId,
      )
    : undefined;
  const actionRunId = input.asset?.provenance?.actionRunId;

  return {
    generation: actionRunId
      ? {
          actionRunId,
          producer: generation
            ? {
                pluginId: generation.run.executor.pluginId,
                actionId: generation.run.actionId,
                timeline: originTimeline
                  ? { id: originTimeline.id, name: originTimeline.name }
                  : undefined,
              }
            : undefined,
        }
      : undefined,
    origin,
    canvases,
    timelines,
    upstreamAssets,
    prompts,
    sourceModel,
  };
}
