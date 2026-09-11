import type { LoroDoc } from "loro-crdt";
import {
  Canvas,
  readProjectGenerator,
  canvasAssetRevision,
  assetRevisionKey,
  type GeneratorRevision,
} from "@clash/shared-types";

/** Host-only projection of a validated fork; caller owns the atomic mutation. */
export function projectLocalModelCopy(
  doc: LoroDoc,
  canvasId: string,
  sourceNodeId: string,
  targetNodeId: string,
  revision: GeneratorRevision,
): void {
  const canvas = new Canvas(doc, () => {}, canvasId);
  const source = canvas.readNode(sourceNodeId);
  const fork = revision.forkedFrom;
  if (
    !fork ||
    source?.type !== "action-badge" ||
    source.data.generatorId !== fork.generatorId ||
    readProjectGenerator(doc, fork.generatorId)?.headRevisionId !==
      fork.generatorRevisionId
  ) {
    throw new Error(
      "The source Generator placement changed. Read the project again before copying.",
    );
  }
  const assets = new Set(
    revision.persistentInputRefs
      .map((ref) => assetRevisionKey(ref.target))
      .filter((key) => key !== null),
  );
  const inputs = canvas
    .listEdges()
    .filter(
      (edge) => edge.target === sourceNodeId && edge.type !== "copy-on-write",
    );
  for (const edge of inputs) {
    const upstream = canvas.readNode(edge.source);
    const key = assetRevisionKey(canvasAssetRevision(upstream));
    if (!key || !assets.has(key)) continue;
    canvas.insertEdge(
      crypto.randomUUID(),
      edge.source,
      targetNodeId,
      edge.type,
      edge.sourceHandle ?? undefined,
      edge.targetHandle ?? undefined,
    );
  }
  if (
    !canvas
      .listEdges()
      .some(
        (edge) =>
          edge.source === sourceNodeId &&
          edge.target === targetNodeId &&
          edge.type === "copy-on-write",
      )
  ) {
    canvas.insertEdge(
      crypto.randomUUID(),
      sourceNodeId,
      targetNodeId,
      "copy-on-write",
    );
  }
}
