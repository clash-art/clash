import { expect, it } from "vitest";
import { appendActionCardInput, createActionCardPromptEdit, reorderActionCardInputs, type GeneratorRevision } from "@clash/shared-types";

const link = { definitionId: "paint", actionId: "generate", inputSlots: { image: "pictures" } };
const revision: GeneratorRevision = { generatorId: "draft", id: "r1", definitionRef: { pluginId: "test.paint", definitionId: "paint", version: "1", schemaHash: `sha256:${"a".repeat(64)}` }, state: { prompt: "Old", quality: "fine" }, persistentInputRefs: [] };
const definition = { ...revision.definitionRef, stateSchema: { type: "object" }, editPolicy: "fork-when-materialized", persistentInputs: [{ slot: "pictures", accepts: [{ kind: "media", mediaKind: "image" }], cardinality: { minItems: 0, maxItems: 5 } }], actions: [{ id: "generate", executorExportId: "paint", parametersSchema: { type: "object" }, invocationInputs: [], outputs: [{ slot: "image", assetType: { kind: "media", mediaKind: "image" }, cardinality: { minItems: 1, maxItems: 1 } }] }] };

it("resolves mentions to the declared persistent slot without adding Model state", () => {
  const next = createActionCardPromptEdit("Draw @[cat](node:b) with @[dog](node:a)", link,
    (id) => ({ type: "image", data: { assetId: id } }))(revision, definition);
  expect(next.state).toEqual({ prompt: "Draw cat with dog", quality: "fine" });
  expect(next.persistentInputRefs.map((ref) => ref.target)).toEqual([
    { kind: "media", projectAssetId: "b" }, { kind: "media", projectAssetId: "a" },
  ]);
  expect(next.persistentInputRefs.every((ref) => ref.slot === link.inputSlots.image && ref.itemKey)).toBe(true);
  const reordered = reorderActionCardInputs(next.persistentInputRefs, ["a", "b"].map(projectAssetId => ({ kind: "media", projectAssetId })));
  expect(reordered.map((ref) => ref.target)).toEqual([...next.persistentInputRefs].reverse().map((ref) => ref.target));
  expect(new Set(reordered.map((ref) => ref.itemKey)).size).toBe(reordered.length);
});

it("rejects unsupported media and missing native contracts before editing", () => {
  expect(() => createActionCardPromptEdit("@[clip](node:v)", link, () => ({ type: "video", data: { assetId: "v" } }))(revision, definition)).toThrow(/mapping/);
  expect(() => createActionCardPromptEdit("@[cat](node:b)", link, () => ({ type: "image", data: { assetId: "b" } }))(revision)).toThrow();
});

it("appends after retained references when a removed input leaves an identity gap", () => {
  const authored = createActionCardPromptEdit("@[a](node:a) @[b](node:b) @[c](node:c)", link,
    (id) => ({ type: "image", data: { assetId: id } }))(revision, definition);
  const retained = { ...authored, persistentInputRefs: authored.persistentInputRefs.filter((ref) =>
    !("projectAssetId" in ref.target) || ref.target.projectAssetId !== "b") };
  const appended = appendActionCardInput(retained, link, definition, { kind: "media", projectAssetId: "d" }, "image");
  const normalized = [...appended.persistentInputRefs].sort((a, b) => (a.itemKey ?? "").localeCompare(b.itemKey ?? ""));
  expect(normalized.map((ref) => ref.target)).toEqual(["a", "c", "d"].map((projectAssetId) => ({ kind: "media", projectAssetId })));
  expect(retained.persistentInputRefs.map((ref) => ref.target)).toEqual(["a", "c"].map((projectAssetId) => ({ kind: "media", projectAssetId })));
});


it("freezes mapped Document mentions as exact inputs and never substitutes a Canvas text shadow", () => {
  const mapped = { ...link, inputSlots: { text: "scripts" } };
  const textDefinition = { ...definition, persistentInputs: [{ slot: "scripts", accepts: [{ kind: "document", documentKind: "text.plain", schemaVersion: 1 }], cardinality: { minItems: 0, maxItems: null } }] };
  const source = { type: "text", data: { content: "Stale text", documentRevision: { kind: "document" as const, documentAssetId: "script", revisionId: "saved" } } };
  const edit = createActionCardPromptEdit("Rewrite @[source](node:script)", mapped, () => source);
  source.data.documentRevision.revisionId = "later";
  const next = edit(revision, textDefinition);
  expect(next.state).toEqual({ ...revision.state, prompt: "Rewrite source" });
  expect(next.persistentInputRefs.map(ref => ref.target)).toEqual([{ kind: "document", documentAssetId: "script", revisionId: "saved" }]);
  const again = createActionCardPromptEdit("Compare @[first](node:old) with @[second](node:new) and @[first](node:old)", mapped,
    id => ({ type: "text", data: { documentRevision: { ...source.data.documentRevision, revisionId: id === "old" ? "saved" : "later" } } }))({ ...revision, ...next }, textDefinition);
  expect(again.persistentInputRefs.map(ref => ref.target)).toEqual(["saved", "later"].map(revisionId => ({ kind: "document", documentAssetId: "script", revisionId })));
  expect(() => createActionCardPromptEdit("@[source](node:script)", link, () => source)(revision, definition)).toThrow(/mapping/);
  expect(() => createActionCardPromptEdit("@[source](node:script)", mapped, () => ({ ...source, data: { content: "Stale text", documentRevision: { documentAssetId: "script" } } }))).toThrow(/Document/);
});
