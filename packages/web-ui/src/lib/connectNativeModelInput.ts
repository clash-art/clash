import type { GeneratorClient } from "@clash/shared-runtime/generator-client";
import {
  MODEL_CARDS,
  editModelKeyframes,
  appendActionCardInput,
  createModelTextReferenceEdit,
  assetRevisionKey,
  type AssetRevisionRef,
  type ExecutableActionCard,
} from "@clash/shared-types";
import { parseGeneratorDraftProjection } from "./generatorDraftEditor";
import {
  modelPromptPartsWithInputs,
  withModelPromptParts,
  removeModelPromptInput,
} from "./modelPromptContent";
import { createModelMediaInput } from "./modelMediaInput";

const queues = new Map<string, Promise<unknown>>();
function serialize<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = (queues.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(run);
  queues.set(key, pending);
  void pending
    .finally(() => {
      if (queues.get(key) === pending) queues.delete(key);
    })
    .catch(() => undefined);
  return pending;
}

/** Drag-connect authors a native input; the Host commits its Canvas edge too. */
export async function connectNativeModelInput(input: {
  client: Pick<GeneratorClient, "getGenerator" | "advanceGenerator"> &
    Partial<Pick<GeneratorClient, "getDefinition">>;
  projectId: string;
  generatorId: string;
  canvasId: string;
  sourceNodeId: string;
  targetNodeId: string;
  asset: AssetRevisionRef;
  kind: "image" | "video" | "audio" | "model" | "text";
  disconnect?: boolean;
  actionCard?: ExecutableActionCard["generator"];
}) {
  input = { ...input, asset: structuredClone(input.asset) };
  return serialize(
    JSON.stringify([input.projectId, input.generatorId]),
    async () => {
      const before = parseGeneratorDraftProjection(
        await input.client.getGenerator(input.projectId, input.generatorId),
      );
      if (
        before.generator.id !== input.generatorId ||
        (!input.actionCard &&
          before.revision.definitionRef.pluginId !== "clash.model-generation")
      )
        throw new Error(
          "The target no longer identifies this Generator draft.",
        );
      let refs = [...before.revision.persistentInputRefs];
      let state = before.revision.state;
      const model = input.actionCard
        ? undefined
        : MODEL_CARDS.find((card) => card.id === state.modelId);
      const keyframes = model?.input.presentation?.type === "keyframes";
      const mediaAssetId =
        input.asset.kind === "media" ? input.asset.projectAssetId : null;
      const matches = (ref: (typeof refs)[number]) =>
        assetRevisionKey(ref.target) === assetRevisionKey(input.asset);
      if (input.disconnect) {
        const removed = refs.filter(matches);
        for (const ref of removed) {
          if (keyframes && ref.slot === "image" && mediaAssetId) {
            const next = editModelKeyframes(
              { state, persistentInputRefs: refs },
              model!,
              { type: "remove", projectAssetId: mediaAssetId, input: ref },
            );
            state = next.state;
            refs = next.persistentInputRefs;
          } else if (!input.actionCard)
            state = removeModelPromptInput(state, ref);
        }
        refs = refs.filter((ref) => !removed.includes(ref));
      } else if (!refs.some(matches)) {
        if (input.actionCard) {
          if (!input.client.getDefinition)
            throw new Error("Generator registry is unavailable.");
          const response = (await input.client.getDefinition(
            before.revision.definitionRef.pluginId,
            before.revision.definitionRef.definitionId,
          )) as { definition?: unknown };
          const next = appendActionCardInput(
            before.revision,
            input.actionCard,
            response.definition,
            input.asset,
            input.kind,
          );
          state = next.state;
          refs = next.persistentInputRefs;
        } else if (input.asset.kind === "document") {
          const next = createModelTextReferenceEdit(
            { type: "text", data: { documentRevision: input.asset } },
            "",
          )({ ...before.revision, state, persistentInputRefs: refs });
          state = next.state;
          refs = next.persistentInputRefs;
        } else if (keyframes && input.kind === "image") {
          const next = editModelKeyframes(
            { state, persistentInputRefs: refs },
            model!,
            {
              type: "add",
              projectAssetId: input.asset.projectAssetId,
              position: "append",
            },
          );
          state = next.state;
          refs = next.persistentInputRefs;
        } else {
          if (input.kind === "text")
            throw new Error(
              "Text connections require an applied Document revision.",
            );
          const ref = createModelMediaInput({
            modelId: state.modelId,
            inputs: refs,
            kind: input.kind,
            projectAssetId: input.asset.projectAssetId,
          });
          state = withModelPromptParts(state, [
            ...modelPromptPartsWithInputs(state, refs),
            {
              type: "input",
              slot: ref.slot,
              ...(ref.itemKey === undefined ? {} : { itemKey: ref.itemKey }),
              label: "",
            },
          ]);
          refs.push(ref);
        }
      }
      const revisionId = crypto.randomUUID();
      const accepted = parseGeneratorDraftProjection(
        await input.client.advanceGenerator(
          input.projectId,
          input.generatorId,
          {
            expectedHeadRevisionId: before.revision.id,
            generatorRevisionId: revisionId,
            state,
            persistentInputRefs: refs,
            canvasInputConnections: [
              {
                canvasId: input.canvasId,
                sourceNodeId: input.sourceNodeId,
                targetNodeId: input.targetNodeId,
                asset: input.asset,
                ...(input.disconnect ? { disconnect: true } : {}),
              },
            ],
          },
        ),
      );
      if (
        accepted.generator.id !== input.generatorId ||
        accepted.revision.id !== revisionId ||
        accepted.revision.parentRevisionId !== before.revision.id
      )
        throw new Error(
          "The connection acknowledgement does not match this edit.",
        );
      return accepted;
    },
  );
}
