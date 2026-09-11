import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { LoroDoc } from "loro-crdt";

import {
  GeneratorDefinitionSchema,
  GeneratorInputRefSchema,
  readDocumentAssetRevision,
  readGeneratorRevision,
  readProjectAsset,
  type ActionRunRequest,
  type GeneratorActionDefinition,
  type GeneratorDefinition,
  type GeneratorInputPort,
  type GeneratorInputRef,
  type GeneratorInputType,
  type GeneratorRevision,
  type GeneratorRevisionRef,
} from "@clash/shared-types";

const ajv = new Ajv({ allErrors: true, strict: true });

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contractError(message: string): never {
  throw new Error(`GENERATOR_CONTRACT_VIOLATION: ${message}`);
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const path = error.instancePath || "/";
      return `${path} ${error.message ?? "is invalid"}`;
    })
    .join("; ");
}

function compileSchema(
  schema: GeneratorDefinition["stateSchema"],
  subject: string,
): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (error) {
    contractError(
      `${subject} schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertSchema(
  schema: GeneratorDefinition["stateSchema"],
  value: unknown,
  subject: string,
): void {
  const validate = compileSchema(schema, subject);
  if (!validate(value)) {
    contractError(`${subject} ${formatSchemaErrors(validate.errors)}`);
  }
}

function definitionRef(definition: GeneratorDefinition) {
  return {
    pluginId: definition.pluginId,
    definitionId: definition.definitionId,
    version: definition.version,
    schemaHash: definition.schemaHash,
  };
}

export function canonicalInputRefs(
  input: readonly GeneratorInputRef[],
): GeneratorInputRef[] {
  return input
    .map((entry) => GeneratorInputRefSchema.parse(entry))
    .sort((left, right) => {
      const leftKey = `${left.slot}\0${left.itemKey ?? ""}\0${canonicalJson(left.target)}`;
      const rightKey = `${right.slot}\0${right.itemKey ?? ""}\0${canonicalJson(right.target)}`;
      return leftKey.localeCompare(rightKey);
    });
}

function targetMatches(
  doc: LoroDoc,
  target: GeneratorInputRef["target"],
  accepted: GeneratorInputType,
): boolean {
  if ("kind" in target && target.kind === "media") {
    if (accepted.kind !== "media") return false;
    const asset = readProjectAsset(doc, target.projectAssetId);
    if (!asset || asset.lifecycle.state !== "active") {
      contractError(
        `media Asset ${target.projectAssetId} is not found or active.`,
      );
    }
    return asset.kind === accepted.mediaKind;
  }
  if ("kind" in target && target.kind === "document") {
    if (accepted.kind !== "document") return false;
    const revision = readDocumentAssetRevision(doc, target);
    if (!revision) {
      contractError(
        `Document revision ${target.documentAssetId}/${target.revisionId} not found.`,
      );
    }
    return (
      revision.documentKind === accepted.documentKind &&
      revision.schemaVersion === accepted.schemaVersion
    );
  }
  if (accepted.kind !== "generator") return false;
  const revision = readGeneratorRevision(doc, target);
  if (!revision) {
    contractError(
      `Generator revision ${target.generatorId}/${target.generatorRevisionId} not found.`,
    );
  }
  return (
    revision.definitionRef.pluginId === accepted.pluginId &&
    revision.definitionRef.definitionId === accepted.definitionId
  );
}

function assertInputs(
  doc: LoroDoc,
  ports: readonly GeneratorInputPort[],
  refsInput: readonly GeneratorInputRef[],
  subject: string,
): GeneratorInputRef[] {
  const refs = canonicalInputRefs(refsInput);
  const portsBySlot = new Map(ports.map((port) => [port.slot, port]));
  const refsBySlot = new Map<string, GeneratorInputRef[]>();
  for (const ref of refs) {
    const port = portsBySlot.get(ref.slot);
    if (!port) contractError(`${subject} has unknown input slot ${ref.slot}.`);
    const group = refsBySlot.get(ref.slot) ?? [];
    group.push(ref);
    refsBySlot.set(ref.slot, group);
    if (
      !port.accepts.some((accepted) => targetMatches(doc, ref.target, accepted))
    ) {
      contractError(`${subject} slot ${ref.slot} has the wrong target type.`);
    }
  }
  for (const port of ports) {
    const group = refsBySlot.get(port.slot) ?? [];
    if (
      group.length < port.cardinality.minItems ||
      (port.cardinality.maxItems !== null &&
        group.length > port.cardinality.maxItems)
    ) {
      contractError(
        `${subject} slot ${port.slot} violates its ${port.cardinality.minItems}..${port.cardinality.maxItems ?? "many"} cardinality.`,
      );
    }
    const isCollection =
      port.cardinality.maxItems === null || port.cardinality.maxItems > 1;
    if (isCollection) {
      const keys = new Set<string>();
      for (const ref of group) {
        if (!ref.itemKey) {
          contractError(
            `${subject} collection slot ${port.slot} requires an itemKey for every input.`,
          );
        }
        if (keys.has(ref.itemKey)) {
          contractError(
            `${subject} collection slot ${port.slot} has duplicate itemKey ${ref.itemKey}.`,
          );
        }
        keys.add(ref.itemKey);
      }
    } else if (group.some((ref) => ref.itemKey !== undefined)) {
      contractError(
        `${subject} singular slot ${port.slot} must not declare an itemKey.`,
      );
    }
  }
  return refs;
}

/** Validate a candidate immutable revision before the Host inserts it. */
export function validateLocalGeneratorRevisionContract(input: {
  doc: LoroDoc;
  definition: GeneratorDefinition;
  revision: GeneratorRevision;
}): GeneratorRevision {
  const definition = GeneratorDefinitionSchema.parse(input.definition);
  if (
    !isDeepStrictEqual(input.revision.definitionRef, definitionRef(definition))
  ) {
    contractError(
      "Generator revision definition provenance does not match the installed definition.",
    );
  }
  assertSchema(definition.stateSchema, input.revision.state, "Generator state");
  return {
    ...input.revision,
    persistentInputRefs: assertInputs(
      input.doc,
      definition.persistentInputs,
      input.revision.persistentInputRefs,
      "Generator revision",
    ),
  };
}

export interface BuildLocalGeneratorActionRunInput {
  doc: LoroDoc;
  definition: GeneratorDefinition;
  actionRunId: string;
  generatorRevision: GeneratorRevisionRef;
  actionId: string;
  parameters: ActionRunRequest["parameters"];
  modelSelection?: NonNullable<ActionRunRequest["modelSelection"]>;
  invocationInputRefs: GeneratorInputRef[];
}

export interface BuiltLocalGeneratorActionRun {
  definition: GeneratorDefinition;
  revision: GeneratorRevision;
  action: GeneratorActionDefinition;
  request: ActionRunRequest;
}

/**
 * The one Host command boundary that turns an intentional invocation into an
 * immutable public Run request. Callers provide no output contract, executor,
 * or fingerprint; all three are derived from the installed definition.
 */
export function prepareLocalGeneratorActionRun(
  input: BuildLocalGeneratorActionRunInput,
): Pick<BuiltLocalGeneratorActionRun, "definition" | "revision" | "action"> & {
  invocationInputRefs: GeneratorInputRef[];
  outputContract: ActionRunRequest["outputContract"];
} {
  const definition = GeneratorDefinitionSchema.parse(input.definition);
  const revision = readGeneratorRevision(input.doc, input.generatorRevision);
  if (!revision) {
    contractError(
      `Generator revision ${input.generatorRevision.generatorId}/${input.generatorRevision.generatorRevisionId} not found.`,
    );
  }
  if (!isDeepStrictEqual(revision.definitionRef, definitionRef(definition))) {
    contractError(
      "The installed Generator definition does not match the immutable revision.",
    );
  }
  const action = definition.actions.find(
    (candidate) => candidate.id === input.actionId,
  );
  if (!action) {
    contractError(
      `Generator definition ${definition.definitionId} has no Action ${input.actionId}.`,
    );
  }

  assertSchema(definition.stateSchema, revision.state, "Generator state");
  assertInputs(
    input.doc,
    definition.persistentInputs,
    revision.persistentInputRefs,
    "Generator revision",
  );
  assertSchema(action.parametersSchema, input.parameters, "Action parameters");
  const invocationInputRefs = assertInputs(
    input.doc,
    action.invocationInputs,
    input.invocationInputRefs,
    "Action invocation",
  );
  const outputContract = (() => {
    if (!action.selectOutputsByParameter) return action.outputs;
    const supplied = (input.parameters as Record<string, unknown>)[
      action.selectOutputsByParameter
    ];
    // A declaration may provide a default selection for prompt-only invocations.
    const properties = action.parametersSchema.properties;
    const selector = properties && typeof properties === "object" && !Array.isArray(properties)
      ? properties[action.selectOutputsByParameter]
      : undefined;
    const selected = supplied === undefined && selector &&
      typeof selector === "object" && !Array.isArray(selector)
      ? selector.default
      : supplied;
    if (!Array.isArray(selected)) {
      contractError(
        `Action parameter ${action.selectOutputsByParameter} must select output slots.`,
      );
    }
    const slots = selected.map((value) => {
      if (typeof value !== "string") {
        contractError(
          `Action parameter ${action.selectOutputsByParameter} must contain output slot strings.`,
        );
      }
      return value;
    });
    if (new Set(slots).size !== slots.length) {
      contractError("Action output selection has duplicate categories.");
    }
    const declared = new Map(action.outputs.map((output) => [output.slot, output]));
    const sourceKinds = invocationInputRefs.flatMap((ref) => {
      if (!("kind" in ref.target) || ref.target.kind !== "media") return [];
      const asset = readProjectAsset(input.doc, ref.target.projectAssetId);
      return asset ? [asset.kind] : [];
    });
    return slots.map((slot) => {
      const output = declared.get(slot);
      if (!output) contractError(`Action output selection has unknown category ${slot}.`);
      if (
        output.sourceMediaKinds &&
        sourceKinds.some(
          (kind) =>
            kind === "model" || !output.sourceMediaKinds!.includes(kind),
        )
      ) {
        contractError(`Action output category ${slot} is not applicable to the source media kind.`);
      }
      return {
        ...output,
        cardinality: { minItems: 1 as const, maxItems: 1 as const },
      };
    });
  })();
  return { definition, revision, action, invocationInputRefs, outputContract };
}

export function buildLocalGeneratorActionRun(
  input: BuildLocalGeneratorActionRunInput,
): BuiltLocalGeneratorActionRun {
  const { definition, revision, action, invocationInputRefs, outputContract } =
    prepareLocalGeneratorActionRun(input);
  if (action.modelExecution && !input.modelSelection?.route.executorBinding) {
    contractError("A model Action requires a Host-selected, pinned Provider executor.");
  }
  const executor = action.modelExecution ? input.modelSelection!.route.executorBinding! : {
    pluginId: definition.pluginId,
    version: definition.version,
    exportId: action.executorExportId!,
    schemaHash: definition.schemaHash,
  };
  const semanticInvocation = {
    definitionRef: definitionRef(definition),
    generatorRevision: input.generatorRevision,
    actionId: action.id,
    executor,
    parameters: input.parameters,
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
    invocationInputRefs,
    outputContract,
  };
  const invocationFingerprint = `sha256:${createHash("sha256")
    .update(canonicalJson(semanticInvocation))
    .digest("hex")}` as const;
  return {
    definition,
    revision,
    action,
    request: {
      actionRunId: input.actionRunId,
      generatorRevision: input.generatorRevision,
      actionId: action.id,
      executor,
      invocationFingerprint,
      parameters: input.parameters,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      invocationInputRefs,
      outputContract,
    },
  };
}
