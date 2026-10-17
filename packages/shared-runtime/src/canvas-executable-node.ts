/**
 * Canvas node → frozen executable run, shared by every adapter.
 *
 * The Local adapter (Node) and the Cloudflare adapter admit a pending Canvas
 * custom Action through exactly these functions, so the same node freezes the
 * same input, Action revision and durable identity in every realm. Moved
 * verbatim from local-api; this module has no platform imports and no
 * environment/mode checks.
 */
import {
  CustomActionDefinitionSchema,
  ExecutablePluginBindingSchema,
  extractPromptText,
  MEDIA_REFERENCE_FIELDS,
  parsePromptParts,
  type CustomActionDefinition,
  type ExecutablePluginBinding,
  type ExecutablePluginCardRegistration,
  type ExecutablePluginInvocation,
  type ExecutablePluginReference,
} from "@clash/shared-types";
import {
  canonicalRevisionJson,
  durableExecutorIdentity,
  executableRevisionId,
  type FrozenExecutableInput,
} from "./executable-run.js";
import { sha256Hex } from "./sha256-hex.js";

export type CanvasProcessableKind = "image" | "video" | "audio" | "model";
export type CanvasProcessableNodeKind = CanvasProcessableKind | "text";

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

export function nodeModelParams(
  data: Record<string, unknown>,
): Record<string, string | number | boolean | undefined> {
  const params = data.modelParams;
  if (!params || typeof params !== "object" || Array.isArray(params)) return {};
  const projectVisibleParams = {
    ...(params as Record<string, string | number | boolean | undefined>),
  };
  // Concrete provider/account routing is owner-private execution state. A legacy replica may still
  // contain this field, but it must never regain authority over a new run.
  delete projectVisibleParams.provider_id;
  return projectVisibleParams;
}

function stringParam(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key] ?? nodeModelParams(data)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function authoredPromptFromData(
  data: Record<string, unknown>,
  fallback: string,
): string {
  return typeof data.prompt === "string" && data.prompt.trim()
    ? data.prompt
    : typeof data.label === "string" && data.label.trim()
      ? data.label
      : fallback;
}

export function modelFromData(
  data: Record<string, unknown>,
  fallback: string,
): string {
  return typeof data.modelId === "string" && data.modelId.trim()
    ? data.modelId
    : typeof data.model === "string" && data.model.trim()
      ? data.model
      : fallback;
}

export function aspectRatioFromData(
  data: Record<string, unknown>,
): string | undefined {
  return stringParam(data, "aspectRatio") ?? stringParam(data, "aspect_ratio");
}

export function customActionPromptFromData(
  data: Record<string, unknown>,
): string {
  return extractPromptText(
    parsePromptParts(
      typeof data.prompt === "string"
        ? data.prompt
        : typeof data.content === "string"
          ? data.content
          : "",
    ),
  );
}

/** A Canvas node waiting for its custom Action to be admitted, or `null`. */
export function pendingCustomActionNode(node: Record<string, any>): {
  actionId: string;
  outputType: CanvasProcessableKind | "text";
} | null {
  const data = node.data;
  if (!data || typeof data !== "object") return null;
  if (
    typeof data.actionType !== "string" ||
    !data.actionType.startsWith("custom:")
  )
    return null;
  if (data.status !== "pending" && data.status !== "generating") return null;
  if (data.pendingTask) return null;
  const actionId =
    typeof data.customActionId === "string" && data.customActionId
      ? data.customActionId
      : data.actionType.slice("custom:".length);
  const outputType =
    data.outputType === "video" ||
    data.outputType === "audio" ||
    data.outputType === "text"
      ? data.outputType
      : "image";
  return { actionId, outputType };
}

/** Resolve an `@`-mention to the referenced Canvas node's published media Asset. */
export function canvasMentionResolver(nodes: {
  get(nodeId: string): unknown;
}): (
  nodeId: string,
) => { assetId: string; kind: CanvasProcessableKind } | undefined {
  return (mentionedNodeId) => {
    const referencedNode = nodes.get(mentionedNodeId) as
      Record<string, any> | undefined;
    const assetId =
      typeof referencedNode?.data?.assetId === "string"
        ? referencedNode.data.assetId
        : undefined;
    const modality = referencedNode?.type;
    return assetId &&
      (modality === "image" || modality === "video" || modality === "audio")
      ? { assetId, kind: modality }
      : undefined;
  };
}

/** Optimistic fingerprint of a mutable Canvas node's authored execution semantics. */
export function canvasNodeProjectionRevisionId(input: {
  projectId: string;
  nodeId: string;
  kind: CanvasProcessableNodeKind;
  nodeData: Record<string, unknown>;
  targetKind?: "generation" | "action";
  executionPrompt?: string;
  resolveMention: (
    nodeId: string,
  ) => { assetId: string; kind: CanvasProcessableKind } | undefined;
}): string {
  if (input.nodeData.generatorRevision !== undefined) {
    // Native requests are identified by their pinned revision. View-only fields
    // cannot change execution; rewiring the revision must invalidate publication.
    // Validate inside per-node admission so a malformed reference fails that node only.
    const generatorRevision = input.nodeData.generatorRevision;
    return `sha256:${sha256Hex(
      canonicalRevisionJson({
        projectId: input.projectId,
        nodeId: input.nodeId,
        kind: input.kind,
        generatorRevision,
        ...(input.nodeData.generatorActionId === undefined
          ? {}
          : { generatorActionId: input.nodeData.generatorActionId }),
      }),
    )}`;
  }
  const targetKind =
    input.targetKind ??
    (typeof input.nodeData.actionType === "string" &&
    input.nodeData.actionType.startsWith("custom:")
      ? "action"
      : "generation");
  const prompt =
    input.executionPrompt ??
    (targetKind === "action"
      ? customActionPromptFromData(input.nodeData)
      : authoredPromptFromData(input.nodeData, `Mock ${input.kind}`));
  const mentions: Array<
    | {
        index: number;
        nodeId: string;
        assetId: string;
        kind: CanvasProcessableKind;
      }
    | { index: number; nodeId: string; missing: true }
  > = [];
  for (const [index, part] of parsePromptParts(prompt).entries()) {
    if (part.type !== "asset_ref" || !part.nodeId) continue;
    const resolved = input.resolveMention(part.nodeId);
    mentions.push(
      resolved
        ? { index, nodeId: part.nodeId, ...resolved }
        : { index, nodeId: part.nodeId, missing: true },
    );
  }
  const parsedBinding = ExecutablePluginBindingSchema.safeParse(
    input.nodeData.pluginBinding,
  );
  const commonProjection = {
    schemaVersion: 1,
    projectId: input.projectId,
    nodeId: input.nodeId,
    kind: input.kind,
    actionType: input.nodeData.actionType,
    prompt,
    // One projected field per `MEDIA_REFERENCE_FIELDS` registry entry
    // (image / video / audio / model today) so a new reference modality
    // only needs a registry entry, not a new field here.
    ...Object.fromEntries(
      MEDIA_REFERENCE_FIELDS.map((field) => [
        field.pendingField,
        stringList(input.nodeData[field.pendingField]),
      ]),
    ),
    mentions,
    ...(parsedBinding.success ? { pluginBinding: parsedBinding.data } : {}),
  };
  const semanticProjection =
    targetKind === "action"
      ? {
          ...commonProjection,
          customActionId: input.nodeData.customActionId,
          customActionParams: input.nodeData.customActionParams,
          outputType: input.nodeData.outputType,
        }
      : {
          ...commonProjection,
          model: modelFromData(input.nodeData, `mock-${input.kind}`),
          modelParams: nodeModelParams(input.nodeData),
          aspectRatio: aspectRatioFromData(input.nodeData),
          duration:
            input.nodeData.duration ?? nodeModelParams(input.nodeData).duration,
          referenceMode: input.nodeData.referenceMode,
        };
  return `sha256:${sha256Hex(canonicalRevisionJson(semanticProjection))}`;
}

export interface FrozenCanvasCustomAction {
  prompt: string;
  params: Record<string, any>;
  actor: ExecutablePluginInvocation["actor"];
  projectionRevisionId: string;
  actionRevisionId: `sha256:${string}`;
  identity: { actionRunId: string; outputSlot: string };
  /** The exact executor input to journal, including its public Action owner. */
  executor: Omit<FrozenExecutableInput, "schemaVersion">;
}

/**
 * Freeze one pending custom Action node: references from the
 * `MEDIA_REFERENCE_FIELDS` pending Asset ids, values `{prompt, ...params}`,
 * the node projection fingerprint, the Action revision and its identity.
 */
export function freezeCanvasCustomAction(input: {
  projectId: string;
  nodeId: string;
  data: Record<string, unknown>;
  binding: ExecutablePluginBinding;
  custom: { actionId: string; outputType: CanvasProcessableKind | "text" };
  resolveMention: (
    nodeId: string,
  ) => { assetId: string; kind: CanvasProcessableKind } | undefined;
}): FrozenCanvasCustomAction {
  const { data, custom, projectId, nodeId } = input;
  // One reference slot per `MEDIA_REFERENCE_FIELDS` registry
  // entry (image / video / audio / model today) so a new
  // modality only needs a registry entry, not a new branch here.
  const references: ExecutablePluginReference[] =
    MEDIA_REFERENCE_FIELDS.flatMap((field) =>
      stringList(data[field.pendingField]).map((assetId, index) => ({
        slot: field.modality,
        index,
        asset: {
          assetId,
          uri: `clash-asset://${assetId}`,
          kind: field.modality,
        },
      })),
    );
  const prompt = customActionPromptFromData(data);
  const params =
    data.customActionParams &&
    typeof data.customActionParams === "object" &&
    !Array.isArray(data.customActionParams)
      ? (data.customActionParams as Record<string, any>)
      : {};
  const actor: ExecutablePluginInvocation["actor"] =
    data.actorType === "agent"
      ? {
          kind: "agent" as const,
          ...(typeof data.actorAgentId === "string"
            ? { id: data.actorAgentId }
            : {}),
        }
      : {
          kind: "user" as const,
          ...(typeof data.actorUserId === "string"
            ? { id: data.actorUserId }
            : {}),
        };
  const projectionRevisionId = canvasNodeProjectionRevisionId({
    projectId,
    nodeId,
    kind: custom.outputType,
    nodeData: data,
    executionPrompt: prompt,
    targetKind: "action",
    resolveMention: input.resolveMention,
  });
  const candidate = {
    targetKind: "action" as const,
    binding: input.binding,
    actionId: custom.actionId,
    actor,
    kind: custom.outputType,
    projectId,
    nodeId,
    provider: `plugin:${input.binding.pluginId}`,
    modelEndpoint: custom.actionId,
    nodeProjectionRevisionId: projectionRevisionId,
    input: {
      values: { prompt, ...params },
      references,
    },
  } satisfies Omit<FrozenExecutableInput, "schemaVersion">;
  const actionRevisionId = executableRevisionId(candidate);
  return {
    prompt,
    params,
    actor,
    projectionRevisionId,
    actionRevisionId,
    identity: durableExecutorIdentity({
      projectId,
      nodeId,
      kind: custom.outputType,
      actionRevisionId,
    }),
    executor: {
      ...candidate,
      publicOwner: { actionId: custom.actionId, actionRevisionId },
    },
  };
}

/** Project executable plugin Action Card registrations into the Canvas Action catalog. */
export function executablePluginActionDefinitions(
  registrations: readonly ExecutablePluginCardRegistration[],
): CustomActionDefinition[] {
  const definitions = new Map<
    string,
    { pluginId: string; definition: CustomActionDefinition }
  >();
  for (const registration of registrations) {
    if (registration.document.kind !== "action-card") continue;
    const card = registration.document.spec;
    const existing = definitions.get(card.id);
    if (existing) {
      throw new Error(
        `Plugins ${existing.pluginId} and ${registration.pluginId} both export action Card ${card.id}.`,
      );
    }
    const definition = CustomActionDefinitionSchema.parse({
      id: card.id,
      name: card.name,
      ...(card.description ? { description: card.description } : {}),
      parameters: card.parameters,
      outputType: card.outputType,
      input: card.input,
      constraints: card.constraints ?? [],
      presentation: card.presentation,
      ...(card.generator ? { generator: card.generator } : {}),
      ...(card.maxRuntimeMs ? { maxRuntimeMs: card.maxRuntimeMs } : {}),
      runtime: registration.runtime.kind === "hosted" ? "worker" : "local",
      version: registration.version,
      ...(registration.runtime.kind === "hosted"
        ? { workerUrl: registration.runtime.endpoint }
        : {}),
      pluginBinding: {
        pluginId: registration.pluginId,
        version: registration.version,
        exportId: card.functionExportId,
        schemaHash: registration.schemaHash,
      },
      promptModalities: card.input.promptModalities,
      tags: ["executable-plugin", registration.pluginId],
    });
    definitions.set(card.id, { pluginId: registration.pluginId, definition });
  }
  return [...definitions.values()]
    .map((entry) => entry.definition)
    .sort((left, right) => left.id.localeCompare(right.id));
}
