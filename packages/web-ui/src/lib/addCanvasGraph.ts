import type { LoroDoc } from "loro-crdt";
import { Canvas, commitProjectMutation } from "@clash/shared-types";

type GraphNode = { id: string; [key: string]: unknown };
type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

/** Publish copied nodes and their inputs as one complete graph update. */
export function addCanvasGraph(
  doc: LoroDoc,
  canvasId: string,
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): void {
  commitProjectMutation(doc, (draft) => {
    if (!draft.getMap("canvases").get(canvasId)) {
      throw new Error(`Canvas ${canvasId} not found`);
    }
    const canvas = new Canvas(draft, () => {}, canvasId);
    const ids = new Set<string>();
    for (const node of nodes) {
      if (
        ids.has(node.id) ||
        draft.getMap("nodes").get(node.id) !== undefined
      ) {
        throw new Error(`Node already exists: ${node.id}`);
      }
      ids.add(node.id);
      canvas.insertNodeRecord(node.id, { ...node, upstream: [] });
    }
    const edgeIds = new Set(canvas.listEdges().map((edge) => edge.id));
    for (const edge of edges) {
      if (edgeIds.has(edge.id))
        throw new Error(`Edge already exists: ${edge.id}`);
      if (!ids.has(edge.source) || !ids.has(edge.target)) {
        throw new Error("Copied graph edges must connect copied nodes");
      }
      edgeIds.add(edge.id);
      canvas.insertEdge(
        edge.id,
        edge.source,
        edge.target,
        edge.type,
        edge.sourceHandle ?? undefined,
        edge.targetHandle ?? undefined,
      );
    }
    return { ok: true };
  });
}
