import { expect, it } from "vitest";
import { MODEL_CARDS } from "./models.js";
import { editModelKeyframes } from "./model-keyframes.js";
import { modelInputRefsInPromptOrder } from "./model-prompt-content.js";

it("edits image inputs, their order and timing as one draft value", () => {
  const model = MODEL_CARDS.find(card => card.id === "flux-3-video-keyframes")!;
  if (model.input.presentation?.type !== "keyframes") throw new Error("Expected keyframe card");
  const initial = { state: { modelId: model.id, prompt: "Animate", params: { duration: 5 } }, persistentInputRefs: [] };
  const start = editModelKeyframes(initial, model, { type: "add", projectAssetId: "start", position: "start" });
  expect(start.persistentInputRefs[0]?.slot).toBe("image");
  const end = editModelKeyframes(start, model, { type: "add", projectAssetId: "end", position: "end" });
  const middle = editModelKeyframes(end, model, { type: "add", projectAssetId: "middle", position: "append" });
  const assets = modelInputRefsInPromptOrder(middle.state, middle.persistentInputRefs).map(ref => "kind" in ref.target && ref.target.kind === "media" ? ref.target.projectAssetId : null);
  expect(assets).toEqual(["start", "middle", "end"]);
  const frames = JSON.parse(String((middle.state.params as Record<string, unknown>).keyframe_frame_indices));
  expect(frames[0]).toBe(0);
  expect(frames[1]).toBeGreaterThan(frames[0]);
  expect(frames[1]).toBeLessThan(frames[2]);
  expect(frames[2]).toBe(5 * model.input.presentation.frameRate!);
  const removed = editModelKeyframes(middle, model, { type: "remove", projectAssetId: "middle" });
  expect(modelInputRefsInPromptOrder(removed.state, removed.persistentInputRefs)).toEqual(modelInputRefsInPromptOrder(end.state, end.persistentInputRefs));
  expect(removed.state.params).toEqual(end.state.params);
  expect(initial).toEqual({ state: { modelId: model.id, prompt: "Animate", params: { duration: 5 } }, persistentInputRefs: [] });
});

it("removes one keyframe identity when the same Asset appears twice", () => {
  const model = MODEL_CARDS.find(card => card.id === "flux-3-video-keyframes")!;
  const refs = ["opening", "middle", "closing"].map(itemKey => ({ slot: "image", itemKey, target: { kind: "media" as const, projectAssetId: itemKey === "middle" ? "other" : "shared" } }));
  const before = { state: { modelId: model.id, prompt: "Animate", params: { duration: 5, keyframe_frame_indices: "[0,24,120]", keyframe_timing_customized: true } }, persistentInputRefs: refs };
  const after = editModelKeyframes(before, model, { type: "remove", projectAssetId: "shared", input: refs[0] });
  expect(after.persistentInputRefs).toEqual(refs.slice(1));
  expect((after.state.params as Record<string, unknown>).keyframe_frame_indices).toBe("[0,120]");
  expect(before.persistentInputRefs).toEqual(refs);
});
