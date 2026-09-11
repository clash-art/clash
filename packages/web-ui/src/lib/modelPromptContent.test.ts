import { expect, it } from "vitest";
import { editModelPromptText, removeModelPromptInput, reorderModelMediaInputs, modelInputRefsInPromptOrder, modelPromptPartsWithInputs } from "./modelPromptContent";

it("materializes omitted inputs after existing content without collapsing repeated occurrences", () => {
  const ref = { slot: "image", itemKey: "subject", target: { kind: "media" as const, projectAssetId: "subject" } };
  const endpoint = { slot: "endFrame", target: { kind: "media" as const, projectAssetId: "end" } };
  const occurrence = { type: "input", slot: ref.slot, itemKey: ref.itemKey, label: "cat" };
  const state = { contentParts: [occurrence, { type: "text", text: " follows " }, occurrence] };
  expect(modelPromptPartsWithInputs(state, [endpoint, ref])).toEqual([
    ...state.contentParts, { type: "input", slot: endpoint.slot, label: "" },
  ]);
});

it("edits text without moving or relabeling the ordered media reference", () => {
  const input = { type: "input", slot: "image", itemKey: "subject", label: "cat" };
  const state = { prompt: "A cat sleeping", contentParts: [{ type: "text", text: "A " }, input, { type: "text", text: " sleeping" }] };
  const next = editModelPromptText(state, 2, " running");
  expect(next.prompt).toBe("A cat running");
  expect(next.contentParts).toEqual([state.contentParts[0], input, { type: "text", text: " running" }]);
  expect(state.prompt).toBe("A cat sleeping");
});

it("removes only the named input occurrence and its label from the prompt", () => {
  const state = { prompt: "beforeafter", contentParts: [
    { type: "input", slot: "video", itemKey: "first", label: "before" },
    { type: "input", slot: "video", itemKey: "second", label: "after" },
  ] };
  const next = removeModelPromptInput(state, { slot: "video", itemKey: "first" });
  expect(next.prompt).toBe("after");
  expect(next.contentParts).toEqual([state.contentParts[1]]);
});

it("rejects a text edit if that position is now a media input", () => {
  expect(() => editModelPromptText({ prompt: "", contentParts: [{ type: "input", slot: "image" }] }, 0, "replace"))
    .toThrow(/changed/i);
});

it("stores media order independently of normalized input identity order", () => {
  const refs = [
    { slot: "image", itemKey: "a", target: { kind: "media" as const, projectAssetId: "first" } },
    { slot: "image", itemKey: "b", target: { kind: "media" as const, projectAssetId: "second" } },
    { slot: "audio", itemKey: "c", target: { kind: "media" as const, projectAssetId: "unplaced" } },
  ];
  const state = reorderModelMediaInputs({ prompt: "Scene" }, refs, ["second", "first"]);
  expect(modelInputRefsInPromptOrder(state, refs)).toEqual([refs[1], refs[0], refs[2]]);
  expect(state.prompt).toBe("Scene");
  const mixed: { prompt: string; contentParts: Record<string, string>[] } = { prompt: "A then B", contentParts: [
    { type: "input", slot: "image", itemKey: "a", label: "A" },
    { type: "text", text: " then " },
    { type: "input", slot: "image", itemKey: "b", label: "B" },
    { type: "input", slot: "audio", itemKey: "c", label: "" },
  ] };
  const reordered = reorderModelMediaInputs(mixed, refs, ["second", "first"]);
  expect(reordered.prompt).toBe("B then A");
  expect((reordered.contentParts as unknown[])[1]).toEqual(mixed.contentParts[1]);
  expect(modelInputRefsInPromptOrder(reordered, refs)).toEqual([refs[1], refs[0], refs[2]]);
  expect(mixed.prompt).toBe("A then B");
});

it("keeps configured keyframe time positions when images are reordered", () => {
  const refs = ["opening", "middle", "closing"].map(itemKey => ({ slot: "image", itemKey, target: { kind: "media" as const, projectAssetId: itemKey } }));
  const frames = [0, 24, 120];
  const state = { prompt: "Animate", params: { duration: 5, keyframe_frame_indices: JSON.stringify(frames), keyframe_timing_customized: true },
    contentParts: [{ type: "text", text: "Animate" }, ...refs.map(ref => ({ type: "input", slot: ref.slot, itemKey: ref.itemKey, label: "" }))] };
  const requestedOrder = ["closing", "opening", "middle"];
  const next = reorderModelMediaInputs(state, refs, requestedOrder);
  expect(next.params).toEqual(state.params);
  expect(modelInputRefsInPromptOrder(next, refs).map((ref, index) => ({ asset: ref.target, frame: frames[index] }))).toEqual(
    requestedOrder.map((projectAssetId, index) => ({ asset: { kind: "media", projectAssetId }, frame: frames[index] })),
  );
  expect(modelInputRefsInPromptOrder(state, refs)).toEqual(refs);
});
