import { z } from "zod";

import { AssetKindSchema } from "./assets.js";
import { ExecutablePluginJsonValueSchema } from "./plugin-json-value.js";
import { pluginIdSchema } from "./plugin-namespace.js";
import { ProviderAssetInputSchema } from "./models.js";

const nonEmptyIdSchema = z.string().trim().min(1);
const prefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const jsonObjectSchema = z.record(ExecutablePluginJsonValueSchema);
const GeneratorMediaKindSchema = AssetKindSchema;

export const GeneratorEditPolicySchema = z.enum([
  "advance-head",
  "fork-when-materialized",
]);
export type GeneratorEditPolicy = z.infer<typeof GeneratorEditPolicySchema>;

export const MediaAssetRevisionRefSchema = z
  .object({
    kind: z.literal("media"),
    projectAssetId: nonEmptyIdSchema,
  })
  .strict();
export type MediaAssetRevisionRef = z.infer<typeof MediaAssetRevisionRefSchema>;

export const DocumentAssetRevisionRefSchema = z
  .object({
    kind: z.literal("document"),
    documentAssetId: nonEmptyIdSchema,
    revisionId: nonEmptyIdSchema,
  })
  .strict();
export type DocumentAssetRevisionRef = z.infer<
  typeof DocumentAssetRevisionRefSchema
>;

export const AssetRevisionRefSchema = z.discriminatedUnion("kind", [
  MediaAssetRevisionRefSchema,
  DocumentAssetRevisionRefSchema,
]);
export type AssetRevisionRef = z.infer<typeof AssetRevisionRefSchema>;

export const GeneratorRevisionRefSchema = z
  .object({
    generatorId: nonEmptyIdSchema,
    generatorRevisionId: nonEmptyIdSchema,
  })
  .strict();
export type GeneratorRevisionRef = z.infer<typeof GeneratorRevisionRefSchema>;

export const GeneratorInputTargetSchema = z.union([
  AssetRevisionRefSchema,
  GeneratorRevisionRefSchema,
]);
export type GeneratorInputTarget = z.infer<typeof GeneratorInputTargetSchema>;

export const GeneratorInputRefSchema = z
  .object({
    slot: nonEmptyIdSchema,
    itemKey: nonEmptyIdSchema.optional(),
    target: GeneratorInputTargetSchema,
  })
  .strict();
export type GeneratorInputRef = z.infer<typeof GeneratorInputRefSchema>;

export const GeneratorDefinitionRefSchema = z
  .object({
    pluginId: pluginIdSchema,
    definitionId: nonEmptyIdSchema,
    version: nonEmptyIdSchema,
    schemaHash: prefixedSha256Schema,
  })
  .strict();
export type GeneratorDefinitionRef = z.infer<
  typeof GeneratorDefinitionRefSchema
>;

/**
 * The exact semantic function selected for one Run. Runtime placement, account
 * selection, process ids, and retry state are Host-private Task facts and are
 * deliberately absent.
 */
export const GeneratorExecutorRefSchema = z
  .object({
    pluginId: pluginIdSchema,
    version: nonEmptyIdSchema,
    exportId: nonEmptyIdSchema,
    schemaHash: prefixedSha256Schema,
  })
  .strict();
export type GeneratorExecutorRef = z.infer<typeof GeneratorExecutorRefSchema>;

export const GeneratorMediaAssetTypeSchema = z
  .object({
    kind: z.literal("media"),
    mediaKind: AssetKindSchema,
  })
  .strict();
export type GeneratorMediaAssetType = z.infer<
  typeof GeneratorMediaAssetTypeSchema
>;

export const GeneratorDocumentAssetTypeSchema = z
  .object({
    kind: z.literal("document"),
    documentKind: nonEmptyIdSchema,
    schemaVersion: z.number().int().positive(),
  })
  .strict();
export type GeneratorDocumentAssetType = z.infer<
  typeof GeneratorDocumentAssetTypeSchema
>;

export const GeneratorAssetTypeSchema = z.discriminatedUnion("kind", [
  GeneratorMediaAssetTypeSchema,
  GeneratorDocumentAssetTypeSchema,
]);
export type GeneratorAssetType = z.infer<typeof GeneratorAssetTypeSchema>;

export const GeneratorInputCardinalitySchema = z
  .object({
    minItems: z.number().int().nonnegative(),
    maxItems: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine(({ minItems, maxItems }, context) => {
    if (maxItems !== null && maxItems < minItems) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxItems"],
        message: "maxItems must be greater than or equal to minItems.",
      });
    }
  });
export type GeneratorInputCardinality = z.infer<
  typeof GeneratorInputCardinalitySchema
>;

export const GeneratorActionInputCardinalitySchema =
  GeneratorInputCardinalitySchema;
export type GeneratorActionInputCardinality = GeneratorInputCardinality;

export const GeneratorFamilyInputTypeSchema = z
  .object({
    kind: z.literal("generator"),
    pluginId: pluginIdSchema,
    definitionId: nonEmptyIdSchema,
  })
  .strict();
export type GeneratorFamilyInputType = z.infer<
  typeof GeneratorFamilyInputTypeSchema
>;

export const GeneratorInputTypeSchema = z.discriminatedUnion("kind", [
  GeneratorMediaAssetTypeSchema,
  GeneratorDocumentAssetTypeSchema,
  GeneratorFamilyInputTypeSchema,
]);
export type GeneratorInputType = z.infer<typeof GeneratorInputTypeSchema>;

export const GeneratorInputPortSchema = z
  .object({
    slot: nonEmptyIdSchema,
    accepts: z.array(GeneratorInputTypeSchema).min(1),
    cardinality: GeneratorInputCardinalitySchema,
  })
  .strict();
export type GeneratorInputPort = z.infer<typeof GeneratorInputPortSchema>;

export const GeneratorActionInputPortSchema = GeneratorInputPortSchema;
export type GeneratorActionInputPort = GeneratorInputPort;

export const GeneratorActionOutputCardinalitySchema =
  GeneratorInputCardinalitySchema;
export type GeneratorActionOutputCardinality = GeneratorInputCardinality;

export const GeneratorActionOutputPortSchema = z
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
  .strict();
export type GeneratorActionOutputPort = z.infer<
  typeof GeneratorActionOutputPortSchema
>;

export const GeneratorActionOutputContractSchema = z
  .array(GeneratorActionOutputPortSchema)
  .min(1)
  .superRefine((outputs, context) => {
    const slots = new Set<string>();
    outputs.forEach((output, index) => {
      if (slots.has(output.slot)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
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
          code: z.ZodIssueCode.custom,
          path: [index, "cardinality"],
          message:
            "The current Generator Action profile requires singular 0..1 or 1..1 output slots.",
        });
      }
    });
  });
export type GeneratorActionOutputContract = z.infer<
  typeof GeneratorActionOutputContractSchema
>;

export const GeneratorActionDefinitionSchema = z
  .object({
    id: nonEmptyIdSchema,
    executorExportId: nonEmptyIdSchema,
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
  .superRefine(({ invocationInputs, modelConsumer }, context) => {
    const seen = new Set<string>();
    invocationInputs.forEach((input, index) => {
      if (seen.has(input.slot)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
        path: ["modelConsumer", "sourceInputSlot"],
        message: `Model consumer source slot ${modelConsumer.sourceInputSlot} is not declared.`,
      });
    }
  });
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

export const GeneratorProjectionSurfaceIdSchema = z.enum(
  GENERATOR_PROJECTION_SURFACE_IDS,
);
export type GeneratorProjectionSurfaceId = z.infer<
  typeof GeneratorProjectionSurfaceIdSchema
>;

export const GeneratorProjectionSurfaceSchema = z
  .object({
    id: GeneratorProjectionSurfaceIdSchema,
    /** Generator state key holding the legacy editable document. */
    stateKey: nonEmptyIdSchema,
    /** Persistent input slot that receives the legacy document's media items. */
    mediaInputSlot: nonEmptyIdSchema.optional(),
    /** Action the legacy render/capture entrypoint submits. */
    primaryActionId: nonEmptyIdSchema,
  })
  .strict();
export type GeneratorProjectionSurface = z.infer<
  typeof GeneratorProjectionSurfaceSchema
>;

const generatorDefinitionSpecShape = {
  definitionId: nonEmptyIdSchema,
  stateSchema: jsonObjectSchema,
  editPolicy: GeneratorEditPolicySchema,
  persistentInputs: z.array(GeneratorInputPortSchema),
  actions: z.array(GeneratorActionDefinitionSchema).min(1),
  projectionSurface: GeneratorProjectionSurfaceSchema.optional(),
} as const;

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
        code: z.ZodIssueCode.custom,
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
        code: z.ZodIssueCode.custom,
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
      code: z.ZodIssueCode.custom,
      path: ["projectionSurface", "primaryActionId"],
      message: `Projection surface ${surface.id} names undefined Action ${surface.primaryActionId}.`,
    });
  }
  if (surface.mediaInputSlot && !persistentSlots.has(surface.mediaInputSlot)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectionSurface", "mediaInputSlot"],
      message: `Projection surface ${surface.id} names undeclared persistent input slot ${surface.mediaInputSlot}.`,
    });
  }
}

/** Plugin-authored semantic definition before the Host injects package provenance. */
export const GeneratorDefinitionSpecSchema = z
  .object(generatorDefinitionSpecShape)
  .strict()
  .superRefine(validateGeneratorDefinitionSpec);
export type GeneratorDefinitionSpec = z.infer<
  typeof GeneratorDefinitionSpecSchema
>;

export const GeneratorDefinitionSchema = GeneratorDefinitionRefSchema.extend({
  stateSchema: generatorDefinitionSpecShape.stateSchema,
  editPolicy: generatorDefinitionSpecShape.editPolicy,
  persistentInputs: generatorDefinitionSpecShape.persistentInputs,
  actions: generatorDefinitionSpecShape.actions,
  projectionSurface: generatorDefinitionSpecShape.projectionSurface,
})
  .strict()
  .superRefine(validateGeneratorDefinitionSpec);
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
export const ProjectGeneratorHeadSchema = z
  .object({
    id: nonEmptyIdSchema,
    headRevisionId: nonEmptyIdSchema,
  })
  .strict();
export type ProjectGeneratorHead = z.infer<typeof ProjectGeneratorHeadSchema>;

/** Read projection joining the persisted head with its immutable revision definition. */
export const ProjectGeneratorSchema = ProjectGeneratorHeadSchema.extend({
  definitionRef: GeneratorDefinitionRefSchema,
}).strict();
export type ProjectGenerator = z.infer<typeof ProjectGeneratorSchema>;

export const GeneratorRevisionSchema = z
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
        code: z.ZodIssueCode.custom,
        path: ["forkedFrom", "generatorId"],
        message:
          "Same-Generator ancestry belongs in parentRevisionId, not forkedFrom.",
      });
    }
  });
export type GeneratorRevision = z.infer<typeof GeneratorRevisionSchema>;

export const ActionRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
]);
export type ActionRunStatus = z.infer<typeof ActionRunStatusSchema>;

/**
 * Exact Provider implementation identity frozen by the Host at selection time.
 * A Card keeps 1:N providerImplementations; this pins the one the Run uses so
 * Settings validation, execution, and lineage cannot silently diverge.
 * Settings itself still persists only the Card id.
 */
export const ActionRunModelRouteSchema = z
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
        code: z.ZodIssueCode.custom,
        message: `executorBinding.pluginId (${route.executorBinding.pluginId}) does not match executorPluginId (${route.executorPluginId}).`,
        path: ["executorBinding", "pluginId"],
      });
    }
    if (route.executorExportId && route.executorBinding.exportId !== route.executorExportId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `executorBinding.exportId (${route.executorBinding.exportId}) does not match executorExportId (${route.executorExportId}).`,
        path: ["executorBinding", "exportId"],
      });
    }
  });
export type ActionRunModelRoute = z.infer<typeof ActionRunModelRouteSchema>;

/** Host-resolved Card selection frozen with the semantic Run authority. */
export const ActionRunModelSelectionSchema = z
  .object({
    semanticShape: z.string().trim().regex(/^[a-z][a-z0-9_]*$/),
    modelId: nonEmptyIdSchema,
    route: ActionRunModelRouteSchema,
  })
  .strict();
export type ActionRunModelSelection = z.infer<
  typeof ActionRunModelSelectionSchema
>;

export const ActionRunRequestSchema = z
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
  .strict();
export type ActionRunRequest = z.infer<typeof ActionRunRequestSchema>;

export const ActionRunOutcomeSchema = z
  .object({
    actionRunId: nonEmptyIdSchema,
    status: z.enum(["succeeded", "failed"]),
  })
  .strict();
export type ActionRunOutcome = z.infer<typeof ActionRunOutcomeSchema>;

/** Read projection joining an immutable Run request with its coarse public state. */
export const ProjectActionRunSchema = ActionRunRequestSchema.extend({
  status: ActionRunStatusSchema,
}).strict();
export type ProjectActionRun = z.infer<typeof ProjectActionRunSchema>;

/** @deprecated Compatibility alias; persist ActionRunRequest and ActionRunOutcome instead. */
export const ActionRunSchema = ProjectActionRunSchema;
export type ActionRun = ProjectActionRun;

export const OutputCommitSchema = z
  .object({
    actionRunId: nonEmptyIdSchema,
    outputSlot: nonEmptyIdSchema,
    itemKey: nonEmptyIdSchema.optional(),
    asset: AssetRevisionRefSchema,
  })
  .strict();
export type OutputCommit = z.infer<typeof OutputCommitSchema>;
