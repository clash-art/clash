import { MODEL_CARDS, type ModelCard } from "./models.js";
import type { GeneratorInputRef } from "./generator-v2.js";

/** Bind form/Canvas media to the Model's declared input role, before admission. */
export function createModelMediaInput(options: {
  modelId: unknown;
  model?: ModelCard;
  inputs: readonly GeneratorInputRef[];
  kind: "image" | "video" | "audio" | "model";
  projectAssetId: string;
  endpoint?: "start" | "end";
}): GeneratorInputRef {
  const card = options.model ?? MODEL_CARDS.find((candidate) => candidate.id === options.modelId);
  const mode = card?.input.inputMode;
  let slot: string = options.kind;
  if (options.endpoint) {
    if (options.kind !== "image" || !mode?.startEnd) throw new Error("This Model does not accept that frame input.");
    slot = options.endpoint === "start" ? "startFrame" : "endFrame";
  } else if (options.kind === "image" && mode?.startEnd && !mode.images) {
    const vacant = ["startFrame", "endFrame"].find((role) => !options.inputs.some((ref) => ref.slot === role));
    if (!vacant) throw new Error("Both frame inputs are occupied. Replace a Start or End frame explicitly.");
    slot = vacant;
  }
  return {
    slot,
    ...(slot === "startFrame" || slot === "endFrame" ? {} : { itemKey: crypto.randomUUID() }),
    target: { kind: "media", projectAssetId: options.projectAssetId },
  };
}
