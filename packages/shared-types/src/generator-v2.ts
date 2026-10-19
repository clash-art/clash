import { lazySchema, lazyValue } from "./lazy-schema.js";
import { z } from "zod";
import { isModelGenerationOutputType } from "./model-output-contract.js";

import { AssetKindSchema } from "./assets.js";
import { ExecutablePluginJsonValueSchema } from "./plugin-json-value.js";
import { pluginIdSchema } from "./plugin-namespace.js";
import { ProviderAssetInputSchema } from "./models.js";

let nonEmptyIdSchema = lazySchema(() => (
z.string().trim().min(1)
), (real) => { nonEmptyIdSchema = real; });
let prefixedSha256Schema = lazySchema(() => (
z.string().regex(/^sha256:[a-f0-9]{64}$/)
), (real) => { prefixedSha256Schema = real; });
let jsonObjectSchema = lazySchema(() => (
z.record(z.string(), ExecutablePluginJsonValueSchema)
), (real) => { jsonObjectSchema = real; });
const GeneratorMediaKindSchema = AssetKindSchema;

export let GeneratorEditPolicySchema = lazySchema(() => (
z.enum([
  "advance-head",
  "fork-when-materialized",
])
), (real) => { GeneratorEditPolicySchema = real; });
export type GeneratorEditPolicy = z.infer<typeof GeneratorEditPolicySchema>;

export let MediaAssetRevisionRefSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("media"),
    projectAssetId: nonEmptyIdSchema,
  })
  .strict()
), (real) => { MediaAssetRevisionRefSchema = real; });
export type MediaAssetRevisionRef = z.infer<typeof MediaAssetRevisionRefSchema>;

export let DocumentAssetRevisionRefSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("document"),
    documentAssetId: nonEmptyIdSchema,
    revisionId: nonEmptyIdSchema,
  })
  .strict()
), (real) => { DocumentAssetRevisionRefSchema = real; });
export type DocumentAssetRevisionRef = z.infer<
  typeof DocumentAssetRevisionRefSchema
>;

export let AssetRevisionRefSchema = lazySchema(() => (
z.discriminatedUnion("kind", [
  MediaAssetRevisionRefSchema,
  DocumentAssetRevisionRefSchema,
])
), (real) => { AssetRevisionRefSchema = real; });
export type AssetRevisionRef = z.infer<typeof AssetRevisionRefSchema>;

export let GeneratorRevisionRefSchema = lazySchema(() => (
z
  .object({
    generatorId: nonEmptyIdSchema,
    generatorRevisionId: nonEmptyIdSchema,
  })
  .strict()
), (real) => { GeneratorRevisionRefSchema = real; });
export type GeneratorRevisionRef = z.infer<typeof GeneratorRevisionRefSchema>;

export let GeneratorInputTargetSchema = lazySchema(() => (
z.union([
  AssetRevisionRefSchema,
  GeneratorRevisionRefSchema,
])
), (real) => { GeneratorInputTargetSchema = real; });
export type GeneratorInputTarget = z.infer<typeof GeneratorInputTargetSchema>;

export let GeneratorInputRefSchema = lazySchema(() => (
z
  .object({
    slot: nonEmptyIdSchema,
    itemKey: nonEmptyIdSchema.optional(),
    target: GeneratorInputTargetSchema,
  })
  .strict()
), (real) => { GeneratorInputRefSchema = real; });
export type GeneratorInputRef = z.infer<typeof GeneratorInputRefSchema>;

export let GeneratorDefinitionRefSchema = lazySchema(() => (
z
  .object({
    pluginId: pluginIdSchema,
    definitionId: nonEmptyIdSchema,
    version: nonEmptyIdSchema,
    schemaHash: prefixedSha256Schema,
  })
  .strict()
), (real) => { GeneratorDefinitionRefSchema = real; });
export type GeneratorDefinitionRef = z.infer<
  typeof GeneratorDefinitionRefSchema
>;

/**
 * The exact semantic function selected for one Run. Runtime placement, account
 * selection, process ids, and retry state are Host-private Task facts and are
 * deliberately absent.
 */
export let GeneratorExecutorRefSchema = lazySchema(() => (
z
  .object({
    pluginId: pluginIdSchema,
    version: nonEmptyIdSchema,
    exportId: nonEmptyIdSchema,
    schemaHash: prefixedSha256Schema,
  })
  .strict()
), (real) => { GeneratorExecutorRefSchema = real; });
export type GeneratorExecutorRef = z.infer<typeof GeneratorExecutorRefSchema>;

export let GeneratorMediaAssetTypeSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("media"),
    mediaKind: AssetKindSchema,
  })
  .strict()
), (real) => { GeneratorMediaAssetTypeSchema = real; });
export type GeneratorMediaAssetType = z.infer<
  typeof GeneratorMediaAssetTypeSchema
>;

export let GeneratorDocumentAssetTypeSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("document"),
    documentKind: nonEmptyIdSchema,
    schemaVersion: z.number().int().positive(),
  })
  .strict()
), (real) => { GeneratorDocumentAssetTypeSchema = real; });
export type GeneratorDocumentAssetType = z.infer<
  typeof GeneratorDocumentAssetTypeSchema
>;

export let GeneratorAssetTypeSchema = lazySchema(() => (
z.discriminatedUnion("kind", [
  GeneratorMediaAssetTypeSchema,
  GeneratorDocumentAssetTypeSchema,
])
), (real) => { GeneratorAssetTypeSchema = real; });
export type GeneratorAssetType = z.infer<typeof GeneratorAssetTypeSchema>;

export let GeneratorInputCardinalitySchema = lazySchema(() => (
z
  .object({
    minItems: z.number().int().nonnegative(),
    maxItems: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine(({ minItems, maxItems }, context) => {
    if (maxItems !== null && maxItems < minItems) {
      context.addIssue({
        code: "custom",
        path: ["maxItems"],
        message: "maxItems must be greater than or equal to minItems.",
      });
    }
  })
), (real) => { GeneratorInputCardinalitySchema = real; });
export type GeneratorInputCardinality = z.infer<
  typeof GeneratorInputCardinalitySchema
>;

export const GeneratorActionInputCardinalitySchema =
  GeneratorInputCardinalitySchema;
export type GeneratorActionInputCardinality = GeneratorInputCardinality;

export let GeneratorFamilyInputTypeSchema = lazySchema(() => (
z
  .object({
    kind: z.literal("generator"),
    pluginId: pluginIdSchema,
    definitionId: nonEmptyIdSchema,
  })
  .strict()
), (real) => { GeneratorFamilyInputTypeSchema = real; });
export type GeneratorFamilyInputType = z.infer<
  typeof GeneratorFamilyInputTypeSchema
>;

export let GeneratorInputTypeSchema = lazySchema(() => (
z.discriminatedUnion("kind", [
  GeneratorMediaAssetTypeSchema,
  GeneratorDocumentAssetTypeSchema,
  GeneratorFamilyInputTypeSchema,
])
), (real) => { GeneratorInputTypeSchema = real; });
export type GeneratorInputType = z.infer<typeof GeneratorInputTypeSchema>;

export let GeneratorInputPortSchema = lazySchema(() => (
z
  .object({
    slot: nonEmptyIdSchema,
    accepts: z.array(GeneratorInputTypeSchema).min(1),
    cardinality: GeneratorInputCardinalitySchema,
  })
  .strict()
), (real) => { GeneratorInputPortSchema = real; });
export type GeneratorInputPort = z.infer<typeof GeneratorInputPortSchema>;

export const GeneratorActionInputPortSchema = GeneratorInputPortSchema;
export type GeneratorActionInputPort = GeneratorInputPort;

export const GeneratorActionOutputCardinalitySchema =
  GeneratorInputCardinalitySchema;
export type GeneratorActionOutputCardinality = GeneratorInputCardinality;

export let GeneratorActionOutputPortSchema = lazySchema(() => (
z
  .object({
    slot: nonEmptyIdSchema,
    assetType: GeneratorAssetTypeSchema,
    cardinality: GeneratorActionOutputCardinalitySchema,
    /** Human label and prompt contract owned by the plugin declaration. */
    title: nonEmptyIdSchema.optional(),
    sourceMediaKinds: z.array(GeneratorMediaKindSchema).min(1).optional(),
    prompt: nonEmptyIdSchema.optional(),
    /** Optional invocation parameter supplying a free-form prompt and text response. */
    promptParameter: nonEmptyIdSchema.optional(),
    promptVersion: nonEmptyIdSchema.optional(),
  })
  .strict()
), (real) => { GeneratorActionOutputPortSchema = real; });
export type GeneratorActionOutputPort = z.infer<
  typeof GeneratorActionOutputPortSchema
>;

export let GeneratorActionOutputContractSchema = lazySchema(() => (
z
  .array(GeneratorActionOutputPortSchema)
  .min(1)
  .superRefine((outputs, context) => {
    const slots = new Set<string>();
    outputs.forEach((output, index) => {
      if (slots.has(output.slot)) {
        context.addIssue({
          code: "custom",
          path: [index, "slot"],
          message: `Duplicate Generator Action output slot: ${output.slot}`,
        });
      }
      slots.add(output.slot);
      if (
        output.cardinality.maxItems !== 1 ||
        (output.cardinality.minItems !== 0 &&
          output.cardinality.minItems !== 1)
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "cardinality"],
          message:
            "The current Generator Action profile requires singular 0..1 or 1..1 output slots.",
        });
      }
    });
  })
), (real) => { GeneratorActionOutputContractSchema = real; });
export type GeneratorActionOutputContract = z.infer<
  typeof GeneratorActionOutputContractSchema
>;

export let GeneratorActionDefinitionSchema = lazySchema(() => (
z
  .object({
    id: nonEmptyIdSchema,
    executorExportId: nonEmptyIdSchema.optional(),
    /** Host selects and freezes the Model's Provider; no plugin Action function is invoked. */
    modelExecution: z.literal(true).optional(),
    parametersSchema: jsonObjectSchema,
    selectOutputsByParameter: nonEmptyIdSchema.optional(),
    /** Provider-independent model consumption contract resolved by the Host. */
    modelConsumer: z
      .object({
        semanticShape: z.string().trim().regex(/^[a-z][a-z0-9_]*$/),
        sourceInputSlot: nonEmptyIdSchema,
      })
      .strict()
      .optional(),
    invocationInputs: z.array(GeneratorActionInputPortSchema),
    outputs: GeneratorActionOutputContractSchema,
  })
  .strict()
  .superRefine(({ invocationInputs, modelConsumer, modelExecution, executorExportId, outputs }, context) => {
    if (Boolean(executorExportId) === Boolean(modelExecution)) {
      context.addIssue({ code: "custom", path: ["executorExportId"],
        message: "An Action requires exactly one plugin executor or Host model execution declaration." });
    }
    if (modelExecution && (modelConsumer || outputs.length !== 1 || !outputs[0] || !isModelGenerationOutputType(outputs[0].assetType))) {
      context.addIssue({ code: "custom", path: ["modelExecution"],
        message: "Host model execution requires one media or plain-text Document output and cannot also delegate to a model-consumer Action plugin." });
    }
    const seen = new Set<string>();
    invocationInputs.forEach((input, index) => {
      if (seen.has(input.slot)) {
        context.addIssue({
          code: "custom",
          path: ["invocationInputs", index, "slot"],
          message: `Duplicate Generator Action input slot: ${input.slot}`,
        });
      }
      seen.add(input.slot);
    });
    if (
      modelConsumer &&
      !invocationInputs.some((input) => input.slot === modelConsumer.sourceInputSlot)
    ) {
      context.addIssue({
        code: "custom",
        path: ["modelConsumer", "sourceInputSlot"],
        message: `Model consumer source slot ${modelConsumer.sourceInputSlot} is not declared.`,
      });
    }
  })
), (real) => { GeneratorActionDefinitionSchema = real; });
export type GeneratorActionDefinition = z.infer<
  typeof GeneratorActionDefinitionSchema
>;

/**
 * Reserved compatibility projection surfaces.
 *
 * A specialized product surface that existed before native Generators (the
 * Timeline editor, the Director Stage) keeps its entrypoints, but those
 * entrypoints must project one plugin-registered Generator family instead of
 * owning a second state model. A plugin claims the surface from its own
 * Generator document; the Host never names the plugin, definition, Actions, or
 * schema hash behind a surface.
 */
export const GENERATOR_PROJECTION_SURFACE_IDS = [
  "clash.timeline",
  "clash.director-stage",
] as const;

export let GeneratorProjectionSurfaceIdSchema = lazySchema(() => (
z.enum(
  GENERATOR_PROJECTION_SURFACE_IDS,
)
), (real) => { GeneratorProjectionSurfaceIdSchema = real; });
export type GeneratorProjectionSurfaceId = z.infer<
  typeof GeneratorProjectionSurfaceIdSchema
>;

export let GeneratorProjectionSurfaceSchema = lazySchema(() => (
z
  .object({
    id: GeneratorProjectionSurfaceIdSchema,
    /** Generator state key holding the legacy editable document. */
    stateKey: nonEmptyIdSchema,
    /** Persistent input slot that receives the legacy document's media items. */
    mediaInputSlot: nonEmptyIdSchema.optional(),
    /** Action the legacy render/capture entrypoint submits. */
    primaryActionId: nonEmptyIdSchema,
  })
  .strict()
), (real) => { GeneratorProjectionSurfaceSchema = real; });
export type GeneratorProjectionSurface = z.infer<
  typeof GeneratorProjectionSurfaceSchema
>;

let generatorDefinitionSpecShape = lazyValue(() => ({
  definitionId: nonEmptyIdSchema,
  stateSchema: jsonObjectSchema,
  editPolicy: GeneratorEditPolicySchema,
  persistentInputs: z.array(GeneratorInputPortSchema),
  actions: z.array(GeneratorActionDefinitionSchema).min(1),
  projectionSurface: GeneratorProjectionSurfaceSchema.optional(),
} as const), {}, (real) => { generatorDefinitionSpecShape = real; });

function validateGeneratorDefinitionSpec(
  input: {
    actions: readonly GeneratorActionDefinition[];
    persistentInputs: readonly GeneratorInputPort[];
    projectionSurface?: GeneratorProjectionSurface;
  },
  context: z.RefinementCtx,
): void {
  const persistentSlots = new Set<string>();
  input.persistentInputs.forEach((persistentInput, index) => {
    if (persistentSlots.has(persistentInput.slot)) {
      context.addIssue({
        code: "custom",
        path: ["persistentInputs", index, "slot"],
        message: `Duplicate Generator persistent input slot: ${persistentInput.slot}`,
      });
    }
    persistentSlots.add(persistentInput.slot);
  });

  const actionIds = new Set<string>();
  input.actions.forEach((action, index) => {
    if (actionIds.has(action.id)) {
      context.addIssue({
        code: "custom",
        path: ["actions", index, "id"],
        message: `Duplicate Generator action id: ${action.id}`,
      });
    }
    actionIds.add(action.id);
  });

  const surface = input.projectionSurface;
  if (!surface) return;
  if (!actionIds.has(surface.primaryActionId)) {
    context.addIssue({
      code: "custom",
      path: ["projectionSurface", "primaryActionId"],
      message: `Projection surface ${surface.id} names undefined Action ${surface.primaryActionId}.`,
    });
  }
  if (surface.mediaInputSlot && !persistentSlots.has(surface.mediaInputSlot)) {
    context.addIssue({
      code: "custom",
      path: ["projectionSurface", "mediaInputSlot"],
      message: `Projection surface ${surface.id} names undeclared persistent input slot ${surface.mediaInputSlot}.`,
    });
  }
}

/** Plugin-authored semantic definition before the Host injects package provenance. */
export let GeneratorDefinitionSpecSchema = lazySchema(() => (
z
  .object(generatorDefinitionSpecShape)
  .strict()
  .superRefine(validateGeneratorDefinitionSpec)
), (real) => { GeneratorDefinitionSpecSchema = real; });
export type GeneratorDefinitionSpec = z.infer<
  typeof GeneratorDefinitionSpecSchema
>;

export let GeneratorDefinitionSchema = lazySchema(() => (
GeneratorDefinitionRefSchema.extend({
  stateSchema: generatorDefinitionSpecShape.stateSchema,
  editPolicy: generatorDefinitionSpecShape.editPolicy,
  persistentInputs: generatorDefinitionSpecShape.persistentInputs,
  actions: generatorDefinitionSpecShape.actions,
  projectionSurface: generatorDefinitionSpecShape.projectionSurface,
})
  .strict()
  .superRefine(validateGeneratorDefinitionSpec)
), (real) => { GeneratorDefinitionSchema = real; });
export type GeneratorDefinition = z.infer<typeof GeneratorDefinitionSchema>;

export type ResolveGeneratorProjectionDefinitionResult =
  | { ok: true; definition: GeneratorDefinition }
  | {
      ok: false;
      code:
        | "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED"
        | "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS";
      surfaceId: GeneratorProjectionSurfaceId;
    };

/**
 * Resolve the single installed Definition that claims one compatibility
 * surface. Zero or several claims fail closed: a legacy entrypoint must never
 * guess which Generator family it is projecting.
 */
export function resolveGeneratorProjectionDefinition(
  definitions: readonly GeneratorDefinition[],
  surfaceId: GeneratorProjectionSurfaceId,
): ResolveGeneratorProjectionDefinitionResult {
  const claiming = definitions.filter(
    (definition) => definition.projectionSurface?.id === surfaceId,
  );
  if (claiming.length === 0) {
    return {
      ok: false,
      code: "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED",
      surfaceId,
    };
  }
  if (claiming.length > 1) {
    return {
      ok: false,
      code: "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS",
      surfaceId,
    };
  }
  return { ok: true, definition: claiming[0]! };
}

/** Persisted mutable Project identity. The definition is derived from its immutable head revision. */
export let ProjectGeneratorHeadSchema = lazySchema(() => (
z
  .object({
    id: nonEmptyIdSchema,
    headRevisionId: nonEmptyIdSchema,
  })
  .strict()
), (real) => { ProjectGeneratorHeadSchema = real; });
export type ProjectGeneratorHead = z.infer<typeof ProjectGeneratorHeadSchema>;

/** Read projection joining the persisted head with its immutable revision definition. */
export let ProjectGeneratorSchema = lazySchema(() => (
ProjectGeneratorHeadSchema.extend({
  definitionRef: GeneratorDefinitionRefSchema,
}).strict()
), (real) => { ProjectGeneratorSchema = real; });
export type ProjectGenerator = z.infer<typeof ProjectGeneratorSchema>;

export let GeneratorRevisionSchema = lazySchema(() => (
z
  .object({
    id: nonEmptyIdSchema,
    generatorId: nonEmptyIdSchema,
    definitionRef: GeneratorDefinitionRefSchema,
    parentRevisionId: nonEmptyIdSchema.optional(),
    forkedFrom: GeneratorRevisionRefSchema.optional(),
    state: jsonObjectSchema,
    persistentInputRefs: z.array(GeneratorInputRefSchema),
  })
  .strict()
  .superRefine(({ generatorId, forkedFrom }, context) => {
    if (forkedFrom?.generatorId === generatorId) {
      context.addIssue({
        code: "custom",
        path: ["forkedFrom", "generatorId"],
        message:
          "Same-Generator ancestry belongs in parentRevisionId, not forkedFrom.",
      });
    }
  })
), (real) => { GeneratorRevisionSchema = real; });
export type GeneratorRevision = z.infer<typeof GeneratorRevisionSchema>;

export let ActionRunStatusSchema = lazySchema(() => (
z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
])
), (real) => { ActionRunStatusSchema = real; });
export type ActionRunStatus = z.infer<typeof ActionRunStatusSchema>;

/**
 * Exact Provider implementation identity frozen by the Host at selection time.
 * A Card keeps 1:N providerImplementations; this pins the one the Run uses so
 * Settings validation, execution, and lineage cannot silently diverge.
 * Settings itself still persists only the Card id.
 */
export let ActionRunModelRouteSchema = lazySchema(() => (
z
  .object({
    providerId: nonEmptyIdSchema.optional(),
    accountId: nonEmptyIdSchema.optional(),
    region: nonEmptyIdSchema.optional(),
    upstreamId: nonEmptyIdSchema,
    upstreamModel: nonEmptyIdSchema,
    apiShape: nonEmptyIdSchema,
    executorPluginId: pluginIdSchema.optional(),
    executorExportId: nonEmptyIdSchema.optional(),
    /**
     * The exact Provider executor plugin/version/export the Host resolved and pinned at
     * selection time. A generic model-consumer Generator Action must dispatch to, and later
     * accept a staged media receipt from, only this exact frozen binding -- never a version the
     * Host happens to resolve fresh when the durable run later submits or polls.
     */
    executorBinding: z
      .object({
        pluginId: pluginIdSchema,
        version: z.string().trim().min(1),
        exportId: nonEmptyIdSchema,
        schemaHash: prefixedSha256Schema,
      })
      .strict()
      .optional(),
    /** Delivery declaration copied from the exact selected Provider route, frozen at selection. */
    assetInputs: z.array(ProviderAssetInputSchema).optional(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (!route.executorBinding) return;
    if (route.executorPluginId && route.executorBinding.pluginId !== route.executorPluginId) {
      ctx.addIssue({
        code: "custom",
        message: `executorBinding.pluginId (${route.executorBinding.pluginId}) does not match executorPluginId (${route.executorPluginId}).`,
        path: ["executorBinding", "pluginId"],
      });
    }
    if (route.executorExportId && route.executorBinding.exportId !== route.executorExportId) {
      ctx.addIssue({
        code: "custom",
        message: `executorBinding.exportId (${route.executorBinding.exportId}) does not match executorExportId (${route.executorExportId}).`,
        path: ["executorBinding", "exportId"],
      });
    }
  })
), (real) => { ActionRunModelRouteSchema = real; });
export type ActionRunModelRoute = z.infer<typeof ActionRunModelRouteSchema>;

/** Host-resolved Card selection frozen with the semantic Run authority. */
export let ActionRunModelSelectionSchema = lazySchema(() => (
z
  .object({
    semanticShape: z.string().trim().regex(/^[a-z][a-z0-9_]*$/),
    modelId: nonEmptyIdSchema,
    route: ActionRunModelRouteSchema,
  })
  .strict()
), (real) => { ActionRunModelSelectionSchema = real; });
export type ActionRunModelSelection = z.infer<
  typeof ActionRunModelSelectionSchema
>;

export let ActionRunRequestSchema = lazySchema(() => (
z
  .object({
    actionRunId: nonEmptyIdSchema,
    generatorRevision: GeneratorRevisionRefSchema,
    actionId: nonEmptyIdSchema,
    executor: GeneratorExecutorRefSchema,
    invocationFingerprint: prefixedSha256Schema,
    parameters: jsonObjectSchema,
    modelSelection: ActionRunModelSelectionSchema.optional(),
    invocationInputRefs: z.array(GeneratorInputRefSchema),
    outputContract: GeneratorActionOutputContractSchema,
  })
  .strict()
), (real) => { ActionRunRequestSchema = real; });
export type ActionRunRequest = z.infer<typeof ActionRunRequestSchema>;

export let ActionRunOutcomeSchema = lazySchema(() => (
z
  .object({
    actionRunId: nonEmptyIdSchema,
    status: z.enum(["succeeded", "failed"]),
  })
  .strict()
), (real) => { ActionRunOutcomeSchema = real; });
export type ActionRunOutcome = z.infer<typeof ActionRunOutcomeSchema>;

/** Read projection joining an immutable Run request with its coarse public state. */
export let ProjectActionRunSchema = lazySchema(() => (
ActionRunRequestSchema.extend({
  status: ActionRunStatusSchema,
}).strict()
), (real) => { ProjectActionRunSchema = real; });
export type ProjectActionRun = z.infer<typeof ProjectActionRunSchema>;

/** @deprecated Compatibility alias; persist ActionRunRequest and ActionRunOutcome instead. */
export const ActionRunSchema = ProjectActionRunSchema;
export type ActionRun = ProjectActionRun;

export let OutputCommitSchema = lazySchema(() => (
z
  .object({
    actionRunId: nonEmptyIdSchema,
    outputSlot: nonEmptyIdSchema,
    itemKey: nonEmptyIdSchema.optional(),
    asset: AssetRevisionRefSchema,
  })
  .strict()
), (real) => { OutputCommitSchema = real; });
export type OutputCommit = z.infer<typeof OutputCommitSchema>;
