import type { GeneratorRevision } from "./generator-v2.js";
import type { ModelCard } from "./models.js";
import { createModelMediaInput } from "./model-media-input.js";
import { modelInputRefsInPromptOrder, modelPromptParts, removeModelPromptInput, reorderModelMediaInputs, withModelPromptParts } from "./model-prompt-content.js";
export const KEYFRAME_FRAME_INDICES_PARAM = "keyframe_frame_indices";
export const KEYFRAME_TIMING_CUSTOMIZED_PARAM = "keyframe_timing_customized";

export function evenlySpacedFrameIndices(count: number, lastFrame: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  return Array.from({ length: count }, (_, index) =>
    Math.round((index * lastFrame) / (count - 1)),
  );
}

export function keyframeFrameIndices(
  raw: unknown,
  count: number,
  lastFrame: number,
  customized: boolean,
): number[] {
  if (typeof raw !== "string")
    return evenlySpacedFrameIndices(count, lastFrame);
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== count) {
      return evenlySpacedFrameIndices(count, lastFrame);
    }
    const values = parsed.map(Number);
    const structurallyValid = values.every(
      (value, index) =>
        Number.isInteger(value) &&
        value >= 0 &&
        (index === 0 || value > values[index - 1]),
    );
    if (!structurallyValid) return evenlySpacedFrameIndices(count, lastFrame);
    if (!customized) return evenlySpacedFrameIndices(count, lastFrame);
    if (count <= 1) return [0];
    const previousLastFrame = values[values.length - 1];
    if (previousLastFrame <= 0)
      return evenlySpacedFrameIndices(count, lastFrame);
    const scaled = values.map((value) =>
      Math.round((value / previousLastFrame) * lastFrame),
    );
    scaled[0] = 0;
    scaled[scaled.length - 1] = lastFrame;
    for (let index = 1; index < scaled.length; index += 1) {
      scaled[index] = Math.max(scaled[index], scaled[index - 1] + 1);
    }
    for (let index = scaled.length - 2; index >= 0; index -= 1) {
      scaled[index] = Math.min(scaled[index], scaled[index + 1] - 1);
    }
    return scaled;
  } catch {
    return evenlySpacedFrameIndices(count, lastFrame);
  }
}

export function planKeyframeInsertion(
  currentFrames: number[],
  lastFrame: number,
  customized: boolean,
): { insertionIndex: number; frameIndices: number[] } {
  const nextCount = currentFrames.length + 1;
  if (!customized || currentFrames.length < 2) {
    return {
      insertionIndex: Math.max(1, currentFrames.length - 1),
      frameIndices: evenlySpacedFrameIndices(nextCount, lastFrame),
    };
  }
  let insertionIndex = 1;
  let largestGap = -1;
  for (let index = 0; index < currentFrames.length - 1; index += 1) {
    const gap = currentFrames[index + 1] - currentFrames[index];
    if (gap >= largestGap) {
      largestGap = gap;
      insertionIndex = index + 1;
    }
  }
  if (largestGap <= 1) {
    return {
      insertionIndex: Math.max(1, currentFrames.length - 1),
      frameIndices: evenlySpacedFrameIndices(nextCount, lastFrame),
    };
  }
  const frameIndices = [...currentFrames];
  frameIndices.splice(
    insertionIndex,
    0,
    Math.floor(
      (currentFrames[insertionIndex - 1] + currentFrames[insertionIndex]) / 2,
    ),
  );
  return { insertionIndex, frameIndices };
}


type Draft = Pick<GeneratorRevision, "state" | "persistentInputRefs">;
export function editModelKeyframes(before: Draft, model: ModelCard, operation:
  { type: "add"; projectAssetId: string; position: "start" | "end" | "append" } |
  { type: "remove"; projectAssetId: string; input?: { slot: string; itemKey?: string } }): Draft {
  if (model.id !== before.state.modelId || model.input.presentation?.type !== "keyframes" || !model.input.inputMode.images) throw new Error("This Model does not accept ordered image keyframes.");
  const params = before.state.params && typeof before.state.params === "object" && !Array.isArray(before.state.params) ? before.state.params : {};
  const duration = Number(params.duration ?? model.defaultParams.duration);
  const lastFrame = Math.round(duration * (model.input.presentation.frameRate ?? 24));
  if (!Number.isFinite(lastFrame) || lastFrame <= 0) throw new Error("Keyframes require a positive duration.");
  const customized = params[KEYFRAME_TIMING_CUSTOMIZED_PARAM] === true;
  let refs = [...before.persistentInputRefs];
  let ordered = modelInputRefsInPromptOrder(before.state, refs).filter(ref => ref.slot === "image" && "kind" in ref.target && ref.target.kind === "media");
  let frames = keyframeFrameIndices(params[KEYFRAME_FRAME_INDICES_PARAM], ordered.length, lastFrame, customized);
  let state = before.state;
  const remove = (index: number) => {
    const removed = ordered[index]!;
    state = removeModelPromptInput(state, removed);
    refs = refs.filter(ref => ref !== removed);
    ordered.splice(index, 1);
    frames.splice(index, 1);
  };
  const existingIndex = ordered.findIndex(ref => "kind" in ref.target && ref.target.kind === "media" && ref.target.projectAssetId === operation.projectAssetId && (operation.type !== "remove" || !operation.input || (ref.slot === operation.input.slot && ref.itemKey === operation.input.itemKey)));
  if (operation.type === "remove") {
    if (existingIndex < 0) throw new Error("The keyframe changed. Read the draft again.");
    remove(existingIndex);
    if (!customized) frames = evenlySpacedFrameIndices(ordered.length, lastFrame);
    else { if (frames.length) frames[0] = 0; if (frames.length > 1) frames[frames.length - 1] = lastFrame; }
  } else {
    if (existingIndex >= 0) return before;
    if (operation.position === "end" && !ordered.length) throw new Error("Add the Start keyframe first.");
    let insertion: number;
    if (operation.position === "start" && ordered.length) { remove(0); insertion = 0; }
    else if (operation.position === "end" && ordered.length > 1) { insertion = ordered.length - 1; remove(insertion); }
    else insertion = operation.position === "start" ? 0 : ordered.length;
    if (ordered.length >= model.input.inputMode.images.max) throw new Error("This Model has reached its keyframe limit.");
    const added = createModelMediaInput({ modelId: model.id, model, inputs: refs, kind: "image", projectAssetId: operation.projectAssetId });
    if (operation.position === "append") {
      const planned = planKeyframeInsertion(frames, lastFrame, customized);
      insertion = Math.min(planned.insertionIndex, ordered.length);
      frames = planned.frameIndices;
    } else { frames.splice(insertion, 0, insertion === 0 ? 0 : lastFrame); }
    refs.push(added);
    ordered.splice(insertion, 0, added);
    if (!customized) frames = evenlySpacedFrameIndices(ordered.length, lastFrame);
    const parts = state.contentParts === undefined
      ? [{ type: "text" as const, text: typeof state.prompt === "string" ? state.prompt : "" }, ...refs.map(ref => ({ type: "input" as const, slot: ref.slot, ...(ref.itemKey === undefined ? {} : { itemKey: ref.itemKey }), label: "" }))]
      : [...modelPromptParts(state), { type: "input" as const, slot: added.slot, itemKey: added.itemKey, label: "" }];
    state = withModelPromptParts(state, parts);
  }
  state = reorderModelMediaInputs(state, refs, ordered.flatMap(ref => "kind" in ref.target && ref.target.kind === "media" ? [ref.target.projectAssetId] : []));
  return { state: { ...state, params: { ...params, [KEYFRAME_FRAME_INDICES_PARAM]: JSON.stringify(frames), [KEYFRAME_TIMING_CUSTOMIZED_PARAM]: customized } }, persistentInputRefs: refs };
}
