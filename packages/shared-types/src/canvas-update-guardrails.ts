import {
  agentReadToken,
  type AgentReadReceiptVerifier,
  validateAgentReadProof,
} from "./agent-read-proof.js";

const PROJECTION_OWNED_DATA_FIELDS = new Set([
  "timelineDsl",
]);

const RUNTIME_OWNED_DATA_FIELDS = new Set([
  "actorType",
  "actorUserId",
  "actorAgentId",
]);

const ACTION_CHECKPOINT_NODE_TYPES = new Set([
  "image_gen",
  "video_gen",
  "audio_gen",
  "text_gen",
]);

const MEDIA_ASSET_NODE_TYPES = new Set([
  "image",
  "video",
  "audio",
]);

const ACTION_CHECKPOINT_SEMANTIC_FIELDS = new Set([
  "actionType",
  "assetId",
  "content",
  "customActionId",
  "customActionParams",
  "error",
  "errorCode",
  "metadata",
  "model",
  "modelEndpoint",
  "modelId",
  "modelName",
  "modelParams",
  "outputType",
  "outputAssetId",
  "outputAssetIds",
  "pendingTask",
  "pendingTaskAt",
  "preAllocatedAssetId",
  "prompt",
  "provider",
  "referenceAssetId",
  "referenceAssetIds",
  "referenceImageOrder",
  "requiredReferenceAssetIds",
  "sourceAssetId",
  "sourceToOutputMap",
  "targetAssetId",
  "status",
]);

export type CanvasUpdateGuardrailResult =
  | { ok: true }
  | { ok: false; error: string };

export type CanvasUpdateNodeLike = {
  type?: string;
  data?: Record<string, unknown>;
};

export type CanvasUpdateEdgeLike = {
  source: string;
  target: string;
};

export type CanvasUpdateNodeWithIdLike = CanvasUpdateNodeLike & {
  id: string;
};

export type CanvasReadProofOperation = "update" | "delete" | "patch" | "timeline apply";

export type CanvasReadProofNodeLike = CanvasUpdateNodeLike & {
  id: string;
  parentId?: string | null;
  parent_id?: string | null;
  position?: unknown;
};

export type CanvasReadProofEdgeLike = Record<string, unknown> & {
  id: string;
  source?: string;
  target?: string;
};

export type CanvasBatchDeleteReadProofLike = {
  nodes: Iterable<CanvasReadProofNodeLike>;
  edges: Iterable<CanvasReadProofEdgeLike>;
};

export function canvasNodeReadToken(node: CanvasReadProofNodeLike): string {
  return agentReadToken({
    namespace: "node",
    subject: normalizeCanvasNodeReadSubject(node),
  });
}

export function canvasEdgeReadToken(edge: CanvasReadProofEdgeLike): string {
  return agentReadToken({
    namespace: "edge",
    subject: normalizeCanvasEdgeReadSubject(edge),
  });
}

export function canvasEdgesReadToken(edges: Iterable<CanvasReadProofEdgeLike>): string {
  return agentReadToken({
    namespace: "edges",
    subject: {
      edges: [...edges]
        .map(normalizeCanvasEdgeReadSubject)
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    },
  });
}

export function canvasBatchDeleteReadToken(options: CanvasBatchDeleteReadProofLike): string {
  return agentReadToken({
    namespace: "canvas-batch-delete",
    subject: {
      nodes: [...options.nodes]
        .map(normalizeCanvasNodeReadSubject)
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
      edges: [...options.edges]
        .map(normalizeCanvasEdgeReadSubject)
        .sort((left, right) => String(left.id).localeCompare(String(right.id))),
    },
  });
}

export function validateCanvasReadProof(options: {
  operation: CanvasReadProofOperation;
  actorClientType?: string;
  node: CanvasReadProofNodeLike;
  expectedReadToken?: string;
  requireReceipt?: boolean;
  readReceiptVerifier?: AgentReadReceiptVerifier;
}): CanvasUpdateGuardrailResult {
  return validateAgentReadProof({
    actorClientType: options.actorClientType,
    operation: `canvas ${options.operation}`,
    currentReadToken: canvasNodeReadToken(options.node),
    expectedReadToken: options.expectedReadToken,
    requireReceipt: options.requireReceipt,
    readReceiptVerifier: options.readReceiptVerifier,
    readCommandHint: "Run `clash canvas get --json` first, then retry the mutation.",
  });
}

export function validateCanvasBatchDeleteReadProof(options: {
  actorClientType?: string;
  nodes: Iterable<CanvasReadProofNodeLike>;
  edges: Iterable<CanvasReadProofEdgeLike>;
  expectedReadToken?: string;
  requireReceipt?: boolean;
  readReceiptVerifier?: AgentReadReceiptVerifier;
}): CanvasUpdateGuardrailResult {
  return validateAgentReadProof({
    actorClientType: options.actorClientType,
    operation: "canvas batch delete",
    currentReadToken: canvasBatchDeleteReadToken({
      nodes: options.nodes,
      edges: options.edges,
    }),
    expectedReadToken: options.expectedReadToken,
    requireReceipt: options.requireReceipt,
    readReceiptVerifier: options.readReceiptVerifier,
    readCommandHint:
      "Run `clash canvas delete-plan --node <id> --node <id> --json` first, then retry the mutation.",
  });
}

export function validateCanvasEdgeReadProof(options: {
  operation: "update" | "delete";
  actorClientType?: string;
  edge: CanvasReadProofEdgeLike;
  expectedReadToken?: string;
  requireReceipt?: boolean;
  readReceiptVerifier?: AgentReadReceiptVerifier;
}): CanvasUpdateGuardrailResult {
  return validateAgentReadProof({
    actorClientType: options.actorClientType,
    operation: `canvas edge ${options.operation}`,
    currentReadToken: canvasEdgeReadToken(options.edge),
    expectedReadToken: options.expectedReadToken,
    requireReceipt: options.requireReceipt,
    readReceiptVerifier: options.readReceiptVerifier,
    readCommandHint: "Run `clash canvas edges --json` first, then retry the mutation.",
  });
}

export function validateCanvasEdgesReadProof(options: {
  operation: "add";
  actorClientType?: string;
  edges: Iterable<CanvasReadProofEdgeLike>;
  expectedReadToken?: string;
  requireReceipt?: boolean;
  readReceiptVerifier?: AgentReadReceiptVerifier;
}): CanvasUpdateGuardrailResult {
  return validateAgentReadProof({
    actorClientType: options.actorClientType,
    operation: `canvas edge ${options.operation}`,
    currentReadToken: canvasEdgesReadToken(options.edges),
    expectedReadToken: options.expectedReadToken,
    requireReceipt: options.requireReceipt,
    readReceiptVerifier: options.readReceiptVerifier,
    readCommandHint: "Run `clash canvas edges --json` first, then retry the mutation.",
  });
}

export function validateCanvasUpdateDataFields(
  fields: Iterable<string>,
): CanvasUpdateGuardrailResult {
  const projectionOwned: string[] = [];
  const runtimeOwned: string[] = [];

  for (const field of fields) {
    if (PROJECTION_OWNED_DATA_FIELDS.has(field)) projectionOwned.push(field);
    if (RUNTIME_OWNED_DATA_FIELDS.has(field)) runtimeOwned.push(field);
  }

  if (projectionOwned.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to patch projection-owned canvas field(s): ${projectionOwned.join(", ")}. ` +
        "Use the matching projection command, such as `clash timeline apply`, so CAS is enforced.",
    };
  }

  if (runtimeOwned.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to patch runtime-owned canvas field(s): ${runtimeOwned.join(", ")}. ` +
        "Actor/provenance fields are stamped by the CLI/runtime.",
    };
  }

  return { ok: true };
}

export function validateCanvasContentPatch(options: {
  nodeId: string;
  node: CanvasUpdateNodeLike | null | undefined;
  nodes?: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
  hasContentPatch: boolean;
}): CanvasUpdateGuardrailResult {
  if (!options.hasContentPatch || options.node?.type !== "text") {
    return { ok: true };
  }
  const downstream = canvasMaterializedContentDownstreamTargets(options.nodeId, options.edges, options.nodes);
  if (downstream.length === 0) return { ok: true };
  return {
    ok: false,
    error:
      `Refusing to patch referenced text content through canvas update. Text node ${options.nodeId} ` +
      `has downstream node(s): ${downstream.join(", ")}. ` +
      "Use text projection or copy-on-write/replace workflow instead.",
  };
}

export function validateCanvasMediaAssetPatch(options: {
  nodeId: string;
  node: CanvasUpdateNodeLike | null | undefined;
  edges: CanvasUpdateEdgeLike[];
  hasAssetIdPatch: boolean;
  nextAssetId?: unknown;
}): CanvasUpdateGuardrailResult {
  if (
    !options.hasAssetIdPatch ||
    typeof options.node?.type !== "string" ||
    !MEDIA_ASSET_NODE_TYPES.has(options.node.type)
  ) {
    return { ok: true };
  }
  const downstream = options.edges.filter((edge) => edge.source === options.nodeId);
  if (downstream.length === 0) return { ok: true };
  const currentAssetId = options.node?.data?.assetId;
  if (typeof currentAssetId !== "string" || currentAssetId.length === 0) {
    return { ok: true };
  }
  if (options.nextAssetId === currentAssetId) return { ok: true };
  return {
    ok: false,
    error:
      `Refusing to patch referenced media asset through canvas update. Media node ${options.nodeId} ` +
      `has downstream node(s): ${downstream.map((edge) => edge.target).join(", ")}. ` +
      "Use copy-on-write/replace workflow instead.",
  };
}

function assetIdPatchValue(patch: Record<string, unknown>): unknown {
  if (isRecord(patch.data) && Object.prototype.hasOwnProperty.call(patch.data, "assetId")) {
    return patch.data.assetId;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "assetId")) {
    return patch.assetId;
  }
  return undefined;
}

function isActionCheckpointNode(node: CanvasUpdateNodeLike | null | undefined): boolean {
  if (!node) return false;
  if (typeof node.type === "string" && ACTION_CHECKPOINT_NODE_TYPES.has(node.type)) return true;
  return (
    typeof node.data?.actionType === "string" ||
    typeof node.data?.customActionId === "string"
  );
}

export function validateCanvasCheckpointPatch(options: {
  nodeId: string;
  node: CanvasUpdateNodeLike | null | undefined;
  nodes?: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
  fields: Iterable<string>;
}): CanvasUpdateGuardrailResult {
  if (!isActionCheckpointNode(options.node)) return { ok: true };

  const downstream = canvasCheckpointDownstreamTargets(options.nodeId, options.edges, options.nodes);
  if (downstream.length === 0) return { ok: true };

  const semanticFields = [...new Set([...options.fields])]
    .filter((field) => ACTION_CHECKPOINT_SEMANTIC_FIELDS.has(field));
  if (semanticFields.length === 0) return { ok: true };

  return {
    ok: false,
    error:
      `Refusing to patch materialized-checkpoint action field(s): ${semanticFields.join(", ")}. ` +
      `Action node ${options.nodeId} has materialized downstream node(s): ` +
      `${downstream.join(", ")}. ` +
      "Use copy-on-write/replace workflow instead.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCanvasNodeReadSubject(node: CanvasReadProofNodeLike): Record<string, unknown> {
  return {
    id: node.id,
    type: node.type ?? null,
    data: node.data ?? {},
    parentId: node.parentId ?? node.parent_id ?? null,
    position: node.position ?? null,
  };
}

function normalizeCanvasEdgeReadSubject(edge: CanvasReadProofEdgeLike): Record<string, unknown> {
  const subject: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(edge)) {
    if (value !== undefined && typeof value !== "function") subject[key] = value;
  }
  subject.id = edge.id;
  return subject;
}

export function canvasPatchFields(patch: Record<string, unknown>): string[] {
  const fields = new Set<string>();
  for (const key of Object.keys(patch)) {
    if (key !== "data") fields.add(key);
  }
  if (isRecord(patch.data)) {
    for (const key of Object.keys(patch.data)) fields.add(key);
  }
  return [...fields];
}

export function validateCanvasNodePatch(options: {
  nodeId: string;
  node: CanvasUpdateNodeLike | null | undefined;
  nodes?: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
  patch: Record<string, unknown>;
}): CanvasUpdateGuardrailResult {
  const fields = canvasPatchFields(options.patch);
  const dataFieldsGuard = validateCanvasUpdateDataFields(fields);
  if (!dataFieldsGuard.ok) return dataFieldsGuard;

  const contentGuard = validateCanvasContentPatch({
    nodeId: options.nodeId,
    node: options.node,
    nodes: options.nodes,
    edges: options.edges,
    hasContentPatch: fields.includes("content"),
  });
  if (!contentGuard.ok) return contentGuard;

  const mediaGuard = validateCanvasMediaAssetPatch({
    nodeId: options.nodeId,
    node: options.node,
    edges: options.edges,
    hasAssetIdPatch: fields.includes("assetId"),
    nextAssetId: assetIdPatchValue(options.patch),
  });
  if (!mediaGuard.ok) return mediaGuard;

  return validateCanvasCheckpointPatch({
    nodeId: options.nodeId,
    node: options.node,
    nodes: options.nodes,
    edges: options.edges,
    fields,
  });
}

export function validateCanvasTimelineApply(options: {
  nodeId: string;
  nodes?: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
}): CanvasUpdateGuardrailResult {
  const downstream = canvasCheckpointDownstreamTargets(options.nodeId, options.edges, options.nodes);
  if (downstream.length === 0) return { ok: true };
  return {
    ok: false,
    error:
      `Refusing to apply timeline for ${options.nodeId}. Timeline has materialized downstream checkpoint node(s): ` +
      `${downstream.join(", ")}. ` +
      "Use the copy-on-write/versioned timeline workflow instead.",
  };
}

export function canvasDownstreamTargets(
  nodeId: string,
  edges: CanvasUpdateEdgeLike[],
): string[] {
  return edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target);
}

export function isCanvasNodeImmutable(options: {
  nodeId: string;
  edges: CanvasUpdateEdgeLike[];
}): boolean {
  return options.edges.some((edge) => edge.source === options.nodeId);
}

function isDraftPlaceholderNode(node: CanvasUpdateNodeWithIdLike | undefined): boolean {
  const status = node?.data?.status;
  return status === "draft" || status === "idle";
}

export function canvasCheckpointDownstreamTargets(
  nodeId: string,
  edges: CanvasUpdateEdgeLike[],
  nodes?: Iterable<CanvasUpdateNodeWithIdLike>,
): string[] {
  const downstream = canvasDownstreamTargets(nodeId, edges);
  if (!nodes) return downstream;

  const nodesById = new Map<string, CanvasUpdateNodeWithIdLike>();
  for (const node of nodes) nodesById.set(node.id, node);

  return downstream.filter((targetId) =>
    isMaterializedCheckpointTarget(targetId, edges, nodesById, new Set([nodeId])),
  );
}

export function isCanvasActionCheckpointLocked(options: {
  nodeId: string;
  nodes?: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
}): boolean {
  return canvasCheckpointDownstreamTargets(options.nodeId, options.edges, options.nodes).length > 0;
}

function isMaterializedCheckpointTarget(
  targetId: string,
  edges: CanvasUpdateEdgeLike[],
  nodesById: Map<string, CanvasUpdateNodeWithIdLike>,
  seen: Set<string>,
): boolean {
  const targetNode = nodesById.get(targetId);
  if (isDraftPlaceholderNode(targetNode)) return false;
  if (!isActionCheckpointNode(targetNode)) return true;
  return actionHasMaterializedDownstream(targetId, edges, nodesById, seen);
}

function actionHasMaterializedDownstream(
  nodeId: string,
  edges: CanvasUpdateEdgeLike[],
  nodesById: Map<string, CanvasUpdateNodeWithIdLike>,
  seen: Set<string>,
): boolean {
  if (seen.has(nodeId)) return false;
  seen.add(nodeId);

  for (const edge of edges) {
    if (edge.source !== nodeId) continue;
    if (isMaterializedCheckpointTarget(edge.target, edges, nodesById, seen)) {
      return true;
    }
  }

  return false;
}

function canvasMaterializedContentDownstreamTargets(
  nodeId: string,
  edges: CanvasUpdateEdgeLike[],
  nodes?: Iterable<CanvasUpdateNodeWithIdLike>,
): string[] {
  const downstream = canvasDownstreamTargets(nodeId, edges);
  if (!nodes) return downstream;

  const nodesById = new Map<string, CanvasUpdateNodeWithIdLike>();
  for (const node of nodes) nodesById.set(node.id, node);

  return downstream.filter((targetId) => {
    const targetNode = nodesById.get(targetId);
    if (isDraftPlaceholderNode(targetNode)) return false;
    if (isActionCheckpointNode(targetNode)) {
      return canvasCheckpointDownstreamTargets(targetId, edges, nodesById.values()).length > 0;
    }
    return true;
  });
}

export function validateCanvasDelete(options: {
  nodeId: string;
  edges: CanvasUpdateEdgeLike[];
}): CanvasUpdateGuardrailResult {
  const downstream = canvasDownstreamTargets(options.nodeId, options.edges);
  if (downstream.length === 0) return { ok: true };
  return {
    ok: false,
    error:
      `Refusing to delete referenced node ${options.nodeId}. It has downstream node(s): ` +
      `${downstream.join(", ")}. Remove or rewire those references first.`,
  };
}

export function validateCanvasBatchDelete(options: {
  nodeIds: Iterable<string>;
  edges: CanvasUpdateEdgeLike[];
}): CanvasUpdateGuardrailResult {
  const deletedIds = new Set(
    [...options.nodeIds]
      .filter((nodeId) => typeof nodeId === "string")
      .map((nodeId) => nodeId.trim())
      .filter(Boolean),
  );
  if (deletedIds.size === 0) return { ok: true };

  const orphanedEdges = options.edges
    .filter((edge) => deletedIds.has(edge.source) && !deletedIds.has(edge.target))
    .map((edge) => `${edge.source} -> ${edge.target}`);

  if (orphanedEdges.length === 0) return { ok: true };
  return {
    ok: false,
    error:
      "Refusing to delete referenced node(s). Batch would orphan downstream reference(s): " +
      `${orphanedEdges.join(", ")}. Delete a closed subgraph or rewire those references first.`,
  };
}

export function validateCanvasEdgeDelete(options: {
  edge: CanvasUpdateEdgeLike;
  nodes: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
}): CanvasUpdateGuardrailResult {
  const nodesById = new Map<string, CanvasUpdateNodeWithIdLike>();
  for (const node of options.nodes) nodesById.set(node.id, node);

  const sourceNode = nodesById.get(options.edge.source);
  const targetNode = nodesById.get(options.edge.target);
  const sourceDownstream = canvasCheckpointDownstreamTargets(options.edge.source, options.edges, options.nodes);
  const targetDownstream = canvasCheckpointDownstreamTargets(options.edge.target, options.edges, options.nodes);

  if (isActionCheckpointNode(sourceNode) && sourceDownstream.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to delete checkpoint lineage edge ${options.edge.source} -> ${options.edge.target}. ` +
        `Action checkpoint ${options.edge.source} has downstream node(s): ${sourceDownstream.join(", ")}. ` +
        "Use copy-on-write/replace workflow instead.",
    };
  }

  if (isActionCheckpointNode(targetNode) && targetDownstream.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to delete checkpoint lineage edge ${options.edge.source} -> ${options.edge.target}. ` +
        `Action checkpoint ${options.edge.target} has downstream node(s): ${targetDownstream.join(", ")}. ` +
        "Use copy-on-write/replace workflow instead.",
    };
  }

  return { ok: true };
}

export function validateCanvasEdgeAdd(options: {
  edge: CanvasUpdateEdgeLike;
  nodes: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
}): CanvasUpdateGuardrailResult {
  const nodesById = new Map<string, CanvasUpdateNodeWithIdLike>();
  for (const node of options.nodes) nodesById.set(node.id, node);

  const targetNode = nodesById.get(options.edge.target);
  const targetDownstream = canvasCheckpointDownstreamTargets(options.edge.target, options.edges, options.nodes);

  if (isActionCheckpointNode(targetNode) && targetDownstream.length > 0) {
    return {
      ok: false,
      error:
        `Refusing to add checkpoint input edge ${options.edge.source} -> ${options.edge.target}. ` +
        `Action checkpoint ${options.edge.target} has downstream node(s): ${targetDownstream.join(", ")}. ` +
        "Use copy-on-write/replace workflow instead.",
    };
  }

  return { ok: true };
}

export function validateCanvasEdgePatch(options: {
  existingEdge?: CanvasUpdateEdgeLike | null;
  patch: Partial<CanvasUpdateEdgeLike> & Record<string, unknown>;
  nodes: Iterable<CanvasUpdateNodeWithIdLike>;
  edges: CanvasUpdateEdgeLike[];
}): CanvasUpdateGuardrailResult {
  const existingEdge = options.existingEdge ?? null;
  const nextSource = typeof options.patch.source === "string"
    ? options.patch.source
    : existingEdge?.source;
  const nextTarget = typeof options.patch.target === "string"
    ? options.patch.target
    : existingEdge?.target;

  if (!nextSource || !nextTarget) return { ok: true };

  const nextEdge = { source: nextSource, target: nextTarget };
  if (!existingEdge) {
    return validateCanvasEdgeAdd({
      edge: nextEdge,
      nodes: options.nodes,
      edges: options.edges,
    });
  }

  const rewritesEndpoint =
    nextEdge.source !== existingEdge.source ||
    nextEdge.target !== existingEdge.target;
  if (!rewritesEndpoint) return { ok: true };

  const deleteGuard = validateCanvasEdgeDelete({
    edge: existingEdge,
    nodes: options.nodes,
    edges: options.edges,
  });
  if (!deleteGuard.ok) return deleteGuard;

  return validateCanvasEdgeAdd({
    edge: nextEdge,
    nodes: options.nodes,
    edges: options.edges,
  });
}
