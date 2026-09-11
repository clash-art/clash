import { CreateProjectGeneratorRequestSchema, type CreateProjectGeneratorRequest, type GeneratorRevision, type CustomActionDefinition } from "@clash/shared-types";
import type { GeneratorClient } from "@clash/shared-runtime/generator-client";
import { parseGeneratorDraftProjection } from "./generatorDraftEditor";

async function createDraft(projectId: string, request: CreateProjectGeneratorRequest, client: Pick<GeneratorClient, "createGenerator">) {
  const accepted = parseGeneratorDraftProjection(await client.createGenerator(projectId, request));
  if (accepted.generator.id !== request.generatorId || accepted.revision.id !== request.generatorRevisionId) {
    throw new Error("Generator acknowledgement does not match the submitted draft.");
  }
  return accepted;
}

export async function createCanvasActionDraft(input: {
  projectId: string; card: CustomActionDefinition; prompt: string; params: GeneratorRevision["state"];
  placement: NonNullable<CreateProjectGeneratorRequest["placement"]>; client: Pick<GeneratorClient, "createGenerator">;
}) {
  if (!input.card.generator || !input.card.pluginBinding) throw new Error("The Action Card does not declare a native Generator.");
  const request = CreateProjectGeneratorRequestSchema.parse({
    generatorId: crypto.randomUUID(), generatorRevisionId: crypto.randomUUID(),
    pluginId: input.card.pluginBinding.pluginId, definitionId: input.card.generator.definitionId,
    state: { ...input.params, prompt: input.prompt }, persistentInputRefs: [],
    placement: { ...input.placement, actionCardId: input.card.id },
  });
  return createDraft(input.projectId, request, input.client);
}

/** The Host creates the draft and placement atomically and owns their layout. */
export async function createCanvasModelDraft(input: {
  projectId: string;
  kind: "image" | "video" | "audio" | "model" | "text";
  modelId: string;
  prompt: string;
  params: GeneratorRevision["state"];
  placement: NonNullable<CreateProjectGeneratorRequest["placement"]>;
  client: Pick<GeneratorClient, "createGenerator">;
}) {
  const request = CreateProjectGeneratorRequestSchema.parse({
    generatorId: crypto.randomUUID(), generatorRevisionId: crypto.randomUUID(),
    pluginId: "clash.model-generation", definitionId: input.kind,
    state: { modelId: input.modelId, prompt: input.prompt, params: input.params },
    persistentInputRefs: [], placement: input.placement,
  });
  return createDraft(input.projectId, request, input.client);
}
