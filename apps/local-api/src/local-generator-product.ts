import type { LoroDoc } from "loro-crdt";
import { z } from "zod";

import {
  advanceProjectGeneratorHead,
  createProjectGenerator as createProjectGeneratorFact,
  ExecutablePluginJsonValueSchema,
  ensureActionRunRequest,
  GeneratorDefinitionSchema,
  GeneratorInputRefSchema,
  GeneratorRevisionRefSchema,
  readGeneratorRevision,
  readDocumentAssetRevision,
  readOutputCommit,
  readProjectActionRun,
  readProjectAsset,
  readProjectGenerator,
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
  validateLocalGeneratorRevisionContract,
  type BuiltLocalGeneratorActionRun,
} from "./local-generator-contract.js";
import {
  DEFAULT_LOCAL_PROVIDER_RUN_DEADLINE_MS,
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

const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .transform((value, context): Record<string, ExecutablePluginJsonValue> => {
    const parsed: Record<string, ExecutablePluginJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = ExecutablePluginJsonValueSchema.safeParse(entry);
      if (!result.success) {
        context.addIssue({
          code: "custom",
          path: [key],
          message:
            result.error.issues[0]?.message ?? "Invalid plugin JSON value.",
        });
        return z.NEVER;
      }
      parsed[key] = result.data;
    }
    return parsed;
  });

const generatorInputRefsSchema = z
  .array(z.unknown())
  .transform((value, context): GeneratorInputRef[] => {
    const result = GeneratorInputRefSchema.array().safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      context.addIssue({
        code: "custom",
        path: issue?.path ?? [],
        message: issue?.message ?? "Invalid Generator input reference.",
      });
      return z.NEVER;
    }
    return result.data;
  });

const generatorRevisionRefSchema = z
  .unknown()
  .transform((value, context): GeneratorRevisionRef => {
    const result = GeneratorRevisionRefSchema.safeParse(value);
    if (!result.success) {
      const issue = result.error.issues[0];
      context.addIssue({
        code: "custom",
        path: issue?.path ?? [],
        message: issue?.message ?? "Invalid Generator revision reference.",
      });
      return z.NEVER;
    }
    return result.data;
  });

export const CreateLocalProjectGeneratorInputSchema = z
  .object({
    generatorId: z.string().trim().min(1),
    generatorRevisionId: z.string().trim().min(1),
    pluginId: z.string().trim().min(1),
    definitionId: z.string().trim().min(1),
    state: jsonObjectSchema,
    persistentInputRefs: generatorInputRefsSchema.default([]),
    forkedFrom: generatorRevisionRefSchema.optional(),
  })
  .strict();
export type CreateLocalProjectGeneratorInput = z.infer<
  typeof CreateLocalProjectGeneratorInputSchema
>;

export const SubmitLocalGeneratorActionInputSchema = z
  .object({
    actionRunId: z.string().trim().min(1),
    generatorRevisionId: z.string().trim().min(1),
    parameters: jsonObjectSchema.default({}),
    invocationInputRefs: generatorInputRefsSchema.default([]),
  })
  .strict();
export type SubmitLocalGeneratorActionInput = z.infer<
  typeof SubmitLocalGeneratorActionInputSchema
>;

export const AdvanceLocalProjectGeneratorInputSchema = z
  .object({
    expectedHeadRevisionId: z.string().trim().min(1),
    generatorRevisionId: z.string().trim().min(1),
    state: jsonObjectSchema,
    persistentInputRefs: generatorInputRefsSchema.default([]),
  })
  .strict();
export type AdvanceLocalProjectGeneratorInput = z.infer<
  typeof AdvanceLocalProjectGeneratorInputSchema
>;

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
      binding: input.built.request.executor,
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
}): LocalDurableRunCreateCommand[] {
  return input.built.request.outputContract.map((output) =>
    buildLocalGeneratorDurableRunCommand({ ...input, outputSlot: output.slot }),
  );
}

export function createLocalGeneratorProductService(options: {
  authority: LocalGeneratorProjectAuthority;
  resolveDefinition: (
    pluginId: string,
    definitionId: string,
  ) => Promise<GeneratorDefinition>;
  ownerId: string;
  journal: SqliteDurableRunJournal;
  actor: ExecutablePluginInvocation["actor"];
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
      const revision: GeneratorRevision = {
        id: input.generatorRevisionId,
        generatorId: input.generatorId,
        definitionRef: semanticDefinitionRef(definition),
        state: input.state,
        persistentInputRefs: input.persistentInputRefs,
        ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
      };
      return options.authority.mutate(projectId, async (doc, checkpoint) => {
        const validatedRevision = validateLocalGeneratorRevisionContract({
          doc,
          definition,
          revision,
        });
        const result = createProjectGeneratorFact(doc, {
          head: {
            id: input.generatorId,
            headRevisionId: input.generatorRevisionId,
          },
          revision: validatedRevision,
        });
        if (!result.ok) {
          throw new LocalGeneratorProductError(
            result.error.code,
            result.error.message,
          );
        }
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
        const definition = requireResolvedDefinition(
          currentRevision.definitionRef,
          await options.resolveDefinition(
            currentRevision.definitionRef.pluginId,
            currentRevision.definitionRef.definitionId,
          ),
        );
        const revision = validateLocalGeneratorRevisionContract({
          doc,
          definition,
          revision: {
            id: input.generatorRevisionId,
            generatorId,
            definitionRef: currentRevision.definitionRef,
            parentRevisionId: input.expectedHeadRevisionId,
            state: input.state,
            persistentInputRefs: input.persistentInputRefs,
          },
        });
        const result = advanceProjectGeneratorHead(doc, {
          generatorId,
          expectedHeadRevisionId: input.expectedHeadRevisionId,
          revision,
          editPolicy: definition.editPolicy,
        });
        if (!result.ok) {
          throw new LocalGeneratorProductError(
            result.error.code,
            result.error.message,
          );
        }
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
        const planned: Array<{ built: BuiltLocalGeneratorActionRun; command: LocalDurableRunCreateCommand }> = [];
        const validationDoc = doc.fork();
        for (const proposal of parsed) {
          const generator = readProjectGenerator(validationDoc, proposal.generatorId);
          if (!generator) throw new LocalGeneratorProductError("PROJECT_GENERATOR_NOT_FOUND", `Project Generator ${proposal.generatorId} not found.`);
          const revision = readGeneratorRevision(validationDoc, { generatorId: proposal.generatorId, generatorRevisionId: proposal.input.generatorRevisionId });
          if (!revision) throw new LocalGeneratorProductError("GENERATOR_REVISION_NOT_FOUND", `Generator revision ${proposal.generatorId}/${proposal.input.generatorRevisionId} not found.`);
          const definition = requireResolvedDefinition(revision.definitionRef, await options.resolveDefinition(revision.definitionRef.pluginId, revision.definitionRef.definitionId));
          const initial = buildLocalGeneratorActionRun({ doc: validationDoc, definition, actionRunId: proposal.input.actionRunId, generatorRevision: { generatorId: proposal.generatorId, generatorRevisionId: proposal.input.generatorRevisionId }, actionId: proposal.actionId, parameters: proposal.input.parameters, invocationInputRefs: proposal.input.invocationInputRefs });
          const modelSelection = await resolveModelSelection(projectId, validationDoc, initial);
          const built = modelSelection
            ? buildLocalGeneratorActionRun({
                doc: validationDoc,
                definition,
                actionRunId: proposal.input.actionRunId,
                generatorRevision: { generatorId: proposal.generatorId, generatorRevisionId: proposal.input.generatorRevisionId },
                actionId: proposal.actionId,
                parameters: proposal.input.parameters,
                modelSelection,
                invocationInputRefs: proposal.input.invocationInputRefs,
              })
            : initial;
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
                deadlineAt: existingTask?.deadlineAt ?? now() + deadlineMs,
                outputSlot: output.slot,
              }),
            );
          }
          planned.push(...commands.map((command) => ({ built, command })));
        }
        const runs = await bridge.enqueueBatch({
          doc,
          entries: planned.map((item) => ({ request: item.built.request, command: item.command })),
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
        const definition = requireResolvedDefinition(
          frozenRevision.definitionRef,
          await options.resolveDefinition(
            frozenRevision.definitionRef.pluginId,
            frozenRevision.definitionRef.definitionId,
          ),
        );
        const initial = buildLocalGeneratorActionRun({
          doc,
          definition,
          actionRunId: input.actionRunId,
          generatorRevision: {
            generatorId,
            generatorRevisionId: input.generatorRevisionId,
          },
          actionId,
          parameters: input.parameters,
          invocationInputRefs: input.invocationInputRefs,
        });
        const modelSelection = await resolveModelSelection(projectId, doc, initial);
        const built = modelSelection
          ? buildLocalGeneratorActionRun({
              doc,
              definition,
              actionRunId: input.actionRunId,
              generatorRevision: {
                generatorId,
                generatorRevisionId: input.generatorRevisionId,
              },
              actionId,
              parameters: input.parameters,
              modelSelection,
              invocationInputRefs: input.invocationInputRefs,
            })
          : initial;
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
