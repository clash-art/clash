import { LoroMap, type LoroDoc } from "loro-crdt";
import type { UpstreamRef } from "./canvas.js";
import { isCanvasAssetReferenceEdge, listCanvasAssetReferenceEdges } from "./canvas-asset-references.js";

export const NODE_UPSTREAMS_CONTAINER = "nodeUpstreams";
export const EDGE_IDENTITY_CONTAINER = "edgeIdentity";
const GRAPH_SCHEMA_CONTAINER = "graphSchema";
const EDGE_IDENTITY_VERSION_KEY = "edgeIdentityVersion";
const EDGE_IDENTITY_VERSION = 1;

export interface NodeOwnedEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  sourceHandle?: string;
  targetHandle?: string;
}

type EdgeIdentity =
  | { target: string; deleted?: false }
  | { deleted: true };

export interface CanvasGraphReconciliation {
  initializedIdentity: boolean;
  migratedLegacyEdgeIds: string[];
  removedOrphanEdgeIds: string[];
  removedDuplicateRefs: number;
}

export function canvasGraphReconciliationChanged(
  result: CanvasGraphReconciliation,
): boolean {
  return result.initializedIdentity ||
    result.migratedLegacyEdgeIds.length > 0 ||
    result.removedOrphanEdgeIds.length > 0 ||
    result.removedDuplicateRefs > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLoroMap(value: unknown): value is LoroMap {
  return value instanceof LoroMap || Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { entries?: unknown }).entries === "function" &&
    typeof (value as { set?: unknown }).set === "function" &&
    typeof (value as { delete?: unknown }).delete === "function",
  );
}

function normalizeUpstreamRef(edgeId: string, value: unknown): UpstreamRef | null {
  if (!isRecord(value) || typeof value.nodeId !== "string" || !value.nodeId.trim()) {
    return null;
  }
  return {
    nodeId: value.nodeId,
    edgeId,
    type: typeof value.type === "string" && value.type.trim() ? value.type : "default",
    ...(typeof value.sourceHandle === "string" ? { sourceHandle: value.sourceHandle } : {}),
    ...(typeof value.targetHandle === "string" ? { targetHandle: value.targetHandle } : {}),
  };
}

function normalizeLegacyGlobalEdge(edgeId: string, value: unknown): NodeOwnedEdge | null {
  if (
    !isRecord(value) ||
    typeof value.source !== "string" ||
    !value.source.trim() ||
    typeof value.target !== "string" ||
    !value.target.trim()
  ) {
    return null;
  }
  return {
    id: edgeId,
    source: value.source,
    target: value.target,
    type: typeof value.type === "string" && value.type.trim() ? value.type : "default",
    ...(typeof value.sourceHandle === "string" ? { sourceHandle: value.sourceHandle } : {}),
    ...(typeof value.targetHandle === "string" ? { targetHandle: value.targetHandle } : {}),
  };
}

function legacyUpstreamRefs(rawNode: unknown): UpstreamRef[] {
  if (!isRecord(rawNode) || !Array.isArray(rawNode.upstream)) return [];
  return rawNode.upstream.flatMap((value) => {
    if (!isRecord(value) || typeof value.edgeId !== "string") return [];
    const normalized = normalizeUpstreamRef(value.edgeId, value);
    return normalized ? [normalized] : [];
  });
}

function existingUpstreamMap(doc: LoroDoc, nodeId: string): LoroMap | null {
  const value = doc.getMap(NODE_UPSTREAMS_CONTAINER).get(nodeId);
  return isLoroMap(value) ? value : null;
}

function rawNodeUpstreamRefs(doc: LoroDoc, nodeId: string, rawNode?: unknown): UpstreamRef[] {
  const refs = existingUpstreamMap(doc, nodeId);
  if (!refs) return legacyUpstreamRefs(rawNode);
  const result: UpstreamRef[] = [];
  for (const [edgeId, value] of refs.entries()) {
    const normalized = normalizeUpstreamRef(edgeId, value);
    if (normalized) result.push(normalized);
  }
  return result.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function ensureUpstreamMap(
  doc: LoroDoc,
  nodeId: string,
  rawNode?: unknown,
): LoroMap {
  const root = doc.getMap(NODE_UPSTREAMS_CONTAINER);
  const existing = root.get(nodeId);
  if (existing !== undefined && !isLoroMap(existing)) {
    throw new Error(`Invalid upstream container for node ${nodeId}`);
  }
  const refs = existingUpstreamMap(doc, nodeId) ?? root.ensureMergeableMap(nodeId);
  for (const legacy of legacyUpstreamRefs(rawNode)) {
    if (refs.get(legacy.edgeId) === undefined) refs.set(legacy.edgeId, legacy);
  }
  return refs;
}

function graphIdentityEnabled(doc: LoroDoc): boolean {
  return doc.getMap(GRAPH_SCHEMA_CONTAINER).get(EDGE_IDENTITY_VERSION_KEY) === EDGE_IDENTITY_VERSION;
}

function hasStoredGraphRelationships(doc: LoroDoc): boolean {
  if (doc.getMap("edges").size > 0 || doc.getMap(EDGE_IDENTITY_CONTAINER).size > 0) {
    return true;
  }
  if (doc.getMap(NODE_UPSTREAMS_CONTAINER).size > 0) return true;
  for (const rawNode of doc.getMap("nodes").values()) {
    if (legacyUpstreamRefs(rawNode).length > 0) return true;
  }
  return false;
}

function parseEdgeIdentity(value: unknown): EdgeIdentity | null {
  if (!isRecord(value)) return null;
  if (value.deleted === true) return { deleted: true };
  return typeof value.target === "string" && value.target.trim()
    ? { target: value.target }
    : null;
}

function nodeCanvasId(rawNode: unknown): string {
  return isRecord(rawNode) && typeof rawNode.canvasId === "string"
    ? rawNode.canvasId
    : "main";
}

function legacyEdges(doc: LoroDoc): NodeOwnedEdge[] {
  const byId = new Map<string, NodeOwnedEdge>();
  for (const [edgeId, rawEdge] of doc.getMap("edges").entries()) {
    const edge = normalizeLegacyGlobalEdge(edgeId, rawEdge);
    if (edge) byId.set(edgeId, edge);
  }
  for (const [target, rawNode] of doc.getMap("nodes").entries()) {
    for (const ref of rawNodeUpstreamRefs(doc, target, rawNode)) {
      if (byId.has(ref.edgeId)) continue;
      byId.set(ref.edgeId, {
        id: ref.edgeId,
        source: ref.nodeId,
        target,
        type: ref.type,
        ...(ref.sourceHandle ? { sourceHandle: ref.sourceHandle } : {}),
        ...(ref.targetHandle ? { targetHandle: ref.targetHandle } : {}),
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function removeRawRef(doc: LoroDoc, nodeId: string, edgeId: string, rawNode?: unknown): boolean {
  const refs = rawNodeUpstreamRefs(doc, nodeId, rawNode);
  if (!refs.some((ref) => ref.edgeId === edgeId)) return false;
  ensureUpstreamMap(doc, nodeId, rawNode).delete(edgeId);
  return true;
}

function removeAllRefsForEdge(doc: LoroDoc, edgeId: string): number {
  let removed = 0;
  for (const [nodeId, rawNode] of doc.getMap("nodes").entries()) {
    if (removeRawRef(doc, nodeId, edgeId, rawNode)) removed += 1;
  }
  return removed;
}

function writeEdgeRef(doc: LoroDoc, edge: NodeOwnedEdge): void {
  const rawTarget = doc.getMap("nodes").get(edge.target);
  ensureUpstreamMap(doc, edge.target, rawTarget).set(edge.id, {
    nodeId: edge.source,
    edgeId: edge.id,
    type: edge.type,
    ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
  });
}

/** Promote both deployed top-level edges and early node-owned refs once. */
export function ensureCanvasGraphIdentity(doc: LoroDoc): string[] {
  if (graphIdentityEnabled(doc)) return [];
  const migrated = legacyEdges(doc);
  const identities = doc.getMap(EDGE_IDENTITY_CONTAINER);
  for (const edge of migrated) {
    removeAllRefsForEdge(doc, edge.id);
    writeEdgeRef(doc, edge);
    identities.set(edge.id, { target: edge.target });
  }
  for (const [edgeId] of [...doc.getMap("edges").entries()]) {
    doc.getMap("edges").delete(edgeId);
  }
  doc.getMap(GRAPH_SCHEMA_CONTAINER).set(EDGE_IDENTITY_VERSION_KEY, EDGE_IDENTITY_VERSION);
  return migrated.map((edge) => edge.id);
}

/**
 * Read the downstream-owned relationship set. The edge identity register makes
 * one edge ID resolve to one downstream map even after concurrent retargets.
 */
export function readNodeUpstreamRefs(
  doc: LoroDoc,
  nodeId: string,
  rawNode?: unknown,
): UpstreamRef[] {
  const refs = rawNodeUpstreamRefs(doc, nodeId, rawNode);
  const identities = doc.getMap(EDGE_IDENTITY_CONTAINER);
  const stored = !graphIdentityEnabled(doc) ? refs : refs.filter((ref) => {
    const identity = parseEdgeIdentity(identities.get(ref.edgeId));
    return identity !== null && "target" in identity && identity.target === nodeId;
  });
  const sources = new Set(stored.map((ref) => ref.nodeId));
  return [...stored, ...listCanvasAssetReferenceEdges(doc, { nodeId })
    .filter((edge) => !sources.has(edge.source))
    .map((edge) => ({ nodeId: edge.source, edgeId: edge.id, type: edge.type }))]
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

export function listNodeOwnedEdges(
  doc: LoroDoc,
  canvasId?: string,
): NodeOwnedEdge[] {
  const nodes = doc.getMap("nodes");
  const candidates = graphIdentityEnabled(doc)
    ? [...doc.getMap(EDGE_IDENTITY_CONTAINER).entries()].flatMap(([edgeId, rawIdentity]) => {
        const identity = parseEdgeIdentity(rawIdentity);
        if (!identity || !("target" in identity)) return [];
        const rawTarget = nodes.get(identity.target);
        const ref = rawNodeUpstreamRefs(doc, identity.target, rawTarget)
          .find((candidate) => candidate.edgeId === edgeId);
        if (!ref) return [];
        return [{
          id: edgeId,
          source: ref.nodeId,
          target: identity.target,
          type: ref.type,
          ...(ref.sourceHandle ? { sourceHandle: ref.sourceHandle } : {}),
          ...(ref.targetHandle ? { targetHandle: ref.targetHandle } : {}),
        } satisfies NodeOwnedEdge];
      })
    : legacyEdges(doc);

  const stored = candidates.filter((edge) => {
    const rawSource = nodes.get(edge.source);
    const rawTarget = nodes.get(edge.target);
    if (!rawSource || !rawTarget) return false;
    const sourceCanvasId = nodeCanvasId(rawSource);
    const targetCanvasId = nodeCanvasId(rawTarget);
    if (sourceCanvasId !== targetCanvasId) return false;
    return !canvasId || targetCanvasId === canvasId;
  });
  const pairs = new Set(stored.map((edge) => JSON.stringify([edge.source, edge.target])));
  return [...stored, ...listCanvasAssetReferenceEdges(doc, { canvasId })
    .filter((edge) => !pairs.has(JSON.stringify([edge.source, edge.target])))
  ].sort((left, right) => left.id.localeCompare(right.id));
}

export function upsertNodeUpstreamRef(
  doc: LoroDoc,
  nodeId: string,
  ref: UpstreamRef,
  rawNode?: unknown,
): void {
  if (isCanvasAssetReferenceEdge(ref.edgeId)) {
    throw new Error("Timeline and View Asset connections follow their material references. Edit the reference in the Timeline or View instead.");
  }
  ensureCanvasGraphIdentity(doc);
  removeAllRefsForEdge(doc, ref.edgeId);
  ensureUpstreamMap(doc, nodeId, rawNode).set(ref.edgeId, ref);
  doc.getMap(EDGE_IDENTITY_CONTAINER).set(ref.edgeId, { target: nodeId });
}

export function deleteNodeUpstreamRef(
  doc: LoroDoc,
  nodeId: string,
  edgeId: string,
  rawNode?: unknown,
): boolean {
  // Deleting a placement/View removes its projection without graph tombstones.
  if (isCanvasAssetReferenceEdge(edgeId)) return false;
  ensureCanvasGraphIdentity(doc);
  const identity = parseEdgeIdentity(doc.getMap(EDGE_IDENTITY_CONTAINER).get(edgeId));
  const existed = Boolean(identity && "target" in identity) ||
    rawNodeUpstreamRefs(doc, nodeId, rawNode).some((ref) => ref.edgeId === edgeId);
  removeAllRefsForEdge(doc, edgeId);
  doc.getMap(EDGE_IDENTITY_CONTAINER).set(edgeId, { deleted: true });
  return existed;
}

export function clearNodeUpstreamRefs(
  doc: LoroDoc,
  nodeId: string,
  rawNode?: unknown,
): string[] {
  ensureCanvasGraphIdentity(doc);
  const edgeIds = rawNodeUpstreamRefs(doc, nodeId, rawNode).map((ref) => ref.edgeId);
  for (const edgeId of edgeIds) {
    const identity = parseEdgeIdentity(doc.getMap(EDGE_IDENTITY_CONTAINER).get(edgeId));
    if (identity && "target" in identity && identity.target === nodeId) {
      deleteNodeUpstreamRef(doc, nodeId, edgeId, rawNode);
    } else {
      removeRawRef(doc, nodeId, edgeId, rawNode);
    }
  }
  return [...new Set(edgeIds)].sort();
}

export function reconcileCanvasGraph(doc: LoroDoc): CanvasGraphReconciliation {
  if (!graphIdentityEnabled(doc) && !hasStoredGraphRelationships(doc)) {
    return {
      initializedIdentity: false,
      migratedLegacyEdgeIds: [],
      removedOrphanEdgeIds: [],
      removedDuplicateRefs: 0,
    };
  }
  const initializedIdentity = !graphIdentityEnabled(doc);
  const migratedLegacyEdgeIds = ensureCanvasGraphIdentity(doc);
  const nodes = doc.getMap("nodes");
  const identities = doc.getMap(EDGE_IDENTITY_CONTAINER);
  const removedOrphanEdgeIds: string[] = [];
  let removedDuplicateRefs = 0;

  for (const [edgeId, rawIdentity] of [...identities.entries()]) {
    const identity = parseEdgeIdentity(rawIdentity);
    if (!identity || !("target" in identity)) {
      removedDuplicateRefs += removeAllRefsForEdge(doc, edgeId);
      continue;
    }
    const rawTarget = nodes.get(identity.target);
    const ref = rawNodeUpstreamRefs(doc, identity.target, rawTarget)
      .find((candidate) => candidate.edgeId === edgeId);
    const rawSource = ref ? nodes.get(ref.nodeId) : undefined;
    const valid = Boolean(
      rawTarget &&
      ref &&
      rawSource &&
      nodeCanvasId(rawSource) === nodeCanvasId(rawTarget),
    );
    if (!valid) {
      removedDuplicateRefs += removeAllRefsForEdge(doc, edgeId);
      identities.set(edgeId, { deleted: true });
      removedOrphanEdgeIds.push(edgeId);
      continue;
    }
    for (const [nodeId, rawNode] of nodes.entries()) {
      if (nodeId === identity.target) continue;
      if (removeRawRef(doc, nodeId, edgeId, rawNode)) removedDuplicateRefs += 1;
    }
  }

  for (const [edgeId] of [...doc.getMap("edges").entries()]) {
    doc.getMap("edges").delete(edgeId);
  }
  return {
    initializedIdentity,
    migratedLegacyEdgeIds,
    removedOrphanEdgeIds: removedOrphanEdgeIds.sort(),
    removedDuplicateRefs,
  };
}
