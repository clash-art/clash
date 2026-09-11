import type { DraftActionAssetInput } from "./action-asset-bindings.js";
import type { CanvasNode } from "./canvas.js";
import { DirectorReferencePacketSchema } from "./director-reference.js";
import {
  MEDIA_REFERENCE_FIELDS,
  type MediaReferenceModality,
} from "./model-capabilities.js";
import { extractAssetRefs, parsePromptParts } from "./prompt.js";

export type CanvasActionAssetInputNode = Pick<
  CanvasNode,
  "id" | "type" | "data"
>;

export interface CanvasActionAssetInputEdge {
  source: string;
  target: string;
}

type MediaModality = MediaReferenceModality;

interface AssetInputCandidate {
  modality: MediaModality;
  projectAssetId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const normalized = nonEmptyString(candidate);
    return normalized ? [normalized] : [];
  });
}

function mediaModality(
  node: CanvasActionAssetInputNode,
): MediaModality | undefined {
  const mediaTypes = MEDIA_REFERENCE_FIELDS.map((field) => field.modality);
  if (mediaTypes.includes(node.type as MediaModality)) {
    return node.type as MediaModality;
  }
  const outputType = nonEmptyString(node.data.outputType);
  return outputType && mediaTypes.includes(outputType as MediaModality)
    ? (outputType as MediaModality)
    : undefined;
}

export function isCanvasManagedAssetAction(
  node: CanvasActionAssetInputNode,
): boolean {
  // Native Generators, Timeline and Director own their inputs in Project
  // state. Canvas is only their visual projection.
  if (
    nonEmptyString(node.data.generatorId) ||
    isRecord(node.data.generatorRevision) ||
    nonEmptyString(node.data.timelineId) ||
    nonEmptyString(node.data.stageId)
  ) {
    return false;
  }
  return Boolean(
    nonEmptyString(node.data.actionType) ||
    nonEmptyString(node.data.modelId) ||
    nonEmptyString(node.data.model) ||
    nonEmptyString(node.data.customActionId) ||
    isRecord(node.data.pluginBinding) ||
    /(?:^|[-_])(action|gen)(?:$|[-_])/.test(node.type),
  );
}

/**
 * Compiles one editable Canvas Action's projected inputs into the authoritative
 * Action input slots. Callers persist these bindings in the same Loro mutation
 * as the node/edge edit; URLs and storage keys never participate.
 */
export function canvasActionAssetInputs(input: {
  node: CanvasActionAssetInputNode;
  nodes: readonly CanvasActionAssetInputNode[];
  edges: readonly CanvasActionAssetInputEdge[];
}): DraftActionAssetInput[] | null {
  if (!isCanvasManagedAssetAction(input.node)) return null;

  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const inputs: DraftActionAssetInput[] = [];
  const mergedMultiplicity = new Map<string, number>();
  const nextIndex: Record<MediaModality, number> = Object.fromEntries(
    MEDIA_REFERENCE_FIELDS.map((field) => [field.modality, 0]),
  ) as Record<MediaModality, number>;
  const mergeProjectedSource = (
    candidates: readonly AssetInputCandidate[],
  ): void => {
    const sourceMultiplicity = new Map<string, number>();
    for (const candidate of candidates) {
      const projectAssetId = candidate.projectAssetId.trim();
      if (!projectAssetId) continue;
      const key = `${candidate.modality}\0${projectAssetId}`;
      const occurrence = (sourceMultiplicity.get(key) ?? 0) + 1;
      sourceMultiplicity.set(key, occurrence);
      if (occurrence <= (mergedMultiplicity.get(key) ?? 0)) continue;
      mergedMultiplicity.set(key, occurrence);
      const index = nextIndex[candidate.modality]++;
      inputs.push({
        slot: `${candidate.modality}:${index}`,
        projectAssetId,
        role: "reference",
      });
    }
  };

  mergeProjectedSource(
    MEDIA_REFERENCE_FIELDS.flatMap(({ pendingField, modality }) =>
      stringList(input.node.data[pendingField]).map((projectAssetId) => ({
        modality,
        projectAssetId,
      })),
    ),
  );

  const incomingSourceIds = input.edges
    .filter((edge) => edge.target === input.node.id)
    .map((edge) => edge.source);
  const orderHint = stringList(input.node.data.referenceImageOrder);
  const incomingSet = new Set(incomingSourceIds);
  const orderedSourceIds = orderHint.filter((id) => incomingSet.has(id));
  const orderedSet = new Set(orderedSourceIds);
  orderedSourceIds.push(
    ...incomingSourceIds.filter((id) => !orderedSet.has(id)),
  );
  mergeProjectedSource(
    orderedSourceIds.flatMap((sourceId) => {
      const source = nodesById.get(sourceId);
      if (!source) return [];
      const modality = mediaModality(source);
      const projectAssetId = nonEmptyString(source.data.assetId);
      return modality && projectAssetId ? [{ modality, projectAssetId }] : [];
    }),
  );

  const prompt =
    nonEmptyString(input.node.data.prompt) ??
    nonEmptyString(input.node.data.content);
  if (prompt) {
    mergeProjectedSource(
      extractAssetRefs(parsePromptParts(prompt)).flatMap((reference) => {
        const source = nodesById.get(reference.nodeId);
        if (!source) return [];
        const modality = mediaModality(source);
        const projectAssetId = nonEmptyString(source.data.assetId);
        return modality && projectAssetId ? [{ modality, projectAssetId }] : [];
      }),
    );
  }

  for (const packetOwner of [
    ...orderedSourceIds.flatMap((sourceId) => {
      const source = nodesById.get(sourceId);
      return source ? [source] : [];
    }),
    // Legacy projects copied the packet onto the consumer Action. Keep that
    // projection readable while new writes retain it on the immutable output.
    input.node,
  ]) {
    const packets = [
      packetOwner.data.directorReferencePacket,
      ...(Array.isArray(packetOwner.data.directorShotReferencePackets)
        ? packetOwner.data.directorShotReferencePackets
        : []),
    ].flatMap((candidate) => {
      const parsed = DirectorReferencePacketSchema.safeParse(candidate);
      return parsed.success ? [parsed.data] : [];
    });
    mergeProjectedSource(
      packets.flatMap((packet) => [
        {
          modality: "video" as const,
          projectAssetId: packet.referenceVideo.assetId,
        },
        ...packet.referenceStills.map((still) => ({
          modality: "image" as const,
          projectAssetId: still.assetId,
        })),
      ]),
    );
  }

  return inputs;
}
