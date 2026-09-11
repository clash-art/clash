import { pluginCapabilities } from "./plugin-capabilities.js";
import { z } from "zod";

import { AssetKindSchema } from "./assets.js";
import { AspectRatioStringSchema } from "./aspect-ratio.js";
import { pluginIdSchema } from "./plugin-namespace.js";
import { PluginAuthDeclarationSchema } from "./plugin-auth.js";
import { AsrTimedTranscriptSchema } from "./production-metadata.js";
import {
  GeneratorDefinitionSchema,
  GeneratorDefinitionSpecSchema,
  type GeneratorDefinition,
  type GeneratorDefinitionSpec,
  type GeneratorInputType,
} from "./generator-v2.js";
export {
  GeneratorDefinitionSpecSchema,
  type GeneratorDefinition,
} from "./generator-v2.js";
import {
  MediaAnalysisCategorySchema,
  MediaAnalysisDocumentSchemas,
  type MediaAnalysisCategory,
} from "./media-analysis-documents.js";

export {
  MEDIA_ANALYSIS_DOCUMENT_KIND_BY_CATEGORY,
  MediaAnalysisCategorySchema,
  MediaAnalysisDocumentSchemas,
  type MediaAnalysisCategory,
} from "./media-analysis-documents.js";
import {
  ExecutablePluginJsonValueSchema,
  type ExecutablePluginJsonValue,
} from "./plugin-json-value.js";
export {
  ExecutablePluginJsonValueSchema,
  type ExecutablePluginJsonValue,
} from "./plugin-json-value.js";

// Re-exported so a plugin reaches it through the one entry it already imports. The package index
// pulls in loro-crdt, which is CommonJS, and bundling that into an ESM plugin turns its first
// import into "Dynamic require of ... is not supported" at spawn.
export {
  PluginAuthDeclarationSchema,
  PluginAuthFlowSchema,
  PluginAuthFormItemSchema,
  PluginAuthRenewSchema,
  type PluginAuthDeclaration,
  type PluginAuthFormItem,
} from "./plugin-auth.js";

// Re-exported so a plugin can reach everything the protocol mentions through this one entry. The
// package index pulls in loro-crdt, which is CommonJS, and bundling that into an ESM plugin turns
// its first import into "Dynamic require of ... is not supported" at spawn.
export { AssetKindSchema, type AssetKind } from "./assets.js";
export {
  AspectRatioStringSchema,
  aspectRatioLabel,
  parseAspectRatio,
  reduceAspectRatio,
  type AspectRatio,
} from "./aspect-ratio.js";
import {
  ModelCardSchema,
  ModelConstraintRuleSchema,
  ModelInputRuleSchema,
  ModelParameterSchema,
  ModelProviderImplementationSchema,
  ProviderAssetInputSchema,
  type ModelCard,
} from "./models.js";

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isSafePluginRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("\\")) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

export const PluginRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    isSafePluginRelativePath,
    "Plugin paths must be relative and cannot contain dot segments.",
  );

export const ExecutablePluginRuntimeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    transport: z.literal("stdio"),
    /**
     * Which interpreter the host launches.
     *
     * A closed enum rather than a command line: the host owns the launch protocol,
     * stdio framing, and process lifecycle for each supported runtime. A plugin that
     * could name an arbitrary command would no longer have a predictable adapter.
     *
     * Optional only so the two manifests written before this field existed keep
     * loading; `resolvePluginLanguage` falls back to the entrypoint extension.
     * New drafts always declare it.
     */
    language: z.enum(["node", "python"]).optional(),
    entrypoint: PluginRelativePathSchema,
    args: z.array(z.string()).default([]),
    /**
     * Declares that the entrypoint is derived from source.
     *
     * Present means the host compiles `source` into `entrypoint` before validating,
     * contract-testing, or activating, so a stale bundle cannot be packaged. Absent
     * means the entrypoint is authored directly and the host never overwrites it --
     * which is the normal case for Python, and for a hand-written `.mjs`.
     */
    build: z
      .object({
        source: PluginRelativePathSchema,
      })
      .strict()
      .optional(),
    /** Immutable package payloads the executor reads at runtime, never Host paths or invocation data. */
    resources: z.array(PluginRelativePathSchema).optional(),
  }),
  z.object({
    kind: z.literal("hosted"),
    transport: z.literal("http"),
    endpoint: z.string().url(),
    resources: z.never().optional(),
  }),
]);

/**
 * The interpreter for a local plugin.
 *
 * Declared `language` wins. Older manifests are inferred from the entrypoint
 * extension, which is what the loader used to do unconditionally -- the reason a
 * `.ts` entrypoint was impossible and why the extension whitelist doubled as a
 * language dispatcher.
 */
export function resolvePluginLanguage(runtime: {
  kind: string;
  language?: "node" | "python";
  entrypoint?: string;
}): "node" | "python" | undefined {
  if (runtime.kind !== "local") return undefined;
  if (runtime.language) return runtime.language;
  const entrypoint = runtime.entrypoint ?? "";
  return entrypoint.toLowerCase().endsWith(".py") ? "python" : "node";
}

export const ExecutablePluginCardExportSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    kind: z.enum(["model-card", "action-card"]),
    path: PluginRelativePathSchema,
  })
  .strict();

export const ExecutablePluginProviderExportSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    kind: z.literal("provider"),
    path: PluginRelativePathSchema,
  })
  .strict();

export const ExecutablePluginModelBindingExportSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    kind: z.literal("model-provider-binding"),
    path: PluginRelativePathSchema,
  })
  .strict();

export const ExecutablePluginGeneratorExportSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    kind: z.literal("generator"),
    path: PluginRelativePathSchema,
  })
  .strict();

export const ExecutablePluginViewExportSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    kind: z.literal("view"),
    path: PluginRelativePathSchema,
  })
  .strict();

export const ExecutableActionPresentationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("form"),
    })
    .strict(),
  z
    .object({
      type: z.literal("dialog"),
      size: z.enum(["sm", "md", "lg", "xl"]).default("lg"),
      title: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("workspace"),
      resourceUri: z.string().regex(/^ui:\/\/[a-z0-9][a-z0-9._/-]*$/),
    })
    .strict(),
]);

/** A text form input consumes a plain-text Document, not an arbitrary typed record. */
export function executableActionCardInputAcceptsType(type: GeneratorInputType, modality: string): boolean {
  return modality === "text"
    ? type.kind === "document" && type.documentKind === "text.plain" && type.schemaVersion === 1
    : type.kind === "media" && type.mediaKind === modality;
}

export const ExecutableActionCardGeneratorSchema = z.object({
  definitionId: z.string().trim().min(1),
  actionId: z.string().trim().min(1),
  inputSlots: z.object({
    text: z.string().trim().min(1).optional(),
    image: z.string().trim().min(1).optional(),
    video: z.string().trim().min(1).optional(),
    audio: z.string().trim().min(1).optional(),
  }).strict().default({}),
}).strict();

export const ExecutableActionCardSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    parameters: z.array(ModelParameterSchema).default([]),
    outputType: z.enum(["image", "video", "audio", "text"]),
    input: ModelInputRuleSchema.default({
      requiresPrompt: true,
      inputMode: {},
      promptModalities: ["text"],
    }),
    constraints: z.array(ModelConstraintRuleSchema).optional(),
    presentation: ExecutableActionPresentationSchema.default({ type: "form" }),
    functionExportId: z.string().trim().regex(PLUGIN_ID_PATTERN),
    /** Legacy form fields edit top-level Generator state; media references use these explicit persistent slots. */
    generator: ExecutableActionCardGeneratorSchema.optional(),
    maxRuntimeMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    const parameterIds = new Set<string>();
    for (const [index, parameter] of action.parameters.entries()) {
      if (parameterIds.has(parameter.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", index, "id"],
          message: "Action parameter ids must be unique.",
        });
      }
      parameterIds.add(parameter.id);

      if (parameter.type === "select") {
        const candidates =
          parameter.options?.map((option) => option.value) ?? [];
        if (candidates.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parameters", index, "options"],
            message: "Select parameters require at least one candidate.",
          });
        }
        if (
          new Set(candidates.map((value) => `${typeof value}:${String(value)}`))
            .size !== candidates.length
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parameters", index, "options"],
            message: "Select parameter candidate values must be unique.",
          });
        }
        if (
          parameter.defaultValue !== undefined &&
          !candidates.some((value) => value === parameter.defaultValue)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parameters", index, "defaultValue"],
            message: `${parameter.label} defaultValue must be one of its configured candidates.`,
          });
        }
      }
      if (parameter.readOnly && parameter.defaultValue === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", index, "defaultValue"],
          message: `${parameter.label} is read-only and requires a fixed default.`,
        });
      }
      if (
        (parameter.type === "number" || parameter.type === "slider") &&
        parameter.defaultValue !== undefined
      ) {
        if (
          typeof parameter.defaultValue !== "number" ||
          !Number.isFinite(parameter.defaultValue)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parameters", index, "defaultValue"],
            message: `${parameter.label} default must be a finite number.`,
          });
        } else if (
          (parameter.min !== undefined &&
            parameter.defaultValue < parameter.min) ||
          (parameter.max !== undefined &&
            parameter.defaultValue > parameter.max)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["parameters", index, "defaultValue"],
            message: `${parameter.label} default must stay within its configured range.`,
          });
        }
      }
      if (
        parameter.type === "boolean" &&
        parameter.defaultValue !== undefined &&
        typeof parameter.defaultValue !== "boolean"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["parameters", index, "defaultValue"],
          message: `${parameter.label} default must be a boolean.`,
        });
      }
    }

    const validateConstraintField = (
      field: string,
      path: Array<string | number>,
    ) => {
      if (!field.startsWith("modelParams.")) return;
      if (parameterIds.has(field.slice("modelParams.".length))) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `Action constraint ${field} must reference a declared parameter.`,
      });
    };
    for (const [index, rule] of (action.constraints ?? []).entries()) {
      if (rule.type === "mutually-exclusive") {
        rule.fields.forEach((field, fieldIndex) =>
          validateConstraintField(field, [
            "constraints",
            index,
            "fields",
            fieldIndex,
          ]),
        );
        continue;
      }
      validateConstraintField(rule.field, ["constraints", index, "field"]);
      if (rule.type === "required") {
        rule.when.forEach((condition, conditionIndex) =>
          validateConstraintField(condition.field, [
            "constraints",
            index,
            "when",
            conditionIndex,
            "field",
          ]),
        );
      }
    }
  });

export const ExecutablePluginCardDocumentSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        apiVersion: z.literal("clash.card/v1"),
        kind: z.literal("model-card"),
        spec: ModelCardSchema,
      })
      .strict(),
    z
      .object({
        apiVersion: z.literal("clash.card/v1"),
        kind: z.literal("action-card"),
        spec: ExecutableActionCardSchema,
      })
      .strict(),
  ])
  .superRefine((document, ctx) => {
    if (document.kind !== "model-card") return;
    document.spec.providerImplementations?.forEach((implementation, index) => {
      if (implementation.accountId === undefined) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["spec", "providerImplementations", index, "accountId"],
        message:
          "Plugin model Cards cannot select a Provider account; the Host selects it at runtime.",
      });
    });
  });

export const ExecutablePluginGeneratorDocumentSchema = z
  .object({
    apiVersion: z.literal("clash.generator/v1"),
    kind: z.literal("generator"),
    spec: GeneratorDefinitionSpecSchema,
  })
  .strict();
export type ExecutablePluginGeneratorDocument = z.infer<
  typeof ExecutablePluginGeneratorDocumentSchema
>;

/** One immutable Project Asset offered as a candidate for a View material slot. */
export const StoryboardViewResourceSchema = z
  .object({
    id: z.string().trim().min(1),
    projectAssetId: z.string().trim().min(1),
    mediaKind: z.enum(["image", "video", "audio", "model"]),
    modelName: z.string().trim().min(1).optional(),
    generatedBy: z
      .object({
        generatorId: z.string().trim().min(1),
        generatorRevisionId: z.string().trim().min(1),
        actionRunId: z.string().trim().min(1),
        outputCommitId: z.string().trim().min(1),
        outputSlot: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StoryboardViewResource = z.infer<typeof StoryboardViewResourceSchema>;

export const StoryboardViewDescriptionPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      type: z.literal("entity-reference"),
      entityId: z.string().trim().min(1),
    })
    .strict(),
]);

export const StoryboardViewMaterialSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1).optional(),
    mediaKind: z.enum(["image", "video", "audio", "model"]),
    promptDraft: z
      .object({
        id: z.string().trim().min(1),
        text: z.string(),
      })
      .strict()
      .optional(),
    candidates: z.array(StoryboardViewResourceSchema).default([]),
    selectedCandidateId: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((material, ctx) => {
    if (
      material.selectedCandidateId &&
      !material.candidates.some(
        (candidate) => candidate.id === material.selectedCandidateId,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedCandidateId"],
        message: "A selected candidate must belong to the same material slot.",
      });
    }
    const candidateIds = new Set<string>();
    material.candidates.forEach((candidate, index) => {
      if (candidateIds.has(candidate.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "id"],
          message: "Candidate ids must be unique within a material slot.",
        });
      }
      candidateIds.add(candidate.id);
      if (candidate.mediaKind !== material.mediaKind) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", index, "mediaKind"],
          message: "A candidate must match its material slot media kind.",
        });
      }
    });
  });
export type StoryboardViewMaterial = z.infer<typeof StoryboardViewMaterialSchema>;

const StoryboardViewItemBaseSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  description: z.array(StoryboardViewDescriptionPartSchema).default([]),
  details: z.string().optional(),
  materials: z.array(StoryboardViewMaterialSchema).default([]),
});

export const StoryboardViewItemSchema = StoryboardViewItemBaseSchema.strict();
export const StoryboardViewShotSchema = StoryboardViewItemBaseSchema.extend({
  durationSeconds: z.number().finite().positive().optional(),
}).strict();
export type StoryboardViewItem = z.infer<typeof StoryboardViewItemSchema>;
export type StoryboardViewShot = z.infer<typeof StoryboardViewShotSchema>;

/**
 * Trace-backed Storyboard projection. It is draft structure only: generation is performed by an
 * installed native Generator and its Output Commit is attached as a resource candidate.
 */
export const StoryboardViewStateSchema = z
  .object({
    keyElements: z.array(StoryboardViewItemSchema),
    shots: z.array(StoryboardViewShotSchema),
    audioLayers: z.array(StoryboardViewItemSchema),
    uncategorized: z.array(StoryboardViewResourceSchema),
  })
  .strict();
export type StoryboardViewState = z.infer<typeof StoryboardViewStateSchema>;

export const ExecutablePluginViewDocumentSchema = z
  .object({
    apiVersion: z.literal("clash.view/v1"),
    kind: z.literal("view"),
    spec: z
      .object({
        definitionId: z.string().trim().regex(PLUGIN_ID_PATTERN),
        name: z.string().trim().min(1),
        description: z.string().trim().min(1).optional(),
        presentation: z.object({ type: z.literal("storyboard") }).strict(),
        initialState: StoryboardViewStateSchema,
      })
      .strict(),
  })
  .strict();
export type ExecutablePluginViewDocument = z.infer<
  typeof ExecutablePluginViewDocumentSchema
>;

export const ExecutablePluginViewReferenceSchema = z
  .object({
    pluginId: pluginIdSchema,
    definitionId: z.string().trim().regex(PLUGIN_ID_PATTERN),
    version: z.string().trim().regex(SEMVER_PATTERN),
    schemaHash: z.string().regex(SHA256_PATTERN),
  })
  .strict();
export type ExecutablePluginViewReference = z.infer<
  typeof ExecutablePluginViewReferenceSchema
>;

export const ExecutablePluginProviderDefinitionSchema = z
  .object({
    /**
     * What this provider needs to authenticate, and how to draw it.
     *
     * Optional because a provider may need nothing -- a local model has no credential. Present, it is
     * the whole of what the host knows: it renders the form, stores the answers opaquely, wakes the
     * plugin on the declared schedule, and never learns what any of the values mean.
     */
    auth: PluginAuthDeclarationSchema.optional(),
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    upstreamId: z.string().trim().regex(PLUGIN_ID_PATTERN),
    apiShape: z.string().trim().regex(PLUGIN_ID_PATTERN),
    executorExportId: z.string().trim().regex(PLUGIN_ID_PATTERN),
    /**
     * Route values every binding of this provider inherits.
     *
     * A binding carries two facts: which catalogue model it routes, and the name that
     * model has upstream. The rest of the route -- provider id, upstream, api shape,
     * executor, credentials, priority -- belongs to the provider. Repeating it per
     * binding produced no information and one real hazard: a single mistyped copy
     * yields a route pointing at the wrong upstream while every sibling looks correct.
     */
    bindingDefaults: z
      .object({
        priority: z.number().nonnegative().optional(),
        weight: z.number().nonnegative().optional(),
        region: z.string().trim().min(1).optional(),
        /** Host delivery forms this Provider implementation accepts for typed media inputs. */
        assetInputs: z.array(ProviderAssetInputSchema).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ExecutablePluginProviderDocumentSchema = z
  .object({
    apiVersion: z.literal("clash.provider/v1"),
    kind: z.literal("provider"),
    spec: ExecutablePluginProviderDefinitionSchema,
  })
  .strict();

export const ExecutablePluginModelBindingSpecSchema = z
  .intersection(
    z.object({
      id: z.string().trim().regex(PLUGIN_ID_PATTERN),
      modelId: z.string().trim().min(1),
    }),
    ModelProviderImplementationSchema,
  )
  .superRefine((binding, ctx) => {
    if (binding.accountId === undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accountId"],
      message:
        "Plugin model bindings cannot select a Provider account; the Host selects it at runtime.",
    });
  });

/**
 * The two facts a binding actually carries.
 *
 * Everything else about a route -- provider id, upstream, api shape, executor,
 * credentials, priority -- belongs to the provider document that owns the binding.
 */
export const ExecutablePluginModelBindingInputSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN).optional(),
    modelId: z
      .string()
      .trim()
      .min(1, "A binding must name the model it routes (modelId)."),
    upstreamModel: z
      .string()
      .trim()
      .min(1, "A binding must name its upstreamModel."),
    providerId: z.string().trim().min(1).optional(),
    upstreamId: z.string().trim().min(1).optional(),
    apiShape: z.string().trim().min(1).optional(),
    executorExportId: z.string().trim().min(1).optional(),
    requiredOAuth: z.array(z.string()).optional(),
    assetInputs: z.array(ProviderAssetInputSchema).optional(),
    priority: z.number().optional(),
    weight: z.number().optional(),
    region: z.string().trim().min(1).optional(),
  })
  .passthrough()
  .superRefine((binding, ctx) => {
    if (binding.accountId === undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["accountId"],
      message:
        "Plugin model bindings cannot select a Provider account; the Host selects it at runtime.",
    });
  });

/**
 * Fill a binding's route from the provider that owns it.
 *
 * The binding stays the two facts it carries; the provider supplies the rest, and an
 * explicit value on the binding still wins. Written out per binding, those shared
 * fields were 186 duplicated values across `hilo-hub-media`'s 31 files -- no added
 * information, and one mistyped copy would route a model at the wrong upstream while
 * every sibling looked correct.
 *
 * `requiredOAuth` is no longer derived from the provider's auth. It used to be: the
 * old auth array was a union over auth *types*, and the `oauth`, `derived-token` and
 * `local-token-import` members each carried an `id` naming one acquisition a route
 * had to wait for. The declarative model has no such ids -- a provider declares form
 * keys, an optional browser flow and an optional renewal schedule, none of which is
 * a named acquisition -- so there is nothing left to derive from. A binding that
 * needs a route to wait states `requiredOAuth` itself.
 */
export function resolveModelBindingFromProvider(
  binding: z.input<typeof ExecutablePluginModelBindingInputSchema>,
  provider: z.infer<typeof ExecutablePluginProviderDefinitionSchema>,
): Record<string, unknown> {
  const parsed = ExecutablePluginModelBindingInputSchema.parse(binding);
  const defaults = provider.bindingDefaults ?? {};

  const resolved: Record<string, unknown> = {
    ...parsed,
    id: parsed.id ?? `${provider.id}-${parsed.modelId}`,
    providerId: parsed.providerId ?? provider.id,
    upstreamId: parsed.upstreamId ?? provider.upstreamId,
    apiShape: parsed.apiShape ?? provider.apiShape,
    executorExportId: parsed.executorExportId ?? provider.executorExportId,
  };

  if (parsed.requiredOAuth) resolved.requiredOAuth = parsed.requiredOAuth;
  else delete resolved.requiredOAuth;

  for (const key of ["priority", "weight", "region"] as const) {
    const value = parsed[key] ?? defaults[key];
    if (value === undefined) delete resolved[key];
    else resolved[key] = value;
  }

  const assetInputs = parsed.assetInputs ?? defaults.assetInputs;
  if (assetInputs === undefined) {
    delete resolved.assetInputs;
  } else {
    resolved.assetInputs = assetInputs.map((input) => ({
      match: {
        ...(input.match.kinds ? { kinds: [...input.match.kinds] } : {}),
        ...(input.match.slots ? { slots: [...input.match.slots] } : {}),
      },
      representations: [...input.representations],
      ...(input.mediaTypes ? { mediaTypes: [...input.mediaTypes] } : {}),
    }));
  }

  return resolved;
}

export const ExecutablePluginModelBindingDocumentSchema = z
  .object({
    apiVersion: z.literal("clash.binding/v1"),
    kind: z.literal("model-provider-binding"),
    spec: ExecutablePluginModelBindingSpecSchema,
  })
  .strict();

/**
 * The operations an entry point answers.
 *
 * Declared rather than discovered. The alternative is to find out by sending a poll and seeing
 * whether the plugin understands it -- after the work was submitted and billed, which is the worst
 * moment to learn that nobody can collect the result.
 *
 * It also reserves what a future callback-capable Host may offer. A callback address may go only
 * to an entry that says it handles callbacks; current Hosts do not issue callback addresses or
 * deliver callback invocations.
 */
export const PLUGIN_ENTRY_OPERATIONS = ["submit", "poll", "callback"] as const;

export const PluginEntryOperationSchema = z.enum(PLUGIN_ENTRY_OPERATIONS);
export type PluginEntryOperation = z.infer<typeof PluginEntryOperationSchema>;

export const ExecutablePluginFunctionExportSchema = z
  .object({
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    kind: z.enum(["action", "provider-projector", "provider-executor"]),
    /** Delivery forms accepted directly by an Action's own executor. */
    assetInputs: z.array(ProviderAssetInputSchema).optional(),
    /** Defaults to submit-only: the simplest plugin declares nothing and gets the simplest contract. */
    operations: z
      .array(PluginEntryOperationSchema)
      .nonempty()
      .default(["submit"]),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.kind !== "action" && entry.assetInputs !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assetInputs"],
        message:
          "Only Action exports declare Asset delivery; Provider delivery belongs to the selected binding.",
      });
    }
    if (!entry.operations.includes("submit")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operations"],
        message:
          "An entry must handle submit; nothing can be polled that was never started.",
      });
    }
    if (
      entry.operations.includes("callback") &&
      !entry.operations.includes("poll")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["operations"],
        message:
          "An entry handling callbacks must also handle poll. A callback that never arrives is an " +
          "ordinary event -- providers drop them and networks partition -- and without a poll to " +
          "fall back on the work is lost.",
      });
    }
  });

/** Activated Card plus the exact package provenance that supplied it. */
export const ExecutablePluginCardRegistrationSchema = z
  .object({
    pluginId: pluginIdSchema,
    version: z.string().trim().regex(SEMVER_PATTERN),
    schemaHash: z.string().regex(SHA256_PATTERN),
    runtime: ExecutablePluginRuntimeSchema,
    document: ExecutablePluginCardDocumentSchema,
  })
  .strict();

const ExecutablePluginArtifactRegistrationBaseSchema = z.object({
  pluginId: pluginIdSchema,
  version: z.string().trim().regex(SEMVER_PATTERN),
  schemaHash: z.string().regex(SHA256_PATTERN),
  runtime: ExecutablePluginRuntimeSchema,
});

export const ExecutablePluginProviderRegistrationSchema =
  ExecutablePluginArtifactRegistrationBaseSchema.extend({
    document: ExecutablePluginProviderDocumentSchema,
  }).strict();

export const ExecutablePluginModelBindingRegistrationSchema =
  ExecutablePluginArtifactRegistrationBaseSchema.extend({
    document: ExecutablePluginModelBindingDocumentSchema,
  }).strict();

/** Generator registrations carry semantic package provenance, never a Host execution realm. */
export const ExecutablePluginGeneratorRegistrationSchema = z
  .object({
    pluginId: pluginIdSchema,
    version: z.string().trim().regex(SEMVER_PATTERN),
    schemaHash: z.string().regex(SHA256_PATTERN),
    document: ExecutablePluginGeneratorDocumentSchema,
  })
  .strict();
export type ExecutablePluginGeneratorRegistration = z.infer<
  typeof ExecutablePluginGeneratorRegistrationSchema
>;

/** View registrations are declarative UI/data contracts and carry no executable runtime. */
export const ExecutablePluginViewRegistrationSchema = z
  .object({
    pluginId: pluginIdSchema,
    version: z.string().trim().regex(SEMVER_PATTERN),
    schemaHash: z.string().regex(SHA256_PATTERN),
    document: ExecutablePluginViewDocumentSchema,
  })
  .strict();
export type ExecutablePluginViewRegistration = z.infer<
  typeof ExecutablePluginViewRegistrationSchema
>;

export function generatorDefinitionFromExecutablePluginRegistration(
  input: ExecutablePluginGeneratorRegistration,
): GeneratorDefinition {
  const registration = ExecutablePluginGeneratorRegistrationSchema.parse(input);
  return GeneratorDefinitionSchema.parse({
    pluginId: registration.pluginId,
    version: registration.version,
    schemaHash: registration.schemaHash,
    ...registration.document.spec,
  });
}

/**
 * Interpret active plugin model Cards as the effective source of truth. Cards
 * replace a built-in with the same id, while new ids are appended. Projector
 * exports that omit an explicit owner are bound to the package provenance.
 */
export function composeExecutablePluginModelCards(
  baseModelsInput: readonly ModelCard[],
  registrationsInput: readonly ExecutablePluginCardRegistration[],
  modelBindingRegistrationsInput: readonly ExecutablePluginModelBindingRegistration[] = [],
): ModelCard[] {
  const baseModels = z.array(ModelCardSchema).parse(baseModelsInput);
  const registrations = z
    .array(ExecutablePluginCardRegistrationSchema)
    .parse(registrationsInput);
  const modelBindingRegistrations = z
    .array(ExecutablePluginModelBindingRegistrationSchema)
    .parse(modelBindingRegistrationsInput);
  const pluginModels = new Map<
    string,
    { pluginId: string; model: ModelCard }
  >();
  for (const registration of registrations) {
    if (registration.document.kind !== "model-card") continue;
    const id = registration.document.spec.id;
    const existing = pluginModels.get(id);
    if (existing) {
      throw new Error(
        `Plugins ${existing.pluginId} and ${registration.pluginId} both export model Card ${id}.`,
      );
    }
    const model = ModelCardSchema.parse({
      ...registration.document.spec,
      providerImplementations:
        registration.document.spec.providerImplementations?.map(
          (implementation) => ({
            ...implementation,
            ...(implementation.projectorExportId &&
            !implementation.projectorPluginId
              ? { projectorPluginId: registration.pluginId }
              : {}),
            ...(implementation.executorExportId &&
            !implementation.executorPluginId
              ? { executorPluginId: registration.pluginId }
              : {}),
          }),
        ),
    });
    pluginModels.set(id, { pluginId: registration.pluginId, model });
  }

  const baseIds = new Set(baseModels.map((model) => model.id));
  const composed = [
    ...baseModels.map((model) => pluginModels.get(model.id)?.model ?? model),
    ...[...pluginModels.values()]
      .map((entry) => entry.model)
      .filter((model) => !baseIds.has(model.id))
      .sort((left, right) => left.id.localeCompare(right.id)),
  ];

  const bindingsByModel = new Map<
    string,
    Array<{
      pluginId: string;
      implementation: z.infer<typeof ModelProviderImplementationSchema>;
    }>
  >();
  for (const registration of modelBindingRegistrations) {
    const {
      id: _id,
      modelId,
      ...implementationInput
    } = registration.document.spec;
    const implementation = ModelProviderImplementationSchema.parse({
      ...implementationInput,
      ...(implementationInput.projectorExportId &&
      !implementationInput.projectorPluginId
        ? { projectorPluginId: registration.pluginId }
        : {}),
      ...(implementationInput.executorExportId &&
      !implementationInput.executorPluginId
        ? { executorPluginId: registration.pluginId }
        : {}),
    });
    const entries = bindingsByModel.get(modelId) ?? [];
    const routeKey = [
      implementation.providerId,
      implementation.region ?? "",
    ].join(":");
    const duplicate = entries.find(
      (entry) =>
        [
          entry.implementation.providerId,
          entry.implementation.region ?? "",
        ].join(":") === routeKey,
    );
    if (duplicate) {
      throw new Error(
        `Plugins ${duplicate.pluginId} and ${registration.pluginId} both bind model Card ${modelId} to ${routeKey}.`,
      );
    }
    entries.push({ pluginId: registration.pluginId, implementation });
    bindingsByModel.set(modelId, entries);
  }

  return composed.map((model) => {
    const external = bindingsByModel.get(model.id) ?? [];
    if (external.length === 0) return model;
    const implementations = [...(model.providerImplementations ?? [])];
    for (const entry of external) {
      const routeKey = [
        entry.implementation.providerId,
        entry.implementation.region ?? "",
      ].join(":");
      const duplicate = implementations.some(
        (implementation) =>
          [implementation.providerId, implementation.region ?? ""].join(":") ===
          routeKey,
      );
      if (duplicate) {
        throw new Error(
          `Model Card ${model.id} already declares provider binding ${routeKey}.`,
        );
      }
      implementations.push(entry.implementation);
    }
    const availableProviders = [
      ...new Set([
        ...(model.availableProviders ?? []),
        ...implementations.map((implementation) => implementation.providerId),
      ]),
    ];
    return ModelCardSchema.parse({
      ...model,
      availableProviders,
      defaultProvider: model.defaultProvider ?? availableProviders[0],
      providerImplementations: implementations,
    });
  });
}

/** Immutable reference stored with Canvas nodes and task invocations. */
export const ExecutablePluginBindingSchema = z
  .object({
    pluginId: pluginIdSchema,
    version: z.string().trim().regex(SEMVER_PATTERN),
    exportId: z.string().trim().regex(PLUGIN_ID_PATTERN),
    schemaHash: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const ExecutablePluginAssetHandleObjectSchema = z
  .object({
    assetId: z.string().trim().min(1),
    uri: z.string().regex(/^clash-asset:\/\/.+/),
    kind: AssetKindSchema,
    mediaType: z.string().trim().min(1).optional(),
  })
  .strict();

export const ExecutablePluginAssetHandleSchema =
  ExecutablePluginAssetHandleObjectSchema;

const ExecutablePluginReferenceBaseSchema = z.object({
  slot: z.string().trim().min(1),
  index: z.number().int().nonnegative(),
});

/** The exact immutable media input accepted by the first-party speech Host tool. */
export const ExecutableSpeechTranscriptionReferenceSchema =
  ExecutablePluginReferenceBaseSchema.extend({
    asset: ExecutablePluginAssetHandleObjectSchema.extend({
      kind: z.enum(["audio", "video"]),
    }).strict(),
  }).strict();

export const ExecutablePluginReferenceSchema = z.union([
  ExecutablePluginReferenceBaseSchema.extend({
    asset: ExecutablePluginAssetHandleSchema,
  }).strict(),
  ExecutablePluginReferenceBaseSchema.extend({
    text: z
      .object({
        nodeId: z.string().trim().min(1),
        value: z.string(),
      })
      .strict(),
  }).strict(),
  ExecutablePluginReferenceBaseSchema.extend({
    document: z
      .object({
        documentAssetId: z.string().trim().min(1),
        revisionId: z.string().trim().min(1),
        documentKind: z.string().trim().min(1),
        schemaVersion: z.number().int().positive(),
      })
      .strict(),
  }).strict(),
]);

/**
 * Asset delivery v0 broker result for `asset.resolve`; SDKs decode bytes before plugin business
 * code sees it. Provider-reachable and execution-realm URLs are separate forms rather than a
 * forgeable `url + reach` compatibility dialect.
 */
export const ExecutablePluginBrokerResolvedReferenceSchema =
  z.discriminatedUnion("form", [
    z
      .object({
        form: z.literal("provider-url"),
        providerUrl: z.string().url(),
        expiresAt: z.string().datetime(),
        kind: AssetKindSchema.optional(),
        mediaType: z.string().trim().min(1).optional(),
      })
      .strict(),
    z
      .object({
        form: z.literal("executor-url"),
        executorUrl: z.string().url(),
        expiresAt: z.string().datetime(),
        kind: AssetKindSchema.optional(),
        mediaType: z.string().trim().min(1).optional(),
      })
      .strict(),
    z
      .object({
        form: z.literal("bytes"),
        bytesBase64: z.string(),
        kind: AssetKindSchema.optional(),
        mediaType: z.string().trim().min(1).optional(),
      })
      .strict(),
    z
      .object({
        form: z.literal("text"),
        text: z.string(),
      })
      .strict(),
    z
      .object({
        form: z.literal("document"),
        documentKind: z.string().trim().min(1),
        schemaVersion: z.number().int().positive(),
        body: ExecutablePluginJsonValueSchema,
      })
      .strict(),
  ]);

export const ExecutablePluginInvocationSchema = z
  .object({
    protocol: z.literal("clash.plugin.invoke/v1"),
    invocationId: z.string().trim().min(1),
    taskId: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    nodeId: z.string().trim().min(1).optional(),
    target: ExecutablePluginBindingSchema.extend({
      kind: z.enum(["action", "provider-projector", "provider-executor"]),
    }),
    input: z
      .object({
        values: z.record(ExecutablePluginJsonValueSchema).default({}),
        references: z.array(ExecutablePluginReferenceSchema).default([]),
      })
      .strict(),
    /** Delivery contract copied from the exact selected Provider binding. */
    assetInputs: z.array(ProviderAssetInputSchema).default([]),
    actor: z
      .object({
        kind: z.enum(["user", "agent", "system"]),
        id: z.string().trim().min(1).optional(),
      })
      .strict(),
    /**
     * Which translation the host wants: start the work, or report on work already started.
     *
     * A plugin at this level only converts shapes. `submit` turns Clash's request into the provider's
     * request and reads back an id; `poll` turns that id into the provider's status request and reads
     * back a verdict. Neither waits. The loop, the interval, the retry budget, and the durability are
     * the host's, because none of them differ by provider -- and because only the host survives its
     * own restart.
     *
     * Stated as a field rather than inferred from an absent one: a plugin that mistakes a status
     * query for a submission bills the user twice.
     */
    operation: z.enum(["submit", "poll", "callback"]).default("submit"),
    /**
     * Reserved future callback address, issued by a callback-capable Host at submit time.
     *
     * The plugin cannot supply this. It has no address: a `local` plugin listens on nothing, and a
     * short-lived translator has nowhere to keep a listener even if it did. The same reasoning already
     * governs upload targets -- the host issues the address, so reachability holds by construction
     * rather than by a plugin's claim about itself.
     *
     * Current Hosts always omit this field and collect asynchronous work through polling. A future
     * adapter may set it only for an entry that also retains a working poll path.
     */
    callbackUrl: z.string().url().optional(),
    /** The opaque state the plugin returned when it accepted the work. Required by `poll`. */
    pollState: ExecutablePluginJsonValueSchema.optional(),
    /**
     * Reserved future Provider callback body, verbatim, for the plugin to translate.
     *
     * A future callback adapter would receive this on the address it issued and route it without
     * interpreting the Provider-specific shape. Current Hosts never construct callback invocations.
     */
    callbackPayload: ExecutablePluginJsonValueSchema.optional(),
    /**
     * Reserved future callback request headers, for Provider signature verification.
     *
     * Providers sign callbacks, and they sign them in headers -- an HMAC over the raw body, a
     * timestamp, a key id. Only the plugin knows which scheme this provider uses, so only the plugin
     * can verify, and it cannot verify from a body alone. Withholding these would leave one defence
     * standing: that the address is hard to guess. An address travels through the provider's logs,
     * any proxy in between, and a referrer header, so it is a weak thing to rest on by itself.
     *
     * The future callback adapter must reject an unverified callback channel without settling the
     * Provider run; polling remains the recovery path. That channel-level rejection semantics is not
     * implemented by the current Host.
     */
    callbackHeaders: z.record(z.string()).optional(),
  })
  .strict()
  .superRefine((invocation, ctx) => {
    if (invocation.operation === "poll" && invocation.pollState === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pollState"],
        message:
          "A poll must carry the state the plugin returned when it accepted the work.",
      });
    }
    if (
      invocation.operation === "submit" &&
      invocation.pollState !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pollState"],
        message: "A submit starts new work and cannot carry poll state.",
      });
    }
    if (
      invocation.operation === "callback" &&
      invocation.callbackPayload === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["callbackPayload"],
        message: "A callback must carry the body the provider sent.",
      });
    }
    if (
      invocation.operation !== "callback" &&
      invocation.callbackHeaders !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["callbackHeaders"],
        message: "callbackHeaders belongs to a callback.",
      });
    }
    if (
      invocation.operation !== "callback" &&
      invocation.callbackPayload !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["callbackPayload"],
        message: "callbackPayload belongs to a callback.",
      });
    }
    if (
      invocation.operation !== "submit" &&
      invocation.callbackUrl !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["callbackUrl"],
        message:
          "A future callback address may be supplied only when work is submitted.",
      });
    }
  });

export const ExecutablePluginOutputSchema = z.union([
  z
    .object({
      slot: z.string().trim().min(1),
      kind: z.literal("asset"),
      asset: ExecutablePluginAssetHandleSchema,
    })
    .strict(),
  z
    .object({
      slot: z.string().trim().min(1),
      kind: z.literal("value"),
      value: ExecutablePluginJsonValueSchema,
    })
    .strict(),
  /**
   * One typed Document body returned by a Generator Action.
   *
   * `value` remains the transport-neutral result shape for legacy Actions and projectors. A
   * native Generator must name the Document contract on the output itself so the Host can compare
   * it with the frozen output port before it stores a body or advances any public authority.
   */
  z
    .object({
      slot: z.string().trim().min(1),
      kind: z.literal("document"),
      document: z
        .object({
          documentKind: z.string().trim().min(1),
          schemaVersion: z.number().int().positive(),
          body: ExecutablePluginJsonValueSchema,
        })
        .strict(),
    })
    .strict(),
]);

/** Stable Host-level failure categories; raw upstream spellings belong in `providerCode`. */
export const ExecutablePluginFailureCodeSchema = z.enum([
  "invalid_request",
  "authentication_failed",
  "permission_denied",
  "content_rejected",
  "rate_limited",
  "quota_exhausted",
  "provider_unavailable",
  "provider_failed",
  "task_not_found",
  "task_expired",
  "transport_timeout",
  "transport_error",
  "invalid_response",
  "execution_failed",
  "contract_violation",
  "cancelled",
  "plugin_unavailable",
  "deadline_exceeded",
  "output_persistence_failed",
  "publication_failed",
]);

/** Structured failure facts shared by runtime results and declarative contract expectations. */
export const ExecutablePluginFailureErrorSchema = z
  .object({
    /** Stable Clash category. Provider-specific spellings belong in `providerCode`. */
    code: ExecutablePluginFailureCodeSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
    /** Whether the provider definitely rejected, may have accepted, or later failed the work. */
    requestState: z.enum(["rejected", "unknown", "accepted"]),
    providerCode: z.string().trim().min(1).optional(),
    details: ExecutablePluginJsonValueSchema.optional(),
  })
  .strict();

export const ExecutablePluginResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocol: z.literal("clash.plugin.result/v1"),
      invocationId: z.string().trim().min(1),
      status: z.literal("completed"),
      outputs: z.array(ExecutablePluginOutputSchema).default([]),
    })
    .strict(),
  /**
   * The provider took the work and has not finished it.
   *
   * A blocking call keeps the upstream's task id in its own stack, so a host that stops mid-flight
   * cannot find the work again -- the node stays pending forever and the generation is already
   * billed. Naming the task hands the host something durable to resume from, and moves the retry
   * loop out of every plugin that currently rewrites it.
   *
   * How the host learns the answer is deliberately unspecified here. Polling is implemented today;
   * a future callback adapter may use the reserved callback ABI without changing this result shape.
   */
  z
    .object({
      protocol: z.literal("clash.plugin.result/v1"),
      invocationId: z.string().trim().min(1),
      status: z.literal("accepted"),
      /**
       * Whatever this plugin needs to ask about the work again, stored verbatim and handed back.
       *
       * Not an id, because plenty of providers have no id: one returns a status URL, another needs a
       * region alongside a job name, a third hands back a cursor. Any of those fits here, and the host
       * reads none of it -- it persists the value and returns it on the next poll. Naming a field
       * `taskId` would have forced every provider without one to fake it.
       */
      pollState: ExecutablePluginJsonValueSchema,
      /** How long to wait before asking again, when the provider says. */
      retryAfterMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      protocol: z.literal("clash.plugin.result/v1"),
      invocationId: z.string().trim().min(1),
      status: z.literal("failed"),
      error: ExecutablePluginFailureErrorSchema,
    })
    .strict(),
]);

export const ExecutableMediaAnalysisReferenceSchema =
  ExecutablePluginReferenceBaseSchema.extend({
    asset: ExecutablePluginAssetHandleObjectSchema.extend({
      kind: z.enum(["image", "video", "audio"]),
    }).strict(),
  }).strict();

/** Credential-free request from the media-analysis plugin to Host routing. */
export const ExecutableMediaAnalysisOperationSchema = z
  .object({
    kind: z.literal("media.analyze"),
    reference: ExecutableMediaAnalysisReferenceSchema,
    modelId: z.string().trim().min(1),
    category: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
    promptVersion: z.string().trim().min(1),
    responseFormat: z.enum(["json", "text"]).optional(),
  })
  .strict();

export const ExecutableMediaAnalysisResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        provider: z.string().trim().min(1),
        route: z.string().trim().min(1),
        underlyingModel: z.string().trim().min(1),
        result: ExecutablePluginJsonValueSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("accepted"),
        poll: ExecutablePluginJsonValueSchema,
        retryAfterMs: z.number().int().positive().optional(),
      })
      .strict(),
  ],
);

/** The exact immutable video input accepted by the generic video-enhance Host tool. */
export const ExecutableVideoEnhanceReferenceSchema =
  ExecutablePluginReferenceBaseSchema.extend({
    asset: ExecutablePluginAssetHandleObjectSchema.extend({
      kind: z.literal("video"),
    }).strict(),
  }).strict();

/**
 * Credential-free request from the generic video-enhance plugin to Host routing. The Host
 * dispatches this to whichever Provider implementation the frozen `route` names; this plugin
 * never recognizes a Provider by name.
 */
export const ExecutableVideoEnhanceOperationSchema = z
  .object({
    kind: z.literal("video.enhance"),
    reference: ExecutableVideoEnhanceReferenceSchema,
    modelId: z.string().trim().min(1),
    params: ExecutablePluginJsonValueSchema,
    /** Present only when resuming Host-owned asynchronous enhancement work. */
    poll: ExecutablePluginJsonValueSchema.optional(),
  })
  .strict();

export const ExecutableVideoEnhanceResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      provider: z.string().trim().min(1),
      route: z.string().trim().min(1),
      underlyingModel: z.string().trim().min(1),
      /**
       * A Host staging receipt from the Provider implementation's own single upload -- not yet
       * a published, immutable Project Asset. Publication requires the Host to verify this
       * receipt's plugin/version/account/slot/task against the frozen Run authority first.
       */
      asset: ExecutablePluginAssetHandleObjectSchema.extend({
        kind: z.literal("video"),
      }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("accepted"),
      poll: ExecutablePluginJsonValueSchema,
      retryAfterMs: z.number().int().positive().optional(),
    })
    .strict(),
]);

/** Credential-free request from an ASR plugin to the Host-owned speech runtime. */
export const ExecutableSpeechTranscriptionOperationSchema = z
  .object({
    kind: z.literal("speech.transcribe"),
    reference: ExecutableSpeechTranscriptionReferenceSchema,
    modelId: z.string().trim().min(1),
    language: z.string().trim().min(1).optional(),
    /** Present only when resuming Host-owned asynchronous speech work. */
    poll: ExecutablePluginJsonValueSchema.optional(),
  })
  .strict();

export const ExecutableSpeechTranscriptionResultSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("completed"),
        transcript: AsrTimedTranscriptSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("accepted"),
        poll: ExecutablePluginJsonValueSchema,
        retryAfterMs: z.number().int().positive().optional(),
      })
      .strict(),
  ],
);

export const ExecutableDirectorStageCaptureOperationSchema = z
  .object({
    kind: z.literal("director.stage.capture-frame"),
    /** Exact source Document bodies resolved from the frozen Director inputs. */
    codeSources: z.record(z.string().min(1)).optional(),
    stage: z.object({
      name: z.string(),
      owner: z.union([
        z.object({ kind: z.literal("project") }).strict(),
        z.object({ kind: z.literal("canvas-action"), canvasId: z.string().min(1), actionNodeId: z.string().min(1) }).strict(),
      ]),
      state: ExecutablePluginJsonValueSchema.refine(
        (value) => value !== null && typeof value === "object" && !Array.isArray(value),
        "Director Stage state must be an object.",
      ),
    }).strict(),
    label: z.string().trim().min(1),
    timeSeconds: z.number().finite().nonnegative(),
    aspectRatio: z.enum(["16:9", "9:16", "4:3", "3:4", "1:1"]),
    longEdge: z.number().int().min(256).max(4096),
  }).strict();

export const ExecutableDirectorStageCaptureResultSchema = z.object({
  mediaType: z.literal("image/png"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytesBase64: z.string().min(1),
}).strict();

/** Runs text through a configured local agent; Project scope comes from the invocation. */
export const ExecutableAgentTextOperationSchema = z.object({
  kind: z.literal("agent.text.generate"),
  prompt: z.string().refine((text) => text.trim().length > 0, "Agent text requires a prompt."),
  agentId: z.string().trim().min(1).optional(),
  modelId: z.string().trim().min(1).optional(),
  systemPrompt: z.string().optional(),
}).strict();
export type ExecutableAgentTextOperation = z.infer<typeof ExecutableAgentTextOperationSchema>;
export const ExecutableAgentTextResultSchema = z.object({
  text: z.string().refine((text) => text.trim().length > 0, "Agent text requires a non-empty result."),
}).strict();
export type ExecutableAgentTextResult = z.infer<typeof ExecutableAgentTextResultSchema>;

export const ExecutablePluginBrokerOperationSchema = z.union([
  ExecutableAgentTextOperationSchema,
  ExecutableDirectorStageCaptureOperationSchema,
  z
    .object({
      kind: z.literal("asset.resolve"),
      reference: ExecutablePluginReferenceSchema,
    })
    .strict(),
  /**
   * Somewhere to put bytes that is not this message.
   *
   * `asset.write` with `dataBase64` carries a result inside the frame that announces it -- one
   * 30-second video is 3,470,456 characters that way, held at once by the plugin, the pipe and the
   * host. A slot separates them: the host names a place, the plugin streams to it, and the frame
   * carries a handle.
   *
   * The size is required so the host can refuse before the bytes arrive rather than after.
   */
  /**
   * Read one value this plugin stored for this account.
   *
   * There is no plugin id and no account id in the request, and adding either would make the
   * binding forgeable. The host knows both from the spawn: it started this process for this
   * account, and the answer is scoped to that pair before the key is looked at.
   *
   * The value is opaque. The host does not know what a vendor's auth looks like -- Google wants an
   * api key on one surface and a bearer token on another, kling wants an access key and a secret --
   * and enumerating those here would mean editing the host every time a vendor changes its mind.
   */
  z
    .object({
      kind: z.literal("store.get"),
      key: z.string().trim().min(1),
    })
    .strict(),
  /** Write one back. Renewal is plugin code: it refreshes a token and stores it where it found it. */
  z
    .object({
      kind: z.literal("store.put"),
      key: z.string().trim().min(1),
      value: z.string(),
      secret: z.boolean().optional(),
      expiresAt: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("asset.upload-slot"),
      slot: z.string().trim().min(1),
      assetKind: AssetKindSchema,
      mediaType: z.string().trim().min(1).optional(),
      /**
       * How many bytes are coming, when the plugin holds them.
       *
       * Announced ahead of the payload so the host can refuse an oversized upload before receiving
       * it rather than after.
       */
      byteLength: z.number().int().positive().optional(),
      /**
       * Where the bytes are, when the vendor answered with a link.
       *
       * A URL has no byte count until someone fetches it, and fetching it only to satisfy a schema
       * pays for the transfer twice -- the host is the side that knows whether it wants a copy. This
       * was required-`byteLength`-only, so the url form failed with "Cannot read properties of
       * undefined (reading 'byteLength')" the first time a real vendor answered with a link, after
       * the generation had completed and been paid for.
       */
      url: z
        .string()
        .trim()
        .url()
        .refine(
          (value) => value.startsWith("https://"),
          "The host will fetch this address, so it must be https.",
        )
        .optional(),
    })
    .strict()
    .refine(
      (operation) =>
        operation.byteLength !== undefined || operation.url !== undefined,
      // Neither is a request for storage with nothing to store, and opens a slot that can only ever
      // be abandoned.
      { message: "An upload slot needs either a byte count or a url." },
    ),
  z
    .object({
      kind: z.literal("asset.write"),
      slot: z.string().trim().min(1),
      assetKind: AssetKindSchema,
      mediaType: z.string().trim().min(1).optional(),
      /**
       * Where the result already lives, for the host to fetch once.
       *
       * A generation plugin normally ends up with a link the upstream published, and passing that
       * through means the bytes cross the wire exactly once and never touch the plugin. Without this
       * field the only ways to return such a result were to download it and re-encode it inline, or
       * to smuggle the link through a free-form `kind: "value"` output -- which is what
       * `hilo-hub-media` does, and why its media type is hardcoded per model kind instead of read
       * from the response.
       */
      url: z
        .string()
        .trim()
        .url()
        .refine(
          (value) => value.startsWith("https://"),
          "The host will ingest this address, so it must be https.",
        )
        .optional(),
      /** Set when the bytes were already streamed to a slot; the write only names them. */
      assetId: z.string().trim().min(1).optional(),
      dataBase64: z
        .string()
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          "Plugin asset data must be canonical base64.",
        )
        .optional(),
    })
    .strict()
    .superRefine((operation, ctx) => {
      const sources = [
        operation.url,
        operation.dataBase64,
        operation.assetId,
      ].filter((source) => source !== undefined).length;
      if (sources !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "asset.write requires exactly one of url, dataBase64 or assetId.",
        });
      }
    }),
  z
    .object({
      kind: z.literal("codex.image.generate"),
      prompt: z.string().trim().min(1).max(20_000),
      aspectRatio: AspectRatioStringSchema.default("1:1"),
      slot: z.string().trim().min(1),
      references: z
        .array(
          ExecutablePluginAssetHandleObjectSchema.extend({
            kind: z.literal("image"),
          }).strict(),
        )
        .max(5)
        .default([]),
    })
    .strict(),
  ExecutableSpeechTranscriptionOperationSchema,
  ExecutableMediaAnalysisOperationSchema,
  ExecutableVideoEnhanceOperationSchema,
]);

export const ExecutablePluginBrokerRequestSchema = z
  .object({
    protocol: z.literal("clash.plugin.broker-request/v1"),
    requestId: z.string().trim().min(1),
    invocationId: z.string().trim().min(1),
    operation: ExecutablePluginBrokerOperationSchema,
  })
  .strict();

export const ExecutablePluginBrokerResponseSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        protocol: z.literal("clash.plugin.broker-response/v1"),
        requestId: z.string().trim().min(1),
        status: z.literal("ok"),
        result: ExecutablePluginJsonValueSchema,
      })
      .strict(),
    z
      .object({
        protocol: z.literal("clash.plugin.broker-response/v1"),
        requestId: z.string().trim().min(1),
        status: z.literal("error"),
        error: z
          .object({
            code: z.string().trim().min(1),
            message: z.string().trim().min(1),
          })
          .strict(),
      })
      .strict(),
  ],
);

const ExecutablePluginContractBrokerFixtureSchema = z
  .object({
    operation: ExecutablePluginBrokerOperationSchema,
    response: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("ok"),
          result: ExecutablePluginJsonValueSchema,
        })
        .strict(),
      z
        .object({
          status: z.literal("error"),
          error: z
            .object({
              code: z.string().trim().min(1),
              message: z.string().trim().min(1),
            })
            .strict(),
        })
        .strict(),
    ]),
  })
  .strict();

/**
 * A deterministic, declarative executable-plugin contract test. Broker
 * fixtures are inert test data: running a contract test never grants access to
 * a real credential, asset, network destination, or external write.
 */
export const ExecutablePluginContractTestDocumentSchema = z
  .object({
    apiVersion: z.literal("clash.plugin.contract-test/v1"),
    id: z.string().trim().regex(PLUGIN_ID_PATTERN),
    description: z.string().trim().min(1).optional(),
    target: z
      .object({
        exportId: z.string().trim().regex(PLUGIN_ID_PATTERN),
        kind: z.enum(["action", "provider-projector", "provider-executor"]),
      })
      .strict(),
    context: z
      .object({
        projectId: z.string().trim().min(1).default("contract-test-project"),
        nodeId: z.string().trim().min(1).optional(),
      })
      .strict()
      .default({ projectId: "contract-test-project" }),
    input: z
      .object({
        values: z.record(ExecutablePluginJsonValueSchema).default({}),
        references: z.array(ExecutablePluginReferenceSchema).default([]),
      })
      .strict(),
    /**
     * Which half of an executor this case exercises.
     *
     * A poll is a different translation from a submit, with a different input and a different set of
     * answers, so a suite that can only describe submits leaves the resuming path uncovered -- and
     * that is the path that runs after a restart, when nobody is watching.
     */
    operation: z.enum(["submit", "poll", "callback"]).default("submit"),
    /** The state a poll is asking about, as the plugin would have returned it. */
    pollState: ExecutablePluginJsonValueSchema.optional(),
    brokerFixtures: z
      .array(ExecutablePluginContractBrokerFixtureSchema)
      .default([]),
    expect: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("completed"),
          outputs: z.array(ExecutablePluginOutputSchema).default([]),
        })
        .strict(),
      // Pinning what a submit hands back is the only way to catch a plugin that silently changes how
      // its own poll state is shaped, which would strand every generation already in flight.
      z
        .object({
          status: z.literal("accepted"),
          pollState: ExecutablePluginJsonValueSchema,
        })
        .strict(),
      z
        .object({
          status: z.literal("failed"),
          error: ExecutablePluginFailureErrorSchema,
        })
        .strict(),
    ]),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  })
  .strict();

/**
 * Where a plugin should PUT a result it holds as bytes, or undefined when no target exists.
 *
 * The host issues the address, which is what makes one plugin code path serve both run modes: a
 * `local` plugin gets the host's own endpoint because it runs here, a `hosted` plugin gets a
 * pre-signed public one. The plugin needs no idea which world it is in.
 *
 * This is the inverse of returning a URL, and both are needed. Returning a URL is cheapest when
 * the upstream already published the result, but it requires the host to reach an address the
 * plugin chose. An upload target is reachable by construction, at the cost of one more transfer.
 *
 * A hosted plugin gets nothing when no public target exists: handing it the loopback address would
 * point it at whatever answers on its own network.
 */
export function uploadTargetForRuntime(
  kind: "local" | "hosted",
  targets: { localBaseUrl?: string; publicUploadUrl?: string },
): string | undefined {
  if (targets.publicUploadUrl) return targets.publicUploadUrl;
  if (kind === "local" && targets.localBaseUrl) {
    return `${targets.localBaseUrl.replace(/\/+$/, "")}/plugin-uploads`;
  }
  return undefined;
}

export const ExecutablePluginContributionsSchema = z
  .object({
    cards: z.array(ExecutablePluginCardExportSchema).default([]),
    providers: z.array(ExecutablePluginProviderExportSchema).default([]),
    modelBindings: z
      .array(ExecutablePluginModelBindingExportSchema)
      .default([]),
    generators: z.array(ExecutablePluginGeneratorExportSchema).default([]),
    views: z.array(ExecutablePluginViewExportSchema).default([]),
    functions: z.array(ExecutablePluginFunctionExportSchema).default([]),
    hostTools: z
      .array(z.enum(["codex.imagegen", "speech.transcribe", "media.analyze", "director.stage.capture-frame", "video.enhance", "agent.text"]))
      .default([]),
  })
  .strict();

export const ExecutablePluginManifestSchema = z
  .object({
    apiVersion: z.literal("clash.plugin/v1"),
    /** `publisher.name`, like clash.google. The version travels beside it, never inside it. */
    id: pluginIdSchema,
    version: z.string().trim().regex(SEMVER_PATTERN),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    runtime: ExecutablePluginRuntimeSchema,
    contributes: ExecutablePluginContributionsSchema,
    contractTests: z.array(PluginRelativePathSchema).default([]),
    author: z.string().trim().min(1).optional(),
    repository: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    for (const [key, values] of [
      ["cards", manifest.contributes.cards],
      ["providers", manifest.contributes.providers],
      ["modelBindings", manifest.contributes.modelBindings],
      ["generators", manifest.contributes.generators],
      ["views", manifest.contributes.views],
      ["functions", manifest.contributes.functions],
    ] as const) {
      const ids = new Set<string>();
      for (const value of values) {
        if (ids.has(value.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["contributes", key],
            message: `Plugin ${key} contribution ids must be unique.`,
          });
        }
        ids.add(value.id);
      }
    }
    const cardPaths = new Set<string>();
    for (const card of manifest.contributes.cards) {
      if (cardPaths.has(card.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes", "cards"],
          message: "Plugin Card contribution paths must be unique.",
        });
      }
      cardPaths.add(card.path);
    }
    const artifactPaths = new Set(cardPaths);
    for (const artifact of [
      ...manifest.contributes.providers,
      ...manifest.contributes.modelBindings,
      ...manifest.contributes.generators,
      ...manifest.contributes.views,
    ]) {
      if (artifactPaths.has(artifact.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contributes"],
          message: "Plugin declarative artifact paths must be unique.",
        });
      }
      artifactPaths.add(artifact.path);
    }
    const contractTestPaths = new Set<string>();
    for (const path of manifest.contractTests) {
      if (contractTestPaths.has(path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contractTests"],
          message: "Plugin contract test paths must be unique.",
        });
      }
      contractTestPaths.add(path);
    }
  });

/**
 * The host dependency surface shared by local stdio and hosted HTTP runtimes.
 * Keeping this in the versioned contract package prevents the two runtimes
 * from offering different SDK operations for the same contribution shape.
 */
export function executablePluginDependencyError(
  manifestInput: unknown,
  requestInput: unknown,
): string | null {
  const manifest = ExecutablePluginManifestSchema.parse(manifestInput);
  const request = ExecutablePluginBrokerRequestSchema.parse(requestInput);
  const operation = request.operation;
  const capabilities = pluginCapabilities(manifest.contributes);

  if (
    operation.kind === "asset.write" ||
    operation.kind === "asset.upload-slot"
  ) {
    // A slot is a write that has not happened yet. Letting one through without the contribution would
    // put the check after the bytes are already stored.
    return capabilities.assets
      ? null
      : `Plugin ${manifest.id} does not contribute anything that produces assets.`;
  }

  if (operation.kind === "asset.resolve") {
    return capabilities.assets
      ? null
      : `Plugin ${manifest.id} does not contribute anything that reads assets.`;
  }

  if (operation.kind === "agent.text.generate") {
    return capabilities.hostTools.includes("agent.text")
      ? null
      : `Plugin ${manifest.id} does not contribute agent text generation.`;
  }

  if (operation.kind === "codex.image.generate") {
    // A named generator this host provides, asked for by name. Nothing about being an action
    // implies it -- deriving it from the kind would hand this host's generator to every action ever
    // written, and dropping the dimension entirely broke clash.codex-imagegen, which is real and
    // installed.
    if (!capabilities.hostTools.includes("codex.imagegen")) {
      return `Plugin ${manifest.id} does not contribute Codex ImageGen.`;
    }
    return capabilities.assets
      ? null
      : `Plugin ${manifest.id} does not contribute anything that produces assets.`;
  }

  if (operation.kind === "speech.transcribe") {
    if (!capabilities.hostTools.includes("speech.transcribe")) {
      return `Plugin ${manifest.id} does not contribute speech transcription.`;
    }
    return capabilities.assets
      ? null
      : `Plugin ${manifest.id} does not contribute anything that reads assets.`;
  }

  if (operation.kind === "media.analyze") {
    if (!capabilities.hostTools.includes("media.analyze")) {
      return `Plugin ${manifest.id} does not contribute media analysis.`;
    }
    return capabilities.assets
      ? null
      : `Plugin ${manifest.id} does not contribute anything that reads assets.`;
  }

  if (operation.kind === "video.enhance") {
    if (!capabilities.hostTools.includes("video.enhance")) {
      return `Plugin ${manifest.id} does not contribute video enhancement.`;
    }
    return capabilities.assets
      ? null
      : `Plugin ${manifest.id} does not contribute anything that reads assets.`;
  }

  if (operation.kind === "director.stage.capture-frame") {
    return capabilities.hostTools.includes("director.stage.capture-frame")
      ? null
      : `Plugin ${manifest.id} does not contribute Director Stage capture.`;
  }

  if (operation.kind === "store.get" || operation.kind === "store.put") {
    return capabilities.store
      ? null
      : `Plugin ${manifest.id} does not contribute anything that owns account state.`;
  }

  return `Plugin ${manifest.id} does not contribute the requested host dependency.`;
}

/** Kernel-owned proof that one exact plugin directory passed activation. */
export const ExecutablePluginActivationReceiptSchema = z
  .object({
    apiVersion: z.literal("clash.plugin.activation/v1"),
    pluginId: pluginIdSchema,
    version: z.string().trim().regex(SEMVER_PATTERN),
    schemaHash: z.string().regex(SHA256_PATTERN),
    contentHash: z.string().regex(SHA256_PATTERN),
    activatedAt: z.string().datetime(),
  })
  .strict();

export interface ValidatedExecutablePluginPackage {
  manifest: ExecutablePluginManifest;
  cards: Record<string, ExecutablePluginCardDocument>;
  providers: Record<string, ExecutablePluginProviderDocument>;
  modelBindings: Record<string, ExecutablePluginModelBindingDocument>;
  generators: Record<string, ExecutablePluginGeneratorDocument>;
  views: Record<string, ExecutablePluginViewDocument>;
  contractTests: Record<string, ExecutablePluginContractTestDocument>;
}

/** Strictly validates one unpacked plugin before it can become active. */
/**
 * Apply provider inheritance to one raw binding document.
 *
 * The owning provider is the one the binding names, or -- when it names none -- the sole
 * provider this package exports. A package that exports several providers has to say
 * which one a binding belongs to, since guessing would silently route a model at whichever
 * provider happened to be declared first.
 */
function inheritBindingRoute(
  input: unknown,
  providers: Record<
    string,
    z.infer<typeof ExecutablePluginProviderDocumentSchema>
  >,
  bindingExportId: string,
): unknown {
  if (typeof input !== "object" || input === null) return input;
  const document = input as { spec?: unknown };
  if (typeof document.spec !== "object" || document.spec === null) return input;
  const spec = document.spec as Record<string, unknown>;

  const declared =
    typeof spec.providerId === "string" ? spec.providerId : undefined;
  const definitions = Object.values(providers).map((provider) => provider.spec);
  const owner = declared
    ? definitions.find((definition) => definition.id === declared)
    : definitions.length === 1
      ? definitions[0]
      : undefined;

  if (!owner) {
    // A binding naming a provider from another plugin is left exactly as written; only a
    // provider in this package can supply defaults.
    if (declared || definitions.length === 0) return input;
    throw new Error(
      `Model Provider binding ${bindingExportId} must name its providerId: ` +
        `this package exports ${definitions.length} providers.`,
    );
  }

  return {
    ...document,
    spec: resolveModelBindingFromProvider(spec as never, owner),
  };
}

export function validateExecutablePluginPackage(
  manifestInput: unknown,
  cardDocuments: Record<string, unknown>,
  contractTestDocuments: Record<string, unknown> = {},
  artifacts: {
    providers?: Record<string, unknown>;
    modelBindings?: Record<string, unknown>;
    generators?: Record<string, unknown>;
    views?: Record<string, unknown>;
  } = {},
): ValidatedExecutablePluginPackage {
  const manifest = ExecutablePluginManifestSchema.parse(manifestInput);
  const functions = new Map(
    manifest.contributes.functions.map((entry) => [entry.id, entry]),
  );
  const cards: Record<string, ExecutablePluginCardDocument> = {};
  const providers: Record<string, ExecutablePluginProviderDocument> = {};
  const modelBindings: Record<string, ExecutablePluginModelBindingDocument> =
    {};
  const generators: Record<string, ExecutablePluginGeneratorDocument> = {};
  const views: Record<string, ExecutablePluginViewDocument> = {};
  const contractTests: Record<string, ExecutablePluginContractTestDocument> =
    {};

  for (const cardExport of manifest.contributes.cards) {
    if (!Object.prototype.hasOwnProperty.call(cardDocuments, cardExport.path)) {
      throw new Error(`Missing declared Card document: ${cardExport.path}`);
    }
    const card = ExecutablePluginCardDocumentSchema.parse(
      cardDocuments[cardExport.path],
    );
    if (card.kind !== cardExport.kind) {
      throw new Error(
        `Card ${cardExport.path} kind ${card.kind} does not match export kind ${cardExport.kind}.`,
      );
    }
    if (card.spec.id !== cardExport.id) {
      throw new Error(
        `Card ${cardExport.path} id ${card.spec.id} does not match export id ${cardExport.id}.`,
      );
    }

    if (card.kind === "action-card") {
      const implementation = functions.get(card.spec.functionExportId);
      if (!implementation || implementation.kind !== "action") {
        throw new Error(
          `Action Card ${card.spec.id} requires action export ${card.spec.functionExportId}.`,
        );
      }
    } else {
      for (const implementation of card.spec.providerImplementations ?? []) {
        if (!implementation.projectorExportId) continue;
        if (
          implementation.projectorPluginId &&
          implementation.projectorPluginId !== manifest.id
        )
          continue;
        const projector = functions.get(implementation.projectorExportId);
        if (!projector || projector.kind !== "provider-projector") {
          throw new Error(
            `Model Card ${card.spec.id} requires provider projector export ${implementation.projectorExportId}.`,
          );
        }
      }
    }
    cards[cardExport.path] = card;
  }

  for (const providerExport of manifest.contributes.providers) {
    const input = artifacts.providers?.[providerExport.path];
    if (input === undefined) {
      throw new Error(
        `Missing declared Provider document: ${providerExport.path}`,
      );
    }
    const provider = ExecutablePluginProviderDocumentSchema.parse(input);
    if (provider.spec.id !== providerExport.id) {
      throw new Error(
        `Provider ${providerExport.path} id ${provider.spec.id} does not match export id ${providerExport.id}.`,
      );
    }
    const executor = functions.get(provider.spec.executorExportId);
    if (!executor || executor.kind !== "provider-executor") {
      throw new Error(
        `Provider ${provider.spec.id} requires provider executor export ${provider.spec.executorExportId}.`,
      );
    }
    providers[providerExport.path] = provider;
  }

  for (const bindingExport of manifest.contributes.modelBindings) {
    const input = artifacts.modelBindings?.[bindingExport.path];
    if (input === undefined) {
      throw new Error(
        `Missing declared model Provider binding: ${bindingExport.path}`,
      );
    }
    // Fill the route from the provider before validating, so a binding may carry only the
    // two facts it owns: which catalogue model it routes and that model's upstream name.
    // Written out per binding, the shared route fields were 186 duplicated values across
    // one plugin's 31 files -- no added information, and one mistyped copy would point a
    // model at the wrong upstream while every sibling looked correct.
    const bindingInput = inheritBindingRoute(
      input,
      providers,
      bindingExport.id,
    );
    const binding =
      ExecutablePluginModelBindingDocumentSchema.parse(bindingInput);
    if (binding.spec.id !== bindingExport.id) {
      throw new Error(
        `Model Provider binding ${bindingExport.path} id ${binding.spec.id} ` +
          `does not match export id ${bindingExport.id}.`,
      );
    }
    for (const [exportId, kind] of [
      [binding.spec.projectorExportId, "provider-projector"],
      [binding.spec.executorExportId, "provider-executor"],
    ] as const) {
      if (!exportId) continue;
      const ownerId =
        kind === "provider-projector"
          ? binding.spec.projectorPluginId
          : binding.spec.executorPluginId;
      if (ownerId && ownerId !== manifest.id) continue;
      const implementation = functions.get(exportId);
      if (!implementation || implementation.kind !== kind) {
        throw new Error(
          `Model Provider binding ${binding.spec.id} requires ${kind} export ${exportId}.`,
        );
      }
    }
    modelBindings[bindingExport.path] = binding;
  }

  for (const generatorExport of manifest.contributes.generators) {
    const input = artifacts.generators?.[generatorExport.path];
    if (input === undefined) {
      throw new Error(
        `Missing declared Generator document: ${generatorExport.path}`,
      );
    }
    const generator = ExecutablePluginGeneratorDocumentSchema.parse(input);
    if (generator.spec.definitionId !== generatorExport.id) {
      throw new Error(
        `Generator ${generatorExport.path} id ${generator.spec.definitionId} ` +
          `does not match export id ${generatorExport.id}.`,
      );
    }
    for (const action of generator.spec.actions) {
      if (action.modelExecution) continue;
      const implementation = action.executorExportId ? functions.get(action.executorExportId) : undefined;
      if (!implementation || implementation.kind !== "action") {
        throw new Error(
          `Generator Action ${action.id} requires action export ${action.executorExportId}.`,
        );
      }
    }
    generators[generatorExport.path] = generator;
  }

  for (const card of Object.values(cards)) {
    if (card.kind !== "action-card" || !card.spec.generator) continue;
    const definition = Object.values(generators).find(
      (entry) => entry.spec.definitionId === card.spec.generator!.definitionId,
    );
    if (!definition) throw new Error(`Action Card ${card.spec.id} names an undeclared Generator.`);
    resolveExecutableActionCardGenerator(card.spec, definition.spec);
  }

  for (const viewExport of manifest.contributes.views) {
    const input = artifacts.views?.[viewExport.path];
    if (input === undefined) {
      throw new Error(`Missing declared View document: ${viewExport.path}`);
    }
    const view = ExecutablePluginViewDocumentSchema.parse(input);
    if (view.spec.definitionId !== viewExport.id) {
      throw new Error(
        `View ${viewExport.path} id ${view.spec.definitionId} ` +
          `does not match export id ${viewExport.id}.`,
      );
    }
    views[viewExport.path] = view;
  }

  for (const path of manifest.contractTests) {
    if (!Object.prototype.hasOwnProperty.call(contractTestDocuments, path)) {
      throw new Error(`Missing declared contract test: ${path}`);
    }
    const contractTest = ExecutablePluginContractTestDocumentSchema.parse(
      contractTestDocuments[path],
    );
    const implementation = functions.get(contractTest.target.exportId);
    if (!implementation || implementation.kind !== contractTest.target.kind) {
      throw new Error(
        `Contract test ${contractTest.id} target ${contractTest.target.kind} ` +
          `${contractTest.target.exportId} does not match function export.`,
      );
    }
    contractTests[path] = contractTest;
  }

  return {
    manifest,
    cards,
    providers,
    modelBindings,
    generators,
    views,
    contractTests,
  };
}

export type ExecutablePluginRuntime = z.infer<
  typeof ExecutablePluginRuntimeSchema
>;
export type ExecutablePluginGeneratorExport = z.infer<
  typeof ExecutablePluginGeneratorExportSchema
>;
export type ExecutableActionCard = z.infer<typeof ExecutableActionCardSchema>;

/** Validate a legacy single-output form against its plugin's explicit native contract. */
export function resolveExecutableActionCardGenerator(
  card: ExecutableActionCard,
  definition: GeneratorDefinitionSpec,
) {
  const link = card.generator;
  if (!link || link.definitionId !== definition.definitionId) {
    throw new Error(`Action Card ${card.id} does not address this Generator.`);
  }
  const action = definition.actions.find((entry) => entry.id === link.actionId);
  if (!action || action.executorExportId !== card.functionExportId) {
    throw new Error(`Action Card ${card.id} must address an Action backed by its declared executor.`);
  }
  const output = action.outputs[0];
  if (action.outputs.length !== 1 || !output || output.cardinality.minItems !== 1 ||
      (card.outputType === "text"
        ? output.assetType.kind !== "document" || output.assetType.documentKind !== "text.plain"
        : output.assetType.kind !== "media" || output.assetType.mediaKind !== card.outputType)) {
    throw new Error(`Action Card ${card.id} requires one matching media or plain-text Document output.`);
  }
  if (action.invocationInputs.some((port) => port.cardinality.minItems > 0) ||
      (Array.isArray(action.parametersSchema.required) && action.parametersSchema.required.length > 0) ||
      action.modelConsumer || action.selectOutputsByParameter) {
    throw new Error(`Action Card ${card.id} cannot supply additional invocation parameters or inputs.`);
  }
  const used = new Set<string>();
  for (const [modality, slot] of Object.entries(link.inputSlots)) {
    const port = definition.persistentInputs.find((entry) => entry.slot === slot);
    if (!port?.accepts.some((type) => executableActionCardInputAcceptsType(type, modality)) || used.has(slot)) {
      throw new Error(`Action Card ${card.id} has an invalid persistent input mapping for ${modality}.`);
    }
    used.add(slot);
  }
  if (definition.persistentInputs.some((port) => port.cardinality.minItems > 0 && !used.has(port.slot))) {
    throw new Error(`Action Card ${card.id} cannot supply a required persistent input.`);
  }
  return { action, output };
}
export type ExecutableActionPresentation = z.infer<
  typeof ExecutableActionPresentationSchema
>;
export type ExecutablePluginCardDocument = z.infer<
  typeof ExecutablePluginCardDocumentSchema
>;
export type ExecutablePluginCardRegistration = z.infer<
  typeof ExecutablePluginCardRegistrationSchema
>;
export type ExecutablePluginProviderDefinition = z.infer<
  typeof ExecutablePluginProviderDefinitionSchema
>;
export type ExecutablePluginProviderDocument = z.infer<
  typeof ExecutablePluginProviderDocumentSchema
>;
export type ExecutablePluginProviderRegistration = z.infer<
  typeof ExecutablePluginProviderRegistrationSchema
>;
export type ExecutablePluginModelBindingSpec = z.infer<
  typeof ExecutablePluginModelBindingSpecSchema
>;
export type ExecutablePluginModelBindingDocument = z.infer<
  typeof ExecutablePluginModelBindingDocumentSchema
>;
export type ExecutablePluginModelBindingRegistration = z.infer<
  typeof ExecutablePluginModelBindingRegistrationSchema
>;
export type ExecutablePluginBinding = z.infer<
  typeof ExecutablePluginBindingSchema
>;
export type ExecutablePluginAssetHandle = z.infer<
  typeof ExecutablePluginAssetHandleSchema
>;
export type ExecutableMediaAnalysisReference = z.infer<
  typeof ExecutableMediaAnalysisReferenceSchema
>;
export type ExecutableMediaAnalysisOperation = z.infer<
  typeof ExecutableMediaAnalysisOperationSchema
>;
export type ExecutableMediaAnalysisResult = z.infer<
  typeof ExecutableMediaAnalysisResultSchema
>;
export type ExecutableVideoEnhanceReference = z.infer<
  typeof ExecutableVideoEnhanceReferenceSchema
>;
export type ExecutableVideoEnhanceOperation = z.infer<
  typeof ExecutableVideoEnhanceOperationSchema
>;
export type ExecutableVideoEnhanceResult = z.infer<
  typeof ExecutableVideoEnhanceResultSchema
>;
export type ExecutableSpeechTranscriptionReference = z.infer<
  typeof ExecutableSpeechTranscriptionReferenceSchema
>;
export type ExecutableDirectorStageCaptureOperation = z.infer<
  typeof ExecutableDirectorStageCaptureOperationSchema
>;
export type ExecutableDirectorStageCaptureResult = z.infer<
  typeof ExecutableDirectorStageCaptureResultSchema
>;
export type ExecutableSpeechTranscriptionOperation = z.infer<
  typeof ExecutableSpeechTranscriptionOperationSchema
>;
export type ExecutableSpeechTranscriptionResult = z.infer<
  typeof ExecutableSpeechTranscriptionResultSchema
>;
export type ExecutablePluginBrokerResolvedReference = z.infer<
  typeof ExecutablePluginBrokerResolvedReferenceSchema
>;
export type ExecutablePluginReference = z.infer<
  typeof ExecutablePluginReferenceSchema
>;
export type ExecutablePluginInvocation = z.infer<
  typeof ExecutablePluginInvocationSchema
>;
export type ExecutablePluginOutput = z.infer<
  typeof ExecutablePluginOutputSchema
>;
export type ExecutablePluginFailureCode = z.infer<
  typeof ExecutablePluginFailureCodeSchema
>;
export type ExecutablePluginFailureError = z.infer<
  typeof ExecutablePluginFailureErrorSchema
>;
export type ExecutablePluginResult = z.infer<
  typeof ExecutablePluginResultSchema
>;
export type ExecutablePluginBrokerOperation = z.infer<
  typeof ExecutablePluginBrokerOperationSchema
>;
export type ExecutablePluginBrokerRequest = z.infer<
  typeof ExecutablePluginBrokerRequestSchema
>;
export type ExecutablePluginBrokerResponse = z.infer<
  typeof ExecutablePluginBrokerResponseSchema
>;
export type ExecutablePluginContractTestDocument = z.infer<
  typeof ExecutablePluginContractTestDocumentSchema
>;
export type ExecutablePluginCardExport = z.infer<
  typeof ExecutablePluginCardExportSchema
>;
export type ExecutablePluginProviderExport = z.infer<
  typeof ExecutablePluginProviderExportSchema
>;
export type ExecutablePluginModelBindingExport = z.infer<
  typeof ExecutablePluginModelBindingExportSchema
>;
export type ExecutablePluginViewExport = z.infer<
  typeof ExecutablePluginViewExportSchema
>;
export type ExecutablePluginFunctionExport = z.infer<
  typeof ExecutablePluginFunctionExportSchema
>;
export type ExecutablePluginContributions = z.infer<
  typeof ExecutablePluginContributionsSchema
>;
export type ExecutablePluginManifest = z.infer<
  typeof ExecutablePluginManifestSchema
>;
export type ExecutablePluginActivationReceipt = z.infer<
  typeof ExecutablePluginActivationReceiptSchema
>;
