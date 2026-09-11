type ParentableNode = {
  id: string;
  parentId?: string;
  extent?: unknown;
};

interface SanitizeNodesForReactFlowOptions<T extends ParentableNode> {
  onInvalidParent?: (node: T, parentId: string) => void;
}

type NodeChangeKind = {
  type: string;
};

export function nodeChangesRequireStructuralSanitize(
  changes: readonly NodeChangeKind[],
): boolean {
  return changes.some(
    (change) => change.type !== "position" && change.type !== "select",
  );
}

export function nodeChangesRequireZIndexNormalization(
  changes: readonly NodeChangeKind[],
): boolean {
  return changes.some(
    (change) => change.type !== "position" && change.type !== "select",
  );
}

type ZIndexedNode = ParentableNode & {
  type?: string;
  style?: { zIndex?: unknown };
};

export function normalizeCanvasNodeZIndex<T extends ZIndexedNode>(
  nodes: readonly T[],
  childNodeBase = 1000,
): T[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const depthById = new Map<string, number>();

  const getDepth = (nodeId: string, visiting = new Set<string>()): number => {
    const cached = depthById.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return 0;

    const node = nodeById.get(nodeId);
    if (!node?.parentId || !nodeById.has(node.parentId)) {
      depthById.set(nodeId, 0);
      return 0;
    }

    visiting.add(nodeId);
    const depth = getDepth(node.parentId, visiting) + 1;
    visiting.delete(nodeId);
    depthById.set(nodeId, depth);
    return depth;
  };

  let changed = false;
  const next = nodes.map((node) => {
    const targetZIndex =
      node.type === "group"
        ? getDepth(node.id)
        : childNodeBase + getDepth(node.id);
    const raw = node.style?.zIndex;
    const currentZIndex =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : undefined;
    if (
      typeof currentZIndex === "number" &&
      Number.isFinite(currentZIndex) &&
      currentZIndex === targetZIndex
    ) {
      return node;
    }

    changed = true;
    return {
      ...node,
      style: {
        ...(node.style ?? {}),
        zIndex: targetZIndex,
      },
    } as T;
  });

  return changed ? next : (nodes as T[]);
}

function sameNodeOrder<T extends ParentableNode>(a: readonly T[], b: readonly T[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ReactFlow v12 requires parent nodes to appear before children.
export function sortNodesParentFirst<T extends ParentableNode>(nodes: readonly T[]): T[] {
  const nodeById = new Map<string, T>();
  for (const node of nodes) {
    nodeById.set(node.id, node);
  }

  const result: T[] = [];
  const visited = new Set<string>();

  const visit = (node: T) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    if (parent) visit(parent);

    result.push(node);
  };

  for (const node of nodes) {
    visit(node);
  }

  return sameNodeOrder(result, nodes) ? (nodes as T[]) : result;
}

export function sanitizeNodesForReactFlow<T extends ParentableNode>(
  nodes: readonly T[],
  options: SanitizeNodesForReactFlowOptions<T> = {},
): T[] {
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    nodeIds.add(node.id);
  }

  let cleanedNodes: T[] | null = null;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const parentId = node.parentId;
    if (!parentId || nodeIds.has(parentId)) continue;

    if (!cleanedNodes) {
      cleanedNodes = nodes.slice() as T[];
    }

    options.onInvalidParent?.(node, parentId);

    cleanedNodes[i] = {
      ...node,
      parentId: undefined,
      extent: undefined,
    };
  }

  return sortNodesParentFirst(cleanedNodes ?? nodes);
}
/** ReactFlow measurements have no resizing flag; gestures include start/end. */
export function isUserResizeChange(change: { type: string; resizing?: boolean }): boolean {
  return change.type === "dimensions" && typeof change.resizing === "boolean";
}
