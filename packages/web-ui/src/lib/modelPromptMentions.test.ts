import { expect, it } from "vitest";
import type { GeneratorRevision } from "@clash/shared-types";
import { createModelPromptEdit } from "./modelPromptMentions";

const revision: GeneratorRevision = { id: "revision", generatorId: "generator", definitionRef: { pluginId: "clash.model-generation", definitionId: "image", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` }, state: { modelId: "model", prompt: "Old" }, persistentInputRefs: [] };
it("freezes media identity and text content in mention order", () => {
  const nodes = { photo: { type: "image", data: { assetId: "immutable-photo" } }, brief: { type: "text", data: { content: "at dawn" } } };
  const edit = createModelPromptEdit("Show @[cat](node:photo) @[brief](node:brief)", (id) => nodes[id as keyof typeof nodes]);
  nodes.brief.data.content = "later edit";
  const next = edit(revision);
  expect(next.state.prompt).toBe("Show cat at dawn");
  expect(next.persistentInputRefs).toEqual([{ slot: "image", itemKey: expect.any(String), target: { kind: "media", projectAssetId: "immutable-photo" } }]);
  expect(next.state.contentParts).toEqual([{ type: "text", text: "Show " }, { type: "input", slot: "image", itemKey: next.persistentInputRefs[0]!.itemKey, label: "cat" }, { type: "text", text: " " }, { type: "text", text: "at dawn" }]);
});
it("retains already attached inputs that were not mentioned and places each in the content sequence", () => {
  const attached = { slot: "video", itemKey: "attached", target: { kind: "media" as const, projectAssetId: "clip" } };
  const next = createModelPromptEdit("@[cat](node:photo)", () => ({ type: "image", data: { assetId: "photo" } }))({ ...revision, persistentInputRefs: [attached] });
  expect(next.persistentInputRefs).toContainEqual(attached);
  expect(next.state.contentParts).toContainEqual({ type: "input", slot: "video", itemKey: "attached", label: "" });
});
it("rejects unresolved draft media rather than saving a mutable Canvas reference", () => {
  expect(() => createModelPromptEdit("@[draft](node:pending)", () => ({ type: "image", data: {} }))).toThrow(/Asset/);
});

it("retains frame identity when a frame is mentioned repeatedly", () => {
  const next = createModelPromptEdit("@[first](node:a) then @[last](node:b) and @[first](node:a)", (id) => ({ type: "image", data: { assetId: id } }))({ ...revision, state: { modelId: "minimax-h3-startend", prompt: "" } });
  expect(next.persistentInputRefs).toEqual([
    { slot: "startFrame", target: { kind: "media", projectAssetId: "a" } },
    { slot: "endFrame", target: { kind: "media", projectAssetId: "b" } },
  ]);
  expect(next.state.prompt).toBe("first then last and first");
});

it("pins a Document mention before queued edits and reuses its exact revision across occurrences", () => {
  const target = { kind: "document" as const, documentAssetId: "script", revisionId: "saved-script" };
  const source = { type: "text", data: { documentRevision: { ...target }, content: "Stale Canvas shadow" } };
  const edit = createModelPromptEdit("Rewrite @[script](node:script), using @[script](node:script)", () => source);
  source.data.documentRevision.revisionId = "later-script";
  const next = edit(revision);
  expect(next.persistentInputRefs).toEqual([{ slot: "text", itemKey: expect.any(String), target }]);
  const ref = next.persistentInputRefs[0]!;
  expect(next.state.contentParts).toEqual([
    { type: "text", text: "Rewrite " }, { type: "input", slot: ref.slot, itemKey: ref.itemKey, label: "script" },
    { type: "text", text: ", using " }, { type: "input", slot: ref.slot, itemKey: ref.itemKey, label: "script" },
  ]);
  expect(next.state.prompt).not.toContain("Stale Canvas shadow");
});

it("rejects an invalid Document identity even when the node has a legacy text shadow", () => {
  expect(() => createModelPromptEdit("@[script](node:script)", () => ({ type: "text", data: {
    documentRevision: { kind: "document", documentAssetId: "script" }, content: "Old text",
  } }))).toThrow(/Document/);
});

it("keeps two revisions of one Document distinct and retains their authored order", () => {
  const next = createModelPromptEdit("Compare @[old](node:old) to @[new](node:new)", id => ({ type: "text", data: {
    documentRevision: { kind: "document", documentAssetId: "script", revisionId: id },
  } }))(revision);
  expect(next.persistentInputRefs.map(ref => ref.target)).toEqual([
    { kind: "document", documentAssetId: "script", revisionId: "old" },
    { kind: "document", documentAssetId: "script", revisionId: "new" },
  ]);
  expect(next.persistentInputRefs[0]!.itemKey).not.toBe(next.persistentInputRefs[1]!.itemKey);
});
