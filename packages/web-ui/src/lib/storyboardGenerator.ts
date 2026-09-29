import type {
  GeneratorDefinition,
  GeneratorInputRef,
  StoryboardViewResource,
} from "@clash/shared-types";
import type { GeneratorClient } from "@clash/shared-runtime/generator-client";

export interface StoryboardGeneratorChoice {
  definition: GeneratorDefinition;
  actionId: string;
  outputSlot: string;
  mediaKind: "image" | "video" | "audio" | "model";
  label: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

/** Only expose prompt-only Actions that the View can invoke completely and honestly. */
export function storyboardGeneratorChoices(
  definitions: readonly GeneratorDefinition[],
): StoryboardGeneratorChoice[] {
  const choices: StoryboardGeneratorChoice[] = [];
  for (const definition of definitions) {
    const stateSchema = record(
      definition.stateSchema,
      "Generator state schema",
    );
    const required = Array.isArray(stateSchema.required)
      ? stateSchema.required
      : [];
    const properties = record(
      stateSchema.properties ?? {},
      "Generator state properties",
    );
    if (
      !("prompt" in properties) ||
      required.some((field) => field !== "prompt")
    )
      continue;
    for (const action of definition.actions) {
      const parameterSchema = record(
        action.parametersSchema,
        "Action parameters schema",
      );
      if (
        Array.isArray(parameterSchema.required) &&
        parameterSchema.required.length > 0
      )
        continue;
      if (
        action.invocationInputs.some((input) => input.cardinality.minItems > 0)
      )
        continue;
      for (const output of action.outputs) {
        if (output.assetType.kind !== "media") continue;
        choices.push({
          definition,
          actionId: action.id,
          outputSlot: output.slot,
          mediaKind: output.assetType.mediaKind,
          label: `${definition.definitionId} · ${action.id}`,
        });
      }
    }
  }
  return choices;
}

export async function runStoryboardMaterialGenerator(options: {
  client: Pick<
    GeneratorClient,
    "createGenerator" | "submitActionRun" | "getActionRun" | "getOutputCommit"
  >;
  projectId: string;
  definition: GeneratorDefinition;
  actionId: string;
  outputSlot: string;
  prompt: string;
  existingRevision?: boolean;
  invocationInputRefs?: GeneratorInputRef[];
  parameters?: Record<
    string,
    import("@clash/shared-types").ExecutablePluginJsonValue
  >;
  ids: {
    generatorId: string;
    generatorRevisionId: string;
    actionRunId: string;
  };
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<StoryboardViewResource> {
  const prompt = options.prompt.trim();
  if (!options.existingRevision && !prompt)
    throw new Error("A material prompt is required");
  if (!options.existingRevision)
    await options.client.createGenerator(options.projectId, {
      generatorId: options.ids.generatorId,
      generatorRevisionId: options.ids.generatorRevisionId,
      pluginId: options.definition.pluginId,
      definitionId: options.definition.definitionId,
      state: { prompt },
      persistentInputRefs: [],
    });
  await options.client.submitActionRun(
    options.projectId,
    options.ids.generatorId,
    options.actionId,
    {
      actionRunId: options.ids.actionRunId,
      generatorRevisionId: options.ids.generatorRevisionId,
      parameters: options.parameters ?? {},
      invocationInputRefs: options.invocationInputRefs ?? [],
    },
  );
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, ms);
      }));
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const response = record(
      await options.client.getActionRun(
        options.projectId,
        options.ids.actionRunId,
      ),
      "Generator Action Run",
    );
    const run = record(response.run, "Generator Action Run");
    if (run.status === "succeeded") break;
    if (run.status === "failed")
      throw new Error(`Generator run ${options.ids.actionRunId} failed`);
    if (Date.now() >= deadline)
      throw new Error(`Generator run ${options.ids.actionRunId} timed out`);
    await sleep(300);
  }
  const response = record(
    await options.client.getOutputCommit(
      options.projectId,
      options.ids.actionRunId,
      options.outputSlot,
    ),
    "Generator Output Commit",
  );
  const commit = record(response.commit, "Generator Output Commit");
  const asset = record(commit.asset, "Generator Output Commit asset");
  if (asset.kind !== "media" || typeof asset.projectAssetId !== "string") {
    throw new Error(
      "Generator Output Commit did not contain a media Project Asset",
    );
  }
  const action = options.definition.actions.find(
    (entry) => entry.id === options.actionId,
  );
  const output = action?.outputs.find(
    (entry) => entry.slot === options.outputSlot,
  );
  if (!output || output.assetType.kind !== "media") {
    throw new Error("Generator output slot is not media");
  }
  const outputCommitId =
    typeof commit.id === "string"
      ? commit.id
      : `${options.ids.actionRunId}:${options.outputSlot}`;
  return {
    id: outputCommitId,
    projectAssetId: asset.projectAssetId,
    mediaKind: output.assetType.mediaKind,
    modelName: options.definition.definitionId,
    generatedBy: {
      generatorId: options.ids.generatorId,
      generatorRevisionId: options.ids.generatorRevisionId,
      actionRunId: options.ids.actionRunId,
      outputCommitId,
      outputSlot: options.outputSlot,
    },
  };
}
