import type { Edge, Node } from "@xyflow/react";
import { ACTION_BADGE_NODE_SIZE } from "@clash/shared-layout";

const TRANSIENT_NODE_KEYS = new Set([
  "dragging",
  "internals",
  "measured",
  "positionAbsolute",
  "resizing",
  "selected",
]);
const INTERACTING_NODE_KEYS = new Set([
  ...TRANSIENT_NODE_KEYS,
  "height",
  "parentId",
  "position",
  "style",
  "width",
]);
const TRANSIENT_EDGE_KEYS = new Set(["selected"]);

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!valuesEqual(left[index], right[index])) return false;
    }
    return true;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightRecord, key)) return false;
    if (!valuesEqual(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

function recordsEqualExcept(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  ignoredKeys: ReadonlySet<string>,
): boolean {
  for (const key of Object.keys(left)) {
    if (ignoredKeys.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!valuesEqual(left[key], right[key])) return false;
  }
  for (const key of Object.keys(right)) {
    if (ignoredKeys.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(left, key)) return false;
  }
  return true;
}

type RuntimeNode = Node & {
  resizing?: boolean;
};

export function reconcileSyncedCanvasNodes<T extends Node>(
  currentNodes: readonly T[],
  syncedNodes: readonly Node[],
): T[] {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  let changed = currentNodes.length !== syncedNodes.length;

  const nextNodes = syncedNodes.map((storedNode, index) => {
    // Capsule bounds are renderer geometry, including for historical nodes.
    // Reading an immutable placement must not turn into a project mutation.
    const syncedNode = storedNode.type === "action-badge"
      ? { ...storedNode, ...ACTION_BADGE_NODE_SIZE, style: { ...storedNode.style, ...ACTION_BADGE_NODE_SIZE } }
      : storedNode;
    const currentNode = currentById.get(syncedNode.id) as
      (T & RuntimeNode) | undefined;
    if (!currentNode) {
      changed = true;
      return syncedNode as T;
    }

    const isInteracting = Boolean(currentNode.dragging || currentNode.resizing);
    const unchanged = recordsEqualExcept(
      currentNode as Record<string, unknown>,
      syncedNode as Record<string, unknown>,
      isInteracting ? INTERACTING_NODE_KEYS : TRANSIENT_NODE_KEYS,
    );
    if (unchanged) {
      if (currentNode !== currentNodes[index]) changed = true;
      return currentNode;
    }

    const nextNode = {
      ...syncedNode,
      data: valuesEqual(currentNode.data, syncedNode.data)
        ? currentNode.data
        : syncedNode.data,
      measured: currentNode.measured,
      position: isInteracting ? currentNode.position : syncedNode.position,
      parentId: isInteracting ? currentNode.parentId : syncedNode.parentId,
      width: isInteracting ? currentNode.width : syncedNode.width,
      height: isInteracting ? currentNode.height : syncedNode.height,
      style: isInteracting ? currentNode.style : syncedNode.style,
      selected: currentNode.selected,
      dragging: currentNode.dragging,
      resizing: currentNode.resizing,
    } as T & RuntimeNode;
    if (nextNode !== currentNodes[index]) changed = true;
    return nextNode as T;
  });

  return changed ? nextNodes : (currentNodes as T[]);
}

export function reconcileSyncedCanvasEdges<T extends Edge>(
  currentEdges: readonly T[],
  syncedEdges: readonly Edge[],
): T[] {
  const currentById = new Map(currentEdges.map((edge) => [edge.id, edge]));
  let changed = currentEdges.length !== syncedEdges.length;

  const nextEdges = syncedEdges.map((syncedEdge, index) => {
    const currentEdge = currentById.get(syncedEdge.id);
    if (!currentEdge) {
      changed = true;
      return syncedEdge as T;
    }

    const unchanged = recordsEqualExcept(
      currentEdge as Record<string, unknown>,
      syncedEdge as Record<string, unknown>,
      TRANSIENT_EDGE_KEYS,
    );
    if (unchanged) {
      if (currentEdge !== currentEdges[index]) changed = true;
      return currentEdge;
    }

    changed = true;
    return {
      ...syncedEdge,
      selected: currentEdge.selected,
    } as T;
  });

  return changed ? nextEdges : (currentEdges as T[]);
}
