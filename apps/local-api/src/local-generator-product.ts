import { projectLocalModelCopy } from "./local-model-copy-projection.js";
import type { LoroDoc } from "loro-crdt";
import { isDeepStrictEqual } from "node:util";

import {
  advanceProjectGeneratorHead,
  Canvas,
  commitProjectMutation,
  createProjectGenerator as createProjectGeneratorFact,
  ensureActionRunRequest,
  GeneratorDefinitionSchema,
  readGeneratorRevision,
  readDocumentAssetRevision,
  readOutputCommit,
  readProjectActionRun,
  readProjectAsset,
  readProjectGenerator,
  canvasAssetRevision,
  assetRevisionKey,
  resolveExecutableActionCardGenerator,
  isCanvasNodeImmutable,
  type ActionRunModelRoute,
  type ActionRunModelSelection,
  type ActionRunRequest,
  type ExecutablePluginInvocation,
  type ExecutablePluginJsonValue,
  type ExecutablePluginReference,
  type GeneratorDefinition,
  type GeneratorInputRef,
  type GeneratorRevision,
  type GeneratorRevisionRef,
  type ProjectGenerator,
} from "@clash/shared-types";

import {
  buildLocalGeneratorActionRun,
  canonicalInputRefs,
  prepareLocalGeneratorActionRun,
  type BuildLocalGeneratorActionRunInput,
  validateLocalGeneratorRevisionContract,
  type BuiltLocalGeneratorActionRun,
} from "./local-generator-contract.js";
import {
  DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS,
  parseFrozenExecutorInput,
  type FrozenGeneratorProviderExecution,
  type LocalDurableRunCreateCommand,
} from "./durable-run-coordinator.js";
import type { SqliteDurableRunJournal } from "./durable-run-journal.js";
import { createLocalGeneratorRunBridge } from "./local-generator-run-bridge.js";

export interface LocalGeneratorProjectAuthority {
  inspect<T>(
    projectId: string,
    read: (doc: LoroDoc) => T | Promise<T>,
  ): Promise<T>;
  mutate<T>(
    projectId: string,
    mutation: (doc: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>,
  ): Promise<T>;
}

export class LocalGeneratorProductError extends Error {
  override name = "LocalGeneratorProductError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export {
  CreateProjectGeneratorRequestSchema as CreateLocalProjectGeneratorInputSchema,
  SubmitGeneratorActionRequestSchema as SubmitLocalGeneratorActionInputSchema,
  AdvanceProjectGeneratorRequestSchema as AdvanceLocalProjectGeneratorInputSchema,
} from "@clash/shared-types";
import {
  CreateProjectGeneratorRequestSchema as CreateLocalProjectGeneratorInputSchema,
  SubmitGeneratorActionRequestSchema as SubmitLocalGeneratorActionInputSchema,
  AdvanceProjectGeneratorRequestSchema as AdvanceLocalProjectGeneratorInputSchema,
  type CreateProjectGeneratorRequest as CreateLocalProjectGeneratorInput,
  type SubmitGeneratorActionRequest as SubmitLocalGeneratorActionInput,
  type AdvanceProjectGeneratorRequest as AdvanceLocalProjectGeneratorInput,
} from "@clash/shared-types";
export type { CreateLocalProjectGeneratorInput, SubmitLocalGeneratorActionInput, AdvanceLocalProjectGeneratorInput };

export interface LocalProjectGeneratorProjection {
  generator: ProjectGenerator;
  revision: GeneratorRevision;
}

function semanticDefinitionRef(definition: GeneratorDefinition) {
  return {
    pluginId: definition.pluginId,
    definitionId: definition.definitionId,
    version: definition.version,
    schemaHash: definition.schemaHash,
  };
}

function requireResolvedDefinition(
  requested: { pluginId: string; definitionId: string },
  input: unknown,
): GeneratorDefinition {
  const definition = GeneratorDefinitionSchema.parse(input);
  if (
    definition.pluginId !== requested.pluginId ||
    definition.definitionId !== requested.definitionId
  ) {
    throw new LocalGeneratorProductError(
      "GENERATOR_DEFINITION_MISMATCH",
      "The Plugin Host resolved a different Generator definition.",
    );
  }
  return definition;
}

function pluginReferenceSlot(ref: GeneratorInputRef): string {
  return ref.itemKey === undefined ? ref.slot : `${ref.slot}:${ref.itemKey}`;
}

function pluginReferences(
  doc: LoroDoc,
  refs: readonly GeneratorInputRef[],
): ExecutablePluginReference[] {
  const indexes = new Map<string, number>();
  return refs.map((ref) => {
    const slot = pluginReferenceSlot(ref);
    const index = indexes.get(slot) ?? 0;
    indexes.set(slot, index + 1);
    const target = ref.target;
    if ("kind" in target && target.kind === "media") {
      const asset = readProjectAsset(doc, target.projectAssetId);
      if (!asset) {
        throw new LocalGeneratorProductError(
          "GENERATOR_INPUT_NOT_FOUND",
          `Project Asset ${target.projectAssetId} not found.`,
        );
      }
      return {
        slot,
        index,
        asset: {
          assetId: asset.id,
          uri: `clash-asset://${asset.id}`,
          kind: asset.kind,
          ...(asset.metadata.contentType
            ? { mediaType: asset.metadata.contentType }
            : {}),
        },
      };
    }
    if ("kind" in target && target.kind === "document") {
      const revision = readDocumentAssetRevision(doc, target);
      if (!revision) {
        throw new LocalGeneratorProductError(
          "GENERATOR_INPUT_NOT_FOUND",
          `Document revision ${target.documentAssetId}/${target.revisionId} not found.`,
        );
      }
      return {
        slot,
        index,
        document: {
          documentAssetId: revision.documentAssetId,
          revisionId: revision.id,
          documentKind: revision.documentKind,
          schemaVersion: revision.schemaVersion,
        },
      };
    }
    throw new LocalGeneratorProductError(
      "GENERATOR_INPUT_UNSUPPORTED",
      "Generator-family executable references are not supported by this Host yet.",
    );
  });
}

function outputFileExtension(
  output: BuiltLocalGeneratorActionRun["action"]["outputs"][number],
): string {
  if (output.assetType.kind === "document") return "json";
  if (output.assetType.mediaKind === "image") return "png";
  if (output.assetType.mediaKind === "video") return "mp4";
  if (output.assetType.mediaKind === "audio") return "wav";
  if (output.assetType.mediaKind === "model") return "glb";
  throw new Error(`Unsupported Generator media kind: ${output.assetType.mediaKind}`);
}

/**
 * The sole public-Run -> private-task translation. Every semantic field comes
 * from the already validated, Host-resolved Generator contract.
 */
export function buildLocalGeneratorDurableRunCommand(input: {
  doc: LoroDoc;
  projectId: string;
  built: BuiltLocalGeneratorActionRun;
  actor: ExecutablePluginInvocation["actor"];
  deadlineAt: number;
  outputSlot?: string;
  /** Host-selected Card id for a declared model consumer; never caller parameters. */
  modelId?: string;
  providerExecution?: FrozenGeneratorProviderExecution;
  canvasProjection?: { nodeId: string; nodeProjectionRevisionId: string };
}): LocalDurableRunCreateCommand {
  const outputContract = input.built.request.outputContract;
  const output = outputContract.find(
    (candidate) => candidate.slot === (input.outputSlot ?? outputContract[0]?.slot),
  );
  if (!output) {
    throw new LocalGeneratorProductError(
      "GENERATOR_OUTPUT_NOT_SELECTED",
      "The durable task output slot is not part of the frozen Run contract.",
    );
  }
  const declaredOutput =
    input.built.action.outputs.find((candidate) => candidate.slot === output.slot) ??
    output;
  const allRefs = [
    ...input.built.revision.persistentInputRefs,
    ...input.built.request.invocationInputRefs,
  ];
  const prompt = input.built.revision.state.prompt;
  const modelConsumer = input.built.action.modelConsumer;
  const modelSource = modelConsumer
    ? input.built.request.invocationInputRefs.find(
        (ref) => ref.slot === modelConsumer.sourceInputSlot,
      )
    : undefined;
  const modelSourceAsset =
    modelSource && "kind" in modelSource.target && modelSource.target.kind === "media"
      ? readProjectAsset(input.doc, modelSource.target.projectAssetId)
      : undefined;
  const modelSourceAssetId =
    modelSource && "kind" in modelSource.target && modelSource.target.kind === "media"
      ? modelSource.target.projectAssetId
      : undefined;
  const resolvedModelId = input.built.request.modelSelection?.modelId ?? input.modelId;
  const frozenModelRoute = input.built.request.modelSelection?.route;
  if (input.built.action.modelExecution && (!input.providerExecution ||
    !isDeepStrictEqual(input.providerExecution.binding, input.built.request.executor))) {
    throw new LocalGeneratorProductError("GENERATOR_MODEL_EXECUTION_UNRESOLVED",
      "Model execution requires the private plan for the frozen Provider executor.");
  }
  if (modelConsumer && (!resolvedModelId || !modelSourceAsset || !modelSourceAssetId)) {
    throw new LocalGeneratorProductError(
      "GENERATOR_MODEL_CONSUMER_UNRESOLVED",
      "Generator model consumer requires a Host-selected model and frozen media source.",
    );
  }
  const modelInvocationValues: Record<string, ExecutablePluginJsonValue> =
    modelConsumer && resolvedModelId && modelSourceAsset && modelSourceAssetId
      ? {
          modelId: resolvedModelId,
          ...(frozenModelRoute
            ? { modelRoute: frozenModelRoute as ExecutablePluginJsonValue }
            : {}),
          modelConsumer: {
            semanticShape: modelConsumer.semanticShape,
            outputs: input.built.request.outputContract.map((selected) => {
              const declared = input.built.action.outputs.find(
                (candidate) => candidate.slot === selected.slot,
              );
              const customPrompt = declared?.promptParameter
                ? input.built.request.parameters[declared.promptParameter]
                : undefined;
              if (customPrompt !== undefined &&
                  (typeof customPrompt !== "string" || !customPrompt.trim())) {
                throw new LocalGeneratorProductError(
                  "GENERATOR_PROMPT_INVALID", "The analysis prompt must be non-empty text.",
                );
              }
              return {
                slot: selected.slot,
                ...(typeof customPrompt === "string"
                  ? { prompt: customPrompt.trim(), responseFormat: "text" }
                  : declared?.prompt ? { prompt: declared.prompt } : {}),
                ...(declared?.promptVersion
                  ? { promptVersion: declared.promptVersion }
                  : {}),
              };
            }),
          },
          source: {
            projectAssetId: modelSourceAssetId,
            resourceHash: modelSourceAsset.source.resourceId,
            kind: modelSourceAsset.kind,
          },
          generatorRevisionId: input.built.revision.id,
          actionRunId: input.built.request.actionRunId,
        }
      : {};
  return {
    type: "create",
    actionRunId: input.built.request.actionRunId,
    outputSlot: output.slot,
    deadlineAt: input.deadlineAt,
    executor: {
      targetKind: "generator-action",
      ...(input.canvasProjection ?? {}),
      binding: input.built.request.executor,
      ...(input.providerExecution ? { providerExecution: input.providerExecution } : {}),
      actionId: input.built.action.id,
      actor: input.actor,
      publicOwner: {
        actionId: input.built.revision.generatorId,
        actionRevisionId: input.built.revision.id,
      },
      generatorOutputContract: input.built.request.outputContract,
      kind:
        output.assetType.kind === "media" ? output.assetType.mediaKind : "text",
      projectId: input.projectId,
      ...(output.assetType.kind === "media"
        ? {
            delivery: {
              kind: "project-asset" as const,
              actionId: input.built.revision.generatorId,
              name:
                `${input.built.revision.generatorId}-` +
                `${input.built.request.actionRunId}.${outputFileExtension(declaredOutput)}`,
              ...(typeof prompt === "string" ? { prompt } : {}),
            },
          }
        : {}),
      input: {
        values: {
          ...input.built.revision.state,
          ...input.built.request.parameters,
          __generatorActionId: input.built.action.id,
          ...modelInvocationValues,
          ...(input.built.action.selectOutputsByParameter
            ? { [input.built.action.selectOutputsByParameter]: [output.slot] }
            : {}),
        },
        references: pluginReferences(input.doc, allRefs),
      },
    },
  };
}

export function buildLocalGeneratorDurableRunCommands(input: {
  doc: LoroDoc;
  projectId: string;
  built: BuiltLocalGeneratorActionRun;
  actor: ExecutablePluginInvocation["actor"];
  deadlineAt: number;
  modelId?: string;
  providerExecution?: FrozenGeneratorProviderExecution;
  canvasProjection?: { nodeId: string; nodeProjectionRevisionId: string };
}): LocalDurableRunCreateCommand[] {
  return input.built.request.outputContract.map((output) =>
    buildLocalGeneratorDurableRunCommand({ ...input, outputSlot: output.slot }),
  );
}

export function createLocalGeneratorProductService(options: {
  authority: LocalGeneratorProjectAuthority;
  /** Host-owned presentation target; never part of the public Run contract. */
  canvasProjection?: { nodeId: string; nodeProjectionRevisionId: string };
  resolveDefinition: (
    pluginId: string,
    definitionId: string,
  ) => Promise<GeneratorDefinition>;
  listPluginCards?: () => Promise<import("@clash/shared-types").ExecutablePluginCardRegistration[]>;
  ownerId: string;
  journal: SqliteDurableRunJournal;
  actor: ExecutablePluginInvocation["actor"];
  resolveModelExecution?: (input: {
    projectId: string;
    doc: LoroDoc;
    prepared: ReturnType<typeof prepareLocalGeneratorActionRun>;
    pinnedSelection?: ActionRunModelSelection;
    providerAccountId?: string;
  }) => Promise<{ selection: ActionRunModelSelection; execution: FrozenGeneratorProviderExecution }>;
  resolveModelConsumer?: (input: {
    projectId: string;
    consumer: { pluginId: string; definitionId: string; actionId: string };
    semanticShape: string;
    sourceKind: "image" | "video" | "audio";
  }) => Promise<{ modelId: string; route: ActionRunModelRoute }>;
  deadlineMs?: number;
  now?: () => number;
}) {
  const bridge = createLocalGeneratorRunBridge({
    ownerId: options.ownerId,
    journal: options.journal,
    now: options.now,
  });
  const deadlineMs =
    options.deadlineMs ?? DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS;
  const now = options.now ?? Date.now;
  const resolveModelSelection = async (
    projectId: string,
    doc: LoroDoc,
    built: BuiltLocalGeneratorActionRun,
  ): Promise<ActionRunModelSelection | undefined> => {
    const declaration = built.action.modelConsumer;
    if (!declaration) return undefined;
    const ref = built.request.invocationInputRefs.find(
      (candidate) => candidate.slot === declaration.sourceInputSlot,
    );
    const asset =
      ref && "kind" in ref.target && ref.target.kind === "media"
        ? readProjectAsset(doc, ref.target.projectAssetId)
        : undefined;
    if (
      !asset ||
      (asset.kind !== "image" && asset.kind !== "video" && asset.kind !== "audio")
    ) {
      throw new LocalGeneratorProductError(
        "GENERATOR_MODEL_SOURCE_UNSUPPORTED",
        "Generator model consumer requires one frozen image, video, or audio source.",
      );
    }
    if (!options.resolveModelConsumer) {
      throw new LocalGeneratorProductError(
        "GENERATOR_MODEL_RESOLVER_UNAVAILABLE",
        `No model resolver is available for semantic shape ${declaration.semanticShape}.`,
      );
    }
    const selected = await options.resolveModelConsumer({
      projectId,
      consumer: {
        pluginId: built.definition.pluginId,
        definitionId: built.definition.definitionId,
        actionId: built.action.id,
      },
      semanticShape: declaration.semanticShape,
      sourceKind: asset.kind,
    });
    return {
      semanticShape: declaration.semanticShape,
      modelId: selected.modelId,
      route: selected.route,
    };
  };
  const resolvePinnedDefinition = async (ref: GeneratorRevision["definitionRef"]) => {
    const archived = await options.journal.readGeneratorDefinition?.(ref);
    if (archived) return archived;
    const definition = requireResolvedDefinition(ref, await options.resolveDefinition(ref.pluginId, ref.definitionId));
    if (!isDeepStrictEqual(semanticDefinitionRef(definition), ref)) {
      throw new LocalGeneratorProductError("GENERATOR_DEFINITION_MISMATCH", "The exact historical Generator Definition is unavailable.");
    }
    await options.journal.rememberGeneratorDefinition?.(definition);
    return definition;
  };
  const replayEntries = async (projectId: string, doc: LoroDoc, generatorId: string, actionId: string, input: SubmitLocalGeneratorActionInput) => {
    const existing = readProjectActionRun(doc, input.actionRunId);
    if (!existing) return null;
    if (existing.generatorRevision.generatorId !== generatorId || existing.generatorRevision.generatorRevisionId !== input.generatorRevisionId ||
        existing.actionId !== actionId || !isDeepStrictEqual(existing.parameters, input.parameters) ||
        !isDeepStrictEqual(canonicalInputRefs(existing.invocationInputRefs), canonicalInputRefs(input.invocationInputRefs))) {
      throw new LocalGeneratorProductError("ACTION_RUN_REQUEST_CONFLICT", "The existing Action Run belongs to a different request.");
    }
    const { status: _status, ...request } = existing;
    const entries: Array<{ request: ActionRunRequest; command: LocalDurableRunCreateCommand }> = [];
    for (const output of existing.outputContract) {
      const task = await options.journal.load({ actionRunId: input.actionRunId, outputSlot: output.slot });
      // A crash before private admission still needs the original Definition to
      // reconstruct missing tasks; never invent execution from public state.
      if (!task) return null;
      const executor = parseFrozenExecutorInput(task.executorInput);
      if (executor.projectId !== projectId || task.owner.realm !== "local" || task.owner.id !== options.ownerId ||
          (options.canvasProjection && (executor.nodeId !== options.canvasProjection.nodeId || executor.nodeProjectionRevisionId !== options.canvasProjection.nodeProjectionRevisionId))) {
        throw new LocalGeneratorProductError("ACTION_RUN_REQUEST_CONFLICT", "The existing Action Run belongs to a different request owner or projection.");
      }
      if (input.providerAccountId && executor.providerExecution?.accountId !== input.providerAccountId) {
        throw new LocalGeneratorProductError("GENERATOR_PROVIDER_SELECTION_CONFLICT", "The frozen execution does not use the requested Provider account.");
      }
      entries.push({ request, command: { type: "create", actionRunId: input.actionRunId, outputSlot: output.slot, deadlineAt: task.deadlineAt, executor } });
    }
    return entries;
  };
  const prepareInvocation = async (
    projectId: string,
    input: BuildLocalGeneratorActionRunInput,
    providerAccountId?: string,
  ): Promise<{ built: BuiltLocalGeneratorActionRun; providerExecution?: FrozenGeneratorProviderExecution }> => {
    const prepared = prepareLocalGeneratorActionRun(input);
    const existing = readProjectActionRun(input.doc, input.actionRunId);
    if (!prepared.action.modelExecution) {
      if (providerAccountId) throw new LocalGeneratorProductError("GENERATOR_PROVIDER_SELECTION_UNSUPPORTED",
        "An explicit Provider account is supported only by model execution Actions.");
      const initial = buildLocalGeneratorActionRun(input);
      const selection = existing?.modelSelection ?? await resolveModelSelection(projectId, input.doc, initial);
      return { built: selection ? buildLocalGeneratorActionRun({ ...input, modelSelection: selection }) : initial };
    }
    const task = await options.journal.load({ actionRunId: input.actionRunId, outputSlot: prepared.outputContract[0]!.slot });
    let selection = existing?.modelSelection;
    let execution = task ? parseFrozenExecutorInput(task.executorInput).providerExecution : undefined;
    if (task && (!selection || !execution)) {
      throw new LocalGeneratorProductError("GENERATOR_MODEL_EXECUTION_CONFLICT",
        "The existing task does not belong to a frozen model Action Run.");
    }
    if (!execution) {
      if (!options.resolveModelExecution) {
        throw new LocalGeneratorProductError("GENERATOR_MODEL_RESOLVER_UNAVAILABLE",
          "Host model execution planning is unavailable.");
      }
      const planned = await options.resolveModelExecution({ projectId, doc: input.doc, prepared, pinnedSelection: selection, providerAccountId });
      if (selection && !isDeepStrictEqual(selection, planned.selection)) {
        throw new LocalGeneratorProductError("GENERATOR_MODEL_EXECUTION_CONFLICT",
          "Recovery must use the Provider selection frozen in the public Run.");
      }
      selection = planned.selection;
      execution = planned.execution;
    }
    if (providerAccountId && execution.accountId !== providerAccountId) {
      throw new LocalGeneratorProductError("GENERATOR_PROVIDER_SELECTION_CONFLICT",
        "The frozen execution does not use the requested Provider account.");
    }
    return { built: buildLocalGeneratorActionRun({ ...input, modelSelection: selection }), providerExecution: execution };
  };
  return {
    async create(
      projectId: string,
      inputRaw: CreateLocalProjectGeneratorInput,
    ): Promise<LocalProjectGeneratorProjection & { changed: boolean }> {
      const input = CreateLocalProjectGeneratorInputSchema.parse(inputRaw);
      const definition = requireResolvedDefinition(
        input,
        await options.resolveDefinition(input.pluginId, input.definitionId),
      );
      await options.journal.rememberGeneratorDefinition?.(definition);
      if (input.placement?.actionCardId) {
        const registration = (await options.listPluginCards?.() ?? []).find((entry) =>
          entry.pluginId === definition.pluginId && entry.document.kind === "action-card" && entry.document.spec.id === input.placement!.actionCardId);
        if (!registration || registration.document.kind !== "action-card" || registration.version !== definition.version || registration.schemaHash !== definition.schemaHash) {
          throw new LocalGeneratorProductError("GENERATOR_CANVAS_PLACEMENT_UNSUPPORTED", "The requested Action Card must belong to this exact Generator package.");
        }
        resolveExecutableActionCardGenerator(registration.document.spec, definition);
      }
      const revision: GeneratorRevision = {
        id: input.generatorRevisionId,
        generatorId: input.generatorId,
        definitionRef: semanticDefinitionRef(definition),
        state: input.state,
        persistentInputRefs: input.persistentInputRefs,
        ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
      };
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        const result = commitProjectMutation(doc, (draft) => {
          const validatedRevision = validateLocalGeneratorRevisionContract({ doc: draft, definition, revision });
          const created = createProjectGeneratorFact(draft, {
            head: { id: input.generatorId, headRevisionId: input.generatorRevisionId }, revision: validatedRevision,
          });
          if (!created.ok) throw new LocalGeneratorProductError(created.error.code, created.error.message);
          if (!input.placement) return created;
          if (!input.placement.actionCardId && (definition.pluginId !== "clash.model-generation" || !["image", "video", "audio", "model", "text"].includes(definition.definitionId))) {
            throw new LocalGeneratorProductError("GENERATOR_CANVAS_PLACEMENT_UNSUPPORTED", "Canvas Model placement requires a Model Generator Definition.");
          }
          const { nodeId, canvasId, label, position, parentId, actionCardId } = input.placement;
          const existing = draft.getMap("nodes").get(nodeId) as { type?: string; canvasId?: string; data?: { generatorId?: string; actionCardId?: string } } | undefined;
          if (existing) {
            if (existing.type !== "action-badge" || (existing.canvasId ?? "main") !== canvasId || existing.data?.generatorId !== input.generatorId || existing.data?.actionCardId !== actionCardId) {
              throw new LocalGeneratorProductError("GENERATOR_CANVAS_PLACEMENT_CONFLICT", `Canvas node ${nodeId} already belongs to another placement.`);
            }
            // Creation replay acknowledges the existing placement without resetting
            // presentation edits made since the original request.
            return created;
          }
          const canvas = new Canvas(draft, () => {}, canvasId);
          if (parentId && canvas.readNode(parentId)?.type !== "group") {
            throw new LocalGeneratorProductError("GENERATOR_CANVAS_PLACEMENT_REJECTED", "The placement parent must be an existing group in the same Canvas.");
          }
          const placement = canvas.createNode(nodeId, "action-badge", {
            generatorId: input.generatorId, ...(label === undefined ? {} : { label }),
            ...(actionCardId ? { actionCardId } : {}),
          }, position, parentId);
          if (placement.error || placement.node_id !== nodeId) {
            throw new LocalGeneratorProductError("GENERATOR_CANVAS_PLACEMENT_REJECTED", placement.error ?? "Canvas did not create the requested placement.");
          }
          if (input.placement.sourceNodeId) {
            try {
              projectLocalModelCopy(draft, canvasId, input.placement.sourceNodeId, nodeId, validatedRevision);
            } catch (error) {
              throw new LocalGeneratorProductError("GENERATOR_CANVAS_PLACEMENT_CONFLICT", error instanceof Error ? error.message : String(error));
            }
          }
          return { ...created, changed: true };
        });
        if (result.changed) await checkpoint();
        return result;
      });
    },

    async read(
      projectId: string,
      generatorId: string,
    ): Promise<LocalProjectGeneratorProjection | null> {
      return options.authority.inspect(projectId, (doc) => {
        const generator = readProjectGenerator(doc, generatorId);
        if (!generator) return null;
        const revision = readGeneratorRevision(doc, {
          generatorId: generator.id,
          generatorRevisionId: generator.headRevisionId,
        });
        return revision ? { generator, revision } : null;
      });
    },

    async advance(
      projectId: string,
      generatorId: string,
      inputRaw: AdvanceLocalProjectGeneratorInput,
    ): Promise<LocalProjectGeneratorProjection & { changed: boolean }> {
      const input = AdvanceLocalProjectGeneratorInputSchema.parse(inputRaw);
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        const generator = readProjectGenerator(doc, generatorId);
        if (!generator) {
          throw new LocalGeneratorProductError(
            "PROJECT_GENERATOR_NOT_FOUND",
            `Project Generator ${generatorId} not found.`,
          );
        }
        if (
          generator.headRevisionId !== input.expectedHeadRevisionId &&
          generator.headRevisionId !== input.generatorRevisionId
        ) {
          throw new LocalGeneratorProductError(
            "STALE_GENERATOR_HEAD",
            `Project Generator ${generatorId} changed after it was read.`,
          );
        }
        const currentRevision = readGeneratorRevision(doc, {
          generatorId,
          generatorRevisionId: generator.headRevisionId,
        });
        if (!currentRevision) {
          throw new LocalGeneratorProductError(
            "GENERATOR_REVISION_NOT_FOUND",
            `Generator revision ${generatorId}/${generator.headRevisionId} not found.`,
          );
        }
        // An accepted plain edit is an immutable receipt, even if the installed
        // Model contract has changed since then. No fresh mutation is requested.
        if (generator.headRevisionId === input.generatorRevisionId && !input.canvasInputConnections?.length) {
          if (currentRevision.parentRevisionId !== input.expectedHeadRevisionId || !isDeepStrictEqual(currentRevision.state, input.state) || !isDeepStrictEqual(currentRevision.persistentInputRefs, canonicalInputRefs(input.persistentInputRefs))) {
            throw new LocalGeneratorProductError("GENERATOR_REVISION_ID_COLLISION", "This revision already identifies a different edit.");
          }
          return { generator, revision: currentRevision, changed: false };
        }
        const definition = requireResolvedDefinition(
          currentRevision.definitionRef,
          await options.resolveDefinition(
            currentRevision.definitionRef.pluginId,
            currentRevision.definitionRef.definitionId,
          ),
        );
        await options.journal.rememberGeneratorDefinition?.(definition);
        const result = advanceLocalGeneratorRevision(doc, definition, generatorId, input);
        if (result.changed) await checkpoint();
        return result;
      });
    },

    async submitBatch(
      projectId: string,
      proposals: readonly {
        generatorId: string;
        actionId: string;
        input: SubmitLocalGeneratorActionInput;
      }[],
    ) {
      if (proposals.length === 0) {
        throw new LocalGeneratorProductError("EMPTY_ACTION_RUN_BATCH", "Generator Action Run batch must not be empty.");
      }
      const parsed = proposals.map((proposal) => ({
        ...proposal,
        input: SubmitLocalGeneratorActionInputSchema.parse(proposal.input),
      }));
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        const planned: Array<{ request: ActionRunRequest; command: LocalDurableRunCreateCommand }> = [];
        const validationDoc = doc.fork();
        try {
        for (const proposal of parsed) {
          const generator = readProjectGenerator(validationDoc, proposal.generatorId);
          if (!generator) throw new LocalGeneratorProductError("PROJECT_GENERATOR_NOT_FOUND", `Project Generator ${proposal.generatorId} not found.`);
          const revision = readGeneratorRevision(validationDoc, { generatorId: proposal.generatorId, generatorRevisionId: proposal.input.generatorRevisionId });
          if (!revision) throw new LocalGeneratorProductError("GENERATOR_REVISION_NOT_FOUND", `Generator revision ${proposal.generatorId}/${proposal.input.generatorRevisionId} not found.`);
          const replay = await replayEntries(projectId, validationDoc, proposal.generatorId, proposal.actionId, proposal.input);
          if (replay) { planned.push(...replay); continue; }
          const definition = await resolvePinnedDefinition(revision.definitionRef);
          const { built, providerExecution } = await prepareInvocation(projectId, {
            doc: validationDoc, definition, actionRunId: proposal.input.actionRunId,
            generatorRevision: { generatorId: proposal.generatorId, generatorRevisionId: proposal.input.generatorRevisionId },
            actionId: proposal.actionId, parameters: proposal.input.parameters, invocationInputRefs: proposal.input.invocationInputRefs,
          }, proposal.input.providerAccountId);
          // Validate all public identities against each other and existing facts before touching authority.
          const validation = ensureActionRunRequest(validationDoc, built.request);
          if (!validation.ok) throw new LocalGeneratorProductError(validation.error.code, validation.error.message);
          const commands: LocalDurableRunCreateCommand[] = [];
          for (const output of built.request.outputContract) {
            const existingTask = await options.journal.load({
              actionRunId: proposal.input.actionRunId,
              outputSlot: output.slot,
            });
            commands.push(
              buildLocalGeneratorDurableRunCommand({
                doc: validationDoc,
                projectId,
                built,
                actor: options.actor,
                providerExecution,
                canvasProjection: options.canvasProjection,
                deadlineAt: existingTask?.deadlineAt ?? now() + deadlineMs,
                outputSlot: output.slot,
              }),
            );
          }
          planned.push(...commands.map((command) => ({ request: built.request, command })));
        }
        } finally { validationDoc.free(); }
        const runs = await bridge.enqueueBatch({
          doc,
          entries: planned,
          checkpoint,
        });
        return parsed.map((proposal) =>
          runs.find((run) => run.actionRunId === proposal.input.actionRunId)!,
        );
      });
    },

    async submit(
      projectId: string,
      generatorId: string,
      actionId: string,
      inputRaw: SubmitLocalGeneratorActionInput,
    ) {
      const input = SubmitLocalGeneratorActionInputSchema.parse(inputRaw);
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        const generator = readProjectGenerator(doc, generatorId);
        if (!generator) {
          throw new LocalGeneratorProductError(
            "PROJECT_GENERATOR_NOT_FOUND",
            `Project Generator ${generatorId} not found.`,
          );
        }
        const frozenRevision = readGeneratorRevision(doc, {
          generatorId,
          generatorRevisionId: input.generatorRevisionId,
        });
        if (!frozenRevision) {
          throw new LocalGeneratorProductError(
            "GENERATOR_REVISION_NOT_FOUND",
            `Generator revision ${generatorId}/${input.generatorRevisionId} not found.`,
          );
        }
        const replay = await replayEntries(projectId, doc, generatorId, actionId, input);
        if (replay) {
          const runs = await bridge.enqueueBatch({ doc, entries: replay, checkpoint });
          return runs[0]!;
        }
        const definition = await resolvePinnedDefinition(frozenRevision.definitionRef);
        const { built, providerExecution } = await prepareInvocation(projectId, {
          doc, definition, actionRunId: input.actionRunId,
          generatorRevision: { generatorId, generatorRevisionId: input.generatorRevisionId },
          actionId, parameters: input.parameters, invocationInputRefs: input.invocationInputRefs,
        }, input.providerAccountId);
        const entries: Array<{
          request: ActionRunRequest;
          command: LocalDurableRunCreateCommand;
        }> = [];
        for (const output of built.request.outputContract) {
          const existingTask = await options.journal.load({
            actionRunId: input.actionRunId,
            outputSlot: output.slot,
          });
          entries.push({
            request: built.request,
            command: buildLocalGeneratorDurableRunCommand({
              doc,
              projectId,
              built,
              actor: options.actor,
              providerExecution,
              canvasProjection: options.canvasProjection,
              deadlineAt: existingTask?.deadlineAt ?? now() + deadlineMs,
              outputSlot: output.slot,
            }),
          });
        }
        const runs = await bridge.enqueueBatch({ doc, entries, checkpoint });
        return runs[0]!;
      });
    },

    async readRun(
      projectId: string,
      actionRunId: string,
    ): Promise<ReturnType<typeof readProjectActionRun>> {
      return options.authority.inspect(projectId, (doc) =>
        readProjectActionRun(doc, actionRunId),
      );
    },

    async readOutput(
      projectId: string,
      input: { actionRunId: string; outputSlot: string },
    ): Promise<ReturnType<typeof readOutputCommit>> {
      return options.authority.inspect(projectId, (doc) =>
        readOutputCommit(doc, input),
      );
    },
  };
}

export type LocalGeneratorProductService = ReturnType<
  typeof createLocalGeneratorProductService
>;


/** Shared Host mutation used by the Generator API and Canvas command adapter. */
export function advanceLocalGeneratorRevision(doc: LoroDoc, definition: GeneratorDefinition, generatorId: string, input: AdvanceLocalProjectGeneratorInput) {
  const generator = readProjectGenerator(doc, generatorId);
  const currentRevision = generator && readGeneratorRevision(doc, { generatorId, generatorRevisionId: generator.headRevisionId });
  if (!generator || !currentRevision) throw new LocalGeneratorProductError("GENERATOR_REVISION_NOT_FOUND", "Generator revision is unavailable. Read again.");
  if (generator.headRevisionId !== input.generatorRevisionId) {
    for (const [nodeId, raw] of doc.getMap("nodes").entries()) {
      const placement = raw as { type?: string; canvasId?: string; data?: { generatorId?: string } };
      if (placement.type !== "action-badge" || placement.data?.generatorId !== generatorId) continue;
      const canvas = new Canvas(doc, () => {}, placement.canvasId ?? "main");
      if (isCanvasNodeImmutable({ nodeId, edges: canvas.listEdges() })) {
        throw new LocalGeneratorProductError("IMMUTABLE_NODE", `Canvas placement ${nodeId} has downstream references. Copy the Generator draft before editing it.`);
      }
    }
  }
  const result = commitProjectMutation(doc, (draft) => {
    const revision = validateLocalGeneratorRevisionContract({
      doc: draft,
      definition,
      revision: {
        id: input.generatorRevisionId,
        generatorId,
        // New edits bind the currently installed contract; historical
        // revisions and their frozen Runs retain their original provenance.
        definitionRef: semanticDefinitionRef(definition),
        parentRevisionId: input.expectedHeadRevisionId,
        state: input.state,
        persistentInputRefs: input.persistentInputRefs,
      },
    });
    const advanced = advanceProjectGeneratorHead(draft, {
      generatorId,
      expectedHeadRevisionId: input.expectedHeadRevisionId,
      revision,
      editPolicy: definition.editPolicy,
    });
    if (!advanced.ok) {
      throw new LocalGeneratorProductError(
        advanced.error.code,
        advanced.error.message,
      );
    }
    let changed = advanced.changed;
    {
      const assets = new Set(revision.persistentInputRefs.map(ref => assetRevisionKey(ref.target)).filter(key => key !== null));
      const placements = new Map<string, string>();
      for (const [nodeId, raw] of draft.getMap("nodes").entries()) {
        const node = raw as { type?: string; canvasId?: string; data?: { generatorId?: string } };
        if (node.type === "action-badge" && node.data?.generatorId === generatorId) placements.set(nodeId, node.canvasId ?? "main");
      }
      for (const canvasId of new Set(placements.values())) {
        const canvas = new Canvas(draft, () => {}, canvasId);
        for (const edge of canvas.listEdges()) {
          if (!placements.has(edge.target) || edge.type === "copy-on-write") continue;
          const source = canvas.readNode(edge.source);
          const key = assetRevisionKey(canvasAssetRevision(source));
          if (!key || !assets.has(key)) changed = canvas.deleteEdge(edge.id) || changed;
        }
      }
      for (const connection of input.canvasInputConnections ?? []) {
        const canvas = new Canvas(draft, () => {}, connection.canvasId);
        const source = canvas.readNode(connection.sourceNodeId);
        const key = assetRevisionKey(connection.asset)!;
        if (placements.get(connection.targetNodeId) !== connection.canvasId || !source || assetRevisionKey(canvasAssetRevision(source)) !== key || (connection.disconnect ? assets.has(key) : !assets.has(key))) {
          throw new LocalGeneratorProductError("GENERATOR_CANVAS_CONNECTION_CONFLICT", "The Canvas source, target, or native input changed. Read them again.");
        }
        if (connection.disconnect) continue;
        const edgeId = `${connection.sourceNodeId}-${connection.targetNodeId}`;
        const existing = canvas.listEdges().find((edge) => edge.id === edgeId);
        if (existing) {
          if (existing.source !== connection.sourceNodeId || existing.target !== connection.targetNodeId) throw new LocalGeneratorProductError("GENERATOR_CANVAS_CONNECTION_CONFLICT", "The Canvas edge belongs to another connection.");
          continue;
        }
        canvas.insertEdge(edgeId, connection.sourceNodeId, connection.targetNodeId);
        changed = true;
      }
    }
    return { ...advanced, changed };
  });
  return result;
}
