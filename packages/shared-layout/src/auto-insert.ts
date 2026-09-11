/**
 * Auto-insert layout for new nodes.
 *
 * Strategy:
 *   - If node has a reference (source via edge): place to the right of it
 *   - If no reference: find the nearest cluster of nodes, place below it
 *   - Resolve overlaps by pushing down
 */

import type { LayoutNode, LayoutEdge } from './types';
import type { Point, Rect } from './types';
import { getNodeSize, rectOverlaps } from './core/geometry';

/** Special position value indicating a node needs auto-layout */
export const NEEDS_LAYOUT_POSITION: Point = { x: -1, y: -1 };

const GAP_X = 60;
const GAP_Y = 30;
const MAX_MEDIA_DIMENSION = 500;

function calculateScaledDimensions(naturalWidth: number, naturalHeight: number): { width: number; height: number } {
  if (!naturalWidth || !naturalHeight) return { width: 400, height: 400 };
  const scale = Math.min(1, MAX_MEDIA_DIMENSION / Math.max(naturalWidth, naturalHeight));
  return { width: Math.round(naturalWidth * scale), height: Math.round(naturalHeight * scale) };
}

export function needsAutoLayout(node: LayoutNode): boolean {
  if (!node.position) return true;
  return node.position.x === NEEDS_LAYOUT_POSITION.x && node.position.y === NEEDS_LAYOUT_POSITION.y;
}

// ─── Helpers ────────────────────────────────────────────

function normalizeDimension(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getNodeHeight(node: LayoutNode): number {
  const defaultSize = getNodeSize(node.type || 'default');
  return (
    normalizeDimension(node.height) ??
    (node.data?.naturalWidth && node.data?.naturalHeight
      ? calculateScaledDimensions(node.data.naturalWidth as number, node.data.naturalHeight as number).height
      : undefined) ??
    normalizeDimension(node.style?.height) ??
    defaultSize.height
  );
}

function getNodeWidth(node: LayoutNode): number {
  const defaultSize = getNodeSize(node.type || 'default');
  return (
    normalizeDimension(node.width) ??
    (node.data?.naturalWidth && node.data?.naturalHeight
      ? calculateScaledDimensions(node.data.naturalWidth as number, node.data.naturalHeight as number).width
      : undefined) ??
    normalizeDimension(node.style?.width) ??
    defaultSize.width
  );
}

export function findReferenceNode(
  nodeId: string,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): LayoutNode | null {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return null;
  const incomingEdge = edges.find(e => e.target === nodeId);
  if (!incomingEdge) return null;
  const sourceNode = nodes.find(n => n.id === incomingEdge.source);
  if (!sourceNode) return null;
  if (sourceNode.parentId !== node.parentId) return null;
  return sourceNode;
}

// ─── Position calculation ───────────────────────────────

/**
 * Calculate insert position:
 *   - Has reference → to the right of reference
 *   - No reference → below the nearest cluster of siblings
 */
export function calculateInsertPosition(
  node: LayoutNode,
  referenceNode: LayoutNode | null,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Point {
  if (referenceNode && referenceNode.position && referenceNode.position.x !== NEEDS_LAYOUT_POSITION.x) {
    // Place to the right of reference, below existing children
    const refWidth = getNodeWidth(referenceNode);
    const childX = referenceNode.position.x + refWidth + GAP_X;

    // Find existing children of this reference (nodes that reference points to via edges)
    const existingChildIds = new Set(
      edges.filter(e => e.source === referenceNode.id).map(e => e.target),
    );
    const existingChildren = nodes.filter(
      n => existingChildIds.has(n.id) && n.id !== node.id &&
           n.position && n.position.x !== NEEDS_LAYOUT_POSITION.x,
    );

    if (existingChildren.length === 0) {
      return { x: childX, y: referenceNode.position.y };
    }

    // Place below the lowest existing child
    let maxBottom = 0;
    for (const child of existingChildren) {
      const bottom = child.position.y + getNodeHeight(child);
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return { x: childX, y: maxBottom + GAP_Y };
  }

  // No reference — find nearest cluster bottom
  const siblings = nodes.filter(n => {
    if (n.id === node.id) return false;
    if (n.parentId !== node.parentId) return false;
    if (n.type === 'group') return false;
    if (!n.position || n.position.x === NEEDS_LAYOUT_POSITION.x) return false;
    return true;
  });

  if (siblings.length === 0) {
    return { x: GAP_X, y: GAP_Y };
  }

  // Find the bottom of existing nodes
  let maxBottom = 0;
  let leftmostX = Infinity;
  for (const s of siblings) {
    const bottom = s.position.y + getNodeHeight(s);
    if (bottom > maxBottom) maxBottom = bottom;
    leftmostX = Math.min(leftmostX, s.position.x);
  }

  return {
    x: Number.isFinite(leftmostX) ? leftmostX : GAP_X,
    y: maxBottom + GAP_Y,
  };
}

// ─── Overlap resolution (push down) ─────────────────────

export function getOverlappingSiblings(
  nodeId: string,
  nodeRect: Rect,
  parentId: string | undefined,
  nodes: LayoutNode[],
): LayoutNode[] {
  return nodes.filter(n => {
    if (n.id === nodeId) return false;
    if (n.parentId !== parentId) return false;
    if (n.type === 'group') return false;
    if (!n.position || n.position.x === NEEDS_LAYOUT_POSITION.x) return false;
    const siblingRect: Rect = {
      x: n.position.x, y: n.position.y,
      width: getNodeWidth(n), height: getNodeHeight(n),
    };
    return rectOverlaps(nodeRect, siblingRect);
  });
}

export function chainPushDown(
  triggerNodeId: string,
  nodes: LayoutNode[],
  maxIterations: number = 20,
): Map<string, Point> {
  const positionUpdates = new Map<string, Point>();
  const workingPositions = new Map<string, Point>();
  for (const node of nodes) {
    if (node.position) workingPositions.set(node.id, { ...node.position });
  }

  const toCheck = new Set<string>([triggerNodeId]);
  const checked = new Set<string>();
  let iterations = 0;

  while (toCheck.size > 0 && iterations < maxIterations) {
    iterations++;
    const next = toCheck.values().next();
    if (next.done) break;
    const nodeId = next.value;
    toCheck.delete(nodeId);
    if (checked.has(nodeId)) continue;
    checked.add(nodeId);

    const node = nodes.find(n => n.id === nodeId);
    if (!node) continue;

    const nodePos = workingPositions.get(nodeId)!;
    const nodeWidth = getNodeWidth(node);
    const nodeHeight = getNodeHeight(node);
    const nodeRect: Rect = { x: nodePos.x, y: nodePos.y, width: nodeWidth, height: nodeHeight };

    const siblings = nodes.filter(n => {
      if (n.id === nodeId || n.parentId !== node.parentId || n.type === 'group') return false;
      const pos = workingPositions.get(n.id);
      return pos && pos.x !== NEEDS_LAYOUT_POSITION.x;
    });

    for (const sibling of siblings) {
      const siblingPos = workingPositions.get(sibling.id)!;
      const siblingRect: Rect = {
        x: siblingPos.x, y: siblingPos.y,
        width: getNodeWidth(sibling), height: getNodeHeight(sibling),
      };
      if (!rectOverlaps(nodeRect, siblingRect)) continue;

      const pushDistance = nodeRect.y + nodeRect.height + GAP_Y - siblingPos.y;
      if (pushDistance > 0) {
        const newPos: Point = { x: siblingPos.x, y: siblingPos.y + pushDistance };
        workingPositions.set(sibling.id, newPos);
        positionUpdates.set(sibling.id, newPos);
        toCheck.add(sibling.id);
      }
    }
  }

  return positionUpdates;
}

// backward compat
export const chainPushRight = chainPushDown;

export function findBottomY(parentId: string | undefined, nodes: LayoutNode[]): number {
  const siblings = nodes.filter(
    n => n.parentId === parentId && n.position?.x !== NEEDS_LAYOUT_POSITION.x,
  );
  if (siblings.length === 0) return GAP_Y;
  let maxBottom = 0;
  for (const s of siblings) {
    if (!s.position) continue;
    maxBottom = Math.max(maxBottom, s.position.y + getNodeHeight(s));
  }
  return maxBottom + GAP_Y;
}

// ─── Main entry point ───────────────────────────────────

export interface AutoInsertResult {
  position: Point;
  pushedNodes: Map<string, Point>;
  hasReference: boolean;
  referenceNodeId?: string;
}

export function autoInsertNode(
  nodeId: string,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): AutoInsertResult {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) {
    return { position: { x: GAP_X, y: GAP_Y }, pushedNodes: new Map(), hasReference: false };
  }

  const referenceNode = findReferenceNode(nodeId, nodes, edges);
  let position = calculateInsertPosition(node, referenceNode, nodes, edges);

  const nodesWithPosition = nodes.map(n =>
    n.id === nodeId ? { ...n, position } : n,
  );
  const pushedNodes = chainPushDown(nodeId, nodesWithPosition);

  // A downstream reference freezes the whole source node, including geometry.
  // If the push chain reaches one, place the new node below its siblings instead.
  if (edges.some(edge => pushedNodes.has(edge.source))) {
    position = { ...position, y: findBottomY(node.parentId, nodes.filter(n => n.id !== nodeId)) };
    pushedNodes.clear();
  }

  return {
    position,
    pushedNodes,
    hasReference: !!referenceNode,
    referenceNodeId: referenceNode?.id,
  };
}

export function applyAutoInsertResult(
  nodes: LayoutNode[],
  nodeId: string,
  result: AutoInsertResult,
): LayoutNode[] {
  return nodes.map(node => {
    if (node.id === nodeId) return { ...node, position: result.position };
    const pushedPosition = result.pushedNodes.get(node.id);
    if (pushedPosition) return { ...node, position: pushedPosition };
    return node;
  });
}

export function processAutoLayoutNodes(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): { nodes: LayoutNode[]; processed: string[] } {
  const referencedIds = new Set(edges.map(edge => edge.source));
  const nodesToLayout = nodes.filter(node => needsAutoLayout(node) && !referencedIds.has(node.id));
  const processed: string[] = [];
  if (nodesToLayout.length === 0) return { nodes, processed };

  let updatedNodes = [...nodes];
  for (const node of nodesToLayout) {
    const result = autoInsertNode(node.id, updatedNodes, edges);
    updatedNodes = applyAutoInsertResult(updatedNodes, node.id, result);
    processed.push(node.id);
  }

  return { nodes: updatedNodes, processed };
}
