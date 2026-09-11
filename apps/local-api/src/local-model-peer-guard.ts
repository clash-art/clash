import type { LoroDoc } from "loro-crdt";
import { isDeepStrictEqual } from "node:util";
import {
  Canvas,
  canvasModelPlacementData,
  isCanvasNodeImmutable,
  canvasAssetRevision,
  assetRevisionKey,
  referenceModality,
  validateCanvasBatchDelete,
} from "@clash/shared-types";

type Node = {
  type?: string;
  canvasId?: string;
  data?: Record<string, unknown>;
};
function native(node: Node | undefined): boolean {
  return node?.type === "action-badge" && node.data?.generatorId !== undefined;
}
function authoringShadows(data: Record<string, unknown>) {
  const placement = canvasModelPlacementData(data);
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !(key in placement)),
  );
}
function assetInputs(doc: LoroDoc, nodeId: string, node: Node): string[] {
  const canvas = new Canvas(doc, () => {}, node.canvasId ?? "main");
  const inputs = new Set<string>();
  for (const edge of canvas.listEdges()) {
    if (edge.target !== nodeId || edge.type === "copy-on-write") continue;
    const source = canvas.readNode(edge.source);
    const kind = source && referenceModality(source);
    if (
      !kind ||
      (kind === "text" && source?.data.documentRevision === undefined)
    )
      continue;
    inputs.add(
      assetRevisionKey(canvasAssetRevision(source)) ?? `missing:${edge.source}`,
    );
  }
  return [...inputs].sort();
}

/** Native Model authoring belongs to Host commands; peers may project presentation. */
export function assertLocalPeerModelProjectionMutation(
  current: LoroDoc,
  candidate: LoroDoc,
): void {
  const before = current.getMap("nodes");
  const after = candidate.getMap("nodes");
  const deletedIds = [...before.keys()].filter(
    (id) => after.get(id) === undefined,
  );
  for (const nodeId of new Set([...before.keys(), ...after.keys()])) {
    const oldNode = before.get(nodeId) as Node | undefined;
    const newNode = after.get(nodeId) as Node | undefined;
    if (!native(oldNode) && !native(newNode)) continue;
    if (!newNode && oldNode) {
      const canvas = new Canvas(current, () => {}, oldNode.canvasId ?? "main");
      if (
        !validateCanvasBatchDelete({
          nodeIds: deletedIds,
          edges: canvas.listEdges(),
        }).ok
      )
        throw new Error(
          "Immutable Model placements must be preserved by the Host.",
        );
      continue;
    }
    if (
      !native(oldNode) ||
      !native(newNode) ||
      oldNode!.data!.generatorId !== newNode!.data!.generatorId
    ) {
      throw new Error(
        "Create or rewire a Model Generator placement through the Host.",
      );
    }
    if (
      !isDeepStrictEqual(oldNode, newNode) &&
      isCanvasNodeImmutable({
        nodeId,
        edges: new Canvas(
          current,
          () => {},
          oldNode!.canvasId ?? "main",
        ).listEdges(),
      })
    ) {
      throw new Error(
        "IMMUTABLE_NODE: Copy the referenced Model placement through the Host before editing it.",
      );
    }
    if (
      !isDeepStrictEqual(
        authoringShadows(oldNode!.data!),
        authoringShadows(newNode!.data!),
      )
    ) {
      throw new Error(
        "Edit Model authoring state through the Host Generator revision API.",
      );
    }
    if (
      !isDeepStrictEqual(
        assetInputs(current, nodeId, oldNode!),
        assetInputs(candidate, nodeId, newNode!),
      )
    ) {
      throw new Error(
        "Edit Model Asset inputs and Canvas connections together through the Host.",
      );
    }
  }
}
