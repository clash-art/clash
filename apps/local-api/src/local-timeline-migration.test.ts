import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import {
  createProjectTimeline, createTimelineOnCanvas, GeneratorDefinitionSchema,
  readProjectTimeline, readProjectGenerator, readGeneratorRevision,
  createProjectAsset, listActionAssetBindings, projectTimelineActionId,
} from "@clash/shared-types";
import { migrateLegacyProjectTimelines } from "./local-timeline-migration.js";
import { readLocalTimelineGenerator, createLocalTimelineGenerator } from "./local-timeline-generator-product.js";

const definition = GeneratorDefinitionSchema.parse({
  pluginId: "test.timeline", definitionId: "timeline", version: "1.0.0", schemaHash: `sha256:${"c".repeat(64)}`,
  stateSchema: { type: "object" }, editPolicy: "advance-head",
  persistentInputs: [{ slot: "media", accepts: [{ kind: "media", mediaKind: "video" }], cardinality: { minItems: 0, maxItems: null } }],
  actions: [{ id: "render", executorExportId: "render", parametersSchema: { type: "object" }, invocationInputs: [],
    outputs: [{ slot: "video", assetType: { kind: "media", mediaKind: "video" }, cardinality: { minItems: 1, maxItems: 1 } }] }],
  projectionSurface: { id: "clash.timeline", stateKey: "timeline", mediaInputSlot: "media", primaryActionId: "render" },
});

describe("legacy Timeline migration", () => {
  it("preserves identity, revision, media, and Canvas ownership while retiring the old draft authority", () => {
    const doc = new LoroDoc();
    expect(createProjectAsset(doc, { id: "clip", kind: "video", source: { kind: "owned", resourceId: "clip-resource" },
      lifecycle: { state: "active" }, metadata: { contentType: "video/mp4" } }).ok).toBe(true);
    const created = createTimelineOnCanvas(doc, { id: "cut", name: "Cut", canvasId: "main", actionNodeId: "cut-node",
      state: { tracks: [{ id: "picture", items: [{ id: "item", type: "video", assetId: "clip", from: 0, durationInFrames: 72 }] }] } });
    if (!created.ok) throw new Error(created.error);
    const before = created.timeline;
    expect(migrateLegacyProjectTimelines(doc, definition)).toMatchObject({ ok: true, migratedIds: [before.id] });
    expect(readProjectTimeline(doc, before.id)).toBeNull();
    expect(readLocalTimelineGenerator(doc, definition, before.id)).toEqual({ ok: true, timeline: before });
    expect(doc.getMap("nodes").get("cut-node")).toBeTruthy();
    const revision = readGeneratorRevision(doc, { generatorId: before.id, generatorRevisionId: before.revisionId });
    expect(revision?.persistentInputRefs.map((ref) => ref.target)).toEqual([{ kind: "media", projectAssetId: "clip" }]);
    expect(listActionAssetBindings(doc).filter((binding) => binding.owner.kind === "draft" && binding.owner.actionId === projectTimelineActionId(before.id, before.owner))).toEqual([]);
    expect(migrateLegacyProjectTimelines(doc, definition)).toEqual({ ok: true, migratedIds: [] });
  });

  it("does not partially import a project containing an invalid legacy record", () => {
    const doc = new LoroDoc();
    expect(createProjectTimeline(doc, { id: "valid", name: "Valid", state: { tracks: [] } }).ok).toBe(true);
    doc.getMap("timelines").set("broken", { name: "Broken", state: { tracks: "invalid" } });
    doc.commit();
    const original = doc.getMap("timelines").toJSON();
    expect(migrateLegacyProjectTimelines(doc, definition).ok).toBe(false);
    expect(readProjectGenerator(doc, "valid")).toBeNull();
    expect(doc.getMap("timelines").toJSON()).toEqual(original);
  });

  it("does not overwrite a different native Timeline with the same identity", () => {
    const doc = new LoroDoc();
    const created = createProjectTimeline(doc, { id: "cut", name: "Legacy", state: { tracks: [] } });
    if (!created.ok) throw new Error(created.error);
    const native = createLocalTimelineGenerator(doc, definition, { ...created.timeline, name: "Native" });
    expect(native.ok).toBe(true);
    expect(migrateLegacyProjectTimelines(doc, definition).ok).toBe(false);
    expect(readLocalTimelineGenerator(doc, definition, "cut")).toMatchObject({ timeline: { name: "Native" } });
    expect(readProjectTimeline(doc, "cut")).toEqual(created.timeline);
  });
});
