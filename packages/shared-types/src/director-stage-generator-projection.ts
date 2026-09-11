import { z } from "zod";
import { DIRECTOR_CODE_INPUT_SLOT, directorCodeRegistryError } from "./director-code.js";

import {
  DirectorStageStateSchema,
  type DirectorStageOwner,
  type ProjectDirectorStage,
} from "./director-stage.js";
import type {
  GeneratorDefinition,
  GeneratorDefinitionRef,
  GeneratorInputRef,
  GeneratorRevision,
  ProjectGenerator,
} from "./generator-v2.js";
import type { ExecutablePluginJsonValue } from "./plugin-json-value.js";

const EnvelopeSchema = z
  .object({
    name: z.string(),
    owner: z.union([
      z.object({ kind: z.literal("project") }).strict(),
      z
        .object({
          kind: z.literal("canvas-action"),
          canvasId: z.string().min(1),
          actionNodeId: z.string().min(1),
        })
        .strict(),
    ]),
    state: DirectorStageStateSchema,
  })
  .strict();

export type DirectorStageProjectionWriteResult =
  | {
      ok: true;
      state: Record<string, ExecutablePluginJsonValue>;
      persistentInputRefs: GeneratorInputRef[];
    }
  | { ok: false; code: string; message: string };
export type DirectorStageProjectionReadResult =
  | { ok: true; stage: ProjectDirectorStage }
  | { ok: false; code: string; generatorId: string; revisionId: string };

function refsMatch(
  a: GeneratorDefinitionRef,
  b: GeneratorDefinitionRef,
): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.definitionId === b.definitionId &&
    a.version === b.version &&
    a.schemaHash === b.schemaHash
  );
}

function profileError(
  definition: GeneratorDefinition,
): { code: string; message: string } | undefined {
  const surface = definition.projectionSurface;
  if (!surface || surface.id !== "clash.director-stage")
    return {
      code: "GENERATOR_PROJECTION_SURFACE_NOT_CLAIMED",
      message: "Definition does not claim clash.director-stage.",
    };
  if (!surface.mediaInputSlot)
    return {
      code: "GENERATOR_PROJECTION_SURFACE_MISSING_MEDIA_SLOT",
      message: "Director Stage requires a persistent media input slot.",
    };
  const action = definition.actions.find(
    ({ id }) => id === surface.primaryActionId,
  );
  if (
    !action ||
    action.id !== "capture-frame" ||
    action.outputs.length !== 1 ||
    action.outputs[0]?.assetType.kind !== "media" ||
    action.outputs[0].assetType.mediaKind !== "image" ||
    action.outputs[0].cardinality.minItems !== 1 ||
    action.outputs[0].cardinality.maxItems !== 1
  ) {
    return {
      code: "GENERATOR_PROJECTION_PROFILE_INVALID",
      message:
        "Director Stage requires the capture-frame primary Action with one image output.",
    };
  }
  return undefined;
}

export function projectDirectorStageToGeneratorRevisionState(
  stage: ProjectDirectorStage,
  definition: GeneratorDefinition,
): DirectorStageProjectionWriteResult {
  const invalid = profileError(definition);
  if (invalid) return { ok: false, ...invalid };
  const parsed = DirectorStageStateSchema.safeParse(stage.state);
  if (!parsed.success)
    return {
      ok: false,
      code: "DIRECTOR_STAGE_STATE_INVALID",
      message: parsed.error.message,
    };
  const slot = definition.projectionSurface!.mediaInputSlot!;
  const registryError = directorCodeRegistryError(parsed.data);
  if (registryError) return { ok: false, code: "DIRECTOR_CODE_REGISTRY_INVALID", message: registryError };
  const refs: GeneratorInputRef[] = [];
  for (const component of parsed.data.codeComponents ?? []) {
    refs.push({ slot: DIRECTOR_CODE_INPUT_SLOT, itemKey: component.id, target: component.source });
  }
  const add = (itemKey: string, projectAssetId: string | undefined) => {
    if (projectAssetId && !projectAssetId.startsWith("builtin:"))
      refs.push({ slot, itemKey, target: { kind: "media", projectAssetId } });
  };
  add("environment", parsed.data.scene.environmentAssetId);
  for (const object of parsed.data.objects)
    if (object.kind === "model")
      add(`model:${object.id}`, object.model.assetId);
  for (const motion of parsed.data.motionAssets ?? [])
    add(`motion:${motion.id}`, motion.assetId);
  refs.sort((a, b) => (a.itemKey ?? "").localeCompare(b.itemKey ?? ""));
  const envelope = {
    name: stage.name,
    owner: stage.owner,
    state: parsed.data,
  } as unknown as ExecutablePluginJsonValue;
  return {
    ok: true,
    state: { [definition.projectionSurface!.stateKey]: envelope },
    persistentInputRefs: refs,
  };
}

export function projectDirectorStageFromGeneratorRevision(
  input: { head: ProjectGenerator; revision: GeneratorRevision },
  definition: GeneratorDefinition,
): DirectorStageProjectionReadResult {
  const { head, revision } = input;
  const fail = (code: string): DirectorStageProjectionReadResult => ({
    ok: false,
    code,
    generatorId: head.id,
    revisionId: revision.id,
  });
  if (revision.generatorId !== head.id)
    return fail("GENERATOR_REVISION_GENERATOR_ID_MISMATCH");
  if (head.headRevisionId !== revision.id)
    return fail("GENERATOR_HEAD_REVISION_ID_MISMATCH");
  const ref = {
    pluginId: definition.pluginId,
    definitionId: definition.definitionId,
    version: definition.version,
    schemaHash: definition.schemaHash,
  };
  if (
    !refsMatch(head.definitionRef, ref) ||
    !refsMatch(revision.definitionRef, ref)
  )
    return fail("GENERATOR_DEFINITION_REF_MISMATCH");
  const invalid = profileError(definition);
  if (invalid) return fail(invalid.code);
  const parsed = EnvelopeSchema.safeParse(
    revision.state[definition.projectionSurface!.stateKey],
  );
  if (!parsed.success) return fail("GENERATOR_PROJECTION_ENVELOPE_INVALID");
  if (directorCodeRegistryError(parsed.data.state)) return fail("DIRECTOR_CODE_REGISTRY_INVALID");
  return {
    ok: true,
    stage: {
      id: head.id,
      name: parsed.data.name,
      owner: parsed.data.owner as DirectorStageOwner,
      revisionId: revision.id,
      state: parsed.data.state,
    },
  };
}
