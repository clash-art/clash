import type { AssetKind } from "./assets.js";
import {
  CustomActionDefinitionSchema,
  type CustomActionDefinition,
} from "./canvas.js";
import {
  ExecutablePluginBindingSchema,
  ExecutablePluginCardRegistrationSchema,
  type ExecutableActionCard,
  type ExecutablePluginBinding,
  type ExecutablePluginCardRegistration,
} from "./executable-plugin.js";
import {
  GeneratorDefinitionSchema,
  GeneratorDocumentAssetTypeSchema,
  type GeneratorActionInputPort,
  type GeneratorActionOutputContract,
  type GeneratorDefinition,
  type GeneratorDocumentAssetType,
} from "./generator-v2.js";
import type { ModelInputRule, ModelParameter } from "./models.js";
import { ActionSpecSchema } from "./actions/spec.js";

export type GeneratorV1TextOutputType = Omit<
  GeneratorDocumentAssetType,
  "kind"
>;

export type GeneratorV1CompatOptions = {
  /** Legacy `text` is not enough to identify a typed Document Asset. */
  textOutputType?: GeneratorV1TextOutputType;
};

function mediaInput(
  slot: "images" | "videos" | "audios",
  mediaKind: "image" | "video" | "audio",
  cardinality: GeneratorActionInputPort["cardinality"],
): GeneratorActionInputPort {
  return {
    slot,
    accepts: [{ kind: "media", mediaKind }],
    cardinality,
  };
}

function cardinalityForReference(spec: {
  min?: number;
  max: number;
}): GeneratorActionInputPort["cardinality"] {
  return { minItems: spec.min ?? 0, maxItems: spec.max };
}

function invocationInputsForRule(
  input: ModelInputRule,
): GeneratorActionInputPort[] {
  const ports: GeneratorActionInputPort[] = [];
  const mode = input.inputMode;
  const promptModalities = new Set(input.promptModalities);

  if (mode.startEnd) {
    ports.push(mediaInput("images", "image", { minItems: 1, maxItems: 2 }));
  } else if (mode.images) {
    ports.push(
      mediaInput("images", "image", cardinalityForReference(mode.images)),
    );
  } else if (promptModalities.has("image")) {
    ports.push(mediaInput("images", "image", { minItems: 0, maxItems: null }));
  }

  if (mode.videos) {
    ports.push(
      mediaInput("videos", "video", cardinalityForReference(mode.videos)),
    );
  } else if (promptModalities.has("video")) {
    ports.push(mediaInput("videos", "video", { minItems: 0, maxItems: null }));
  }

  if (mode.audios) {
    ports.push(
      mediaInput("audios", "audio", cardinalityForReference(mode.audios)),
    );
  } else if (promptModalities.has("audio")) {
    ports.push(mediaInput("audios", "audio", { minItems: 0, maxItems: null }));
  }

  return ports;
}

function parameterSchema(parameter: ModelParameter): Record<string, unknown> {
  const annotations = {
    ...(parameter.defaultValue === undefined
      ? {}
      : { default: parameter.defaultValue }),
  };
  if (parameter.type === "number" || parameter.type === "slider") {
    return {
      type: "number",
      ...(parameter.min === undefined ? {} : { minimum: parameter.min }),
      ...(parameter.max === undefined ? {} : { maximum: parameter.max }),
      ...annotations,
    };
  }
  if (parameter.type === "text") return { type: "string", ...annotations };
  if (parameter.type === "boolean") {
    return { type: "boolean", ...annotations };
  }
  const candidates = parameter.options?.map((option) => option.value);
  if (!candidates?.length) {
    throw new Error(
      `Select parameter ${parameter.id} requires declared candidates.`,
    );
  }
  return { enum: candidates, ...annotations };
}

function parametersSchemaForCard(
  parameters: readonly ModelParameter[],
  input: ModelInputRule,
): Record<string, unknown> {
  const acceptsPrompt = input.promptModalities.includes("text");
  const properties = Object.fromEntries([
    ...(acceptsPrompt ? [["prompt", { type: "string" }]] : []),
    ...parameters.map((parameter) => [
      parameter.id,
      parameterSchema(parameter),
    ]),
  ]);
  return {
    type: "object",
    properties,
    required: [
      ...(input.requiresPrompt ? ["prompt"] : []),
      ...parameters
        .filter((parameter) => parameter.required)
        .map((parameter) => parameter.id),
    ],
    additionalProperties: false,
  };
}

function outputContractForLegacyAction(
  outputType: ExecutableActionCard["outputType"],
  options: GeneratorV1CompatOptions,
): GeneratorActionOutputContract {
  if (outputType === "text") {
    if (!options.textOutputType) {
      throw new Error(
        "Legacy text output requires an explicit textOutputType Document contract.",
      );
    }
    const assetType = GeneratorDocumentAssetTypeSchema.parse({
      kind: "document",
      ...options.textOutputType,
    });
    return [
      {
        slot: "result",
        assetType,
        cardinality: { minItems: 1, maxItems: 1 },
      },
    ];
  }

  return [
    {
      slot: "media",
      assetType: { kind: "media", mediaKind: outputType },
      cardinality: { minItems: 1, maxItems: 1 },
    },
  ];
}

function syntheticDefinition(
  card: Pick<
    ExecutableActionCard,
    "id" | "functionExportId" | "input" | "outputType" | "parameters"
  >,
  binding: ExecutablePluginBinding,
  options: GeneratorV1CompatOptions,
): GeneratorDefinition {
  return GeneratorDefinitionSchema.parse({
    pluginId: binding.pluginId,
    definitionId: card.id,
    version: binding.version,
    schemaHash: binding.schemaHash,
    stateSchema: { type: "object" },
    editPolicy: "fork-when-materialized",
    persistentInputs: [],
    actions: [
      {
        id: card.id,
        executorExportId: card.functionExportId,
        parametersSchema: parametersSchemaForCard(card.parameters, card.input),
        invocationInputs: invocationInputsForRule(card.input),
        outputs: outputContractForLegacyAction(card.outputType, options),
      },
    ],
  });
}

/**
 * Compatibility projection for the historical built-in ActionSpec catalog.
 * The binding addresses one synthetic adapter; each stable operation id selects
 * a method on it. Execution realm is Host-private and never becomes semantic
 * Generator identity or `executorExportId`.
 */
export function generatorDefinitionFromActionSpec(
  specInput: unknown,
  bindingInput: unknown,
): GeneratorDefinition {
  const spec = ActionSpecSchema.parse(specInput);
  const binding = ExecutablePluginBindingSchema.parse(bindingInput);
  if (binding.exportId !== spec.id) {
    throw new Error(
      `ActionSpec binding ${binding.exportId} does not address ${spec.id}.`,
    );
  }

  return GeneratorDefinitionSchema.parse({
    pluginId: binding.pluginId,
    definitionId: spec.id,
    version: binding.version,
    schemaHash: binding.schemaHash,
    stateSchema: { type: "object" },
    editPolicy: "advance-head",
    persistentInputs: [],
    actions: spec.operations.map((operation) => ({
      id: operation.id,
      executorExportId: binding.exportId,
      parametersSchema: { type: "object" },
      invocationInputs: [
        {
          slot: "source",
          accepts: spec.inputKinds.map((mediaKind: AssetKind) => ({
            kind: "media" as const,
            mediaKind,
          })),
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
      outputs: [
        {
          slot: "output",
          assetType: { kind: "media", mediaKind: operation.outputKind },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    })),
  });
}

/** Convert one activated v1 Action Card into a synthetic single-Action Generator. */
export function generatorDefinitionFromExecutableActionCard(
  registrationInput: unknown,
  options: GeneratorV1CompatOptions = {},
): GeneratorDefinition {
  const registration: ExecutablePluginCardRegistration =
    ExecutablePluginCardRegistrationSchema.parse(registrationInput);
  if (registration.document.kind !== "action-card") {
    throw new Error(
      "A Generator compatibility definition requires an Action Card.",
    );
  }
  const card = registration.document.spec;
  if (card.generator) {
    throw new Error("This Action Card projects a native Generator. Resolve its declared Definition instead of synthesizing a second one.");
  }
  const binding = ExecutablePluginBindingSchema.parse({
    pluginId: registration.pluginId,
    version: registration.version,
    exportId: card.functionExportId,
    schemaHash: registration.schemaHash,
  });
  return syntheticDefinition(card, binding, options);
}

/**
 * Convert the Canvas v1 CustomActionDefinition projection. Definitions without
 * immutable plugin provenance cannot be assigned a Generator identity safely.
 */
export function generatorDefinitionFromCustomActionDefinition(
  definitionInput: unknown,
  options: GeneratorV1CompatOptions = {},
): GeneratorDefinition {
  const definition: CustomActionDefinition =
    CustomActionDefinitionSchema.parse(definitionInput);
  if (definition.generator) {
    throw new Error("This Custom Action projects a native Generator. Resolve its declared Definition instead of synthesizing a second one.");
  }
  if (!definition.pluginBinding) {
    throw new Error(
      `Custom Action ${definition.id} requires pluginBinding before Generator migration.`,
    );
  }
  const binding = ExecutablePluginBindingSchema.parse(definition.pluginBinding);

  return syntheticDefinition(
    {
      id: definition.id,
      functionExportId: binding.exportId,
      input: definition.input,
      outputType: definition.outputType,
      parameters: definition.parameters,
    },
    binding,
    options,
  );
}
